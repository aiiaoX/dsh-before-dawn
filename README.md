# 凌晨 · Before Dawn

把操作者提示词注入每个会话，为新会话钉住全权限，回合异常时自动重试与续跑，并提供四个 agent preset 工作模式与能力自检。全部实现走 Cordis 官方扩展点。

当前版本 **1.0.0**，实测适配 DSH `0.2.2-rc.3`（rc.1 / rc.2 同样可用）。插件管理页可编辑 **19 项**配置。

## 它做什么

| 能力 | 做法 | 你看到的效果 |
| --- | --- | --- |
| 提示词注入 | `systemPrompt.section()` 注册 `before-dawn` 段，文本实时读盘 | 每次组装系统提示都带上破甲词；改文件即热生效 |
| 权限钉住 | `permissionPresets.set(session, 'danger-full-access')` | 新会话开局就是沙箱全权限 + 审批 never，不用手动切 |
| 自动重试 / 续跑 | `agent/request-error`（waterfall）、`agent/status`（emit） | 请求失败自动重来；回合异常结束自动发「继续」 |
| 工作模式 | `agentPresets.register()` 注册四个 preset | 新会话的模式下拉里出现「凌晨模式 / 凌晨 · 实验室」及其子任务版 |
| 观测 | `dawn_*` 工具、`/dawn` 命令、HTTP 状态接口 | 随时看注入字符数、权限、模式、扩展点是否还在 |

## 安装

在插件管理里安装本目录，或：

```
plugin_manager install_bundle  target = <本目录绝对路径>
```

- **客户端半身在页面加载时取**：装完或改了 `client.js` 要刷新页面；只改 `index.js` 用插件开关 toggle 一次即可。
- 安装后三处确认：插件列表里 `@aiiao/dsh-before-dawn` 为「运行中」；徽标出现在左侧栏底部；`/dawn status` 能出报告。

### 前置要求

- DSH 0.2.x（0.2.2-rc.1 / rc.2 / rc.3 实测；更早版本按能力探测降级）。
- 运行期依赖 `yaml`（解析宿主组合）与 `@deepseek-ai/schemastery`（配置表单）。用插件管理器安装时由 pnpm 自动装好；手动拷目录的话先在该目录 `npm install`。

### 从 GitHub 安装

```bash
git clone https://github.com/aiiao/dsh-before-dawn.git
cd dsh-before-dawn
npm install --omit=dev        # 只装 yaml + schemastery
```

然后在 DSH 插件管理里把**这个目录**作为 bundle 安装；或让插件管理器直接吃 Release 里的 `aiiao-dsh-before-dawn-<版本>.tgz`。

> 仓库带 `private: true`，是防止误发 npm 的保险，不影响安装。

### 提示词放在哪

本仓库的 `prompt/seed.md` 只是**空模板**。插件首次启用时把它复制到 `$DSH_HOME/before-dawn/inject.md`，之后每轮从那个文件现读；改文件即热生效，不需要重启。你自己的条款不要提交进仓库。

## 使用

### 徽标

固定在**左侧栏底部**（「新版本」与设置上方），水平贴右、垂直贴底。胶囊只显示「状态点 + 凌晨」，颜色即状态：绿=正常 / 黄=降级 / 灰=停用 / 红=出错。

点开面板看：提示词大小与路径、权限预设、DSH 版本、扩展点、工作模式、自动续跑、告警。面板里唯一的控件是**启动状态**开关（等价 `/dawn on|off`，改完即时生效并记住），保存成功后自动收起；点面板外或按 Esc 关闭。

### 工具

| 工具 | 作用 |
| --- | --- |
| `dawn_status` | 人类可读的体检报告 |
| `dawn_prompt` | `read` / `path` / `set` / `append` / `reload`，可直接改写提示词文件 |
| `dawn_apply` | `scope = live` 把当前存活会话钉到目标预设；`fresh` 只影响之后的新会话 |
| `dawn_verify_pin` | 建一个临时会话验证「钉住」链路，读完立即销毁，不留残影 |
| `dawn_retry_probe` | 派发一次合成的 `agent/request-error` 走真实 waterfall，验证「瞬时错误→重试 / 永久错误→不重试」，不发真实请求 |

### 命令

```
/dawn status            查看状态
/dawn on | off          开关注入
/dawn reload            重读提示词文件
/dawn path              打印提示词文件路径
/dawn apply [preset]    钉住所有存活会话
/dawn auto [on|off]     自动重试与续跑总开关
/dawn continue [文本]   立刻发一条续跑消息（手动验证用）
/dawn modes             列出四个模式与注册表状态
/dawn verify            同 dawn_verify_pin
/dawn doctor            扩展点能力矩阵
/dawn plugins           相关插件启用情况
```

### HTTP

`GET /before-dawn/status` 与 `/before-dawn/status/json` 返回同一份状态（`{"ok":true,...}`）；`POST /before-dawn/status/config` 接受与面板相同的配置补丁。

## 工作模式

DSH 的「模式」不是开关，而是一整条 agent 平面组合（人设 + 工具行 + 计划/压缩/委派分组）。凌晨注册四项，行数在 r3 上由宿主真实组合实时派生：

| 模式 | id | 差异 |
| --- | --- | --- |
| 凌晨模式 | `before-dawn` | 标准工具面全保留，人设换成「直接执行 / 只报增量 / 失败换路」 |
| 凌晨模式 · 子任务 | `before-dawn-child` | 委派组去掉 `subagent_fork`、`workflow`、`ralph` |
| 凌晨 · 实验室 | `before-dawn-lab` | 再去掉 `tool-web`、`present`、`tool-schedule`，适合离线作业 |
| 凌晨 · 实验室 · 子任务 | `before-dawn-lab-child` | 同上，再加委派三行 |

- 模式只改**人设与工具面**；注入、权限、续跑属于宿主平面，任何模式下都生效——「模式管怎么干，凌晨管能不能干」。
- 只能在**新会话**选定（宿主要求首轮前 select），子智能体会继承父预设。
- 来源以 `status.modeSource` 为准：`live:<预设名>` = 读到宿主真实组合；`内置快照` = 宿主预设未就绪，降级并在下个新会话自动重试。
- 想新增模式：改 `modes/derive.mjs` 的 `MODES`，跑 `node modes/build.mjs` 刷新离线快照。

## 配置项

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关，关闭后不注入提示词 |
| `position` | `head` | 注入位置：`head` / `tail` / `both` |
| `promptPath` | 空 | 留空用 `~/.dsh/before-dawn/inject.md` |
| `pinFullAccess` | `true` | 新会话自动钉目标预设 |
| `pinOnlyFresh` | `true` | 只钉没被手动改过预设的会话 |
| `pinExistingSessions` | `false` | 加载时也给已有会话补钉 |
| `targetPreset` | `danger-full-access` | 钉住的目标预设 |
| `stripChatmlTags` | `true` | 注入前剥掉 ChatML / `project_instructions` 标签 |
| `modes` | `true` | 注册四个 agent preset |
| `modesSource` | `auto` | `auto` 从宿主组合派生；`static` 用包内快照 |
| `statusRoute` | `true` | 开启 HTTP 状态接口 |
| `routePath` | `/before-dawn/status` | 接口路径 |
| `autoRetry` | `true` | 请求失败自动重试 |
| `retryMax` | `3` | 每个 step 重试上限（0–20） |
| `autoContinue` | `true` | 异常结束后自动续跑 |
| `continueMax` | `3` | 每个会话续跑上限（0–20） |
| `continueText` | `继续` | 续跑文本 |
| `continueDelayMs` | `700` | idle 后延迟判断（200–5000ms） |
| `maxToolChars` | `4000` | `dawn_prompt read` 回显上限 |

配置改动写在 `~/.dsh/before-dawn/settings.json`（插件自管，优先于 bundle 默认值），并尽力镜像进 profile 覆盖层；插件管理器重写 patch 文件时不会丢设置。

## 自检

```
/dawn doctor                    # 10 项扩展点能力矩阵
node tools/armor-doctor.mjs     # 22 项环境 + 运行期体检（自动找端口）
node selftest.mjs               # 15 条离线单测
```

判读只看四行：系统提示注入 ≈20,926 字符 / 权限钉住 `pin=true` / 工作模式 4-4 / 扩展点 10-10。

## 失效与兜底

| 场景 | 方案 |
| --- | --- |
| DSH 升级后注入没了 | `node tools/armor-fallback.mjs on`：把破甲词写进 `~/.dsh/AGENTS.md`，走宿主自带的 `@deepseek-ai/dsh-agent-instructions`（每链 65,536 字节），与插件版本无关 |
| 插件管理器装不上 | `node tools/install-bundle.mjs --pkg .`：纯 node 写依赖 + junction，有 pnpm 就顺手收敛 |
| 升级前留现场 | `node tools/armor-snapshot.mjs`：打包插件包 + 提示词 + 偏好 + profile 声明 + 恢复说明 |
| 模式行数变少 | `node modes/build.mjs` 重建快照，再看 `/dawn modes` 的 `broken` |

## 原理

宿主平面四层（提示词 / 权限 / 续跑 / 观测）+ agent 平面一层（模式），全部通过 Cordis 官方服务与事件实现：

- `systemPrompt.section({ name, order, interpolate: false, text })` — 段文本是函数，每轮重新读文件（`size:mtime` 变了才重读）。
- `permissionPresets.set(session, preset)` — 跳过 subagent 会话与手动改过预设的会话。
- `agent/request-error` waterfall 里先 `await next()`，官方没重试且错误非永久时补 `{ kind: 'retry' }`。
- `agent/status` 转 `idle` 后延迟判断六道闸门，满足才 `agent.followup('继续')`。
- `agentPresets.register(def)` — 运行期读宿主默认组合再派生，宿主升级后行清单自动跟随。

## 与「改宿主型」破甲插件的区别

有些同类插件靠解包 `app.asar`、替换宿主 `.js` 实现，会和凌晨往同一个提示词瀑布里塞段，
**同开就是重复注入**（实测会把凌晨段裁到 529 字符）。二选一：只留凌晨，或把凌晨 `position` 设为
`tail` 减少重叠。那类插件改过的宿主要用它自己的回滚脚本还原；凌晨不碰宿主文件。

## 升级 DSH 之后

1. `/dawn doctor` 看哪一项变 off——那就是扩展点变了的位置。
2. `node tools/armor-doctor.mjs` 补查安装链（pnpm 运行时、`link:`/`file:` 依赖、软链指向）。
3. `/dawn modes` 看 `broken`，必要时重建模式快照。
4. 开一个新会话确认徽标与注入字符数。

## 卸载 / 回滚

- 停用：插件管理里关掉，或 `set_bundle @aiiao/dsh-before-dawn false`
- 卸载：`remove_bundle @aiiao/dsh-before-dawn`
- 只停注入：`/dawn off`

不修改 `app.asar`、不写 `*.bak`、不改 profile 的 `cordis.patch.yml`，卸载后不留残留状态。

## 目录

```
index.js         宿主半身：注入、权限、续跑、模式注册、工具、命令、HTTP
client.js        Web 半身：侧栏徽标 + 面板
lib/automation.mjs  续跑与重试的纯逻辑
modes/derive.mjs    模式派生规则（运行期与离线共用）
modes/build.mjs     离线快照生成器
lib/fallback-rows.json       标准 agent 平面基线（行清单）
tools/          体检、备用通道、快照、兜底安装、版本工具
prompt/seed.md  首次运行时的提示词模板
cordis.patch.yml  bundle patch（只 insert 自己一行）
compat.json     版本 → 说明，供体检显示
```


## 打包与归档

```bash
node tools/bump.mjs --set 1.0.1 --pack     # 改版本 + 打包
bash pack.sh                               # 只打包当前版本
```

每次打包会产出三件（`dist/`）：安装包 `.tgz`、源码包 `-src.zip`、校验清单 `MANIFEST.txt`，
并**自动复制一份到归档目录** `D:\Before Dawn\<版本>\`（含 `ARCHIVE.txt`）。
换目录用 `DAWN_ARCHIVE_DIR` 覆盖：

```bash
DAWN_ARCHIVE_DIR="E:/backup" bash pack.sh
```

归档是离线快照，与 GitHub Release 无关；只想留一份手头可装的包时，直接取 `D:\Before Dawn\<版本>\*.tgz`。

## 版本沿革

| 版本 | 说明 |
| --- | --- |
| 1.0.0 | 首个版本：提示词注入、全权限钉住、自动重试与续跑、四个 agent preset 工作模式、侧栏徽标与状态面板、随包工具箱与 23 条离线自测 |

## 免责声明

本插件会把新会话设为 `danger-full-access` + 审批 `never`，注入的提示词会进入会话系统提示并落盘。请只在自有机器和已备份的仓库里使用，在他人环境或受监管场景使用前自行确认授权。软件按 MIT 许可「按现状」提供，不附带担保，使用后果自负。

## 许可

MIT，见 [LICENSE](./LICENSE)。

## 贡献

```bash
npm install
node selftest.mjs        # 23 项断言，全绿再提 PR
node modes/build.mjs     # 改过 lib/fallback-rows.json 后重生成四个 JSON
```

CI 在 Ubuntu / Windows × Node 20 / 22 上跑同样的三件事。行为约定写在上面「原理」一节，改动前先读。
