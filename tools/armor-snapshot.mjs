#!/usr/bin/env node
/**
 * armor-snapshot.mjs — 把"当前可用状态"打包成一个 zip，升级/翻车时解压即用
 *
 * 用法：node armor-snapshot.mjs [--out <输出目录>]（默认：包旁的 dist/）
 * 产物：armor-snapshot-<时间戳>.zip（含插件包、破甲词、设置、profile 声明、版本清单、RESTORE.md）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const NEAR_DIST = path.join(PKG_ROOT, '..', 'dist');

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT = outIdx >= 0 ? args[outIdx + 1] : (fs.existsSync(NEAR_DIST) ? NEAR_DIST : path.join(process.cwd(), 'dist'));
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PROFILE = path.join(DSH_HOME, 'profiles', process.env.DSH_PROFILE_NAME || 'desktop');
const APP_DIR = detectAppDir();

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
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const work = path.join(os.tmpdir(), 'armor-snapshot-' + stamp);
const zip = path.join(OUT, `armor-snapshot-${stamp}.zip`);

const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null);
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const put = (src, dstName) => {
  if (!fs.existsSync(src)) return null;
  const dst = path.join(work, dstName);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return { name: dstName, bytes: fs.statSync(dst).size, sha256: sha(dst) };
};

fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

// 1. 最新的插件包
const distDir = fs.existsSync(NEAR_DIST) ? NEAR_DIST : OUT;
let tgz = null;
if (fs.existsSync(distDir)) {
  const cands = fs.readdirSync(distDir)
    .filter((n) => /^aiiao-dsh-before-dawn-\d+\.\d+\.\d+\.tgz$/.test(n))
    .map((n) => ({ n, m: fs.statSync(path.join(distDir, n)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (cands.length) tgz = path.join(distDir, cands[0].n);
}

const files = [];
files.push(put(tgz, `plugin/${tgz ? path.basename(tgz) : 'none.tgz'}`));
files.push(put(path.join(DSH_HOME, 'before-dawn', 'inject.md'), 'prompt/inject.md'));
files.push(put(path.join(DSH_HOME, 'before-dawn', 'settings.json'), 'prompt/settings.json'));
files.push(put(path.join(PROFILE, 'package.json'), 'profile/package.json'));
files.push(put(path.join(PROFILE, 'cordis.patch.yml'), 'profile/cordis.patch.yml'));
files.push(put(APP_DIR + '/package.json', 'host/app-package.json'));
files.push(put(APP_DIR + '/dsh/package.json', 'host/runtime-package.json'));

const hostApp = readJson(APP_DIR + '/package.json') || {};
const runtime = readJson(APP_DIR + '/dsh/package.json') || {};
const pluginPkg = readJson(path.join(PKG_ROOT, 'package.json')) || {};
const deps = (runtime.dependencies || {})['@deepseek-ai/cordis'] || (runtime.devDependencies || {})['@deepseek-ai/cordis'] || '?';

const manifest = {
  kind: 'before-dawn snapshot',
  at: new Date().toISOString(),
  host: { version: hostApp.version || runtime.version || '?', runtime: runtime.name || '?' },
  cordis: deps,
  plugin: { name: pluginPkg.name || '?', version: pluginPkg.version || '?' },
  files: files.filter(Boolean),
};
fs.writeFileSync(path.join(work, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

const restore = `# 凌晨插件快照恢复说明

快照时间：${manifest.at}
宿主版本：${manifest.host.version}（cordis ${manifest.cordis}）
插件版本：${manifest.plugin.name} ${manifest.plugin.version}

## 这个快照里有什么

- \`plugin/\` —— 可安装的插件包（tgz）
- \`prompt/inject.md\` —— 破甲词本体（25 KB，你的资产，任何版本都能用）
- \`prompt/settings.json\` —— 徽标位置等偏好
- \`profile/package.json\` / \`profile/cordis.patch.yml\` —— 出事前的 profile 声明（对照用）
- \`host/\` —— 当时的 DSH 版本记录
- \`manifest.json\` —— 逐文件 sha256

## 恢复步骤（任选其一）

### A. 只接回破甲词（不装插件，30 秒）
\`\`\`bash
node tools/armor-fallback.mjs on
\`\`\`
它把 \`prompt/inject.md\` 写进 \`$DSH_HOME/AGENTS.md\`，走宿主自带的
\`@deepseek-ai/dsh-agent-instructions\`（预算 65,536 字节），与插件版本无关。

### B. 重装插件
\`\`\`text
plugin_manager install_bundle  target = <解压出来的 plugin/*.tgz 所在目录或 tgz 路径>
\`\`\`
或在会话里：\`/dawn doctor\` 看体检结果。

### C. 恢复偏好
把 \`prompt/settings.json\` 复制回 \`$DSH_HOME/before-dawn/settings.json\`。

## 体检
\`\`\`bash
node tools/armor-doctor.mjs
\`\`\`
关注四行：系统提示注入（≈20926 字符）、权限钉住、工作模式（4/4）、扩展点（10/10）。
`;
fs.writeFileSync(path.join(work, 'RESTORE.md'), restore, 'utf8');

// 打 zip（Windows 下用 bsdtar）
execSync(`tar -a -c -f "${zip}" -C "${work}" .`, { stdio: 'inherit' });
const size = fs.statSync(zip).size;
const list = execSync(`tar -tf "${zip}"`, { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);

console.log('快照已生成');
console.log(`  文件: ${zip}`);
console.log(`  大小: ${size} B，条目 ${list.length} 个`);
console.log(`  sha256: ${sha(zip)}`);
console.log(`  插件包: ${tgz ? path.basename(tgz) : '未找到'}`);
console.log(`  宿主: ${manifest.host.version} / 插件 ${manifest.plugin.version}`);
console.log('内容:');
for (const f of manifest.files) console.log(`  - ${f.name}  ${f.bytes} B`);
console.log('  - manifest.json / RESTORE.md');
fs.rmSync(work, { recursive: true, force: true });
