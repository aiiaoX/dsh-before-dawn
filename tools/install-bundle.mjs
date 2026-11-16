#!/usr/bin/env node
/**
 * 兜底安装器：插件管理器坏掉（缺 pnpm / remove_bundle 半途失败）时，用纯 node + fs
 * 把「凌晨」装回 profile，不依赖 pnpm 也能让插件先跑起来。
 *
 * 用法：
 *   node tools/install-bundle.mjs                     # 用当前脚本所在包目录
 *   node tools/install-bundle.mjs --pkg <dir|tgz>     # 指定包目录或 tgz
 *   node tools/install-bundle.mjs --profile desktop   # 默认 desktop
 *   node tools/install-bundle.mjs --dry-run --json
 *
 * 做的事：写 profile/package.json 依赖 + dsh.profile.bundles、在 node_modules 建链接，
 * 若恰好有 pnpm 就再跑一次 install 收敛 lock（没有就跳过并说明）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.dirname(HERE)

function detectAppDir() {
  if (process.env.DSH_APP_DIR) return process.env.DSH_APP_DIR
  const cands = [
    path.join(os.homedir(), '.local/share/deepseek-harness/resources/app'),
    'C:/Program Files/DeepSeek Harness/resources/app',
    path.join(process.env.LOCALAPPDATA || '', 'Programs/DeepSeek Harness/resources/app'),
    '/Applications/DeepSeek Harness.app/Contents/Resources/app',
  ]
  return cands.find((p) => p && fs.existsSync(p)) || cands[0]
}

const APP_DIR = detectAppDir()

function detectPnpm() {
  if (process.env.DSH_PNPM) return process.env.DSH_PNPM
  const base = path.join(APP_DIR, '..')
  const cands = [
    path.join(base, 'runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs'),
    path.join(base, 'runtime/dependencies/pnpm/bin/pnpm.mjs'),
    path.join(APP_DIR, 'node_modules/pnpm/bin/pnpm.mjs'),
  ]
  return cands.find((p) => fs.existsSync(p)) || cands[0]
}

function parseArgs(argv) {
  const out = { pkg: PKG_ROOT, profile: process.env.DSH_PROFILE_NAME || 'desktop', dryRun: false, json: false, bundle: true }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--pkg') out.pkg = argv[++i]
    else if (arg === '--profile') out.profile = argv[++i]
    else if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--json') out.json = true
    else if (arg === '--no-bundle') out.bundle = false
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PROFILE = path.join(DSH_HOME, 'profiles', args.profile)
const log = []
const note = (message) => { log.push(message) }

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }

function readPkg() {
  const stat = fs.statSync(args.pkg)
  if (stat.isDirectory()) {
    const pkg = readJson(path.join(args.pkg, 'package.json'))
    if (!pkg) throw new Error('目录里没有 package.json: ' + args.pkg)
    return { pkg, dir: args.pkg, spec: 'link:' + args.pkg.replace(/\\/g, '/') }
  }
  const text = execFileSync('tar', ['-xzOf', args.pkg, 'package/package.json'], { encoding: 'utf8' })
  return { pkg: JSON.parse(text), dir: null, spec: 'file:' + args.pkg.replace(/\\/g, '/') }
}

function findPnpm() {
  const candidates = [
    process.env.DSH_PNPM,
    path.join(path.dirname(process.execPath), 'resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'),
    detectPnpm(),
  ].filter(Boolean)
  for (const candidate of candidates) if (candidate && fs.existsSync(candidate)) return candidate
  return null
}

function main() {
  if (!fs.existsSync(PROFILE)) throw new Error('找不到 profile 目录: ' + PROFILE)
  const pkgFile = path.join(PROFILE, 'package.json')
  const profilePkg = readJson(pkgFile)
  if (!profilePkg) throw new Error('profile package.json 读不出来: ' + pkgFile)

  const { pkg, dir, spec } = readPkg()
  const name = pkg.name
  if (typeof name !== 'string' || !name.includes('/')) throw new Error('包名不合法: ' + name)

  const deps = { ...(profilePkg.dependencies || {}) }
  const before = deps[name]
  deps[name] = spec
  profilePkg.dependencies = deps

  const dsh = { ...(profilePkg.dsh || {}) }
  const profile = { ...(dsh.profile || {}) }
  const bundles = Array.isArray(profile.bundles) ? [...profile.bundles] : []
  let bundleAdded = false
  if (args.bundle && !bundles.includes(name)) { bundles.push(name); bundleAdded = true }
  profile.bundles = bundles
  dsh.profile = profile
  profilePkg.dsh = dsh

  note('依赖: ' + name + ' ' + (before ? before + ' -> ' : '') + spec)
  note('bundles: ' + bundles.length + ' 项' + (bundleAdded ? '（新增 ' + name + '）' : '（已存在）'))

  if (args.dryRun) {
    note('dry-run：未写盘')
  } else {
    fs.writeFileSync(pkgFile, JSON.stringify(profilePkg, null, 2) + '\n', 'utf8')
    const scopeDir = path.join(PROFILE, 'node_modules', ...name.split('/').slice(0, -1))
    const linkPath = path.join(PROFILE, 'node_modules', name)
    fs.mkdirSync(scopeDir, { recursive: true })
    let mode = 'kept'
    if (dir) {
      const target = fs.realpathSync(dir)
      if (fs.existsSync(linkPath)) {
        const resolved = (() => { try { return fs.realpathSync(linkPath) } catch { return null } })()
        if (resolved !== target) { fs.rmSync(linkPath, { recursive: true, force: true }) }
        else mode = 'unchanged'
      }
      if (!fs.existsSync(linkPath)) {
        try { fs.symlinkSync(target, linkPath, 'junction'); mode = 'junction' } catch (error) { note('链接失败: ' + error.message) }
      }
    } else {
      fs.rmSync(linkPath, { recursive: true, force: true })
      execFileSync('tar', ['-xzf', args.pkg, '-C', PROFILE, '--strip-components=1', '--exclude=package/package.json'], { stdio: 'inherit' })
      mode = 'extracted'
    }
    note('node_modules: ' + mode + '  ' + linkPath)

    const pnpm = findPnpm()
    if (pnpm) {
      try {
        execFileSync(process.execPath, [pnpm, 'install', '--prefer-offline'], { cwd: PROFILE, stdio: 'inherit' })
        note('pnpm install: ok (' + pnpm + ')')
      } catch (error) {
        note('pnpm install 失败（可忽略，插件已可直接加载）: ' + String(error.message || error).slice(0, 200))
      }
    } else {
      note('本机没有 pnpm：已跳过 install，依赖 lock 可能与 package.json 不一致（不影响加载）')
    }
  }

  /* 收尾校验 */
  const entry = path.join(PROFILE, 'node_modules', name, 'package.json')
  const installed = readJson(entry)
  note(installed ? '校验: node_modules 里可读到 ' + installed.name + '@' + installed.version + ' → ' + entry : '校验: node_modules 里读不到 ' + entry)

  const payload = {
    ok: Boolean(installed),
    profile: PROFILE,
    package: name,
    version: installed ? installed.version : null,
    spec,
    bundleAdded,
    log,
  }
  if (args.json) console.log(JSON.stringify(payload, null, 2))
  else console.log(payload.log.join('\n'))
  process.exit(payload.ok ? 0 : 1)
}

try { main() } catch (error) {
  const payload = { ok: false, error: String(error?.message || error), log }
  if (args.json) console.log(JSON.stringify(payload, null, 2))
  else { console.error(String(error?.message || error)); if (log.length) console.error(log.join('\n')) }
  process.exit(1)
}
