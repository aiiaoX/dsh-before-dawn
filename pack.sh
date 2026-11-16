#!/usr/bin/env bash
# 重新打包 凌晨（Before Dawn）：tgz（可安装/可发布）+ src.zip（可读备份）+ MANIFEST.txt（校验清单）
set -euo pipefail
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${1:-$(dirname "$SRC_DIR")/dist}"
mkdir -p "$OUT_DIR"
cd "$SRC_DIR"
NAME=$(node -p "require('./package.json').name.replace('@','').replace('/','-')")
VER=$(node -p "require('./package.json').version")
npm pack --pack-destination "$OUT_DIR" >/dev/null
TGZ="$OUT_DIR/$NAME-$VER.tgz"
ZIP="$OUT_DIR/$NAME-$VER-src.zip"
( cd "$SRC_DIR/.." && tar -a -c -f "$ZIP" \
    --exclude='*.bak' --exclude='*.bak-*' --exclude='node_modules' --exclude='.tmp*' \
    --exclude='*.tsbuildinfo' --exclude='.git' \
    "$(basename "$SRC_DIR")" )
node - "$OUT_DIR" "$TGZ" "$ZIP" <<'NODEEOF'
const fs = require('fs'), crypto = require('crypto'), path = require('path');
const [outDir, tgz, zip] = process.argv.slice(2);
const hash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const files = ['index.js','client.js','cordis.patch.yml','locale/zh.json','locale/en.json',
               'icon.svg','prompt/seed.md','compat.json','README.md','selftest.mjs','package.json',
               'modes/build.mjs','lib/fallback-rows.json','modes/before-dawn.json','modes/before-dawn-child.json',
               'modes/before-dawn-lab.json','modes/before-dawn-lab-child.json',
               'LICENSE','CHANGELOG.md','tools/README.md','tools/armor-fallback.mjs','tools/armor-doctor.mjs','tools/armor-snapshot.mjs',
               'tools/install-bundle.mjs','modes/derive.mjs','lib/automation.mjs'];
const lines = [
  '凌晨（Before Dawn）打包清单',
  '==================',
  `包名        : ${pkg.name}`,
  `版本        : ${pkg.version}`,
  `打包时间    : ${new Date().toISOString()}`,
  `tgz         : ${path.basename(tgz)}  (${fs.statSync(tgz).size} B)`,
  `tgz sha256  : ${hash(tgz)}`,
  `zip         : ${path.basename(zip)}  (${fs.statSync(zip).size} B)`,
  `zip sha256  : ${hash(zip)}`,
  '',
  '源文件 sha256:',
  ...files.filter((f) => fs.existsSync(f)).map((f) => `  ${hash(f)}  ${f}`),
  '',
  '安装（DSH 插件管理里 install_bundle，spec 用绝对路径）:',
  `  ${tgz}`,
  '',
  '卸载:',
  `  plugin_manager remove_bundle "${pkg.name}"`,
  '',
];
fs.writeFileSync(path.join(outDir, 'MANIFEST.txt'), lines.join('\n'), 'utf8');
console.log(lines.join('\n'));
NODEEOF
