# tools/ —— 保险工具箱

三个脚本都不依赖插件运行时，插件挂了也能单独跑。默认从环境变量推断路径：`DSH_HOME`（默认 `~/.dsh`）、`DSH_PROFILE_NAME`（默认 `desktop`）、`DSH_APP_DIR`（DSH 安装的 `resources/app`，不填则自动探测常见位置）。

## armor-doctor.mjs —— 体检

```bash
node tools/armor-doctor.mjs                 # 自动扫本地端口找状态接口
node tools/armor-doctor.mjs --port 57470    # 指定端口
node tools/armor-doctor.mjs --json          # 机器可读
```

22 项检查，分四组：插件身份与版本、提示词注入（字符数 / 段数 / 重复段）、权限与工作模式、扩展点与安装链（pnpm 是否存在、`file:`/`link:` 依赖是否可解析、`node_modules` 链接是否指向对的地方）。

判读四行就够：注入字符数、权限钉住、模式 4/4、扩展点 10/10。退出码 0 = 全绿，1 = 有 fail。

## armor-fallback.mjs —— 备用注入通道

```bash
node tools/armor-fallback.mjs status    # 看两条通道现状
node tools/armor-fallback.mjs on        # 接上备用通道（自动备份原 AGENTS.md）
node tools/armor-fallback.mjs off       # 撤掉（有备份则还原）
```

宿主自带的 `@deepseek-ai/dsh-agent-instructions` 会读用户全局 `AGENTS.md`（即 `$DSH_HOME/AGENTS.md`），每条链预算 **65,536 字节**。所以插件整体失效时，把 `$DSH_HOME/before-dawn/inject.md` 同步进去，破甲词照样进每个新会话——这条通道与插件版本完全无关。

插件正常时保持 **off**，否则同一份文字会进两次。

## armor-snapshot.mjs —— 环境快照

```bash
node tools/armor-snapshot.mjs            # 默认输出到包内 dist/
node tools/armor-snapshot.mjs --out <目录>
```

打包：插件 tgz、`inject.md`、`settings.json`、profile 的 `package.json` 与 `cordis.patch.yml`、宿主版本信息、`manifest.json`、`RESTORE.md`。升级 DSH 或重装系统前跑一次。

## install-bundle.mjs —— 纯 node 兜底安装器

```bash
node tools/install-bundle.mjs --dry-run          # 只看会改什么
node tools/install-bundle.mjs --pkg <目录|tgz>
node tools/install-bundle.mjs --profile desktop --json
```

插件管理器依赖 pnpm 运行时；pnpm 缺失或 `remove_bundle` 半途失败时，用它把依赖行、`dsh.profile.bundles`、`node_modules` 链接补回去。有 pnpm 就顺手收敛，没有就跳过并说明。

## 什么时候用哪个

| 症状 | 先跑 |
| --- | --- |
| 徽标不见了 / 面板数字不对 | `armor-doctor.mjs` |
| 插件装不上、卸载报 pnpm 缺失 | `install-bundle.mjs` |
| DSH 升级后模式 broken | `armor-doctor.mjs` → 看 `modes` → 必要时重载插件 |
| 要升级 DSH、换机器 | `armor-snapshot.mjs` |
| 插件彻底不工作但急着用 | `armor-fallback.mjs on` |
