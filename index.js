/**
 * @aiiao/dsh-before-dawn —— 凌晨 / Before Dawn（Cordis 插件实现）
 *
 * 目标：用 DSH 官方扩展点复现「破甲」效果，不打补丁、不改 asar、不依赖任何第三方仓库。
 *
 * 三层：
 *   1) 提示词层：ctx.systemPrompt.section() 注入 prompt 文件（默认 $DSH_HOME/before-dawn/inject.md）
 *   2) 权限层：session/created 时 permissionPresets.set(session, 'danger-full-access')
 *      —— 该预设同时给出 sandbox = danger-full-access 与 approval = never
 *   3) 观测层：dawn_status / /dawn doctor 输出「当前 DSH 版本 + 各扩展点是否还在」，
 *      升级后能力漂移一眼可见。这是版本自适应：不写死任何文件偏移或行号锚点。
 */
import fs from 'node:fs'
import os from 'node:os'
import z from '@deepseek-ai/schemastery'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { deriveModeDefinitions, dropEntry } from './modes/derive.mjs'

const PKG_DIR = path.dirname(fileURLToPath(import.meta.url))
import {
  PERMANENT_FAILURE_CODES,
  CONTINUE_REASON_KINDS,
  isPermanentFailure,
  eventsOf,
  lastTurnEndEvent,
  humanMessageSince,
  inboxBusy,
  makeContinueMessage,
  noteInjected,
  createBudgets,
} from './lib/automation.mjs'

const PREFIX = '[before-dawn]'
const SEC_HEAD = 'before-dawn'
const SEC_TAIL = 'before-dawn-tail'
const ORDER_HEAD = -100000
const ORDER_TAIL = 10150
const PRESET_FULL = 'danger-full-access'


const DEFAULTS = {
  enabled: true,
  position: 'head',
  promptPath: '',
  pinFullAccess: true,
  pinOnlyFresh: true,
  pinExistingSessions: false,
  targetPreset: PRESET_FULL,
  stripChatmlTags: true,
  escapeInterpolation: false,
  seedFromLegacy: true,
  statusRoute: true,
  routePath: '/before-dawn/status',
  maxToolChars: 4000,
  modes: true,
  modesSource: 'auto',
  autoRetry: true,
  retryMax: 3,
  autoContinue: true,
  continueMax: 3,
  continueText: '继续',
  continueDelayMs: 700,
}

const FALLBACK_PROMPT = [
  '【操作者条款】',
  '',
  '这段文字来自插件内置兜底：既没有 $DSH_HOME/before-dawn/inject.md，也没有包内 prompt/seed.md。',
  '把你想长期生效的条款写进 $DSH_HOME/before-dawn/inject.md 即可，改文件后下一轮就生效。',
].join('\n')

/* ------------------------------------------------------------------ utils */

function errText(error) {
  if (!error) return 'unknown error'
  if (typeof error === 'string') return error
  return String(error.message || error)
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

function normalizeConfig(raw) {
  const cfg = { ...DEFAULTS }
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw)) {
      if (value === undefined || value === null || value === '') {
        if (key === 'promptPath' || key === 'routePath') continue
      }
      cfg[key] = value
    }
  }
  cfg.enabled = cfg.enabled !== false
  cfg.position = ['head', 'tail', 'both'].includes(String(cfg.position)) ? String(cfg.position) : 'head'
  cfg.promptPath = String(cfg.promptPath || '').trim()
  cfg.targetPreset = String(cfg.targetPreset || PRESET_FULL)
  cfg.routePath = String(cfg.routePath || DEFAULTS.routePath)
  if (!cfg.routePath.startsWith('/')) cfg.routePath = '/' + cfg.routePath
  cfg.maxToolChars = clampInt(cfg.maxToolChars, 200, 40000, DEFAULTS.maxToolChars)
  cfg.modes = cfg.modes !== false
  cfg.modesSource = cfg.modesSource === 'static' ? 'static' : 'auto'
  cfg.autoRetry = cfg.autoRetry !== false
  cfg.autoContinue = cfg.autoContinue !== false
  cfg.retryMax = clampInt(cfg.retryMax, 0, 20, DEFAULTS.retryMax)
  cfg.continueMax = clampInt(cfg.continueMax, 0, 20, DEFAULTS.continueMax)
  cfg.continueText = String(cfg.continueText || DEFAULTS.continueText).trim() || DEFAULTS.continueText
  cfg.continueDelayMs = clampInt(cfg.continueDelayMs, 200, 5000, DEFAULTS.continueDelayMs)
  return cfg
}

function dshHome() {
  const env = process.env.DSH_HOME || process.env.DSH_DESKTOP_HOME
  if (env && String(env).trim()) return String(env).trim()
  return path.join(os.homedir(), '.dsh')
}

/* 自己的设置文件：profile 的 cordis.patch.yml 覆盖层会被插件管理器重写（只留 id/name/disabled），
   所以真实持久化放这里；Loader 配置仍可作为初始值，但 settings.json 优先。 */
const SETTINGS_KEYS = [
  'enabled', 'position', 'pinFullAccess', 'pinOnlyFresh', 'pinExistingSessions',
  'stripChatmlTags', 'modes', 'modesSource', 'statusRoute', 'routePath', 'autoRetry', 'retryMax', 'autoContinue',
  'continueMax', 'continueText', 'continueDelayMs', 'targetPreset', 'maxToolChars',
]

function settingsPath() {
  return path.join(dshHome(), 'before-dawn', 'settings.json')
}

function readSettings() {
  try {
    const file = settingsPath()
    if (!fs.existsSync(file)) return {}
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const out = {}
    if (raw && typeof raw === 'object') {
      for (const key of SETTINGS_KEYS) {
        if (raw[key] !== undefined && raw[key] !== null) out[key] = raw[key]
      }
    }
    return out
  } catch {
    return {}
  }
}

function writeSettings(patch) {
  try {
    const file = settingsPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const next = { ...readSettings(), ...patch }
    fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
    return true
  } catch {
    return false
  }
}

function resolvePromptPath(config) {
  if (config.promptPath) return path.resolve(config.promptPath)
  return path.join(dshHome(), 'before-dawn', 'inject.md')
}

function escapeInterpolation(text) {
  // 把每一处 "{{" 拆成 "{ {"：DSH 的模板插值只认成对的连续大括号，
  // 拆开之后原样文本不会再被当作变量求值。
  const input = String(text ?? '')
  let cursor = input.indexOf('{{')
  if (cursor < 0) return input
  let output = ''
  let consumed = 0
  while (cursor >= 0) {
    output += input.slice(consumed, cursor) + '{ {'
    consumed = cursor + 2
    cursor = input.indexOf('{{', consumed)
  }
  return output + input.slice(consumed)
}

function sanitizePrompt(text, config) {
  let out = String(text || '').replace(/^\uFEFF/, '')
  if (config.stripChatmlTags) {
    out = out
      .replace(/<\|im_start\|>\s*system\s*:\s*/gi, '')
      .replace(/<\/?project_instructions>/gi, '')
      .replace(/<\|im_end\|>/g, '')
  }
  if (config.escapeInterpolation) out = escapeInterpolation(out)
  return out.replace(/\r\n/g, '\n').trim()
}

/* ------------------------------------------------------------ prompt file */

function createState(config) {
  return {
    config,
    prompt: {
      path: resolvePromptPath(config),
      text: '',
      bytes: 0,
      rawBytes: 0,
      mtime: 0,
      sha: '',
      key: null,
      error: null,
      source: '',
      loadedAt: 0,
    },
    sections: [],
    modes: [],
    modeSource: null,
    modeState: 'unknown',
    modeReason: null,
    modeAttempts: 0,
    modeWaitMs: 0,
    modeUpgradedAt: null,
    assemblyCache: null,
    diag: null,
    relatedCache: null,
    pinned: 0,
    pinLog: [],
    warnings: [],
    route: null,
    auto: { retries: 0, continues: 0, lastError: null, tracker: null, injected: new Set() },
    startedAt: Date.now(),
  }
}

function refreshPrompt(state, options) {
  const force = !!options?.force
  const file = state.prompt.path
  try {
    const stat = fs.statSync(file)
    const key = stat.size + ':' + Math.round(stat.mtimeMs)
    if (!force && state.prompt.key === key && state.prompt.text) return state.prompt
    const raw = fs.readFileSync(file, 'utf8')
    const text = sanitizePrompt(raw, state.config)
    state.prompt = {
      ...state.prompt,
      key,
      text,
      bytes: Buffer.byteLength(text, 'utf8'),
      rawBytes: Buffer.byteLength(raw, 'utf8'),
      mtime: stat.mtimeMs,
      sha: sha256(text),
      error: null,
      loadedAt: Date.now(),
    }
    state.assemblyCache = null
  } catch (error) {
    state.prompt = { ...state.prompt, key: null, text: '', bytes: 0, error: errText(error) }
  }
  return state.prompt
}

function ensurePromptFile(state) {
  const file = state.prompt.path
  try {
    if (fs.existsSync(file)) return { created: false, source: 'existing' }
  } catch { /* ignore */ }
  let body = ''
  let source = ''
  if (state.config.seedFromLegacy) {
    const legacyCandidates = [
      path.join(dshHome(), 'armor', 'inject.md'),
      path.join(dshHome(), 'prompt-inject.md'),
    ]
    for (const legacy of legacyCandidates) {
      try {
        if (!fs.existsSync(legacy)) continue
        body = fs.readFileSync(legacy, 'utf8')
        source = legacy
        break
      } catch { /* ignore */ }
    }
  }
  if (!body) {
    const bundled = path.join(PKG_DIR, 'prompt', 'seed.md')
    try {
      if (fs.existsSync(bundled)) {
        body = fs.readFileSync(bundled, 'utf8')
        source = bundled
      }
    } catch { /* ignore */ }
  }
  if (!body) {
    body = FALLBACK_PROMPT
    source = 'builtin'
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, body, 'utf8')
    return { created: true, source }
  } catch (error) {
    state.warnings.push('seed prompt failed: ' + errText(error))
    return { created: false, source: '' }
  }
}

function promptText(state) {
  return () => {
    if (!state.config.enabled) return ''
    const loaded = refreshPrompt(state)
    return loaded.text || ''
  }
}

/* --------------------------------------------------------- prompt sections */

function installPromptSections(ctx, state) {
  const register = (host) => {
    const wanted = []
    if (state.config.position === 'head' || state.config.position === 'both') {
      wanted.push({ name: SEC_HEAD, order: ORDER_HEAD })
    }
    if (state.config.position === 'tail' || state.config.position === 'both') {
      wanted.push({ name: SEC_TAIL, order: ORDER_TAIL })
    }
    for (const target of wanted) {
      const section = { name: target.name, order: target.order, interpolate: false, text: promptText(state) }
      try {
        const dispose = host.systemPrompt.section(section)
        state.sections.push(target.name)
        if (typeof dispose === 'function' && typeof host.effect === 'function') {
          host.effect(() => () => {
            try { dispose() } catch { /* ignore */ }
          })
        }
      } catch (error) {
        const message = errText(error)
        if (/already registered/i.test(message)) {
          if (!state.sections.includes(target.name)) state.sections.push(target.name)
          continue
        }
        state.warnings.push('section ' + target.name + ': ' + message)
      }
    }
  }
  try {
    ctx.inject(['systemPrompt'], (host) => register(host))
  } catch (error) {
    state.warnings.push('inject systemPrompt: ' + errText(error))
  }
}

/* --------------------------------------------------------------- permissions */

function pinSession(host, state, session, reason) {
  if (!state.config.enabled || !state.config.pinFullAccess) return false
  try {
    const service = host.permissionPresets || host.get?.('permissionPresets')
    if (!service || typeof service.set !== 'function') return false
    if (session?.header?.origin === 'subagent') return false

    let current = null
    try {
      current = typeof service.current === 'function' ? service.current(session) : null
    } catch { /* ignore */ }
    if (current === state.config.targetPreset) return false

    if (state.config.pinOnlyFresh) {
      let pins = 0
      try {
        const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
        pins = (events || []).filter((event) => event?.type === 'permission/preset').length
      } catch { /* ignore */ }
      if (pins > 1) return false
    }

    service.set(session, state.config.targetPreset)
    state.pinned += 1
    state.pinLog.push({
      session: String(session?.id || session?.header?.id || ''),
      preset: state.config.targetPreset,
      from: current,
      reason: reason || 'session/created',
      at: Date.now(),
    })
    if (state.pinLog.length > 20) state.pinLog.shift()
    return true
  } catch (error) {
    const message = errText(error)
    state.warnings.push('pin preset: ' + message)
    console.warn(PREFIX, 'pin preset failed:', message)
    return false
  }
}

function liveSessions(ctx) {
  try {
    const store = ctx.get?.('sessions')
    const all = typeof store?.all === 'function' ? store.all() : typeof store?.list === 'function' ? store.list() : []
    return Array.isArray(all) ? all : []
  } catch {
    return []
  }
}

function installSessionPin(ctx, state) {
  try {
    ctx.inject(['permissionPresets'], (host) => {
      try {
        host.effect(() => {
          let dispose = null
          try {
            dispose = host.on('session/created', (session) => {
              state.seen = (state.seen || 0) + 1
              queueMicrotask(() => pinSession(host, state, session, 'session/created'))
            })
          } catch (error) {
            state.warnings.push('on session/created: ' + errText(error))
          }
          return () => {
            try { if (typeof dispose === 'function') dispose() } catch { /* ignore */ }
          }
        })
      } catch (error) {
        state.warnings.push('effect session/created: ' + errText(error))
      }
      if (state.config.pinExistingSessions) {
        for (const session of liveSessions(ctx)) pinSession(host, state, session, 'activation')
      }
    })
  } catch (error) {
    state.warnings.push('inject permissionPresets: ' + errText(error))
  }
}

/* ----------------------------------------------------------------- status */

function serviceHas(ctx, name, method) {
  try {
    const service = ctx.get?.(name)
    if (!service) return false
    if (!method) return true
    return typeof service[method] === 'function'
  } catch {
    return false
  }
}

function collectCaps(ctx) {
  return {
    systemPromptSection: serviceHas(ctx, 'systemPrompt', 'section'),
    permissionPresets: serviceHas(ctx, 'permissionPresets', 'set'),
    permissionPresetsCurrent: serviceHas(ctx, 'permissionPresets', 'current'),
    approvalPolicy: serviceHas(ctx, 'approval', 'setPolicy'),
    tools: serviceHas(ctx, 'tools', 'register'),
    commands: serviceHas(ctx, 'commands', 'register'),
    webServer: serviceHas(ctx, 'webServer', 'register'),
    configEditor: serviceHas(ctx, 'configEditor', 'edit'),
    pluginManager: serviceHas(ctx, 'pluginManager', 'listPlugins'),
    sessions: serviceHas(ctx, 'sessions'),
  }
}

function readVersion(file) {
  try {
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (pkg && typeof pkg.version === 'string') return pkg.version
  } catch { /* ignore */ }
  return ''
}

function detectRuntimeVersion() {
  const env = process.env.DSH_VERSION || process.env.DSH_DESKTOP_VERSION
  if (env && String(env).trim()) return { version: String(env).trim(), source: 'env' }
  const starts = [process.execPath, process.argv?.[1]].filter(Boolean)
  const seen = new Set()
  for (const start of starts) {
    let dir = path.dirname(String(start))
    for (let depth = 0; depth < 8 && dir; depth += 1) {
      if (seen.has(dir)) break
      seen.add(dir)
      for (const rel of ['resources/app/package.json', 'resources/app/dsh/package.json', 'app/package.json', 'package.json']) {
        const file = path.resolve(dir, rel)
        const version = readVersion(file)
        if (version) return { version, source: file }
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return { version: 'unknown', source: '' }
}

function readCompatNotes(version) {
  try {
    const file = path.join(PKG_DIR, 'compat.json')
    if (!fs.existsSync(file)) return null
    const table = JSON.parse(fs.readFileSync(file, 'utf8'))
    const keys = Object.keys(table || {}).filter((key) => key !== 'default')
    const matched = keys.find((key) => version !== 'unknown' && version.startsWith(key))
    return { matched: matched || null, note: matched ? table[matched] : table.default || null }
  } catch {
    return null
  }
}

async function listRelatedPluginsCached(ctx, state) {
  const ttl = 15000
  const cache = state.relatedCache
  if (cache && Date.now() - cache.at < ttl) return cache.value
  const value = await listRelatedPlugins(ctx)
  state.relatedCache = { at: Date.now(), value }
  return value
}

async function listRelatedPlugins(ctx) {
  try {
    const pm = ctx.get?.('pluginManager')
    if (!pm || typeof pm.listPlugins !== 'function') return null
    const rows = await pm.listPlugins()
    if (!Array.isArray(rows)) return null
    return rows
      .filter((row) => /armor|purge|dawn|before-dawn/i.test(String(row?.moduleName || '')))
      .map((row) => ({ name: String(row.moduleName || ''), enabled: !!row.enabled, phase: row.fiberPhase ?? null }))
  } catch {
    return null
  }
}


function detectPort(ctx) {
  try {
    const service = ctx.get?.('webServer')
    if (!service) return null
    const candidates = [service.port, service.address?.port, service.server?.address?.()?.port]
    for (const value of candidates) {
      const port = Number(value)
      if (Number.isInteger(port) && port > 0) return port
    }
    return null
  } catch {
    return null
  }
}

async function probeAssembly(ctx, state) {
  const ttl = 30000
  const cache = state.assemblyCache
  if (cache && cache.value && Date.now() - cache.at < ttl) return cache.value
  try {
    const service = ctx.get?.('systemPrompt')
    if (!service || typeof service.assemble !== 'function') return { available: false }
    const assembly = await service.assemble({})
    const sections = Array.isArray(assembly?.sections) ? assembly.sections : []
    const mine = sections.filter((row) => row?.name === SEC_HEAD || row?.name === SEC_TAIL)
    const others = sections.filter((row) => !(row?.name === SEC_HEAD || row?.name === SEC_TAIL))
    const needle = state.prompt.text ? state.prompt.text.slice(0, 96) : ''
    const duplicate = needle
      ? others.filter((row) => String(row?.text || '').includes(needle)).map((row) => String(row?.name || ''))
      : []
    const value = {
      available: true,
      total: sections.length,
      chars: mine.reduce((sum, row) => sum + String(row?.text || '').length, 0),
      mine: mine.map((row) => String(row?.name || '')),
      textChars: String(state.prompt.text || '').length,
      head: String(mine[0]?.text || '').slice(0, 120),
      duplicate,
      names: sections.map((row) => String(row?.name || '')),
      sizes: sections.map((row) => String(row?.name || '') + '=' + String(row?.text || '').length),
      at: Date.now(),
    }
    state.assemblyCache = { at: value.at, value }
    return value
  } catch (error) {
    return { available: false, error: errText(error) }
  }
}

async function collectStatus(ctx, state) {
  const loaded = refreshPrompt(state)
  const runtime = detectRuntimeVersion()
  const compat = readCompatNotes(runtime.version)
  return {
    plugin: '@aiiao/dsh-before-dawn',
    enabled: !!state.config.enabled,
    position: state.config.position,
    settings: { path: settingsPath(), keys: Object.keys(readSettings()) },
    sections: [...state.sections],
    prompt: {
      path: loaded.path,
      exists: fs.existsSync(loaded.path),
      bytes: loaded.bytes,
      rawBytes: loaded.rawBytes,
      mtime: loaded.mtime,
      sha: loaded.sha ? loaded.sha.slice(0, 12) : '',
      error: loaded.error,
      source: loaded.source,
    },
    permissions: {
      pinFullAccess: !!state.config.pinFullAccess,
      preset: state.config.targetPreset,
      pinned: state.pinned,
      recent: state.pinLog.slice(-3),
    },
    runtime: { version: runtime.version, source: runtime.source, compat: compat?.matched || null, note: compat?.note || '' },
    caps: collectCaps(ctx),
    route: state.route,
    warnings: state.warnings.slice(-6),
    related: await listRelatedPluginsCached(ctx, state),
    assembly: await probeAssembly(ctx, state),
    automation: {
      autoRetry: !!state.config.autoRetry,
      retryMax: state.config.retryMax,
      autoContinue: !!state.config.autoContinue,
      continueMax: state.config.continueMax,
      continueText: state.config.continueText,
      continueDelayMs: state.config.continueDelayMs,
      retries: state.auto.retries,
      continues: state.auto.continues,
      lastError: state.auto.lastError,
      trackedSessions: state.auto.tracker ? state.auto.tracker.size() : 0,
    },
    modes: state.modes,
    modeSource: state.modeSource || null,
    modesSource: state.config.modesSource,
    modeState: state.modeState || 'unknown',
    modeReason: state.modeReason || null,
    modeAttempts: state.modeAttempts || 0,
    modeWaitMs: state.modeWaitMs || 0,
    modeUpgradedAt: state.modeUpgradedAt || null,
    modeRoster: await probeModes(ctx),
    diag: state.diag,
    port: detectPort(ctx),
    uptimeSec: Math.round((Date.now() - state.startedAt) / 1000),
  }
}

function kb(bytes) {
  return (Number(bytes || 0) / 1024).toFixed(1) + ' KB'
}

function flag(value) {
  return value ? 'on' : 'off'
}

function renderStatus(status) {
  const lines = []
  lines.push('凌晨插件 @aiiao/dsh-before-dawn  ' + (status.enabled ? '已启用' : '已停用'))
  lines.push('提示词段: ' + (status.sections.length ? status.sections.join(', ') : '未注册') + '  位置: ' + status.position)
  const prompt = status.prompt
  if (prompt.error) lines.push('prompt 文件: ' + prompt.path + '  [读取失败: ' + prompt.error + ']')
  else lines.push('prompt 文件: ' + prompt.path + '  ' + kb(prompt.bytes) + ' / ' + prompt.bytes + ' 字符  sha=' + prompt.sha + (prompt.source ? '  seed=' + prompt.source : ''))
  lines.push('权限钉住: ' + flag(status.permissions.pinFullAccess) + '  预设=' + status.permissions.preset + '  已钉会话=' + status.permissions.pinned)
  if (status.automation) {
    const auto = status.automation
    lines.push('自动续跑: 重试=' + flag(auto.autoRetry) + '(≤' + auto.retryMax + '次)' +
      '  续跑=' + flag(auto.autoContinue) + '(≤' + auto.continueMax + '次, 触发词「' + auto.continueText + '」)' +
      '  本次已重试=' + auto.retries + ' 已续跑=' + auto.continues)
  }
  if (status.modes) {
    const ok = status.modes.filter((mode) => mode.ok)
    const failed = status.modes.filter((mode) => !mode.ok)
    const modeState = status.modeState || 'unknown'
    const sourceText = modeState === 'live'
      ? '来源=' + status.modeSource
      : modeState === 'degraded'
        ? '来源=内置快照（宿主预设未就绪：重试 ' + (status.modeAttempts || 0) + ' 次 / ' + Math.round(status.modeWaitMs || 0) + 'ms，新会话时自动重试）'
        : modeState === 'failed'
          ? '来源=不可用（' + (status.modeReason || '未知原因') + '）'
          : modeState === 'off'
            ? '来源=已关闭'
            : '来源=' + (status.modeSource || '未知')
    lines.push('工作模式: ' + (ok.length ? ok.map((mode) => mode.name + '(' + mode.rows + '行)').join(' / ') : '未注册') +
      (failed.length ? '  失败: ' + failed.map((mode) => mode.id).join(',') : '') +
      '  ' + sourceText +
      (status.modeUpgradedAt ? '  已于 ' + new Date(status.modeUpgradedAt).toLocaleTimeString() + ' 自愈' : ''))
  }
  if (status.modeRoster && status.modeRoster.available) {
    lines.push('预设注册表: ' + status.modeRoster.total + ' 项  凌晨系: ' +
      (status.modeRoster.mine.map((preset) => preset.id + (preset.broken ? '(broken)' : '')).join(',') || '无'))
  } else if (status.modeRoster && status.modeRoster.error) {
    lines.push('预设注册表: 读取失败 ' + status.modeRoster.error)
  }
  lines.push('DSH 版本: ' + status.runtime.version + (status.runtime.source ? '  (' + status.runtime.source + ')' : '') + (status.runtime.compat ? '  compat=' + status.runtime.compat : ''))
  const caps = status.caps
  lines.push('扩展点: systemPrompt.section=' + flag(caps.systemPromptSection) +
    ' permissionPresets.set=' + flag(caps.permissionPresets) +
    ' tools=' + flag(caps.tools) +
    ' commands=' + flag(caps.commands) +
    ' webServer=' + flag(caps.webServer) +
    ' configEditor=' + flag(caps.configEditor))
  if (status.assembly && status.assembly.available) {
    lines.push('系统提示实测: 本插件段 ' + status.assembly.chars + ' 字符 / 共 ' + status.assembly.total + ' 段' +
      (status.assembly.duplicate.length ? '  重复注入段: ' + status.assembly.duplicate.join(',') : ''))
  } else if (status.assembly && status.assembly.error) {
    lines.push('系统提示实测: 组装失败 ' + status.assembly.error)
  }
  if (status.route) lines.push('状态接口: http://127.0.0.1:' + (status.port || 'PORT') + status.route)
  if (status.related && status.related.length) {
    lines.push('相关插件: ' + status.related.map((row) => row.name + '(' + (row.enabled ? 'on' : 'off') + ',' + (row.phase || '?') + ')').join(' '))
    if (status.related.some((row) => row.enabled && /purge/i.test(row.name))) {
      lines.push('注意: 检测到 purge 系插件同时启用，会与破甲重复注入同一份提示词，建议在插件管理里停用它。')
    }
  }
  if (status.runtime.note) lines.push('版本说明: ' + status.runtime.note)
  if (status.warnings.length) lines.push('告警: ' + status.warnings.join(' | '))
  lines.push('运行时长: ' + status.uptimeSec + 's')
  return lines.join('\n')
}

/* ------------------------------------------------------------- automation */

function installAutomation(ctx, state) {
  const cfg = state.config
  if (!cfg.autoRetry && !cfg.autoContinue) return
  const budgets = createBudgets()
  const timers = new Set()
  state.auto.tracker = budgets

  const listen = (name, handler) => {
    try {
      return ctx.on(name, handler, { global: true })
    } catch {
      try { return ctx.on(name, handler) } catch (error) {
        state.warnings.push('on ' + name + ': ' + errText(error))
        return null
      }
    }
  }

  const schedule = (fn, ms) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      try { fn() } catch (error) { state.warnings.push('automation: ' + errText(error)) }
    }, ms)
    timers.add(timer)
    return timer
  }

  let offError = null
  if (cfg.autoRetry) {
    offError = listen('agent/request-error', async (payload, next) => {
      const downstream = typeof next === 'function' ? await next() : undefined
      if (downstream?.kind === 'retry') return downstream
      let agentRef = payload?.agent || null
      if (!agentRef) {
        try { agentRef = ctx.get?.('agents')?.currentInitiator?.() || null } catch { agentRef = null }
      }
      const id = String(agentRef?.id || '')
      const code = String(payload?.failure?.code || '').toUpperCase()
      if (!id || payload?.signal?.aborted || isPermanentFailure(code)) return downstream
      const key = (payload?.turn || 0) + ':' + (payload?.step || 0) + ':' + code
      if (!budgets.takeRetry(id, key, cfg.retryMax)) return downstream
      state.auto.retries += 1
      state.auto.lastError = { at: Date.now(), session: id, code, turn: payload?.turn ?? null, step: payload?.step ?? null }
      console.log(PREFIX, 'auto-retry', '#' + state.auto.retries, code || '(no-code)', 'session=' + id)
      return { kind: 'retry' }
    })
  }

  const maybeContinue = (agent) => {
    if (!cfg.autoContinue) return
    const id = String(agent?.id || '')
    if (!id) return
    if (agent?.header?.origin === 'subagent' || agent?.session?.header?.origin === 'subagent') return
    if (agent?.status === 'running' || inboxBusy(agent)) return
    const events = eventsOf(agent)
    const end = lastTurnEndEvent(events)
    if (!end) return
    const reason = end.data?.reason || null
    const kind = String(reason?.kind || '')
    if (!CONTINUE_REASON_KINDS.has(kind)) return
    if (kind === 'aborted' && String(reason?.reason?.kind || '') === 'user') return
    if (isPermanentFailure(reason?.error?.code)) return
    if (humanMessageSince(events, end.seq || 0, state.auto.injected)) {
      budgets.reset(id)
      return
    }
    if (!budgets.takeContinue(id, end.seq || 0, cfg.continueMax)) return
    const message = makeContinueMessage(cfg.continueText)
    try {
      if (typeof agent.followup === 'function') {
        agent.followup(message)
        noteInjected(state, message.id)
      }
      else if (typeof agent.send === 'function') {
        agent.send(message, 'next-turn', true)
        noteInjected(state, message.id)
      }
      else {
        budgets.refundContinue(id)
        return
      }
    } catch (error) {
      budgets.refundContinue(id)
      state.warnings.push('auto-continue: ' + errText(error))
      return
    }
    state.auto.continues += 1
    console.log(PREFIX, 'auto-continue', '#' + state.auto.continues, 'session=' + id, 'reason=' + kind)
  }

  let offStatus = null
  if (cfg.autoContinue) {
    offStatus = listen('agent/status', (payload) => {
      const agent = payload?.agent
      if (!agent) return
      if (payload?.status === 'idle') {
        budgets.settle(String(agent.id || ''), lastTurnEndEvent(eventsOf(agent))?.data?.reason)
        schedule(() => maybeContinue(agent), cfg.continueDelayMs)
      }
    })
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      try { offError?.() } catch { /* ignore */ }
      try { offStatus?.() } catch { /* ignore */ }
    })
  }
}

/* ------------------------------------------------------------------ tools */

function textOutput() {
  return {
    schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } } },
    render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
  }
}

async function verifyPin(ctx, state, cwdArg, presetArg) {
  const store = ctx.get?.('sessions')
  const presets = ctx.get?.('permissionPresets')
  if (!store || typeof store.prepare !== 'function') return '验证失败: sessions 服务不可用'
  if (!presets || typeof presets.set !== 'function') return '验证失败: permissionPresets 服务不可用'
  const cwd = String(cwdArg || process.cwd())
  const originalTarget = state.config.targetPreset
  if (presetArg) state.config.targetPreset = String(presetArg)
  const seenBefore = state.seen || 0
  const pinnedBefore = state.pinned
  let catalog = null
  try { catalog = typeof presets.catalog === 'function' ? presets.catalog() : null } catch { /* ignore */ }
  let session = null
  let detach = null
  try {
    session = store.prepare(undefined, { meta: { cwd } })
    const id = session?.id
    detach = store.enter(session)
    store.announce(session)
    await new Promise((resolve) => setTimeout(resolve, 150))
    let preset = '(未知)'
    try {
      preset = typeof presets.current === 'function' ? presets.current(session) : '(无 current())'
    } catch (error) {
      preset = '读取失败: ' + errText(error)
    }
    let events = []
    try {
      events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
    } catch { /* ignore */ }
    const presetEvents = (events || []).filter((event) => event?.type === 'permission/preset')
    const seenDelta = (state.seen || 0) - seenBefore
    const pinnedDelta = state.pinned - pinnedBefore
    let removed = '未销毁'
    try {
      if (typeof detach === 'function') detach()
      await new Promise((resolve) => setTimeout(resolve, 60))
      removed = typeof store.get === 'function' && store.get(session.id) === undefined ? '已销毁（不在 store 内）' : '销毁后仍在 store 内'
    } catch (error) {
      removed = '销毁异常: ' + errText(error)
    }
    const lines = []
    lines.push('session/created 监听触发: ' + (seenDelta > 0 ? '是 (+' + seenDelta + ')' : '否'))
    lines.push('本次新增钉住次数: ' + pinnedDelta)
    lines.push('临时会话: ' + String(id) + '  cwd=' + cwd)
    lines.push('创建后预设: ' + preset + '  (目标 ' + state.config.targetPreset + ')')
    lines.push('permission/preset 事件数: ' + presetEvents.length)
    if (catalog) lines.push('部署默认预设: ' + String(catalog.defaultPreset || '(未知)'))
    lines.push('结论: ' + (preset === state.config.targetPreset ? '新会话拿到目标预设' : '新会话没拿到目标预设') + '；' + (seenDelta > 0 ? '监听链路正常' : '监听链路未触发'))
    lines.push('清理: ' + removed)
    return lines.join('\n')
  } catch (error) {
    try { if (typeof detach === 'function') detach() } catch { /* ignore */ }
    return '验证异常: ' + errText(error)
  } finally {
    state.config.targetPreset = originalTarget
  }
}

/* ------------------------------------------------------------------- modes */

const MODE_DIR = path.join(PKG_DIR, 'modes')

const YAML_JS_TAG = { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (v) => ({ __jsExpr: String(v).trim() }) }] }

/** 读取预设名单的就绪等待：apply 时别的 bundle 可能还没把预设声明完，读到空不算结论 */
const ROSTER_RETRY_MS = [0, 120, 240, 400, 650, 900]

async function waitForRoster(registry, state) {
  const started = Date.now()
  let rows = []
  let attempts = 0
  for (const delay of ROSTER_RETRY_MS) {
    attempts += 1
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
    let list
    try {
      list = await registry.list()
    } catch {
      list = []
    }
    rows = Array.isArray(list) ? list : []
    if (rows.length) break
  }
  const waitedMs = Date.now() - started
  if (state) {
    state.modeAttempts = attempts
    state.modeWaitMs = waitedMs
  }
  return { rows, attempts, waitedMs }
}

/** 读宿主当前默认预设的真实组合（YAML 文档）；读不到就抛，由调用方回落静态 JSON */
async function readLiveBase(registry, state) {
  const { rows, attempts, waitedMs } = await waitForRoster(registry, state)
  if (!rows.length) {
    throw new Error('宿主在 ' + Math.round(waitedMs) + 'ms 内没有声明任何预设（已重试 ' + attempts + ' 次）')
  }
  const pick = rows.find((preset) => preset && preset.isDefault)
    || rows.find((preset) => typeof preset?.id === 'string' && preset.id !== '')
  if (!pick || typeof pick.id !== 'string') throw new Error('找不到可读的默认预设')
  const doc = await registry.readDocument(pick.id)
  const content = typeof doc === 'string' ? doc : doc?.content
  if (typeof content !== 'string' || !content.trim()) throw new Error('readDocument 返回空内容')
  const parsed = YAML.parse(content, YAML_JS_TAG)
  const plugins = Array.isArray(parsed) ? parsed : parsed?.plugins
  if (!Array.isArray(plugins) || !plugins.length) throw new Error('文档不是插件行数组')
  return { preset: pick.id, name: pick.name || pick.id, rows: plugins }
}

/** 注册；遇到 never started 时按错误里的 entryId 摘掉那一行再重试（替代写死的 BASE_DROP） */
async function registerWithRepair(registry, definition, state) {
  let current = definition
  for (let round = 0; round <= 4; round += 1) {
    try {
      return await registry.register(current)
    } catch (error) {
      const message = errText(error)
      const entryId = /^\s*([a-z0-9][a-z0-9-]*)\s*[(:]/.exec(message)?.[1]
      if (!entryId || round === 4) throw error
      const next = structuredClone(current)
      const removed = dropEntry(next.plugins, entryId)
      if (!removed) throw error
      state.warnings.push('模式 ' + definition.id + '：自动剔除不可用行 ' + entryId + ' 后重试')
      current = next
    }
  }
  throw new Error('unreachable')
}

/** 读 modes/*.json（构建产物）；坏文件只记警告，不阻塞插件 */
function readModeDefinitions(state) {
  if (!fs.existsSync(MODE_DIR)) return []
  const definitions = []
  for (const file of fs.readdirSync(MODE_DIR).filter((name) => name.endsWith('.json')).sort()) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(MODE_DIR, file), 'utf8'))
      if (!raw || typeof raw.id !== 'string' || !Array.isArray(raw.plugins)) throw new Error('缺少 id 或 plugins')
      definitions.push(raw)
    } catch (error) {
      state.warnings.push('模式 ' + file + ' 不可用: ' + errText(error))
    }
  }
  return definitions
}

/** 把模式注册成 agent preset：新会话下拉里出现「凌晨模式 / 凌晨 · 实验室」及其「· 子任务」 */
function installModes(ctx, state) {
  if (!state.config.modes) {
    state.modeState = 'off'
    return
  }
  /* 用 inject 等 agentPresets 就位再注册：直接 ctx.get 会在宿主装配尚未完成时拿到 undefined */
  ctx.inject(['agentPresets'], (host) => {
    const registry = host.agentPresets || host.get('agentPresets')
    if (!registry || typeof registry.register !== 'function') {
      state.modeState = 'unavailable'
      state.warnings.push('agentPresets 不可用：模式未注册（该 DSH 版本没有 preset 机制）')
      return
    }
    let disposers = []
    let applying = false
    let upgrades = 0

    host.effect(() => () => {
      for (const dispose of disposers.reverse()) {
        try { void dispose() } catch { /* ignore */ }
      }
      disposers = []
    })

    const dropModeWarnings = () => {
      state.warnings = state.warnings.filter((line) => !/^读宿主组合失败/.test(line))
    }

    const applyModes = async ({ upgrade = false } = {}) => {
      if (applying) return
      applying = true
      try {
        let definitions = []
        let source = 'static'
        let reason = null
        const preferStatic = state.config.modesSource === 'static'
        if (!preferStatic && typeof registry.readDocument === 'function' && typeof registry.list === 'function') {
          try {
            const live = await readLiveBase(registry, state)
            try {
              definitions = deriveModeDefinitions(live.rows)
              source = 'live:' + live.preset
            } catch (deriveError) {
              try {
                const dump = path.join(dshHome(), 'before-dawn', 'live-base.dump.yml')
                fs.mkdirSync(path.dirname(dump), { recursive: true })
                fs.writeFileSync(dump, YAML.stringify(live.rows), 'utf8')
                state.liveDump = dump
              } catch { /* ignore */ }
              throw deriveError
            }
          } catch (error) {
            reason = errText(error)
          }
        }
        if (!definitions.length) definitions = readModeDefinitions(state)
        if (!definitions.length) {
          state.modeState = 'failed'
          state.modeReason = reason || '没有任何模式定义（modes/*.json 缺失且宿主组合不可读）'
          state.warnings.push('没有任何模式定义（modes/*.json 缺失且宿主组合不可读）')
          return
        }
        /* 预设 id 固定，重新注册前必须先释放上一份，否则 "already registered" */
        for (const dispose of disposers.reverse()) {
          try { void dispose() } catch { /* ignore */ }
        }
        disposers = []
        state.modes = []
        for (const definition of definitions) {
          const row = {
            id: definition.id,
            name: definition.name || definition.id,
            order: definition.order ?? null,
            rows: definition.plugins.length,
            ok: false,
            error: null,
          }
          state.modes.push(row)
          try {
            const dispose = await registerWithRepair(registry, definition, state)
            if (typeof dispose === 'function') disposers.push(dispose)
            row.ok = true
            row.rows = definition.plugins.length
          } catch (error) {
            row.error = errText(error)
            state.warnings.push('模式 ' + definition.id + ' 注册失败: ' + row.error)
          }
        }
        state.modeSource = source
        state.modeReason = reason || (preferStatic ? '配置为 static（使用包内快照）' : null)
        state.modeState = reason ? 'degraded' : 'live'
        if (upgrade && !reason) state.modeUpgradedAt = Date.now()
        dropModeWarnings()
        if (reason) {
          state.warnings.push('读宿主组合失败，回落到内置模式: ' + reason + '（下一个新会话创建时会自动重试一次）')
        }
        const ok = state.modes.filter((mode) => mode.ok).map((mode) => mode.id)
        console.log(PREFIX, 'modes:', (ok.length ? ok.join(',') : 'none') + '  source=' + source + (upgrade ? ' (retried)' : ''))
      } finally {
        applying = false
      }
    }

    void applyModes()

    /* 降级自愈：宿主预设晚于本插件声明时，下一个新会话创建时重试，最多 2 次 */
    if (typeof host.on === 'function') {
      const off = host.on('session/created', () => {
        if (state.modeState !== 'degraded' || upgrades >= 2) return
        upgrades += 1
        void applyModes({ upgrade: true })
      })
      host.effect(() => () => { try { off?.() } catch { /* ignore */ } })
    }
  })
}

/** 状态用：注册表里现在有哪些 preset（含 broken 标记） */
async function probeModes(ctx) {
  const registry = ctx.get('agentPresets')
  if (!registry || typeof registry.list !== 'function') return { available: false }
  try {
    const all = await registry.list()
    const mine = all.filter((preset) => /^before-dawn/.test(String(preset?.id || '')))
    return {
      available: true,
      total: all.length,
      mine: mine.map((preset) => ({
        id: preset.id,
        name: preset.name || preset.id,
        order: preset.order ?? null,
        broken: preset.broken ?? null,
      })),
    }
  } catch (error) {
    return { available: false, error: errText(error) }
  }
}

async function probeRetry(ctx, state) {
  const agents = ctx.get?.('agents')
  if (!agents || typeof agents.create !== 'function') return '验证失败: agents 服务不可用'
  if (typeof ctx.waterfall !== 'function') return '验证失败: 本版本 ctx 没有 waterfall，无法主动派发事件'
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const lines = []
  let handle = null
  try {
    handle = await agents.create({ sessionId: 'session-probe-' + Date.now().toString(36), meta: { cwd: String(process.cwd()) } })
    const agent = handle?.agent
    if (!agent) return '验证失败: agents.create 没返回 agent'
    lines.push('临时 Agent: ' + String(agent.id))
    const base = { agent, turn: 9001, step: 1, provider: 'before-dawn-probe', retryPolicy: undefined, signal: undefined }
    const runs = [
      { label: '瞬时错误 ETIMEDOUT（期望 retry）', failure: { code: 'ETIMEDOUT', message: 'synthetic probe (no real request)' } },
      { label: '永久错误 AUTH（期望不重试）', failure: { code: 'AUTH', message: 'synthetic probe (no real request)' } },
    ]
    for (const run of runs) {
      const before = state.auto?.retries || 0
      let action = '(无返回)'
      let errorText = ''
      try {
        const invoke = () => ctx.waterfall('agent/request-error', { ...base, failure: run.failure, agent: undefined }, () => Promise.resolve(undefined))
        const out = typeof agents.withInitiator === 'function' ? await agents.withInitiator(agent, invoke) : await invoke()
        action = out && out.kind ? String(out.kind) : out === undefined ? '(undefined)' : JSON.stringify(out).slice(0, 120)
      } catch (error) {
        const stack = String(error && error.stack || '')
        const line = stack.split('\n').slice(1, 3).join(' | ')
        errorText = '  抛错: ' + errText(error) + (line ? '   栈: ' + line : '')
      }
      await sleep(40)
      const after = state.auto?.retries || 0
      lines.push(run.label + ' → 返回 ' + action + errorText + '  重试计数 ' + before + '→' + after)
    }
    let tracked = 0
    try { tracked = typeof state.auto?.tracker?.size === 'function' ? state.auto.tracker.size() : 0 } catch { tracked = 0 }
    lines.push('预算表 trackedSessions: ' + tracked)
    lines.push('自动重试开关: ' + (state.config.autoRetry !== false ? 'on' : 'off') + ' / 上限 ' + state.config.retryMax)
    return lines.join('\n')
  } catch (error) {
    return '验证异常: ' + errText(error) + (lines.length ? '\n' + lines.join('\n') : '')
  } finally {
    try { if (handle && typeof handle.dispose === 'function') await handle.dispose() } catch { /* ignore */ }
  }
}

function installTools(ctx, state) {
  try {
    ctx.inject(['tools'], (host) => {
      const register = (definition) => {
        try {
          host.tools.register(definition)
        } catch (error) {
          state.warnings.push('tool ' + definition.name + ': ' + errText(error))
        }
      }

      register({
        name: 'dawn_status',
        description: '查看破甲插件状态：提示词注入段与字节数、每会话全权限钉住、当前 DSH 版本、扩展点能力矩阵、相关插件冲突。',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output: textOutput(),
        async execute() {
          return { text: renderStatus(await collectStatus(ctx, state)) }
        },
      })

      register({
        name: 'dawn_prompt',
        description: '读写破甲提示词文件：action=read|path|set|append|reload。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string', enum: ['read', 'path', 'set', 'append', 'reload'], description: '操作类型' },
            text: { type: 'string', description: 'set/append 时写入的正文' },
            chars: { type: 'number', description: 'read 时返回的字符数上限' },
          },
          required: ['action'],
        },
        output: textOutput(),
        async execute(args) {
          const action = String(args?.action || 'read')
          const file = state.prompt.path
          if (action === 'path') {
            const exists = fs.existsSync(file)
            return { text: file + (exists ? '  (' + kb(fs.statSync(file).size) + ')' : '  (尚未创建)') }
          }
          if (action === 'reload') {
            const loaded = refreshPrompt(state, { force: true })
            if (loaded.error) return { text: '重载失败: ' + loaded.error + '  路径: ' + file }
            return { text: '已重载: ' + kb(loaded.bytes) + ' / ' + loaded.bytes + ' 字符  sha=' + loaded.sha.slice(0, 12) }
          }
          if (action === 'set' || action === 'append') {
            const body = String(args?.text ?? '')
            if (!body) return { text: '缺少 text 参数' }
            try {
              fs.mkdirSync(path.dirname(file), { recursive: true })
              if (action === 'append' && fs.existsSync(file)) {
                fs.appendFileSync(file, '\n' + body + '\n', 'utf8')
              } else {
                fs.writeFileSync(file, body, 'utf8')
              }
              const loaded = refreshPrompt(state, { force: true })
              return { text: action + ' 完成: ' + kb(loaded.bytes) + ' / ' + loaded.bytes + ' 字符  sha=' + loaded.sha.slice(0, 12) }
            } catch (error) {
              return { text: '写入失败: ' + errText(error) }
            }
          }
          const loaded = refreshPrompt(state)
          if (loaded.error) return { text: '读取失败: ' + loaded.error + '  路径: ' + file }
          const limit = clampInt(args?.chars, 200, state.config.maxToolChars, state.config.maxToolChars)
          const head = loaded.text.slice(0, limit)
          const tailNote = loaded.text.length > limit ? '\n… (共 ' + loaded.text.length + ' 字符，已截断)' : ''
          return { text: '路径: ' + file + '\n字节: ' + loaded.bytes + '  sha=' + loaded.sha.slice(0, 12) + '\n---\n' + head + tailNote }
        },
      })

      register({
        name: 'dawn_verify_pin',
        description: '新建一个临时会话，读取其创建后的权限预设，验证「新会话自动钉全权限」这条链路是否真的触发；读完立刻拆掉该临时会话，不在列表里留下痕迹。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            cwd: { type: 'string', description: '临时会话的工作目录，默认进程当前目录' },
            preset: { type: 'string', description: '临时把目标预设换成这个值来验证钉住是否真的生效（验证后自动还原）' },
          },
        },
        output: textOutput(),
        async execute(args) {
          return { text: await verifyPin(ctx, state, args?.cwd, args?.preset) }
        },
      })

      register({
        name: 'dawn_retry_probe',
        description: '自检用：派发一次合成的 agent/request-error 事件走真实 waterfall，验证「瞬时错误→重试、永久错误→不重试」这条链路。不发起任何真实模型请求。',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output: textOutput(),
        async execute() {
          return { text: await probeRetry(ctx, state) }
        },
      })

      register({
        name: 'dawn_apply',
        description: '把全权限预设钉到当前存活会话（scope=live），或只回报新会话自动钉住策略（scope=fresh）。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            scope: { type: 'string', enum: ['live', 'fresh'], description: '作用范围' },
            preset: { type: 'string', description: '目标预设名，默认 danger-full-access' },
          },
        },
        output: textOutput(),
        async execute(args) {
          const scope = String(args?.scope || 'live')
          const preset = String(args?.preset || state.config.targetPreset)
          if (scope === 'fresh') {
            return { text: '新会话自动钉住: ' + flag(state.config.pinFullAccess) + '  预设=' + state.config.targetPreset }
          }
          const sessions = liveSessions(ctx)
          let changed = 0
          for (const session of sessions) {
            try {
              const service = ctx.get?.('permissionPresets')
              if (!service || typeof service.set !== 'function') break
              const current = typeof service.current === 'function' ? service.current(session) : null
              if (current === preset) continue
              service.set(session, preset)
              changed += 1
            } catch (error) {
              state.warnings.push('apply preset: ' + errText(error))
            }
          }
          return { text: '存活会话 ' + sessions.length + ' 个，改动 ' + changed + ' 个 → ' + preset }
        },
      })
    })
  } catch (error) {
    state.warnings.push('inject tools: ' + errText(error))
  }
}

/* --------------------------------------------------------------- commands */

function applyConfigPatch(state, patch) {
  const applied = {}
  if (!patch || typeof patch !== 'object') return applied
  state.assemblyCache = null
  if (Object.prototype.hasOwnProperty.call(patch, 'enabled')) {
    state.config.enabled = patch.enabled !== false
    applied.enabled = state.config.enabled
  }
  for (const key of ['autoRetry', 'autoContinue']) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      state.config[key] = patch[key] !== false
      applied[key] = state.config[key]
    }
  }
  const keys = Object.keys(patch)
  if (keys.length && !Object.keys(applied).length) {
    throw new Error('不支持的配置键: ' + keys.join(',') + '（可用: enabled, autoRetry, autoContinue）')
  }
  return applied
}

async function persistConfig(ctx, patch) {
  const fileSaved = writeSettings(patch)
  let mirrored = false
  let reason = ''
  try {
    const entry = ctx.fiber?.entry
    const editor = ctx.get?.('configEditor')
    if (entry && editor && typeof editor.edit === 'function') {
      await editor.edit(entry, (current) => ({ ...(current || {}), ...patch }))
      mirrored = true
    } else {
      reason = 'profile 没有提供 configEditor'
    }
  } catch (error) {
    reason = errText(error)
  }
  return { saved: fileSaved, mirrored, reason, path: settingsPath() }
}

const HELP_TEXT = [
  '/dawn 子命令：',
  '  status            当前状态（默认）',
  '  on | off          启用 / 停用提示词注入（写入插件配置）',
  '  reload            重新读取 prompt 文件',
  '  path              显示 prompt 文件路径',
  '  apply [preset]    把当前会话钉成全权限（默认 danger-full-access）',
  '  verify            新建临时会话验证全权限钉住（读完即销毁）',
  '  auto [on|off]     查看 / 开关自动重试与自动续跑',
  '  modes             列出已注册的凌晨模式（新会话下拉可选）',
  '  continue [文本]   立刻给当前会话发一条续跑消息',
  '  plugins           列出破甲 / purge 相关插件',
  '  doctor            能力矩阵与冲突体检',
  '  help              本说明',
].join('\n')

function installCommands(ctx, state) {
  try {
    ctx.inject(['commands'], (host) => {
      const definition = {
        name: 'dawn',
        description: '凌晨插件（status/on/off/reload/path/apply/verify/plugins/doctor/help）',
        input: { hint: 'status | on | off | reload | path | apply | verify | plugins | doctor | help' },
        handler: async (invocation) => {
          const raw = String(invocation?.rawInput || '').trim()
          const sub = (raw.split(/\s+/)[0] || 'status').toLowerCase()
          const rest = raw.slice(sub.length).trim()
          const session = invocation?.agent?.session
          try {
            if (sub === 'help') return { kind: 'success', text: HELP_TEXT }
            if (sub === 'path') return { kind: 'success', text: state.prompt.path }
            if (sub === 'reload') {
              const loaded = refreshPrompt(state, { force: true })
              if (loaded.error) return { kind: 'error', text: '重载失败: ' + loaded.error }
              return { kind: 'success', text: '已重载: ' + kb(loaded.bytes) + ' / ' + loaded.bytes + ' 字符' }
            }
            if (sub === 'on' || sub === 'off') {
              state.config.enabled = sub === 'on'
              const saved = await persistConfig(ctx, { enabled: state.config.enabled })
              return {
                kind: 'success',
                text: '提示词注入已' + (state.config.enabled ? '启用' : '停用') +
                  (saved.saved ? '（已写入插件配置）' : '（本次运行生效，未能持久化: ' + saved.reason + '）'),
              }
            }
            if (sub === 'apply') {
              const preset = rest || state.config.targetPreset
              const service = ctx.get?.('permissionPresets')
              if (!service || typeof service.set !== 'function') return { kind: 'error', text: '本版本没有 permissionPresets 服务' }
              if (!session) return { kind: 'error', text: '拿不到当前会话' }
              const before = typeof service.current === 'function' ? service.current(session) : null
              service.set(session, preset)
              return { kind: 'success', text: '当前会话权限: ' + String(before) + ' → ' + preset }
            }
            if (sub === 'verify') {
              return { kind: 'success', text: await verifyPin(ctx, state, rest) }
            }
            if (sub === 'auto') {
              const arg = rest.toLowerCase()
              if (arg === 'on' || arg === 'off') {
                state.config.autoRetry = arg === 'on'
                state.config.autoContinue = arg === 'on'
                const saved = await persistConfig(ctx, { autoRetry: state.config.autoRetry, autoContinue: state.config.autoContinue })
                return {
                  kind: 'success',
                  text: '自动重试 / 续跑已' + (arg === 'on' ? '启用' : '停用') +
                    (saved.saved ? '（已写入插件配置）' : '（本次运行生效，未能持久化: ' + saved.reason + '）'),
                }
              }
              const auto = state.config
              return {
                kind: 'success',
                text: '自动重试: ' + flag(auto.autoRetry) + '  最多 ' + auto.retryMax + ' 次\n' +
                  '自动续跑: ' + flag(auto.autoContinue) + '  最多 ' + auto.continueMax + ' 次  触发词「' + auto.continueText + '」  延迟 ' + auto.continueDelayMs + 'ms\n' +
                  '本次已重试 ' + state.auto.retries + ' 次 / 已续跑 ' + state.auto.continues + ' 次',
              }
            }
            if (sub === 'continue') {
              const agent = invocation?.agent
              if (!agent || typeof agent.followup !== 'function') return { kind: 'error', text: '当前会话没有可续跑的 agent' }
              const text = rest || state.config.continueText
              const message = makeContinueMessage(text)
              agent.followup(message)
              noteInjected(state, message.id)
              state.auto.continues += 1
              return { kind: 'success', text: '已发送续跑消息: ' + text }
            }
            if (sub === 'modes') {
              const roster = await probeModes(ctx)
              const lines = ['模式开关: ' + flag(state.config.modes)]
              if (!state.modes.length) lines.push('尚未注册（modes/*.json 为空，或本版本没有 agentPresets）')
              for (const mode of state.modes) {
                lines.push('- ' + mode.name + '  ' + (mode.ok ? 'ok' : '失败: ' + mode.error) + '  ' + mode.rows + ' 行  order=' + mode.order)
              }
              if (roster.available) {
                lines.push('注册表共 ' + roster.total + ' 项；凌晨系: ' +
                  (roster.mine.map((preset) => preset.id + (preset.broken ? '(broken)' : '')).join(',') || '无'))
              } else if (roster.error) {
                lines.push('注册表读取失败: ' + roster.error)
              }
              lines.push('用法：新建会话时在模式下拉里选「凌晨模式」或「凌晨 · 实验室」；子智能体自动用对应的「· 子任务」。')
              return { kind: 'success', text: lines.join('\n') }
            }
            if (sub === 'plugins') {
              const rows = await listRelatedPlugins(ctx)
              if (!rows) return { kind: 'error', text: 'pluginManager 不可用' }
              if (!rows.length) return { kind: 'success', text: '没有破甲 / purge 相关插件' }
              return { kind: 'success', text: rows.map((row) => '- ' + row.name + '  ' + (row.enabled ? 'enabled' : 'disabled') + '  ' + (row.phase || '?')).join('\n') }
            }
            if (sub === 'doctor') {
              const status = await collectStatus(ctx, state)
              const problems = []
              if (!status.caps.systemPromptSection) problems.push('systemPrompt.section 不可用：提示词注入无法生效')
              if (!status.caps.permissionPresets) problems.push('permissionPresets.set 不可用：会话全权限无法钉住')
              if (status.prompt.error) problems.push('prompt 文件读不出：' + status.prompt.error)
              if (!status.prompt.bytes) problems.push('prompt 内容为空')
              if (!status.caps.tools) problems.push('tools.register 不可用：dawn_* 工具缺失')
              if (status.assembly && status.assembly.duplicate && status.assembly.duplicate.length) {
                problems.push('提示词重复注入：' + status.assembly.duplicate.join(',') + ' 也带着同一份文本，建议停用其中一个')
              }
              if (!status.caps.commands) problems.push('commands.register 不可用：/dawn 缺失')
              const body = renderStatus(status)
              if (!problems.length) return { kind: 'success', text: body + '\n体检: 全部扩展点就位。' }
              return { kind: 'error', text: body + '\n体检问题:\n' + problems.map((line) => '- ' + line).join('\n') }
            }
            const status = await collectStatus(ctx, state)
            return { kind: 'success', text: renderStatus(status) }
          } catch (error) {
            return { kind: 'error', text: 'dawn 命令失败: ' + errText(error) }
          }
        },
      }
      try {
        host.commands.register(definition)
      } catch (error) {
        const message = errText(error)
        if (!/already registered/i.test(message)) {
          state.warnings.push('command /dawn: ' + message)
          return
        }
        try {
          host.commands.register({ ...definition, name: 'dawn-local' })
        } catch (inner) {
          state.warnings.push('command /dawn-local: ' + errText(inner))
        }
      }
    })
  } catch (error) {
    state.warnings.push('inject commands: ' + errText(error))
  }
}

/* ------------------------------------------------------------------ route */

async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 65536) throw new Error('body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  return JSON.parse(text)
}

function sendJson(response, status, payload) {
  try {
    response.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(payload))
  } catch { /* ignore */ }
}

function installStatusRoute(ctx, state) {
  if (!state.config.statusRoute) return
  try {
    ctx.inject(['webServer'], (host) => {
      const target = state.config.routePath.replace(/\/+$/, '')
      const handler = async (request, response) => {
        try {
          if (request?.method === 'OPTIONS') {
            response.writeHead(204, { 'cache-control': 'no-store' })
            response.end()
            return
          }
          const url = new URL(String(request?.url || '/'), 'http://127.0.0.1')
          const pathname = url.pathname.replace(/\/+$/, '')
          const isDiag = pathname === target + '/diag'
          const isConfig = pathname === target + '/config'
          if (pathname !== target && pathname !== target + '/json' && !isConfig && !isDiag) {
            sendJson(response, 404, { ok: false, error: 'not-found' })
            return
          }
          const method = String(request?.method || 'GET').toUpperCase()
          if (isDiag) {
            if (method !== 'POST') {
              sendJson(response, 405, { ok: false, error: 'method-not-allowed' })
              return
            }
            let body = {}
            try {
              body = await readJsonBody(request)
            } catch (error) {
              sendJson(response, 400, { ok: false, error: 'bad-json: ' + errText(error) })
              return
            }
            state.diag = { at: new Date().toISOString(), data: body }
            console.log(PREFIX, 'client diag received:', JSON.stringify(body).slice(0, 1200))
            sendJson(response, 200, { ok: true })
            return
          }
          if (isConfig) {
            if (method !== 'POST') {
              sendJson(response, 405, { ok: false, error: 'method-not-allowed' })
              return
            }
            let body = {}
            try {
              body = await readJsonBody(request)
            } catch (error) {
              sendJson(response, 400, { ok: false, error: 'bad-json: ' + errText(error) })
              return
            }
            let applied = {}
            try {
              applied = applyConfigPatch(state, body)
            } catch (error) {
              sendJson(response, 400, { ok: false, error: errText(error) })
              return
            }
            const saved = await persistConfig(ctx, applied)
            const status = await collectStatus(ctx, state)
            sendJson(response, 200, { ok: true, applied, saved, status: { ok: true, ...status } })
            return
          }
          if (method !== 'GET' && method !== 'HEAD') {
            sendJson(response, 405, { ok: false, error: 'method-not-allowed' })
            return
          }
          const status = await collectStatus(ctx, state)
          sendJson(response, 200, { ok: true, ...status })
        } catch (error) {
          sendJson(response, 500, { ok: false, error: errText(error) })
        }
      }
      try {
        const dispose = host.webServer.register({ kind: 'prefix', path: target, handler })
        state.route = target
        if (typeof host.effect === 'function') {
          host.effect(() => () => {
            try { dispose?.() } catch { /* ignore */ }
            state.route = null
          })
        }
      } catch (error) {
        state.warnings.push('webServer.register: ' + errText(error))
      }
    })
  } catch (error) {
    state.warnings.push('inject webServer: ' + errText(error))
  }
}

/* ------------------------------------------------------------------- apply */

/* 配置表单：用宿主同款 schemastery，DSH 插件管理才能渲染「修改」项。 */
export const Config = z.object({
  enabled: z.boolean().default(true).description('总开关：关闭后不再注入提示词（权限钉住与自动续跑各自独立）。'),
  position: z.string().default('head').description('注入位置：head 系统提示开头 / tail 末尾 / both 两端。'),
  promptPath: z.string().default('').description('提示词文件路径，留空用 ~/.dsh/before-dawn/inject.md。'),
  pinFullAccess: z.boolean().default(true).description('新会话自动钉到目标预设。'),
  pinOnlyFresh: z.boolean().default(true).description('只钉没有被手动改过预设的会话。'),
  pinExistingSessions: z.boolean().default(false).description('加载时也给已有会话补钉。'),
  stripChatmlTags: z.boolean().default(true).description('注入前剥掉 ChatML 与 project_instructions 标签。'),
  modes: z.boolean().default(true).description('注册「凌晨模式 / 凌晨 · 实验室」两个 agent preset。'),
  modesSource: z.string().default('auto').description('auto = 运行期从宿主组合派生；static = 只用包内 modes/*.json 快照。'),
  statusRoute: z.boolean().default(true).description('开启 HTTP 状态接口。'),
  routePath: z.string().default('/before-dawn/status').description('状态接口路径。'),
  autoRetry: z.boolean().default(true).description('模型请求失败时自动重试。'),
  retryMax: z.number().default(3).description('每个 step 最多重试次数（0-20）。'),
  autoContinue: z.boolean().default(true).description('回合异常结束后自动续跑。'),
  continueMax: z.number().default(3).description('每个会话最多自动续跑次数（0-20）。'),
  continueText: z.string().default('继续').description('续跑时发送的文本。'),
  continueDelayMs: z.number().default(700).description('续跑延迟毫秒（200-5000）。'),
  targetPreset: z.string().default('danger-full-access').description('钉住的目标权限预设。'),
  maxToolChars: z.number().default(4000).description('工具输出回显字符上限。'),
})

export function apply(ctx, rawConfig) {
  const config = normalizeConfig({ ...(rawConfig || {}), ...readSettings() })
  const state = createState(config)
  const seeded = ensurePromptFile(state)
  if (seeded.created) state.prompt.source = 'seeded:' + seeded.source
  refreshPrompt(state, { force: true })

  installPromptSections(ctx, state)
  installSessionPin(ctx, state)
  installAutomation(ctx, state)
  installModes(ctx, state)
  installTools(ctx, state)
  installCommands(ctx, state)
  installStatusRoute(ctx, state)

  const tail = state.prompt.error ? ' (prompt 读取失败: ' + state.prompt.error + ')' : ''
  console.log(PREFIX, 'ready:', state.prompt.path, '→', state.prompt.bytes, 'chars' + tail)
}

/* 仅供离线自测：验证决策逻辑，不参与宿主装配。 */
export const __dawnTest = {
  probeRetry,
  sanitizePrompt,
  escapeInterpolation,
  registerWithRepair, waitForRoster, readLiveBase, isPermanentFailure, humanMessageSince, makeContinueMessage, createBudgets, lastTurnEndEvent }
