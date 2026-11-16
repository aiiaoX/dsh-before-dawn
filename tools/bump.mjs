#!/usr/bin/env node
/**
 * bump.mjs — 一条命令改版本号（package.json 是唯一来源）
 *
 * 用法：
 *   node tools/bump.mjs patch          # 1.12.0 -> 1.12.1
 *   node tools/bump.mjs minor          # 1.12.0 -> 1.13.0
 *   node tools/bump.mjs major          # 1.12.0 -> 2.0.0
 *   node tools/bump.mjs --set 1.20.3   # 直接指定
 *   node tools/bump.mjs patch --pack   # 改完顺带跑 pack.sh
 *
 * 只改 package.json 的 version，其余（README/MANIFEST）由 pack.sh 现算，避免多处不一致。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PKG = path.join(ROOT, 'package.json')
const args = process.argv.slice(2)
const wantPack = args.includes('--pack')
const setIdx = args.indexOf('--set')
const mode = setIdx >= 0 ? 'set' : (args[0] || 'patch')

const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'))
const cur = String(pkg.version || '0.0.0').split('.').map((n) => Number(n) || 0)
const [major, minor, patch] = [cur[0] || 0, cur[1] || 0, cur[2] || 0]

let next
if (mode === 'set') {
  next = String(args[setIdx + 1] || '').trim()
  if (!/^\d+\.\d+\.\d+/.test(next)) {
    console.error('版本号格式应为 x.y.z')
    process.exit(2)
  }
} else if (mode === 'major') next = `${major + 1}.0.0`
else if (mode === 'minor') next = `${major}.${minor + 1}.0`
else if (mode === 'patch') next = `${major}.${minor}.${patch + 1}`
else {
  console.error('用法: node tools/bump.mjs patch|minor|major|--set x.y.z [--pack]')
  process.exit(2)
}

pkg.version = next
fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n')
console.log(`${pkg.name}: ${cur.join('.')} -> ${next}`)

if (wantPack) {
  const r = spawnSync('bash', ['pack.sh'], { cwd: ROOT, stdio: 'inherit' })
  process.exit(r.status || 0)
}
