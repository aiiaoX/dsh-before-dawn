#!/usr/bin/env node
/**
 * 生成「凌晨」的 agent preset 声明（modes/*.json）——离线兜底。
 *
 * 运行期 index.js 会优先从宿主 agentPresets.readDocument() 读真实组合派生；
 * 只有读不到时才回落到这里生成的静态 JSON。两者走同一份 modes/derive.mjs。
 *
 * 基线数据在 lib/fallback-rows.json：标准 agent 平面的行清单（行 id / 插件名 /
 * 默认参数），JSON 结构与本项目自有注释归本项目。它不含任何外部项目的注释、
 * 人设文本或目录结构；人设一律由 derive.mjs 现场写入。
 *
 * 用法：node modes/build.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { deriveModeDefinitions } from './derive.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROWS_FILE = path.join(HERE, '..', 'lib', 'fallback-rows.json')

if (!fs.existsSync(ROWS_FILE)) {
  console.error('缺少基线行清单：' + ROWS_FILE)
  process.exit(1)
}

const rows = JSON.parse(fs.readFileSync(ROWS_FILE, 'utf8'))
if (!Array.isArray(rows) || !rows.length) {
  console.error('基线行清单为空：' + ROWS_FILE)
  process.exit(1)
}

for (const definition of deriveModeDefinitions(rows)) {
  const file = path.join(HERE, definition.id + '.json')
  fs.writeFileSync(file, JSON.stringify(definition, null, 2) + '\n', 'utf8')
  console.log(definition.id.padEnd(22) + ' rows=' + String(definition.plugins.length).padStart(2) + '  ' + path.basename(file))
}
