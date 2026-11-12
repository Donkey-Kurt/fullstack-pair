# 发布与上架清单

这份文档是"把插件发给别人"的操作流程。按顺序做，每步都有验证方法。

## 一、发布前必须改的四项

| 项 | 当前值 | 改成 |
|---|---|---|
| `package.json` 的 `name` | `@local/fullstack-pair` | 你自己的 npm scope，例如 `@your-name/fullstack-pair`。`@local` 是本地占位，公开发布不可用 |
| `package.json` 的 `repository.url` | `git+https://github.com/YOUR-GITHUB-NAME/fullstack-pair.git` | 你的真实仓库地址（市场详情页会读它显示 README） |
| `package.json` 的 `private` | `true` | 发布到 npm 前**删掉这一行**；只在 GitHub 分发 tgz 可保留 |
| 版本号 | `1.2.2` | 每次发布递增（SemVer：修 bug 补丁位、加功能次版本位） |

`engines.dsh` 已声明为 `^0.2.2-rc.1`：表示只在验证过的那条版本线上可用。如果之后适配了更早/更晚的宿主，改这个范围即可——市场用它判断兼容性。

## 二、三种分发方式

### 方式 A：GitHub Release（最简单，推荐先做）

```powershell
# 在插件目录
pnpm pack --pack-destination dist
# 产物：dist/local-fullstack-pair-<version>.tgz
```

把 tgz 上传到 GitHub Release。别人安装：

```
plugin_manager install_bundle <下载后的 tgz 绝对路径>
```

升级：先 `remove_bundle @local/fullstack-pair`，再装新 tgz。

### 方式 B：npm 公开发布

1. 按第一节改包名、删 `private`；
2. `npm login`（需要你自己的账号，AI 不代做）；
3. `npm publish --access public`；
4. 别人安装：`plugin_manager install_bundle @your-name/fullstack-pair@1.2.2`。

### 方式 C：上架社区市场（供人发现）

1. 先完成 A 或 B（市场只认可安装的来源）；
2. 向 [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 仓库**提 PR**，按该仓库条目格式加一条；
3. 合并后市场（dshmarket）与目录站（awesome-dsh-plugin.com）会在一天内自动收录。

注意：dshmarket 有安全策略——**只允许安装该精选列表内的来源**，所以想被"一键安装"，这一步无法跳过。

## 三、每次发布前的验证

```powershell
# 1. 语法
node --check index.js
node --check client.js

# 2. 打包并检查内容（必须包含 client.js 与 cordis.patch.yml）
pnpm pack --pack-destination dist
tar -tzf dist/local-fullstack-pair-<version>.tgz

# 3. 重新安装验证（本机）
#    remove_bundle → install_bundle <新 tgz> → 右键菜单/头部徽章/设置对话框各点一次
```

## 四、版本兼容性风险（发布时写清楚）

插件依赖 DSH 的内部能力：`contextMenus`、`slots`（`conversation.session.header.utilities`、`shell.overlay`）、`uiWorkspace.openWorkspace/pickDirectory`、`sessions` 服务、`connection.fetch` 路由。

- 宿主版本差异可能导致**加载失败**或**部分入口不出现**；
- 发布说明里应写明"已验证的 DSH 版本"；
- 若对方报错，先核对版本，再决定是适配还是拒绝安装。
