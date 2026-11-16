#!/usr/bin/env node
/**
 * armor-fallback.mjs — 破甲词的"第二条通道"开关
 *
 * 原理：DSH 自带 @deepseek-ai/dsh-agent-instructions（dsh-base 默认启用），
 * 会加载 $DSH_HOME/AGENTS.md 作为用户全局指令链，每条链预算 65,536 字节。
 * 这条通道与 @aiiao/dsh-before-dawn 插件完全无关 —— 插件挂了它照样生效。
 *
 * 用法：
 *   node armor-fallback.mjs status   查看两条通道现状
 *   node armor-fallback.mjs on       把破甲词写入 $DSH_HOME/AGENTS.md（自动备份原文件）
 *   node armor-fallback.mjs off      撤掉（有备份则还原）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const BUDGET = 65536;
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const TARGET = path.join(DSH_HOME, 'AGENTS.md');
const SIDECAR = path.join(DSH_HOME, 'AGENTS.md.before-dawn.json');
const SOURCES = [
  path.join(DSH_HOME, 'before-dawn', 'inject.md'),
  path.join(DSH_HOME, 'prompt-inject.md'),
  path.join(PKG_ROOT, 'prompt', 'seed.md'),
];

function sanitize(text) {
  let out = String(text || '');
  if (out.charCodeAt(0) === 0xfeff) out = out.slice(1);
  out = out.replace(/\r\n?/g, '\n');
  out = out.replace(/^\s*<\|im_start\|>\s*system\s*:\s*/i, '');
  out = out.replace(/<\/?project_instructions>/gi, '');
  out = out.replace(/<\|im_end\|>/g, '');
  return out.trim();
}

function sha12(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
}

function pickSource() {
  for (const p of SOURCES) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function lines(a) { return a.map((s) => (s === '' ? '' : '  ' + s)).join('\n'); }

const cmd = (process.argv[2] || 'status').toLowerCase();

if (cmd === 'status') {
  const src = pickSource();
  const onTarget = fs.existsSync(TARGET);
  const side = readJson(SIDECAR);
  console.log('破甲词备用通道（$DSH_HOME/AGENTS.md）');
  console.log(`  DSH_HOME        : ${DSH_HOME}`);
  console.log(`  破甲词源文件    : ${src ? `${src} (${fs.statSync(src).size} B)` : '未找到'}`);
  console.log(`  AGENTS.md       : ${onTarget ? `${TARGET} (${fs.statSync(TARGET).size} B, sha ${sha12(fs.readFileSync(TARGET))})` : '不存在（通道未启用）'}`);
  console.log(`  由本工具写入    : ${side ? `是，${side.at}，源 ${side.source}` : '否'}`);
  console.log(`  字节预算        : ${BUDGET} B，剩余 ${onTarget ? BUDGET - fs.statSync(TARGET).size : BUDGET} B`);
  console.log('');
  console.log(onTarget ? '状态：备用通道【已启用】—— 插件失效时破甲词仍会进上下文。' : '状态：备用通道【关闭】—— 需要时执行 `node armor-fallback.mjs on`。');
  process.exit(0);
}

if (cmd === 'on') {
  const src = pickSource();
  if (!src) {
    console.error('找不到破甲词源文件。请确认 $DSH_HOME/before-dawn/inject.md 存在。');
    process.exit(1);
  }
  const body = sanitize(fs.readFileSync(src, 'utf8'));
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > BUDGET) {
    console.error(`破甲词 ${bytes} B 超过单链预算 ${BUDGET} B，写入会被宿主截断，已中止。`);
    process.exit(1);
  }
  let backup = null;
  if (fs.existsSync(TARGET)) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    backup = `${TARGET}.bak-${stamp}`;
    fs.copyFileSync(TARGET, backup);
  }
  fs.writeFileSync(TARGET, body, 'utf8');
  fs.writeFileSync(SIDECAR, JSON.stringify({ source: src, bytes, sha: sha12(Buffer.from(body)), at: new Date().toISOString() }, null, 2), 'utf8');
  console.log('备用通道已启用');
  console.log(`  写入: ${TARGET} (${bytes} B, 预算余 ${BUDGET - bytes} B)`);
  if (backup) console.log(`  原文件已备份: ${backup}`);
  console.log('  注意：插件同时生效时同一份词会进两次上下文；插件正常时建议 off。');
  process.exit(0);
}

if (cmd === 'off') {
  const side = readJson(SIDECAR);
  if (!fs.existsSync(TARGET)) {
    console.log('AGENTS.md 不存在，无需撤销。');
    try { fs.unlinkSync(SIDECAR); } catch {}
    process.exit(0);
  }
  if (!side) {
    console.error('AGENTS.md 不是本工具写入的（没有 sidecar 记录），为安全起见不删除。');
    process.exit(1);
  }
  const baks = fs.readdirSync(DSH_HOME).filter((n) => n.startsWith('AGENTS.md.bak-')).sort();
  const last = baks.length ? path.join(DSH_HOME, baks[baks.length - 1]) : null;
  if (last) {
    fs.copyFileSync(last, TARGET);
    console.log(`已还原原 AGENTS.md（来自 ${path.basename(last)}）`);
  } else {
    fs.unlinkSync(TARGET);
    console.log('已删除 AGENTS.md（此前没有备份）');
  }
  try { fs.unlinkSync(SIDECAR); } catch {}
  process.exit(0);
}

console.log('用法: node armor-fallback.mjs [status|on|off]');
process.exit(2);
