# 变更记录

## 1.0.0 — 首个版本

### 提示词注入
- 通过 `systemPrompt.section` 在系统提示最前注入一段独立文本（默认 `~/.dsh/before-dawn/inject.md`），段名 `before-dawn`，order `-100000`。
- 文本实读磁盘，改文件即热生效；首次运行从 `$DSH_HOME/prompt-inject.md` 或包内中性模板播种。
- 自动清洗 BOM、CRLF、ChatML 与实际提示无关的包裹标签；可选把 `{{name}}` 转义成 `{ {name}}` 避免被当作插值。

### 全权限钉住
- 新会话创建时自动把权限预设切到 `danger-full-access`（沙箱全权限 + 审批 never 一体），子会话自动跳过。
- 只对"新装配"的会话动作，已有会话保持用户当初的选择；可用 `dawn_verify_pin` 实测这条链路。
- 目标预设可改（`targetPreset`），也可关掉（`pinFullAccess: false`）。

### 自动重试与续跑
- 回合以 `error` / `aborted` / `interrupted` / `max-tokens` 结束时，按预算自动重试或补一句「继续」。
- 永久性错误（鉴权、额度、模型不存在、上下文超限等）不重试；用户主动中止不续跑；连续失败 3 次熔断。
- 每条会话独立预算，可在配置里调次数、触发词与延迟。

### 工作模式（agent preset）
- 内置四个预设：`凌晨模式`、`凌晨模式 · 子任务`、`凌晨 · 实验室`、`凌晨 · 实验室 · 子任务`。
- 运行期从宿主当前默认组合派生（`modeSource: live:<preset>`），宿主升级后自动跟随；也可固定用包内快照（`modesSource: static`）。
- 子预设继承父预设提示词与设置，排除 `subagent_fork`、`workflow`、`ralph`，主会话选不带「· 子任务」的那个。
- 注册失败会自动剔除不可用行再重试，不因单行坏掉整个模式。

### 界面
- 侧栏底部一枚徽标：状态点 + 名称，右对齐、与侧栏底边对齐，点开是状态面板。
- 面板含提示词大小、权限预设与已钉会话数、DSH 版本、扩展点能力、模式来源、自动续跑开关与实时计数。
- 面板内可直接启停插件，改完自动收起；位置与开关持久化在 `~/.dsh/before-dawn/settings.json`。

### 工具与接口
- 工具：`dawn_status`、`dawn_prompt`、`dawn_apply`、`dawn_verify_pin`、`dawn_retry_probe`。
- 命令：`/dawn`（status / on / off / reload / path / apply / modes / auto / continue / doctor / plugins / help）。
- HTTP：`GET /before-dawn/status`、`GET /before-dawn/status/json`、`POST /before-dawn/status/config`。

### 自检与兜底
- `tools/armor-doctor.mjs`：一次性体检注入、权限、模式、扩展点、安装链环境。
- `tools/armor-fallback.mjs`：把提示词写进 `$DSH_HOME/AGENTS.md` 作为与插件无关的备用通道。
- `tools/armor-snapshot.mjs`：把插件包、提示词、profile 声明、宿主信息打成一个可复原快照。
- `tools/install-bundle.mjs`：纯 node + fs 的兜底安装器，没有 pnpm 也能把包挂进 profile。
- `tools/bump.mjs`：版本号与打包一条命令。
- `selftest.mjs`：23 条离线断言，覆盖清洗、转义、派生、预算、剔行重试等。

### 其它
- 适配 DSH `0.2.2-rc.3`（rc.1 / rc.2 同样可用），全部走 Cordis 官方扩展点，不修改宿主文件。
- 插件管理页可编辑 19 项配置；未知配置键返回 400，不静默吞掉。
- MIT 许可。
