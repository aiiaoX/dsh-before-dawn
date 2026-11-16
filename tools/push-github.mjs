#!/usr/bin/env node
/**
 * 一条命令把本仓库发到 GitHub（默认私有）。
 *
 *   set GITHUB_TOKEN=ghp_xxx        （PowerShell: $env:GITHUB_TOKEN="ghp_xxx"）
 *   node tools/push-github.mjs
 *
 * 可选：
 *   --repo <name>      仓库名，默认取 package.json 的 name 去掉 scope
 *   --public           发成公开仓库（默认 private）
 *   --no-release       不创建 Release
 *   --tag <vX.Y.Z>     指定 tag，默认取 package.json 的 version
 *   --remote <url>     已存在的仓库：跳过创建，直接推到这个地址
 *
 * 需要的 token 权限：fine-grained 勾 "Administration: Read and write" +
 * "Contents: Read and write"；classic 勾 repo。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name)
  if (i < 0) return fallback
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : true
}
const has = (name) => process.argv.includes('--' + name)

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
if (!token) {
  console.error('缺少 GITHUB_TOKEN / GH_TOKEN 环境变量。')
  console.error('  生成：https://github.com/settings/tokens  （classic 勾 repo，或 fine-grained 勾 Contents + Administration 读写）')
  console.error('  然后：set GITHUB_TOKEN=ghp_xxx  再跑 node tools/push-github.mjs')
  process.exit(2)
}

const repoName = String(arg('repo', pkg.name.split('/').pop()))
const isPublic = has('public')
const tag = String(arg('tag', 'v' + pkg.version))
const skipRelease = has('no-release')
const remoteArg = arg('remote', null)

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts })
const runOut = (cmd, args) =>
  execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8' }).trim()

async function api(url, init = {}) {
  const res = await fetch('https://api.github.com' + url, {
    ...init,
    headers: {
      authorization: 'Bearer ' + token,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
      'user-agent': 'dsh-before-dawn-publisher',
      ...(init.headers || {}),
    },
  })
  const text = await res.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: res.status, body }
}

const me = await api('/user')
if (me.status !== 200) {
  console.error('token 无效或没权限：', me.status, typeof me.body === 'string' ? me.body : me.body?.message)
  process.exit(1)
}
const owner = me.body.login
console.log('账号:', owner)

let remote = remoteArg
if (!remote) {
  const full = `${owner}/${repoName}`
  const probe = await api('/repos/' + full)
  if (probe.status === 404) {
    const created = await api('/user/repos', {
      method: 'POST',
      body: JSON.stringify({
        name: repoName,
        private: !isPublic,
        description: pkg.description,
        has_issues: true,
        has_wiki: false,
        has_projects: false,
      }),
    })
    if (created.status >= 300) {
      console.error('创建仓库失败：', created.status, created.body?.message || created.body)
      process.exit(1)
    }
    console.log('已创建', isPublic ? '公开' : '私有', '仓库:', created.body.html_url)
  } else if (probe.status === 200) {
    console.log('仓库已存在:', probe.body.html_url)
  } else {
    console.error('查询仓库失败：', probe.status, probe.body?.message || probe.body)
    process.exit(1)
  }
  remote = `https://github.com/${full}.git`
}

// 推送：把 token 放进 URL，避免交互提示；推完把 remote 换成干净地址
const authed = remote.replace('https://', `https://x-access-token:${token}@`)
try {
  run('git', ['remote', 'remove', 'origin'], { stdio: 'ignore' })
} catch {}
run('git', ['remote', 'add', 'origin', authed])
run('git', ['push', '-u', 'origin', 'HEAD:refs/heads/main', '--force'])
run('git', ['push', 'origin', tag, '--force'])
run('git', ['remote', 'set-url', 'origin', remote])
console.log('已推送分支 main 与 tag', tag)
console.log('仓库地址:', remote.replace(/\.git$/, ''))

if (!skipRelease) {
  const tgz = path.join(path.dirname(ROOT), 'dist', `aiiao-dsh-before-dawn-${pkg.version}.tgz`)
  if (!fs.existsSync(tgz)) {
    console.log('跳过 Release：没找到', tgz)
  } else {
    const rel = await api(`/repos/${owner}/${repoName}/releases`, {
      method: 'POST',
      body: JSON.stringify({
        tag_name: tag,
        name: 'v' + pkg.version,
        body: '安装包见下方附件；或直接 `plugin_manager install_bundle` 指向仓库目录。',
        draft: false,
        prerelease: false,
      }),
    })
    if (rel.status >= 300) {
      console.log('创建 Release 失败（可稍后网页手动建）：', rel.status, rel.body?.message || rel.body)
    } else {
      const uploadUrl = rel.body.upload_url.replace(/\{.*$/, '')
      const bytes = fs.readFileSync(tgz)
      const up = await fetch(`${uploadUrl}?name=${encodeURIComponent(path.basename(tgz))}`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + token,
          'content-type': 'application/octet-stream',
          'content-length': String(bytes.length),
          'user-agent': 'dsh-before-dawn-publisher',
        },
        body: bytes,
      })
      console.log(up.ok ? 'Release 已创建并上传安装包' : 'Release 已创建，但附件上传失败：' + up.status)
    }
  }
}

console.log('完成。私有仓库里只有你自己能看到。')
