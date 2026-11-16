#!/usr/bin/env node
/**
 * armor-doctor.mjs — 升级后 60 秒体检
 *
 * 用法：
 *   node armor-doctor.mjs                自动探测 127.0.0.1 上的 DSH Web 端口
 *   node armor-doctor.mjs --port 57470   指定端口
 *   node armor-doctor.mjs --json         机器可读输出
 *
 * 退出码：0 = 全部通过 / 仅警告；1 = 有失败项
 */
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const portArg = (() => {
  const i = args.indexOf('--port');
  return i >= 0 ? Number(args[i + 1]) : null;
})();

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PROFILE_NAME = process.env.DSH_PROFILE_NAME || 'desktop';
const PROFILE = path.join(DSH_HOME, 'profiles', PROFILE_NAME);
const APP_DIR = detectAppDir();

function detectPnpm(hint) {
  if (process.env.DSH_PNPM) return process.env.DSH_PNPM
  const base = path.join(hint || APP_DIR, '..')
  const cands = [
    path.join(base, 'runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs'),
    path.join(base, 'runtime/dependencies/pnpm/bin/pnpm.mjs'),
    path.join(APP_DIR, 'node_modules/pnpm/bin/pnpm.mjs'),
  ]
  return cands.find((p) => fs.existsSync(p)) || cands[0]
}

function detectAppDir() {
  if (process.env.DSH_APP_DIR) return process.env.DSH_APP_DIR
  const home = os.homedir()
  const cands = [
    path.join(home, 'DSH/resources/app'),
    'C:/Program Files/DeepSeek Harness/resources/app',
    path.join(process.env.LOCALAPPDATA || '', 'Programs/DeepSeek Harness/resources/app'),
    '/Applications/DeepSeek Harness.app/Contents/Resources/app',
    '/opt/DeepSeek Harness/resources/app',
  ]
  return cands.find((p) => p && fs.existsSync(p)) || cands[0]
}
const ROUTE = '/before-dawn/status/json';
const ENGINE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const results = [];
const add = (level, name, detail) => results.push({ level, name, detail });

function sha12File(p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 12); } catch { return null; }
}
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

// ---- 1. 破甲词文件
const promptPath = path.join(DSH_HOME, 'before-dawn', 'inject.md');
if (fs.existsSync(promptPath)) {
  const st = fs.statSync(promptPath);
  add('ok', '破甲词文件', `${promptPath} ${st.size} B（原文）· raw sha ${sha12File(promptPath)}`);
} else {
  add('fail', '破甲词文件', `缺失：${promptPath}（插件会回退到包内 seed.md）`);
}

// ---- 2. 用户设置
const settingsPath = path.join(DSH_HOME, 'before-dawn', 'settings.json');
const settings = readJson(settingsPath);
add(settings ? 'ok' : 'warn', '用户设置', settings ? `${settingsPath} ${JSON.stringify(settings)}` : `缺失或不可解析：${settingsPath}`);

// ---- 3. profile 依赖与 bundle 列表
const pkgPath = path.join(PROFILE, 'package.json');
const pkg = readJson(pkgPath);
if (!pkg) {
  add('fail', 'profile package.json', `不可读：${pkgPath}`);
} else {
  const dep = (pkg.dependencies || {})['@aiiao/dsh-before-dawn'];
  const bundles = ((pkg.dsh || {}).profile || {}).bundles || [];
  add(dep ? 'ok' : 'fail', '依赖声明', dep ? `@aiiao/dsh-before-dawn → ${dep}` : '依赖里没有 @aiiao/dsh-before-dawn');
  add(bundles.includes('@aiiao/dsh-before-dawn') ? 'ok' : 'fail', 'bundle 列表', bundles.includes('@aiiao/dsh-before-dawn') ? `已登记（共 ${bundles.length} 项）` : `未登记（共 ${bundles.length} 项）`);
}

// ---- 4. 包体是否真实存在
const entry = path.join(PROFILE, 'node_modules', '@aiiao', 'dsh-before-dawn');
for (const f of ['index.js', 'client.js', 'cordis.patch.yml', 'package.json']) {
  const p = path.join(entry, f);
  add(fs.existsSync(p) ? 'ok' : 'fail', `包内 ${f}`, fs.existsSync(p) ? p : `缺失：${p}`);
}
const entryPkg = readJson(path.join(entry, 'package.json'));
if (entryPkg) add('ok', '包版本', `${entryPkg.name} ${entryPkg.version}`);

// ---- 5. 宿主版本
const appPkg = readJson(APP_DIR + '/package.json');
add('ok', 'DSH 版本(app)', appPkg ? `${appPkg.version}（${APP_DIR}/package.json）` : '宿主为 asar 形态（未解包），版本见下方状态接口');

function whichPnpm() {
  const cmd = process.platform === 'win32' ? 'where pnpm' : 'command -v pnpm'
  try {
    const out = execSync(cmd, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
    const hit = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && fs.existsSync(l))
    return hit[0] || null
  } catch {
    return null
  }
}

function appDirFromStatus(status) {
  const src = status && status.runtime && status.runtime.source;
  if (!src) return null;
  const i = src.toLowerCase().indexOf('app.asar');
  if (i > 0) return path.join(src.slice(0, i) + 'app');
  const j = src.toLowerCase().indexOf(path.sep + 'resources' + path.sep);
  if (j > 0) return path.join(src.slice(0, j), 'resources', 'app');
  return null;
}

function checkInstallChain(appDirHint) {
  const hint = appDirHint || APP_DIR
  const pnpmCandidates = [
    process.env.DSH_PNPM,
    path.join(hint, '..', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'),
    path.join(hint, '..', 'runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'),
    path.join(hint, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
    detectPnpm(hint),
    whichPnpm(),
  ].filter(Boolean)
  const pnpm = pnpmCandidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } })
  add(pnpm ? 'ok' : 'warn', 'pnpm 运行时', pnpm ? pnpm : '缺失：插件管理器的 install/remove 会失败（可先用 tools/install-bundle.mjs 兜底）')

  if (pkg && pkg.dependencies) {
    const broken = []
    for (const [name, spec] of Object.entries(pkg.dependencies)) {
      if (typeof spec !== 'string') continue
      if (spec.startsWith('file:') || spec.startsWith('link:')) {
        const target = spec.slice(5)
        if (!fs.existsSync(target)) broken.push(name + ' → ' + target)
      }
    }
    add(broken.length ? 'fail' : 'ok', '依赖可解析', broken.length ? '指向不存在的路径：' + broken.join('；') : '全部 file:/link: 依赖都指向存在的路径')
  }

  const entryLink = path.join(PROFILE, 'node_modules', '@aiiao', 'dsh-before-dawn')
  let entryReal = null
  try { entryReal = fs.realpathSync(entryLink) } catch { entryReal = null }
  add(entryReal ? 'ok' : 'fail', 'node_modules 链接', entryReal ? entryReal : '缺失：' + entryLink)

  const installer = path.join(ENGINE_DIR, 'tools', 'install-bundle.mjs')
  add('ok', '兜底安装器', installer)
}

// ---- 6. 备用通道
const agentsMd = path.join(DSH_HOME, 'AGENTS.md');
add('ok', '备用注入通道', fs.existsSync(agentsMd) ? `已启用 ${agentsMd} (${fs.statSync(agentsMd).size} B)` : '关闭（备用通道未启用，插件正常时属正常状态，不算异常）');

// ---- 7. 运行期状态接口
function get(port, route, timeout = 800) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: route, timeout, headers: { connection: 'close' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function candidatePorts() {
  if (portArg) return [portArg];
  const fromEnv = Number(process.env.DSH_PORT || process.env.DSH_WEB_PORT || 0);
  const list = [];
  if (fromEnv) list.push(fromEnv);
  try {
    const out = execSync('netstat -ano -p TCP', { encoding: 'utf8', timeout: 4000 });
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/127\.0\.0\.1:(\d{4,5})\s+\S+\s+LISTENING/i);
      if (m) list.push(Number(m[1]));
    }
  } catch {}
  return [...new Set(list)];
}

const ports = candidatePorts();
let status = null;
let hitPort = null;
for (const p of ports) {
  const res = await get(p, ROUTE, 1800);
  if (!res || res.status !== 200) continue;
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch { continue; }
  // 只接受本插件的状态体，避免误认到别的本地服务
  if (!parsed || (parsed.plugin !== '@aiiao/dsh-before-dawn' && !Array.isArray(parsed.sections))) continue;
  status = parsed; hitPort = p; break;
}

if (!status) {
  add('warn', '状态接口', `未能连上（已探测 ${ports.length} 个端口）。若 DSH 未运行，属正常；也可用 --port 指定。`);
} else {
  add('ok', '状态接口', `http://127.0.0.1:${hitPort}${ROUTE}`);
  add(status.enabled ? 'ok' : 'warn', '插件开关', `enabled=${status.enabled}`);
  const chars = status.assembly && status.assembly.chars;
  const dup = (status.assembly && status.assembly.duplicate) || [];
  if (status.assembly && status.assembly.available === false) {
    add('fail', '系统提示注入', `组装失败：${status.assembly.error || '未知'}`);
  } else if (chars >= 20000) {
    add('ok', '系统提示注入', `${chars} 字符 / ${status.assembly.total} 段 / 重复段 ${dup.length}`);
  } else if (chars > 0) {
    add('warn', '系统提示注入', `仅 ${chars} 字符（可能被别的插件裁剪）`);
  } else {
    add('fail', '系统提示注入', '0 字符 —— 破甲词没有进系统提示');
  }
  if (dup.length) add('warn', '重复注入', `这些段也带着同一份文本：${dup.join(', ')}`);
  const perms = status.permissions || {};
  add(perms.pinFullAccess ? 'ok' : 'warn', '权限钉住', `pin=${perms.pinFullAccess} preset=${perms.preset} 已钉 ${perms.pinned}`);
  const modes = status.modes || [];
  const bad = modes.filter((m) => !m.ok);
  add(bad.length === 0 && modes.length > 0 ? 'ok' : modes.length ? 'warn' : 'warn', '工作模式', modes.length ? `${modes.length - bad.length}/${modes.length} 正常${bad.length ? '，失败：' + bad.map((m) => `${m.id}(${m.error})`).join(', ') : ''}` : '未注册');
  const caps = status.caps || {};
  const capBad = Object.entries(caps).filter(([, v]) => v === false).map(([k]) => k);
  const capTotal = Object.keys(caps).length;
  add(capBad.length ? 'warn' : capTotal ? 'ok' : 'warn', '扩展点', capTotal ? `${capTotal - capBad.length}/${capTotal} 可用${capBad.length ? '，缺失：' + capBad.join(', ') : ''}` : '状态里没有 caps 字段');
  const w = status.warnings || [];
  add(w.length ? 'warn' : 'ok', '插件警告', w.length ? w.join(' | ') : '无');
}

const RESOLVED_APP_DIR = appDirFromStatus(status) || APP_DIR;
if (status && status.runtime && status.runtime.source && RESOLVED_APP_DIR) {
  add('ok', '宿主目录', RESOLVED_APP_DIR);
}

// ---- 5.5 安装链环境（放到状态解析之后，才能推出真实的 app 目录）
checkInstallChain(RESOLVED_APP_DIR);

// ---- 输出
const order = { fail: 0, warn: 1, ok: 2 };
results.sort((a, b) => order[a.level] - order[b.level]);
const hardest = results.some((r) => r.level === 'fail') ? 'FAIL' : results.some((r) => r.level === 'warn') ? 'WARN' : 'PASS';

if (asJson) {
  console.log(JSON.stringify({ verdict: hardest, at: new Date().toISOString(), port: hitPort, checks: results }, null, 2));
} else {
  const icon = { ok: '✓', warn: '!', fail: '✗' };
  console.log(`凌晨插件体检  ${new Date().toLocaleString('zh-CN', { hour12: false })}`);
  console.log('─'.repeat(64));
  for (const r of results) console.log(`${icon[r.level]} ${r.name.padEnd(14, ' ')} ${r.detail}`);
  console.log('─'.repeat(64));
  const tips = [];
  if (hardest === 'FAIL') {
    tips.push('有失败项：先看「破甲词文件 / 依赖声明 / bundle 列表」是否被升级重置；插件失效时先跑 `node armor-fallback.mjs on` 用备用通道顶上。');
  } else if (hardest === 'WARN') {
    tips.push('有警告项：常见于模式需要重建、状态接口未连上、依赖缺件；备用注入通道关闭不算异常。');
  } else {
    tips.push('全部通过：破甲词注入、权限钉住、工作模式、扩展点都正常。');
  }
  if (results.some((r) => r.name === '工作模式' && /失败/.test(r.detail))) tips.push('模式失败时重生成：`node modes/build.mjs`，然后停用→启用插件一次。');
  console.log(tips.join('\n'));
}
process.exit(hardest === 'FAIL' ? 1 : 0);
