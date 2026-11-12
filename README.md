# 多目录任务范围（fullstack-pair）

让一个会话在运行时把**任意多个目录**纳入同一任务范围，并提供跨目录的概览与检索工具。
不预设"前端 + 后端"，也不要求事先把路径写进配置。

## 三种入口

| 入口 | 维度 | 用法 |
|---|---|---|
| **会话右键菜单** | 会话 | `本次任务范围：N 个目录 ›` 子菜单：主根（★ 工作区，不可移出）+ 已关联目录（✓，点击移出）+ **`＋ 添加其他目录…`**（调平台目录选择器）+ **`↺ 最近使用`**（一点即加，不用再开对话框）。 |
| **会话头部徽章** | 会话 | 标题右侧（`conversation.session.header.utilities`，与"智能体团队 / 标准模式"同一行）常驻显示 `📁 N · 分支`：N 是范围目录数，分支是范围内各目录的当前 git 分支（多分支显示"首个 +N"，无 git 显示目录数）。悬停看明细（每个目录 → 分支）。菜单操作后立即刷新，模型用工具改范围后 15 秒内刷新。 |
| **工作区右键菜单** | 工作区 | ①【新建会话并预设范围…】——勾选目录后创建会话并写入范围（解决"空白新会话没有会话 id、会话菜单用不了"的问题）；②【加入本次任务范围】/【移出本次任务范围】——把该工作区加入当前会话的范围；若它已是主根，显示只读说明。 |
| **对话里说一句** | 会话 | 「用 `pair_use` 把 `E:\WS\YM\web-vomp-system` 加入范围」——模型调用工具完成。 |
| **配置文件预置** | 全局 | `pair.config.json` 的 `defaults`，新会话首次访问范围时自动带上。 |

两个菜单都会**每次打开实时拉取**，不做缓存。

## 三个工具

| 工具 | 作用 |
|---|---|
| `pair_use` | 不传参数：列出当前范围；传 `path`：把绝对目录纳入范围（可加 `label`）；`remove: true`：移出。只改检索范围，不动文件。 |
| `pair_overview` | 范围内各目录的路径、是否存在、顶层条目、技术栈、git 分支与未提交数。只读。 |
| `pair_grep` | 跨范围正则检索，自动跳过 `node_modules`、构建产物、版本库；支持 `target`、`glob`、`maxResults`、`caseSensitive`。只读。 |

范围 = 会话当前目录（主根，随 `working_directory` 的 cd 变化）+ 已关联的额外目录。

## GUI 的数据通道

Client 半部注册工作区右键操作，`resolve` 时先 GET 一次范围做状态回显，`run` 时 POST
更新。两条路由都在 Host 的 `client-connection` 精确 Fetch 路由表里：

| 路由 | 方法 | 用途 |
|---|---|---|
| `/api/fullstack-pair/scope` | GET | 读取会话范围：`{ sessionId, primary, entries }`；`primary` 是主根（`{label,path}` 或 `null`） |
| `/api/fullstack-pair/scope` | POST | `{ path, label?, remove?, sessionId? }` 加入/移出，响应同 GET |
| `/api/fullstack-pair/health` | GET | 健康检查 |
| `/api/fullstack-pair/client-ready` | POST | Client 挂载自检，落盘 `client-ready.json` |

`primary` 通过缓存的 agent 引用调 `workingDirectory.ensure` 解析；agent 未见过（还没发过消息）
时为 `null`，GUI 只少显示主根那一行，不会报错。

会话定位：**GUI 会显式带 `sessionId`**，取自 `ctx.uiSession.adapter.current` 的主视图绑定，
因此多个会话交替操作不会串。请求不带 `sessionId` 时（例如手工 curl），Host 回退到最近一次
提示组装 / 工具调用 / `agent/created` 采到的活跃会话——这是兜底，不是正常路径。
没有打开的会话时，菜单项会显示为禁用并提示"先打开一个会话"。

## 实现注意（踩过的坑）

- **`dsh.client.inject` 必须写 `@deepseek-ai/dsh-client-ui-conversation`。**
  写成 `@deepseek-ai/dsh-client-ui-context-menu` 时实测 Client 半部**不加载**（等待 5 分钟
  没有 `client-ready.json`）；回退到 conversation 后约 2.5 分钟加载成功。
  `contextMenus` 服务本身通过插件返回对象的 `inject: ['contextMenus']` 取得，不依赖声明目标。
- **`client-ready.json` 是 Client 侧的验收点。** 自检上报被放在 `contextMenus.register`
  之后，所以文件存在 = Client 插件已加载 **且** 菜单注册没有抛错。
- **改 Client 半部后不一定需要刷新页面。** Host 发布客户端图后，页面会经 SSE 自行加载新
  模块（实测两次都是自动生效，延迟约 2–3 分钟）。

## 可选配置：`pair.config.json`

留空（`"defaults": []`）即纯运行时模式，插件完整可用。想让某些固定工程在每个新会话
自动带上，就写进 `defaults`：

```json
{
  "defaults": [
    { "path": "D:\\code\\shop-web", "label": "web" },
    { "path": "D:\\code\\shop-api", "label": "api" }
  ],
  "conventions": "接口契约以 api/docs/openapi.yaml 为准，改接口需同步前端调用处。"
}
```

`defaults` 只在**磁盘上没有该会话记录**时生效，因此不会把用户已经移出的目录重新灌回来。

## 安装与分发

发布流程（改包名、发 GitHub Release / npm、上架社区市场、发布前验证）见 [PUBLISHING.md](PUBLISHING.md)。

打包成 tarball 后安装，**运行时不再依赖源码目录**：

```powershell
# 1. 打包（在包目录）
pnpm pack --pack-destination dist

# 2. 安装（用 plugin_manager 的 install_bundle，目标换成 tarball 路径）
#    dist/local-fullstack-pair-1.0.0.tgz
```

- 安装后 profile 的依赖是 `file:<tarball 路径>`，包体解压到 profile 的 `node_modules`，
  因此**源码目录挪走、删除都不影响运行**（只有重装/升级时才需要 tarball 仍在）。
- 分发：把 `local-fullstack-pair-1.0.0.tgz` 发给对方，用同样的 `install_bundle` 安装即可。
- 升级流程：`remove_bundle` → `install_bundle <新 tarball>`；状态在独立目录（见下），升级不丢。

## 持久化

状态（`scopes.json`，含范围 / 最近使用 / fork 映射）落在**独立状态目录**，不在包目录内：

```
$DSH_HOME/storages/fullstack-pair/scopes.json      # 默认 %USERPROFILE%\.dsh\storages\fullstack-pair
$DSH_HOME/storages/fullstack-pair/client-ready.json   # Client 半部加载自检
$DSH_HOME/storages/fullstack-pair/fork-probe.json     # fork 继承判定证据
```

```json
{ "version": 1, "sessions": { "session-xxx": { "updatedAt": "...", "entries": [{ "path": "...", "label": "..." }] } },
  "recent": [{ "path": "...", "label": "...", "at": "..." }],
  "forks": { "子会话 id": "父会话 id" } }
```

- **为什么外置**：打包安装后包体在 `node_modules` 里，重装/升级会整体替换该目录；状态放
  独立目录才不会丢。旧版本写在包目录里的 `scopes.json` 会在首次读取时自动迁移。
- **写入时机**：任何一次范围变更（工具调用、GUI 菜单点击）都会立即整体重写，用
  "临时文件 + rename"保证原子性，避免进程退出时留下半个文件。
- **恢复时机**：会话首次访问范围时（提示组装 / 工具调用 / GUI 读取）自动读回，所以
  DSH 重启后范围仍在。
- **容错**：文件缺失是正常状态；结构或版本不符、条目字段错误的记录一律跳过，并在
  插件日志里留一条 warning，不会因为坏文件导致插件激活失败。
- **清理**：范围记录带 90 天 TTL，加载时丢弃更早的会话；最近使用保留 20 条、fork 映射 200 条。

## 边界（重要）

- **不改变沙箱语义**。插件只做"知道 + 检索"，不注册 fs/shell 后端、不绕过 `ctx.fs`。
  模型能否写入某个目录仍由会话的 sandbox 模式决定；被拒时提示词要求模型如实报告阻塞。
- **只读工具**。三个工具都不写业务文件；状态文件是插件自己的。
  `pair_grep` 有 8 秒 / 2 万文件 / 单文件 1 MB 的预算上限。

## 会话操作与范围的关系

范围以 session id 为键，所以判断标准是"该操作是否产生新会话 id"：

| 操作 | 范围 |
|---|---|
| 重命名、置顶、归档/取消归档、复制 Session ID、在文件夹显示 | 保留（id 不变） |
| **分叉会话** | **自动继承**（见下） |

### 最近使用

每加入一个目录，就把它记进 `scopes.json` 的 `recent`（去重、置顶、最多 20 条）。子菜单里
显示最近 5 个，点一下直接加入，绕开系统对话框——系统对话框的初始位置由 DSH 主进程决定
（`showOpenDialog` 没传 `defaultPath`），插件改不了，所以用快捷项替代"记住上次位置"。

**存在性校验**：读取时逐项 `statSync` 校验，只显示当前仍存在的目录；不存在的只跳过显示，
不会删除记录（U 盘、网络盘可能稍后恢复）。已在范围内或等于主根的项也不再重复列出。

### 主根不会重复登记

主根本就隐含在范围里（工具视图的第一条、菜单子菜单的 ★ 项）。因此：

- 加入一个**等于当前会话主根**的目录会被忽略（`pair_use` 返回 `changed: false`，GUI 不写入）；
- 读取时若发现历史数据里把主根登记成了额外目录，会**自动清理并落盘**（自愈），
  所以菜单不会出现两个相同条目、计数也不会多算。

### 分叉继承的实现与边界

DSH 的 `SessionStore.fork()` **不记录父会话关系**（meta 里只有 `cwd` 与 `isSeeded`，
`parentSession` 只用于子代理），事件里也没有来源标记。因此继承分两级：

**第一级：精确来源（主路径，跨重启有效）**

插件在 `apply` 时包装一次 `sessions.fork`：透传参数、调用原方法、把 `(子会话 id → 父会话 id)`
记进 `scopes.json` 的 `forks` 字段（最多保留 200 条），卸载时恢复原方法。fork **调用点**是
唯一确定知道父会话是谁的时刻，这里不需要任何推理。包装器用 rest 参数转发，签名变化也不会
丢参数；原方法的异常照常抛出。

之所以落盘而不是只放内存：分叉之后可能先重启 DSH、再打开子会话，那时进程内映射已经没了。

**第二级：事件前缀比对（兜底）**

`forks` 里没有记录时（例如插件安装之前就分叉出来的会话），退化为前缀比对：`fork()` 把父
会话事件原样复制成子会话前缀，`Session.inheritedEventCount` 记录复制条数，`header.isSeeded`
标记 seeded 会话。判定规则：

1. 候选的**事件总数必须覆盖完整继承前缀**（`seq >= inheritedEventCount`）——祖先的事件数
   通常小于直接父，这一步排除祖先；
2. 比对前缀的**头 10 条 + 尾 10 条**——尾部分能区分"从同一父分叉、之后各自增长"的会话；
3. 多个候选同时匹配时选事件数最接近继承长度的（最可能是直接父）。

**降级**：两级都失败（父会话已归档/关闭、前缀不足、拿不到 sessions 服务）时跳过，不做猜测性
复制。每次 agent 创建都会把判定过程写入 `fork-probe.json`，其中 `source` 字段标明用的是
`fork-hook`（精确）还是 `prefix-match`（推理兜底）。

- 安装位置：`desktop` profile 的 bundle，影响该 profile 的所有会话。卸载用
  `plugin_manager` 的 `remove_bundle`。
