import crypto from 'node:crypto'

/* 由 index.js 抽出：自动重试/续跑的纯函数与预算表（无 ctx 依赖，可单测） */

export const PERMANENT_FAILURE_CODES = new Set([
  'AUTH', 'UNAUTHORIZED', 'FORBIDDEN', 'INVALID', 'INVALID_REQUEST', 'QUOTA', 'ACCOUNT_QUOTA',
  'BILLING', 'MODEL_NOT_FOUND', 'CONTEXT_OVERFLOW', 'CONTEXT_LENGTH', 'CONTEXT_WINDOW_EXCEEDED',
  'NO_ADAPTER', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL',
])

export const CONTINUE_REASON_KINDS = new Set(['error', 'aborted', 'interrupted', 'max-tokens'])

export function isPermanentFailure(code) {
  return PERMANENT_FAILURE_CODES.has(String(code || '').toUpperCase())
}

export function eventsOf(agent) {
  try {
    const session = agent?.session
    if (!session) return []
    if (typeof session.snapshotEvents === 'function') return session.snapshotEvents() || []
    if (Array.isArray(session.events)) return session.events
  } catch { /* ignore */ }
  return []
}

export function lastTurnEndEvent(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.type === 'turn/end') return events[i]
  }
  return null
}

export function humanMessageSince(events, seq, injected) {
  const floor = Number(seq || 0)
  for (const event of events) {
    if (!event || event.type !== 'user/message') continue
    if (Number(event.seq || 0) <= floor) continue
    if (event.data?.source?.kind === 'plugin') continue
    if (injected && event.data?.id && injected.has(event.data.id)) continue
    return true
  }
  return false
}

export function inboxBusy(agent) {
  try {
    const inbox = agent?.inbox
    if (!inbox) return false
    if (typeof inbox.hasPending === 'boolean') return inbox.hasPending
    if (typeof inbox.hasPending === 'function') return !!inbox.hasPending()
    if (typeof inbox.size === 'number') return inbox.size > 0
    if (typeof inbox.length === 'number') return inbox.length > 0
  } catch { /* ignore */ }
  return false
}

export function makeContinueMessage(text) {
  return {
    id: 'before-dawn-continue-' + crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text || '继续') }],
    source: { kind: 'user' },
  }
}

export function noteInjected(state, id) {
  const set = state.auto.injected
  if (!id || !set) return
  if (set.size >= 256) {
    const oldest = set.values().next().value
    if (oldest !== undefined) set.delete(oldest)
  }
  set.add(id)
}

export function createBudgets() {
  const CAP = 200
  const EVICT = 50
  const bySession = new Map()
  const slot = (id) => {
    if (!id) return null
    let cur = bySession.get(id)
    if (cur) return cur
    if (bySession.size >= CAP) {
      let i = 0
      for (const key of bySession.keys()) {
        if (i >= EVICT) break
        bySession.delete(key)
        i += 1
      }
    }
    cur = { retry: 0, cont: 0, lastRetryKey: '', lastContinueSeq: 0, failStreak: 0 }
    bySession.set(id, cur)
    return cur
  }
  return {
    size: () => bySession.size,
    takeRetry(id, key, max) {
      const cur = slot(id)
      if (!cur || max <= 0) return false
      if (cur.lastRetryKey === key) return false
      if (cur.retry >= max) return false
      cur.retry += 1
      cur.lastRetryKey = key
      return true
    },
    takeContinue(id, seq, max) {
      const cur = slot(id)
      if (!cur || max <= 0) return false
      if (cur.lastContinueSeq === seq) return false
      if (cur.cont >= max) return false
      if (cur.failStreak >= 3) return false
      cur.cont += 1
      cur.lastContinueSeq = seq
      return true
    },
    refundContinue(id) {
      const cur = bySession.get(id)
      if (!cur || cur.cont <= 0) return
      cur.cont -= 1
      cur.failStreak += 1
    },
    reset(id) {
      if (id) bySession.delete(id)
    },
    settle(id, reason) {
      const kind = String(reason?.kind || '')
      const cur = bySession.get(id)
      if (!cur) return
      if (kind === 'completed' || kind === 'blocked') bySession.delete(id)
      else cur.failStreak = 0
    },
  }
}
