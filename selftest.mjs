/* 离线自测：node selftest.mjs —— 校验自动重试/续跑的决策逻辑，不连宿主。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
const { __dawnTest } = await import(new URL('./index.js', import.meta.url).href)
const { isPermanentFailure, humanMessageSince, makeContinueMessage, createBudgets, lastTurnEndEvent } = __dawnTest
const { registerWithRepair, waitForRoster } = __dawnTest
const { deriveModeDefinitions, dropEntry, CHILD_TOOLNAMES, findSpawnRow } = await import(new URL('./modes/derive.mjs', import.meta.url).href)

const results = []
function check(name, fn) {
  try { fn(); results.push('PASS ' + name) } catch (e) { results.push('FAIL ' + name + ' :: ' + e.message) }
}

check('永久错误码识别', () => {
  assert.equal(isPermanentFailure('AUTH'), true)
  assert.equal(isPermanentFailure('context_overflow'), true)
  assert.equal(isPermanentFailure('TRANSPORT'), false)
  assert.equal(isPermanentFailure(''), false)
})

check('真人消息识别（跳过插件自己发的续跑）', () => {
  const mine = makeContinueMessage('继续')
  const events = [
    { type: 'turn/end', seq: 10, data: { reason: { kind: 'error', error: { code: 'TRANSPORT' } } } },
    { type: 'user/message', seq: 11, data: { id: mine.id, role: 'user', content: [] } },
  ]
  const injected = new Set([mine.id])
  assert.equal(humanMessageSince(events, 10, injected), false, '自己的续跑不该算真人')
  assert.equal(humanMessageSince(events, 10, new Set()), true, '未登记时按真人处理（安全侧）')
  events.push({ type: 'user/message', seq: 12, data: { id: 'real-1', role: 'user', content: [] } })
  assert.equal(humanMessageSince(events, 10, injected), true, '真有真人消息时应跳过续跑')
})

check('续跑消息形态符合官方 user 消息', () => {
  const m = makeContinueMessage('继续')
  assert.equal(m.role, 'user')
  assert.equal(m.source.kind, 'user')
  assert.deepEqual(m.content, [{ type: 'text', text: '继续' }])
  assert.match(m.id, /^before-dawn-continue-/)
  assert.notEqual(makeContinueMessage('继续').id, m.id)
})

check('重试预算与去重', () => {
  const b = createBudgets()
  assert.equal(b.takeRetry('s1', '1:2:TRANSPORT', 3), true)
  assert.equal(b.takeRetry('s1', '1:2:TRANSPORT', 3), false, '同一轮同码只重试一次')
  assert.equal(b.takeRetry('s1', '1:3:TRANSPORT', 3), true)
  assert.equal(b.takeRetry('s1', '1:4:TRANSPORT', 3), true)
  assert.equal(b.takeRetry('s1', '1:5:TRANSPORT', 3), false, '达上限后不再重试')
  assert.equal(b.takeRetry('s2', '1:2:TRANSPORT', 3), true, '预算是按会话计的')
  assert.equal(b.takeRetry('s1', '1:6:TRANSPORT', 0), false, 'max=0 时不重试')
})

check('续跑预算、退票与连续失败熔断', () => {
  const b = createBudgets()
  assert.equal(b.takeContinue('s1', 100, 3), true)
  assert.equal(b.takeContinue('s1', 100, 3), false, '同一 turn/end 不重复续跑')
  assert.equal(b.takeContinue('s1', 200, 3), true)
  b.refundContinue('s1')
  assert.equal(b.takeContinue('s1', 300, 3), true)
  assert.equal(b.takeContinue('s1', 400, 3), true, '退票后额度回收，可再续跑一次')
  assert.equal(b.takeContinue('s1', 500, 3), false, '预算用尽')
  const b2 = createBudgets()
  for (let i = 0; i < 3; i += 1) { assert.equal(b2.takeContinue('s2', i + 1, 3), true); b2.refundContinue('s2') }
  assert.equal(b2.takeContinue('s2', 99, 3), false, '连续失败 3 次后熔断')
  const b3 = createBudgets()
  b3.takeContinue('s3', 5, 3)
  b3.settle('s3', { kind: 'completed' })
  assert.equal(b3.size(), 0, '正常完成后预算清零')
})

check('最后一条 turn/end 提取', () => {
  const events = [
    { type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } },
    { type: 'user/message', seq: 4, data: {} },
    { type: 'turn/end', seq: 9, data: { reason: { kind: 'max-tokens' } } },
  ]
  assert.equal(lastTurnEndEvent(events).seq, 9)
  assert.equal(lastTurnEndEvent([]), null)
})


/* ---- 模式派生（父/子预设、spawn 改写、行增删） ---- */
const baseRows = () => ([
  { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: 'old' } },
  { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web' },
  { id: 'present', name: '@deepseek-ai/dsh-present' },
  {
    id: 'delegation',
    name: 'cordis:group',
    config: [
      { id: 'tool-subagent', name: '@deepseek-ai/dsh-tool-subagent', config: { toolName: 'subagent', toolFilter: { deny: ['subagent_fork', 'workflow', 'ralph'] } } },
      { id: 'tool-subagent-fork', name: '@deepseek-ai/dsh-tool-subagent', config: { toolName: 'subagent_fork' } },
      { id: 'tool-workflow', name: '@deepseek-ai/dsh-tool-workflow' },
      { id: 'tool-ralph', name: '@deepseek-ai/dsh-tool-ralph' },
    ],
  },
])

check('派生四个预设（父/子 × 2 模式）', () => {
  assert.equal(deriveModeDefinitions(baseRows()).length, 4)
})

check('父/子预设 id、order、名字约定', () => {
  const [main, child] = deriveModeDefinitions(baseRows())
  assert.equal(main.id, 'before-dawn')
  assert.equal(child.id, 'before-dawn-child')
  assert.equal(main.order, 30)
  assert.equal(child.order, 30.1)
  assert.ok(child.name.endsWith('· 子任务'))
})

check('父预设换人设、实验室去掉 tool-web/present', () => {
  const [main, , lab] = deriveModeDefinitions(baseRows())
  assert.ok(main.plugins.find((row) => row.id === 'persona').config.prefix.includes('凌晨'))
  assert.ok(!lab.plugins.some((row) => row.id === 'tool-web' || row.id === 'present'))
})

check('spawn 行删 toolFilter 并指向子预设', () => {
  const [main] = deriveModeDefinitions(baseRows())
  const spawn = findSpawnRow(main.plugins)
  assert.equal(spawn.config.agentPreset, 'before-dawn-child')
  assert.equal(spawn.config.toolFilter, undefined)
})

check('子预设不含 subagent_fork/workflow/ralph', () => {
  const [, child] = deriveModeDefinitions(baseRows())
  const text = JSON.stringify(child.plugins)
  for (const name of CHILD_TOOLNAMES) assert.ok(!text.includes('"' + name + '"'), name)
})

check('dropEntry 摘顶层与嵌套行', () => {
  const rows = [{ id: 'a' }, { id: 'g', config: [{ id: 'x' }, { id: 'y' }] }]
  assert.equal(dropEntry(rows, 'a'), 1)
  assert.equal(dropEntry(rows, 'x'), 1)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].config.length, 1)
  assert.equal(dropEntry(rows, 'nope'), 0)
})


/* 异步用例：必须等它跑完再输出结果 */
try {
  const definition = { id: 'before-dawn', plugins: [{ id: 'persona' }, { id: 'tool-broken' }, { id: 'tool-web' }] }
  const state = { warnings: [] }
  let attempts = 0
  const registry = {
    async register(candidate) {
      attempts += 1
      if (candidate.plugins.some((row) => row.id === 'tool-broken')) {
        throw new Error('tool-broken (@deepseek-ai/dsh-tool-broken/lib/x.js): never started')
      }
      return () => {}
    },
  }
  const dispose = await registerWithRepair(registry, definition, state)
  assert.equal(typeof dispose, 'function')
  assert.equal(attempts, 2)
  assert.ok(state.warnings.some((line) => line.includes('tool-broken')))
  results.push('PASS register 失败时按 entryId 自动剔行并重试')
} catch (error) {
  results.push('FAIL register 失败时按 entryId 自动剔行并重试 :: ' + error.message)
}

/* 预设名单晚到时应当等待而不是立刻降级 */
try {
  let calls = 0
  const registry = {
    async list() {
      calls += 1
      return calls >= 3 ? [{ id: 'standard', isDefault: true }] : []
    },
  }
  const state = {}
  const { rows, attempts, waitedMs } = await waitForRoster(registry, state)
  assert.equal(rows.length, 1)
  assert.equal(attempts, 3)
  assert.ok(waitedMs >= 100, 'waitedMs=' + waitedMs)
  assert.equal(state.modeAttempts, 3)
  results.push('PASS 预设名单晚到时按退避等待并最终读到')
} catch (error) {
  results.push('FAIL 预设名单晚到时按退避等待并最终读到 :: ' + error.message)
}

/* 一直读不到时给出可读的失败原因，而不是空数组 */
try {
  const registry = { async list() { return [] } }
  const state = {}
  const { rows, attempts } = await waitForRoster(registry, state)
  assert.equal(rows.length, 0)
  assert.equal(attempts, 6, 'attempts=' + attempts)
  results.push('PASS 名单始终为空时重试到上限并如实返回空')
} catch (error) {
  results.push('FAIL 名单始终为空时重试到上限并如实返回空 :: ' + error.message)
}


/* ── 提示词清洗与插值转义（1.17.x 改为扫描式实现后新增的回归用例）───────── */
const { escapeInterpolation, sanitizePrompt } = __dawnTest
const baseCfg = { stripChatmlTags: true, escapeInterpolation: false }

check('插值转义：无 {{ 时原样返回', () => {
  assert.equal(escapeInterpolation('hello world'), 'hello world')
})

check('插值转义：{{x}} → { {x}}', () => {
  assert.equal(escapeInterpolation('a{{x}}b'), 'a{ {x}}b')
  assert.equal(escapeInterpolation('{{x}}/{{y}}'), '{ {x}}/{ {y}}')
  assert.equal(escapeInterpolation('{{{'), '{ {{')
  assert.equal(escapeInterpolation('{ {x}}'), '{ {x}}')
})

check('插值转义：空值与 null 安全', () => {
  assert.equal(escapeInterpolation(''), '')
  assert.equal(escapeInterpolation(null), '')
})

check('清洗：去 BOM / ChatML / project_instructions / CRLF', () => {
  assert.equal(sanitizePrompt('\uFEFFabc', baseCfg), 'abc')
  assert.equal(sanitizePrompt('<|im_start|>system:\n正文<|im_end|>', baseCfg), '正文')
  assert.equal(sanitizePrompt('<project_instructions>甲</project_instructions>', baseCfg), '甲')
  assert.equal(sanitizePrompt('a\r\nb', baseCfg), 'a\nb')
  assert.equal(sanitizePrompt('  \n x \n  ', baseCfg), 'x')
})

check('清洗：stripChatmlTags=false 时保留标签', () => {
  assert.equal(sanitizePrompt('<|im_end|>', { stripChatmlTags: false, escapeInterpolation: false }), '<|im_end|>')
})

check('清洗：escapeInterpolation=true 时真的转义', () => {
  assert.equal(sanitizePrompt('值 {{name}}', { stripChatmlTags: true, escapeInterpolation: true }), '值 { {name}}')
})

check('基线 JSON 能派出四个模式（离线兜底路径）', () => {
  const rows = JSON.parse(fs.readFileSync(new URL('./lib/fallback-rows.json', import.meta.url), 'utf8'))
  assert.ok(Array.isArray(rows) && rows.length >= 18, 'rows=' + rows.length)
  const defs = deriveModeDefinitions(rows)
  assert.equal(defs.length, 4)
  assert.deepEqual(defs.map((d) => d.plugins.length), [20, 20, 17, 17])
  assert.equal(defs[0].id, 'before-dawn')
  assert.equal(defs[0].order, 30)
  assert.equal(defs[1].id, 'before-dawn-child')
  assert.equal(defs[1].order, 30.1)
})

check('基线 JSON 里的人设是空的（人设只在 derive 里写）', () => {
  const rows = JSON.parse(fs.readFileSync(new URL('./lib/fallback-rows.json', import.meta.url), 'utf8'))
  const persona = rows.find((r) => r.id === 'persona')
  assert.equal(persona.config.prefix, '')
  assert.equal(persona.config.suffix, '')
})

console.log(results.join('\n'))
const failed = results.filter((row) => row.startsWith('FAIL'))
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed')
process.exit(failed.length ? 1 : 0)
