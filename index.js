/**
 * 多目录任务范围（multi-root scope）—— Host 半部。
 *
 * ## 模块定位
 *
 * 让**任意会话**在**任意时刻**把任意多个目录纳入同一任务的检索范围，并提供跨目录的
 * 概览与检索工具。它不预设"前端 + 后端"，也不要求用户事先把路径写进配置文件：
 * 装上即用，默认以会话当前目录为主根；需要跨目录时由模型调用 `pair_use` 动态关联。
 *
 * ## 为什么需要它（设计背景）
 *
 * DSH 的一个会话只绑定一个不可变工作区根（`SessionHeader.cwd`）。读取虽不受文件沙箱
 * 限制，但模型并不知道"另一个目录"在哪、也不会有意识地跨目录检索，于是每个跨目录任务
 * 都要用户重新交代路径。把父目录设为工作区又会把大量无关工程拖进来，污染搜索与权限面。
 *
 * 本插件给出第三条路：**范围运行时可变，且只包含本次任务真正需要的目录**。
 *
 * ## 不触碰沙箱语义
 *
 * - 不注册 fs/shell 后端，不修改策略，不绕过 `ctx.fs` 与 `ctx.shell`；
 * - 只注册两个只读工具 + 一个范围管理工具，并注入一段系统提示；
 * - 模型能否写入某个目录，仍由会话的 sandbox 模式决定，插件不改变该边界。
 *
 * ## 范围如何按会话隔离并持久化
 *
 * 每个会话的范围是 `Map<会话标识, Map<绝对路径, 标签>>`。会话标识来自 agent（工具与提示
 * 组装两处都能拿到），GUI 走 HTTP 路由时改为从请求里带的 `sessionId` 取——两条链路共享
 * 同一份内存状态。
 *
 * 持久化：内存是权威，磁盘（包目录下的 `scopes.json`）是镜像。任何一次范围变更都会原子
 * 写回（临时文件 + rename），会话首次访问范围时从磁盘恢复，因此 DSH 重启后范围仍在。
 * 预置的 `defaults` 只在磁盘上没有该会话记录时生效——否则每次重启都会把用户已整理过的
 * 范围重新灌满。记录带 90 天 TTL，加载时清理陈旧项，避免文件无限增长。
 *
 * ## 为什么零 import
 *
 * 本插件由 `plugin_manager install_bundle` 安装到 profile，profile 的 node_modules 只包含
 * 本地 bundle，**解析不到 dsh 自带的包**。因此这里不使用 `defineTool` 与 schemastery，
 * 而是直接构造工具定义对象、直接提供标准 JSON Schema（dsh 工具注册表只要求
 * `output.schema` 落在它支持的 JSON Schema 子集内）。
 *
 * ## 可选配置
 *
 * `pair.config.json` 仅用于**预置**：`defaults` 里的目录会在每个新会话首次访问时自动
 * 纳入范围（适合长期固定的工程）。留空即纯运行时模式，插件依然完整可用。
 *
 * @module @local/fullstack-pair
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** 本包目录；用于定位可选配置文件与旧版状态文件。 */
const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 可选配置文件：包目录下的 pair.config.json。 */
const CONFIG_FILE = path.join(PACKAGE_DIR, 'pair.config.json');

/**
 * 插件状态目录：与插件本体分离，跟随 DSH_HOME（默认 `~/.dsh`）。
 *
 * 为什么外置：打包分发后插件本体位于 profile 的 `node_modules` 内，重新安装或升级会整体
 * 替换该目录。状态放在这里，升级不丢范围；插件目录本身也可以整体挪走或删除。
 */
const STATE_DIR = path.join(process.env.DSH_HOME ?? path.join(homedir(), '.dsh'), 'storages', 'fullstack-pair');

/** 范围持久化文件：状态目录下的 scopes.json。 */
const SCOPES_FILE = path.join(STATE_DIR, 'scopes.json');

/** 旧版状态文件位置（包目录内），仅用于升级时一次性迁移读取。 */
const LEGACY_SCOPES_FILE = path.join(PACKAGE_DIR, 'scopes.json');

/** 持久化格式版本；结构变化时递增，读取端只接受同版本。 */
const SCOPES_VERSION = 1;

/** 会话范围记录的保留时长（90 天）；加载时清理更早的记录，避免文件无限增长。 */
const SCOPES_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * 磁盘镜像：会话标识 → `{ updatedAt, entries }`。
 *
 * 只在首次需要时读一次文件（`loaded` 标记），之后由 `persistSession` 增量维护并整体写回。
 * 之所以单独维护镜像而不是只写"当前内存里的会话"：内存只包含已加载过的会话，而磁盘里
 * 还有其它会话的记录，整体写回时必须把它们一起带上，否则会被覆盖丢失。
 */
const persisted = { loaded: false, sessions: new Map(), recent: [], forks: new Map() };

/**
 * fork 父子映射的保留条数。
 *
 * 精确来源只用于"分叉后打开子会话"这一瞬间，但 fork 与打开之间可能隔着一次重启，
 * 所以落盘保留；200 条足够覆盖很长的使用跨度，又不至于让状态文件失控。
 */
const FORK_LIMIT = 200;

/**
 * "最近使用"的持久化上限（保留多少条历史）。
 *
 * 只用于给菜单提供快捷入口，不是业务状态；留 20 条足够覆盖最近几天的工作目录，
 * 又不至于让文件无意义膨胀。
 */
const RECENT_LIMIT = 20;

/** "最近使用"在菜单里最多显示几条（菜单过长会难用）。 */
const RECENT_MENU_LIMIT = 5;

/** 持久化失败时的告警出口；`apply` 时接到插件 logger，避免静默丢数据。 */
let reportWarning = () => {};

/**
 * 读取磁盘镜像（幂等，只读一次）。
 *
 * 容错：文件缺失是正常状态；格式损坏、版本不符、字段类型不对的条目一律跳过，绝不因为
 * 一个坏文件让插件激活失败。陈旧记录（超过 TTL）在加载时丢弃。
 *
 * @returns 无（结果写入 `persisted`）。
 */
function loadPersisted() {
  if (persisted.loaded) return;
  persisted.loaded = true;

  // 升级路径：新状态目录没有文件、而旧版（包目录）有时，读旧文件做一次性迁移；
  // 下一次写盘会落到新位置。
  const source = existsSync(SCOPES_FILE)
    ? SCOPES_FILE
    : (existsSync(LEGACY_SCOPES_FILE) ? LEGACY_SCOPES_FILE : SCOPES_FILE);

  let raw;
  try {
    raw = JSON.parse(readFileSync(source, 'utf8'));
  }
  catch (error) {
    if (existsSync(source)) reportWarning(`读取 ${source} 失败：${messageOf(error)}`);
    return;
  }

  if (raw?.version !== SCOPES_VERSION || raw?.sessions === null || typeof raw?.sessions !== 'object') {
    reportWarning(`${source} 版本或结构不符（期望 version=${SCOPES_VERSION}），已忽略`);
    return;
  }

  const now = Date.now();
  for (const [sessionKey, value] of Object.entries(raw.sessions)) {
    if (!Array.isArray(value?.entries)) continue;
    const updatedAt = typeof value.updatedAt === 'string' ? Date.parse(value.updatedAt) : Number.NaN;
    if (Number.isFinite(updatedAt) && now - updatedAt > SCOPES_TTL_MS) continue;
    const entries = new Map();
    for (const entry of value.entries) {
      if (typeof entry?.path !== 'string' || entry.path.trim() === '') continue;
      entries.set(path.resolve(entry.path), typeof entry.label === 'string' ? entry.label : '');
    }
    if (entries.size > 0) {
      persisted.sessions.set(sessionKey, { updatedAt: Number.isFinite(updatedAt) ? updatedAt : now, entries });
    }
  }

  // 最近使用是可选字段：旧文件没有它，或格式不对时按空列表处理，不影响会话范围恢复。
  if (Array.isArray(raw.recent)) {
    for (const item of raw.recent) {
      if (typeof item?.path !== 'string' || item.path.trim() === '') continue;
      persisted.recent.push({
        path: path.resolve(item.path),
        label: typeof item.label === 'string' ? item.label : '',
        at: typeof item.at === 'string' ? item.at : new Date().toISOString(),
      });
      if (persisted.recent.length >= RECENT_LIMIT) break;
    }
  }

  // 回填：旧版本没有记录 recent，从已有会话范围里按会话更新时间聚合一次，
  // 让升级后的第一屏就有"最近使用"，而不是要用户再手动加一遍才出现。
  if (persisted.recent.length === 0) {
    const seen = new Set();
    const ordered = [...persisted.sessions.entries()].sort((a, b) => b[1].updatedAt - a[1].updatedAt);
    for (const [, record] of ordered) {
      for (const [dir, label] of record.entries) {
        const key = pathKeyOf(dir);
        if (seen.has(key)) continue;
        seen.add(key);
        persisted.recent.push({
          path: dir,
          label: label === '' ? path.basename(dir) || dir : label,
          at: new Date(record.updatedAt).toISOString(),
        });
        if (persisted.recent.length >= RECENT_LIMIT) break;
      }
      if (persisted.recent.length >= RECENT_LIMIT) break;
    }
  }

  // fork 父子映射：精确来源，跨重启保留（fork 与"打开子会话"之间可能隔着一次重启）。
  if (raw.forks !== null && typeof raw.forks === 'object') {
    for (const [childId, parentId] of Object.entries(raw.forks)) {
      if (typeof childId !== 'string' || childId === '') continue;
      if (typeof parentId !== 'string' || parentId === '') continue;
      persisted.forks.set(childId, parentId);
      if (persisted.forks.size >= FORK_LIMIT) break;
    }
  }
}

/**
 * 把当前内存镜像整体写回磁盘（sessions + recent + forks）。
 *
 * 整体重写而不是增量：文件只有几 KB，整体写最简单也最不容易出现半更新；
 * 用"临时文件 + rename"保证原子性，避免进程中途退出留下半个 JSON。
 *
 * @returns 无；失败只告警，不抛错。
 */
function writeStore() {
  const sessions = {};
  for (const [key, record] of persisted.sessions) {
    sessions[key] = {
      updatedAt: new Date(record.updatedAt).toISOString(),
      entries: [...record.entries].map(([dir, label]) => ({ path: dir, label })),
    };
  }
  const recent = persisted.recent
    .slice(0, RECENT_LIMIT)
    .map((item) => ({ path: item.path, label: item.label, at: item.at }));
  const forks = {};
  for (const [childId, parentId] of persisted.forks) forks[childId] = parentId;

  try {
    const temporary = `${SCOPES_FILE}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: SCOPES_VERSION, sessions, recent, forks }, null, 2), 'utf8');
    renameSync(temporary, SCOPES_FILE);
    // 迁移完成：旧位置（包目录）的文件不再被读取，删掉避免两份状态并存造成误导。
    try {
      if (existsSync(LEGACY_SCOPES_FILE)) unlinkSync(LEGACY_SCOPES_FILE);
    }
    catch {
      // 删不掉也无害：读取侧永远优先新位置。
    }
  }
  catch (error) {
    reportWarning(`写入 ${SCOPES_FILE} 失败：${messageOf(error)}`);
  }
}

/**
 * 记下一个会话的当前范围并落盘。
 *
 * @param sessionKey - 会话标识。
 * @param scope - 该会话的范围集合（权威内存态）。
 * @returns 无。
 */
function persistSession(sessionKey, scope) {
  loadPersisted();
  persisted.sessions.set(sessionKey, { updatedAt: Date.now(), entries: new Map(scope) });
  writeStore();
}

/**
 * 记录一次 fork 的父子关系并落盘。
 *
 * 这是"精确来源"的写入口：fork 调用点确定知道父是谁，不依赖任何推理。落盘是为了覆盖
 * "分叉后先重启、再打开子会话"的情况——那时进程内映射早就没了。
 *
 * @param childId - 子会话 id。
 * @param parentId - 父会话 id。
 * @returns 无。
 */
function rememberFork(childId, parentId) {
  loadPersisted();
  persisted.forks.set(childId, parentId);
  // 超限时丢弃最早插入的键（Map 保持插入顺序）。
  while (persisted.forks.size > FORK_LIMIT) {
    const oldest = persisted.forks.keys().next().value;
    if (oldest === undefined) break;
    persisted.forks.delete(oldest);
  }
  writeStore();
}

/**
 * 把一个刚被加入范围的目录记进"最近使用"（去重、置顶、限长）。
 *
 * 不在这里写盘：调用方紧接着会 `persistSession`，由那一次原子写把 recent 一起落盘，
 * 避免同一操作产生两次文件写入。
 *
 * @param dir - 目录绝对路径。
 * @param label - 显示标签；空串时用目录名。
 * @returns 无。
 */
function rememberRecent(dir, label) {
  loadPersisted();
  const resolved = path.resolve(dir);
  const key = pathKeyOf(resolved);
  persisted.recent = persisted.recent.filter((item) => pathKeyOf(item.path) !== key);
  persisted.recent.unshift({
    path: resolved,
    label: label === '' ? path.basename(resolved) || resolved : label,
    at: new Date().toISOString(),
  });
  if (persisted.recent.length > RECENT_LIMIT) persisted.recent.length = RECENT_LIMIT;
}

/**
 * 取"最近使用"列表，**逐项校验目录仍然存在**。
 *
 * 校验放在读取侧而不是写入侧：目录可能被临时拔掉（U 盘、网络盘）后又恢复，
 * 记录保留着更合理；但菜单里绝不能出现点不动的死目录，所以每次读取都过滤。
 *
 * @param limit - 最多返回几条（默认菜单上限）。
 * @returns `[{ path, label }]`，按最近使用排序，已剔除不存在的目录。
 */
function recentDirs(limit = RECENT_MENU_LIMIT) {
  loadPersisted();
  const result = [];
  for (const item of persisted.recent) {
    let isDirectory = false;
    try {
      isDirectory = statSync(item.path).isDirectory();
    }
    catch {
      isDirectory = false;
    }
    if (!isDirectory) continue;
    result.push({
      path: item.path,
      label: item.label === '' ? path.basename(item.path) || item.path : item.label,
    });
    if (result.length >= limit) break;
  }
  return result;
}

/**
 * 取出（必要时懒创建）某个会话的额外目录集合。
 *
 * 恢复顺序：内存 → 磁盘 → 配置预置。**磁盘命中时不再叠加预置**，否则每次重启都会把
 * 用户已经整理掉（移出过）的预置目录重新灌回来。
 *
 * @param sessionKey - 会话标识。
 * @param defaults - 预置目录（仅在磁盘上没有该会话记录时使用）。
 * @returns 该会话的可变目录集合。
 */
function scopeForSession(sessionKey, defaults) {
  let scope = SCOPES.get(sessionKey);
  if (scope === undefined) {
    loadPersisted();
    const saved = persisted.sessions.get(sessionKey);
    if (saved !== undefined) {
      scope = new Map(saved.entries);
    }
    else {
      scope = new Map();
      for (const item of defaults) scope.set(item.path, item.label);
    }
    SCOPES.set(sessionKey, scope);
  }
  return scope;
}

/**
 * 验证用健康检查路由。
 *
 * 为什么需要它：Client 插件（浏览器侧菜单/面板）必须能读写 Host 侧的范围状态，而
 * 第三方插件拿不到 typert 的类型契约工具链。`client-connection` 的 Host 半部提供
 * 「精确 Fetch 路由注册表」——注册的路径必须位于 `/api/` 前缀下，浏览器同源 fetch
 * 会先经过官方认证栅栏（得到 `principal.kind === 'owner'` 的 browserPeer），再分派到
 * 本 Handler。这条通道是 GUI 能"点了就生效"的前提，因此在接入菜单之前先验证它。
 */
const HEALTH_PATH = '/api/fullstack-pair/health';

/**
 * 范围读写端点（GUI 与 Host 共用）。
 *
 * GET 读当前会话范围；POST 加入 / 移出一个目录。GUI 的右键菜单直接调它，
 * 因此"点一下就生效"，且不需要模型往返。请求方不必带 sessionId——Host 会用最近
 * 一次提示组装/工具调用/agent 创建采到的活跃会话。
 */
const SCOPE_PATH = '/api/fullstack-pair/scope';

/** Client 半部挂载时的自检上报端点；Host 落盘，agent 读文件即可确认 Client 已加载。 */
const CLIENT_READY_PATH = '/api/fullstack-pair/client-ready';

/** Client 自检结果文件。 */
const CLIENT_READY_FILE = path.join(STATE_DIR, 'client-ready.json');

/**
 * fork 继承的诊断证据文件。
 *
 * 每次 agent 创建时覆盖写入：本会话是否 seeded、继承前缀长度、前缀键、候选会话比对结果、
 * 命中的父会话以及复制了哪些目录。继承逻辑一旦出问题，靠它判断是"前提不成立"还是"实现有 bug"。
 */
const FORK_PROBE_FILE = path.join(STATE_DIR, 'fork-probe.json');

/** 系统提示段名称；全局唯一。 */
const SECTION_NAME = 'multi-root:scope';

/**
 * 系统提示段排序位。
 * 选 950：位于基线策略（persona/plan，0–800）之后、工具专属说明（≥1010）之前。
 */
const SECTION_ORDER = 950;

/** 遍历时跳过的目录名：依赖、构建产物、版本库与虚拟环境，避免把磁盘扫穿。 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target', 'coverage',
  '.next', '.nuxt', '.output', '.turbo', '.cache', '.parcel-cache', '.svelte-kit',
  'venv', '.venv', '__pycache__', '.mypy_cache', '.pytest_cache', '.tox',
  '.idea', '.vscode', '.gradle', 'vendor', '.dart_tool', 'Pods',
]);

/** 单文件读取上限：超过即跳过，避免把大产物或数据文件读进内存。 */
const MAX_FILE_BYTES = 1024 * 1024;

/** 一次 pair_grep 最多扫描的文件数。 */
const MAX_SCANNED_FILES = 20000;

/** 一次 pair_grep 的默认与最大命中数。 */
const DEFAULT_MAX_RESULTS = 100;
const HARD_MAX_RESULTS = 200;

/** 一次 pair_grep 的软超时（毫秒）；超时后返回已收集结果并标记 truncated。 */
const GREP_BUDGET_MS = 8000;

/** 概览里每个目录最多列出的顶层条目数。 */
const MAX_TOP_ENTRIES = 25;

/** 用于识别目录形态的清单文件及其所属技术栈标签。 */
const MANIFESTS = [
  ['package.json', 'node'],
  ['pyproject.toml', 'python'],
  ['requirements.txt', 'python'],
  ['go.mod', 'go'],
  ['Cargo.toml', 'rust'],
  ['pom.xml', 'jvm'],
  ['build.gradle', 'jvm'],
  ['build.gradle.kts', 'jvm'],
  ['composer.json', 'php'],
  ['Gemfile', 'ruby'],
  ['pubspec.yaml', 'dart'],
];

/** 本插件依赖的服务：工具注册表、系统提示注册表、会话目录归属。 */
export const inject = ['tools', 'systemPrompt', 'workingDirectory'];

/** Cordis 插件名。 */
export const name = 'fullstack-pair';

/**
 * 每个会话的额外目录集合，键是会话标识。
 *
 * 为什么按会话标识而不是 agent 对象：GUI（右键菜单 / 面板）走 HTTP 路由改范围，
 * 路由里拿不到 agent 实例，只能拿到会话 id。改用普通 Map + 显式清理（`agent/disposed`），
 * 让"工具/提示"与"GUI"看到同一份状态。
 *
 * 值结构：`Map<绝对路径, 显示标签>`。
 */
const SCOPES = new Map();

/**
 * 会话标识 → 最近一次见到的 agent。
 *
 * GUI 要显示"本次任务范围"的完整清单，其中主根（会话当前目录）只有通过 agent 才能
 * 拿到（`workingDirectory.ensure`），而 HTTP 路由里没有 agent。这里缓存最近一次引用，
 * 工具调用、提示组装、agent 创建三处都会更新它；`agent/disposed` 时清理。
 */
const AGENTS = new Map();

/**
 * fork 的精确来源（`forks`）：子会话 id → 父会话 id，随 `scopes.json` 落盘。
 *
 * DSH 里 `SessionStore.fork()` 不把父会话写进 header（`parentSession` 只用于子代理），
 * 事件前缘里也没有来源标记——只靠事件前缀只能"推理"。而 fork **调用点**是唯一确定知道
 * parent 的时刻，因此在 `apply` 里包装一次 `sessions.fork` 把关系记下来并落盘。
 *
 * 精度分级：`forks` 命中 = 精确；未命中（例如插件安装前就分叉的旧会话）才回落到事件
 * 前缀比对。两者的取舍写在 README 的「分叉继承」一节。
 */

/** 最近一次被创建或参与提示组装的会话标识；GUI 请求未带 sessionId 时用它。 */
let lastSessionKey = '';

/**
 * 从一个 agent 解析会话标识。
 *
 * 防御式读取多个来源：Agent 句柄通常暴露 `session.id`，个别载体只给 `sessionId`；
 * 都拿不到时退回 agent 自身 id，至少保证同一 agent 内隔离。
 *
 * @param agent - 会话 agent。
 * @returns 会话标识；无法解析时为空串。
 */
function sessionKeyOf(agent) {
  const key = agent?.session?.id ?? agent?.sessionId ?? agent?.id;
  return typeof key === 'string' ? key : '';
}

/**
 * 把会话范围渲染成 GUI/Host 共用的 JSON 视图。
 *
 * 已知主根时过滤掉与主根相同的条目：主根本来就隐含在范围里（`buildScope` 把它列为第一条），
 * 再作为"额外目录"列出会造成重复显示与计数错误。
 *
 * @param sessionKey - 会话标识。
 * @param scope - 该会话的额外目录集合。
 * @param primary - 主根 `{ label, path }`，未知时省略或传 null。
 * @returns 可直接 JSON 序列化的范围条目数组。
 */
function scopeEntries(sessionKey, scope, primary = null) {
  const primaryKey = primary === null || primary === undefined ? '' : pathKeyOf(primary.path);
  return {
    sessionId: sessionKey,
    entries: [...scope.entries()]
      .filter(([dir]) => primaryKey === '' || pathKeyOf(dir) !== primaryKey)
      .map(([dir, label]) => ({
        path: dir,
        label: label === '' ? path.basename(dir) : label,
      })),
  };
}

/**
 * 构造 JSON 响应（GUI 的 fetch 直接消费）。
 *
 * @param payload - 任意可 JSON 序列化的结果。
 * @param status - HTTP 状态码，默认 200。
 * @returns Fetch Response。
 */
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * 把任意抛错转成可读文本。
 *
 * @param error - 未知类型的错误值。
 * @returns 错误消息。
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 把一条会话事件压成用于前缀比对的稳定键。
 *
 * 只取 `type` 与 `data`：`seq` 在 fork 两侧本就相同、没有区分度；外层时间戳等字段
 * 若在重建时被改写，反而会造成假阴性。内容相同即视为同一条被复制的事件。
 *
 * @param event - 会话事件。
 * @returns 比对键。
 */
function eventKey(event) {
  try {
    return `${event?.type ?? ''}|${JSON.stringify(event?.data ?? null)}`;
  }
  catch {
    return `${event?.type ?? ''}|<unserializable>`;
  }
}

/**
 * 路径比较键：去掉尾部分隔符并小写（Windows 路径大小写不敏感）。
 *
 * @param value - 任意路径文本。
 * @returns 用于相等判断的键。
 */
function pathKeyOf(value) {
  return String(value).replace(/[\\/]+$/, '').toLowerCase();
}

/**
 * 从范围里移除"就是主根"的条目（历史脏数据自愈）。
 *
 * 为什么要这一步：GUI 的"加入本次任务范围"在早期版本没有校验目标是否就是会话主根，
 * 而主根又总是隐含在范围里（`buildScope` 会把它作为第一条返回），于是同一目录会同时
 * 出现在"主根"和"额外目录"两处——菜单里显示成两个相同条目、计数也多算一个。
 *
 * @param scope - 该会话的额外目录集合（原地修改）。
 * @param primary - 主根 `{ label, path }`，未知时为 null。
 * @returns 是否发生了删除（用于决定要不要落盘）。
 */
function dropPrimaryDuplicate(scope, primary) {
  if (primary === null || primary === undefined) return false;
  const primaryKey = pathKeyOf(primary.path);
  let changed = false;
  for (const dir of [...scope.keys()]) {
    if (pathKeyOf(dir) === primaryKey) {
      scope.delete(dir);
      changed = true;
    }
  }
  return changed;
}

/**
 * 处理 GUI 的范围读写请求。
 *
 * GET：读取最近活跃（或被显式指定）会话的范围。
 * POST：`{ path, label?, remove?, sessionId? }` 加入或移出一个绝对目录。
 *
 * 会话定位策略：请求可带 `sessionId`；不带时用 `lastSessionKey`——它由提示组装、
 * 工具调用、`agent/created` 三处采样更新，因此用户在哪个会话里点菜单，改的就是哪个。
 *
 * @param request - Fetch Request。
 * @returns Fetch Response。
 */
async function handleScopeRequest(request, resolvePrimary) {
  const config = loadConfig();

  if (request.method === 'GET') {
    const url = new URL(request.url);
    const requested = url.searchParams.get('sessionId') ?? '';
    const sessionKey = requested !== '' ? requested : lastSessionKey;
    if (sessionKey === '') return jsonResponse({ ok: false, error: '还没有活跃会话' }, 409);
    const primary = await resolvePrimary(sessionKey);
    const scope = scopeForSession(sessionKey, config.defaults);
    // 自愈：旧版本可能把主根登记成了额外目录，读取时顺手清掉并落盘。
    if (dropPrimaryDuplicate(scope, primary)) persistSession(sessionKey, scope);
    const view = scopeEntries(sessionKey, scope, primary);
    return jsonResponse({ ok: true, primary, recent: recentDirs(), branches: branchView(primary, view.entries), ...view });
  }

  let payload;
  try {
    payload = await request.json();
  }
  catch {
    return jsonResponse({ ok: false, error: '请求体不是合法 JSON' }, 400);
  }

  const requested = typeof payload?.sessionId === 'string' ? payload.sessionId : '';
  const sessionKey = requested !== '' ? requested : lastSessionKey;
  if (sessionKey === '') return jsonResponse({ ok: false, error: '还没有活跃会话' }, 409);

  const rawPath = typeof payload?.path === 'string' ? payload.path.trim() : '';
  if (rawPath === '' || !path.isAbsolute(rawPath)) {
    return jsonResponse({ ok: false, error: `path 必须是绝对路径（收到 "${rawPath}"）` }, 400);
  }
  const target = path.resolve(rawPath);
  const scope = scopeForSession(sessionKey, config.defaults);
  const primary = await resolvePrimary(sessionKey);
  const targetIsPrimary = primary !== null && pathKeyOf(primary.path) === pathKeyOf(target);

  if (payload.remove === true) {
    scope.delete(target);
  }
  else if (targetIsPrimary) {
    // 主根永远在范围里，重复登记没有意义：不写入，并顺手删掉可能存在的旧脏条目。
    scope.delete(target);
  }
  else {
    let isDirectory = false;
    try {
      isDirectory = statSync(target).isDirectory();
    }
    catch {
      isDirectory = false;
    }
    if (!isDirectory) return jsonResponse({ ok: false, error: `目录不存在或不是目录：${target}` }, 400);
    const label = typeof payload.label === 'string' ? payload.label.trim() : '';
    scope.set(target, label);
    // 记进"最近使用"，下次可以不开对话框直接点。
    rememberRecent(target, label);
  }

  // 无论走哪条分支都再清一次主根脏条目，然后落盘（GUI 点菜单也是真实变更）。
  dropPrimaryDuplicate(scope, primary);
  persistSession(sessionKey, scope);

  const view = scopeEntries(sessionKey, scope, primary);
  return jsonResponse({ ok: true, primary, recent: recentDirs(), branches: branchView(primary, view.entries), ...view });
}
/**
 * 读取可选配置。
 *
 * 读取失败不抛错——把失败信息带回去，让工具结果如实报告"配置不可用"，
 * 而不是让插件在激活阶段崩掉。配置文件缺失是正常状态（纯运行时模式）。
 *
 * @returns 预置目录列表、跨目录约定与读取错误。
 */
function loadConfig() {
  let raw = {};
  let readError = '';
  try {
    raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  }
  catch (error) {
    if (existsSync(CONFIG_FILE)) readError = error instanceof Error ? error.message : String(error);
  }

  const defaults = Array.isArray(raw.defaults)
    ? raw.defaults
      .filter((entry) => entry !== null && typeof entry === 'object')
      .map((entry) => ({
        path: typeof entry.path === 'string' ? entry.path.trim() : '',
        label: typeof entry.label === 'string' ? entry.label.trim() : '',
      }))
      .filter((entry) => entry.path !== '')
      .map((entry) => ({ ...entry, path: path.resolve(entry.path) }))
    : [];

  return {
    defaults,
    readError,
    conventions: typeof raw.conventions === 'string' ? raw.conventions : '',
  };
}

/**
 * 生成"范围视图"：主根（会话当前目录）加额外关联目录。
 *
 * @param primary - 会话当前目录的绝对路径。
 * @param scope - 额外目录集合。
 * @returns 统一结构的范围条目数组，主根排在最前。
 */
function buildScope(primary, scope) {
  const entries = [{ label: '工作区', path: primary, primary: true }];
  for (const [dir, label] of scope) {
    // 与主根重复的关联没有意义，避免同一目录在概览里出现两次。
    if (dir === primary) continue;
    entries.push({ label: label === '' ? path.basename(dir) : label, path: dir, primary: false });
  }
  return entries;
}

/**
 * 渲染系统提示段。
 *
 * 同步实现是硬约束：提示组装是同步的，因此这里只读内存态集合，不调用
 * `workingDirectory.ensure`（异步）——主根由各工具在执行时解析。
 *
 * @param scope - 该 agent 的额外目录集合。
 * @param conventions - 配置里的跨目录约定文本。
 * @returns 提示段正文；未关联任何额外目录时返回一段极简说明（保证能力可被发现）。
 */
function renderPrompt(scope, conventions) {
  const labels = [...scope.entries()];
  const head = '## 多目录任务范围';
  const lines = [head, ''];

  if (labels.length === 0) {
    lines.push(
      '本会话的检索范围当前只有会话工作区。',
      '如果本次任务需要同时处理工作区之外的目录（例如另一个仓库、另一层工程），',
      '先用 `pair_use` 把它们纳入范围，再继续；`pair_overview` 可查看范围内各目录的结构与 git 状态，',
      '`pair_grep` 可跨范围一次检索。',
    );
    return lines.join('\n');
  }

  lines.push('本次任务已纳入以下额外目录（与会话工作区共同构成检索范围）：', '');
  for (const [dir, label] of labels) {
    const exists = existsSync(dir);
    lines.push(`- ${label === '' ? path.basename(dir) : label}：\`${dir}\`${exists ? '' : '〔路径当前不存在〕'}`);
  }
  if (conventions.trim() !== '') {
    lines.push('', '跨目录约定：', conventions.trim());
  }
  lines.push(
    '',
    '工作方式：',
    '1. 跨目录访问一律使用绝对路径；相对路径仍按会话当前目录解析。',
    '2. 需要再纳入一个目录时调用 `pair_use`，不要用 shell 逐个目录 ls/grep 代替。',
    '3. 改动跨目录时先读相关各自代码，完成后按各自工程的验证命令逐项确认。',
    '4. 若写入某个目录被文件沙箱拒绝，如实报告阻塞并继续可完成的部分，不要空转重试。',
  );
  return lines.join('\n');
}

/**
 * 列出一个目录的顶层条目（只读、限条数）。
 *
 * @param dir - 绝对目录路径。
 * @returns 顶层条目名（目录以 `/` 结尾）；不可读时返回空数组。
 */
function listTopEntries(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.name !== '.git')
      .slice(0, MAX_TOP_ENTRIES)
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
  }
  catch {
    return [];
  }
}

/**
 * 识别目录形态：读取已知清单文件，返回命中的技术栈标签，并附带 node 主包名（若有）。
 *
 * @param dir - 绝对目录路径。
 * @returns 技术栈标签数组；无法识别时为空数组。
 */
function detectStacks(dir) {
  const stacks = [];
  for (const [file, label] of MANIFESTS) {
    if (!existsSync(path.join(dir, file))) continue;
    if (!stacks.includes(label)) stacks.push(label);
  }
  const pkgFile = path.join(dir, 'package.json');
  if (stacks.includes('node') && existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
      if (typeof pkg.name === 'string' && pkg.name !== '') stacks[stacks.indexOf('node')] = `node (${pkg.name})`;
    }
    catch {
      // 清单损坏不影响"这是 node 工程"的判断，保持标签原样。
    }
  }
  return stacks;
}

/**
 * 读取一个目录的 git 状态：分支名与未提交条目数。
 *
 * 失败（不是 git 仓库、git 不在 PATH）时返回空分支与 -1，由调用方翻译成"未知"，绝不猜测。
 *
 * @param dir - 目录绝对路径。
 * @returns 分支名（未知为空串）与未提交条目数（未知为 -1）。
 */
function gitState(dir) {
  try {
    const output = execFileSync('git', ['-C', dir, 'status', '--porcelain=v1', '-b'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const lines = output.split(/\r?\n/).filter((line) => line !== '');
    const header = lines.find((line) => line.startsWith('## ')) ?? '';
    // 分支头形如 `## main...origin/main [ahead 1]` 或 `## HEAD (no branch)`。
    const branch = header.replace(/^## /, '').split('...')[0].split(' ')[0];
    const changed = lines.filter((line) => !line.startsWith('## ')).length;
    return { branch: branch === '' ? '(unknown)' : branch, changed };
  }
  catch {
    return { branch: '', changed: -1 };
  }
}

/** git 分支信息的缓存时长：header 会周期性刷新，不能每次都真的跑 git。 */
const BRANCH_CACHE_TTL_MS = 15000;

/** 目录 → `{ branch, at }` 的分支缓存。 */
const branchCache = new Map();

/**
 * 取目录的当前 git 分支（带缓存）。
 *
 * 缓存的意义：会话头部的徽章每 15 秒刷新一次，而一次 `git status` 在大型仓库上可能
 * 耗时几十毫秒；没有缓存的话，仅为了显示分支名就会周期性拖慢界面的数据请求。
 *
 * @param dir - 目录绝对路径。
 * @returns 分支名；不是 git 仓库或 git 不可用时为空串。
 */
function branchOf(dir) {
  const now = Date.now();
  const cached = branchCache.get(dir);
  if (cached !== undefined && now - cached.at < BRANCH_CACHE_TTL_MS) return cached.branch;
  const { branch } = gitState(dir);
  branchCache.set(dir, { branch, at: now });
  return branch;
}

/**
 * 构造范围各目录的分支视图，供会话头部徽章显示。
 *
 * @param primary - 主根 `{ label, path }` 或 null。
 * @param entries - 额外目录（已过滤主根重复项）。
 * @returns `[{ path, branch }]`，顺序为主根在前。
 */
function branchView(primary, entries) {
  const items = [];
  if (primary !== null && primary !== undefined) {
    items.push({ path: primary.path, branch: branchOf(primary.path) });
  }
  for (const entry of entries) {
    items.push({ path: entry.path, branch: branchOf(entry.path) });
  }
  return items;
}

/**
 * 深度优先遍历目录树（生成器），跳过依赖/构建/版本库目录与符号链接。
 *
 * @param root - 起始目录。
 * @param state - 共享预算状态（已扫描文件数、起始时间、是否被截断）。
 * @yields 每个候选文件的绝对路径。
 */
function* walkFiles(root, state) {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    }
    catch {
      continue;
    }
    for (const entry of entries) {
      // 符号链接一律跳过：既避免循环，也避免把范围外的目录扫进来。
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (state.scanned >= MAX_SCANNED_FILES || Date.now() - state.startedAt > GREP_BUDGET_MS) {
        state.truncated = true;
        return;
      }
      state.scanned += 1;
      yield full;
    }
  }
}

/**
 * 判断相对路径是否匹配用户给的 glob。
 *
 * 只支持两种最常见写法（后缀式 `*.ts`、子串式 `src/api`），避免引入 glob 依赖。
 *
 * @param relative - 相对于目录根的路径（统一用 `/` 分隔）。
 * @param glob - 匹配串；空串表示不过滤。
 * @returns 是否匹配。
 */
function matchesGlob(relative, glob) {
  if (glob === '') return true;
  if (glob.startsWith('*.')) return relative.endsWith(glob.slice(1));
  return relative.includes(glob);
}

/**
 * 在一个目录内按正则检索文本。
 *
 * @param entry - 范围条目（含 label 与绝对路径）。
 * @param regex - 编译好的正则。
 * @param glob - 路径过滤串。
 * @param limit - 本目录最多返回的命中数。
 * @param state - 共享预算状态。
 * @returns 命中数组。
 */
function grepDirectory(entry, regex, glob, limit, state) {
  const hits = [];
  if (limit <= 0) return hits;
  for (const file of walkFiles(entry.path, state)) {
    if (hits.length >= limit) return hits;
    const relative = path.relative(entry.path, file).split(path.sep).join('/');
    if (!matchesGlob(relative, glob)) continue;
    let text;
    try {
      if (statSync(file).size > MAX_FILE_BYTES) continue;
      text = readFileSync(file, 'utf8');
    }
    catch {
      continue;
    }
    // 含 NUL 的按二进制处理：文本检索对它们没有意义。
    if (text.includes('\u0000')) continue;
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (!regex.test(lines[index])) continue;
      hits.push({
        label: entry.label,
        file: path.join(entry.path, relative),
        line: index + 1,
        text: lines[index].length > 300 ? `${lines[index].slice(0, 300)}…` : lines[index],
      });
      if (hits.length >= limit) break;
    }
  }
  return hits;
}

/**
 * 把范围条目渲染成模型可见文本（pair_use 的返回）。
 *
 * @param value - 工具返回值。
 * @returns 文本块数组。
 */
function renderScope(value) {
  const lines = value.scope.map((entry) => `${entry.primary ? '★ ' : '  '}${entry.label}：${entry.path}`);
  const head = value.changed ? '范围已更新。' : '当前范围：';
  return [{ type: 'text', text: `${head}\n${lines.join('\n')}` }];
}

/**
 * 把概览结果渲染成模型可见文本。
 *
 * @param value - 工具返回值。
 * @returns 文本块数组。
 */
function renderOverview(value) {
  const blocks = value.directories.map((dir) => {
    const stacks = dir.manifests.length === 0 ? '未识别' : dir.manifests.join(', ');
    const git = dir.gitChanged < 0
      ? 'git：未知（不是仓库或 git 不可用）'
      : `git：${dir.gitBranch}，未提交 ${dir.gitChanged} 项`;
    const entries = dir.entries.length === 0 ? '（空目录或不可读）' : dir.entries.join('  ');
    return [
      `【${dir.label}】${dir.primary ? '（工作区）' : ''}${dir.path}`,
      `  技术栈：${stacks}`,
      `  ${git}`,
      `  顶层：${entries}`,
    ].join('\n');
  });
  return [{ type: 'text', text: blocks.join('\n\n') }];
}

/**
 * 把检索结果渲染成模型可见文本。
 *
 * @param value - 工具返回值。
 * @returns 文本块数组。
 */
function renderGrep(value) {
  if (value.matches.length === 0) {
    return [{ type: 'text', text: `没有命中。已扫描 ${value.scannedFiles} 个文件（pattern=${value.pattern}）。` }];
  }
  const lines = value.matches.map((hit) => `${hit.label}:${hit.file}:${hit.line}: ${hit.text}`);
  const tail = value.truncated
    ? `\n\n结果已截断：仅返回前 ${value.matches.length} 条（共扫描 ${value.scannedFiles} 个文件）。收窄 pattern/glob 可得到更精确的结果。`
    : '';
  return [{ type: 'text', text: `命中 ${value.matches.length} 条：\n${lines.join('\n')}${tail}` }];
}

/** 范围管理工具的输出来结构。 */
const SCOPE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['primary', 'changed', 'scope'],
  properties: {
    primary: { type: 'string', description: '会话当前目录的绝对路径。' },
    changed: { type: 'boolean', description: '本次调用是否改变了范围。' },
    scope: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'path', 'primary'],
        properties: {
          label: { type: 'string' },
          path: { type: 'string' },
          primary: { type: 'boolean' },
        },
      },
    },
  },
};

/** 概览工具的输出来结构。 */
const OVERVIEW_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['directories'],
  properties: {
    directories: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'path', 'primary', 'exists', 'entries', 'manifests', 'gitBranch', 'gitChanged'],
        properties: {
          label: { type: 'string' },
          path: { type: 'string' },
          primary: { type: 'boolean' },
          exists: { type: 'boolean' },
          entries: { type: 'array', items: { type: 'string' } },
          manifests: { type: 'array', items: { type: 'string' } },
          gitBranch: { type: 'string' },
          gitChanged: { type: 'integer' },
        },
      },
    },
  },
};

/** 检索工具的输出来结构。 */
const GREP_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pattern', 'scannedFiles', 'truncated', 'matches'],
  properties: {
    pattern: { type: 'string' },
    scannedFiles: { type: 'integer' },
    truncated: { type: 'boolean' },
    matches: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'file', 'line', 'text'],
        properties: {
          label: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'integer' },
          text: { type: 'string' },
        },
      },
    },
  },
};

/**
 * 插件入口：注册范围管理工具、两个只读跨目录工具，并注入提示段。
 *
 * @param ctx - 插件上下文（含 tools、systemPrompt、workingDirectory 服务）。
 */
export function apply(ctx) {
  // 状态目录先建好：所有写盘（范围、fork 映射、自检文件）都落在这里，
  // 不再写插件本体目录，因此打包安装后升级替换包目录也不会丢状态。
  try {
    mkdirSync(STATE_DIR, { recursive: true });
  }
  catch (error) {
    // 建不出来时后续写盘会各自告警，不在这里中断插件激活。
    ctx.logger?.warn?.(`[fullstack-pair] 无法创建状态目录 ${STATE_DIR}：${messageOf(error)}`);
  }

  // 持久化失败（磁盘不可写、文件损坏）必须留痕，否则"范围悄悄丢了"无从排查。
  reportWarning = (message) => {
    try {
      ctx.logger?.warn?.(`[fullstack-pair] ${message}`);
    }
    catch {
      // 日志器本身不可用时不递归；持久化失败已经不影响内存态功能。
    }
  };
  /**
   * 解析当前 agent 的完整范围：主根来自会话当前目录，额外目录来自内存态集合。
   *
   * @param agent - 会话 agent。
   * @param signal - 当前调用的取消信号。
   * @returns 主根路径与该 agent 的额外目录集合。
   */
  async function resolveScope(agent, signal) {
    const primary = await ctx.workingDirectory.ensure(agent, signal);
    const sessionKey = sessionKeyOf(agent);
    // 工具调用是最强的"当前会话"信号：GUI 路由在未带 sessionId 时依赖它。
    if (sessionKey !== '') {
      lastSessionKey = sessionKey;
      // 同时保留 agent 引用，GUI 才能解析主根路径。
      AGENTS.set(sessionKey, agent);
    }
    const scope = scopeForSession(sessionKey, loadConfig().defaults);
    return { primary, scope, sessionKey };
  }

  /**
   * 解析某个会话的主根（会话当前目录），供 GUI 显示"工作区"那一行。
   *
   * 两条来源，按准确性排序：
   * 1. **agent 的当前目录**（`workingDirectory.ensure`）——能反映会话内 `cd` 之后的位置，
   *    但要求插件见过该 agent（调过工具，或在插件加载之后创建的 agent）；
   * 2. **会话 header 的 `cwd`**——创建时写入、不随 `cd` 改变，但只要有 live session 就能读，
   *    因此覆盖"纯聊天没调过工具""插件重装前就存在"的会话。
   *
   * 之所以要第 2 条：只走第 1 条时，同一工作区下有的会话菜单能显示 ★ 主根、有的不能，
   * 取决于它碰巧有没有被插件见过——那是实现细节泄漏，不是合理行为。
   *
   * 两条都取不到时返回 null（GUI 少显示一行），而不是让菜单报错。
   *
   * @param sessionKey - 会话标识。
   * @returns `{ label, path }` 或 null。
   */
  async function resolvePrimary(sessionKey) {
    const agent = AGENTS.get(sessionKey);
    if (agent !== undefined) {
      try {
        const primary = await ctx.workingDirectory.ensure(agent, new AbortController().signal);
        if (typeof primary === 'string' && primary !== '') {
          return { label: path.basename(primary) || primary, path: primary };
        }
      }
      catch {
        // 落到 header 兜底：agent 刚释放或 ensure 失败时，header 仍然可用。
      }
    }

    try {
      const sessions = ctx.get('sessions');
      const cwd = sessions?.get?.(sessionKey)?.header?.cwd;
      if (typeof cwd === 'string' && cwd !== '') {
        return { label: path.basename(cwd) || cwd, path: cwd };
      }
    }
    catch {
      // 读取 header 失败同样只降级为"没有主根"，不影响其它逻辑。
    }
    return null;
  }

  /**
   * 按 label 或绝对路径在范围里定位条目；未命中返回 undefined。
   *
   * @param entries - 范围条目数组。
   * @param target - label 或绝对路径。
   * @returns 命中的条目。
   */
  function pickTarget(entries, target) {
    const wanted = target.trim();
    if (wanted === '') return undefined;
    const resolved = path.isAbsolute(wanted) ? path.resolve(wanted) : '';
    return entries.find((entry) => entry.label === wanted)
      ?? (resolved === '' ? undefined : entries.find((entry) => path.resolve(entry.path) === resolved));
  }

  ctx.tools.register({
    name: 'pair_use',
    description:
      '管理本次任务的多目录范围。不传参数：列出当前范围（会话工作区 + 已关联目录）。'
      + '传 path：把该绝对目录纳入范围，之后 pair_overview / pair_grep 都会覆盖它。'
      + '传 path 并设 remove=true：移出范围。'
      + '当用户提到工作区之外的另一个目录/仓库、并要求把它们当作同一任务处理时，先调用本工具关联，'
      + '不要用 shell 逐个目录 ls 或 grep 代替。只改检索范围，不改变任何文件。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '要关联（或移出）的目录绝对路径；省略则只列出当前范围。' },
        label: { type: 'string', description: '给该目录起的短名，用于提示与检索结果；省略则用目录名。' },
        remove: { type: 'boolean', description: '为 true 时把 path 移出范围。' },
      },
    },
    output: {
      schema: SCOPE_OUTPUT_SCHEMA,
      render: (_args, value) => renderScope(value),
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('pair_use 需要一个会话上下文');
      const { primary, scope, sessionKey } = await resolveScope(exec.agent, exec.signal);

      if (typeof args.path !== 'string' || args.path.trim() === '') {
        return { primary, changed: false, scope: buildScope(primary, scope) };
      }

      const raw = args.path.trim();
      if (!path.isAbsolute(raw)) {
        throw new Error(`path 必须是绝对路径（收到 "${raw}"）；相对路径的基准目录在不同调用间不稳定`);
      }
      const target = path.resolve(raw);

      if (args.remove === true) {
        scope.delete(target);
        // 变更即落盘：会话结束/DSH 重启后范围仍然在。
        persistSession(sessionKey, scope);
        return { primary, changed: true, scope: buildScope(primary, scope) };
      }

      let isDirectory = false;
      try {
        isDirectory = statSync(target).isDirectory();
      }
      catch {
        isDirectory = false;
      }
      if (!isDirectory) throw new Error(`目录不存在或不是目录：${target}`);

      // 主根本来就是范围的第一项（`buildScope` 会列出它），再登记进额外目录会造成
      // 列表里同一目录出现两次。这里拒绝写入，并顺手清掉可能存在的旧脏条目。
      if (pathKeyOf(target) === pathKeyOf(primary)) {
        const changed = scope.delete(target);
        if (changed) persistSession(sessionKey, scope);
        return { primary, changed, scope: buildScope(primary, scope) };
      }

      const label = typeof args.label === 'string' ? args.label.trim() : '';
      scope.set(target, label);
      // 记进"最近使用"；与范围变更共用同一次落盘。
      rememberRecent(target, label);
      persistSession(sessionKey, scope);
      return { primary, changed: true, scope: buildScope(primary, scope) };
    },
  });

  ctx.tools.register({
    name: 'pair_overview',
    description:
      '列出本会话多目录范围内各目录的绝对路径、是否存在、顶层条目、技术栈与 git 状态。'
      + '在跨目录改动前用它建立整体形状，避免逐个目录 ls。只读，不修改任何文件。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: { type: 'string', description: '只看某个目录（label 或绝对路径）；省略则返回范围内的全部目录。' },
      },
    },
    output: {
      schema: OVERVIEW_OUTPUT_SCHEMA,
      render: (_args, value) => renderOverview(value),
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('pair_overview 需要一个会话上下文');
      const { primary, scope } = await resolveScope(exec.agent, exec.signal);
      const entries = buildScope(primary, scope);

      let selected = entries;
      if (typeof args.target === 'string' && args.target.trim() !== '') {
        const hit = pickTarget(entries, args.target);
        if (hit === undefined) {
          const known = entries.map((entry) => `${entry.label}(${entry.path})`).join('、');
          throw new Error(`范围内没有 "${args.target}"；当前范围：${known}`);
        }
        selected = [hit];
      }

      const directories = selected.map((entry) => {
        const exists = existsSync(entry.path);
        const git = exists ? gitState(entry.path) : { branch: '', changed: -1 };
        return {
          label: entry.label,
          path: entry.path,
          primary: entry.primary,
          exists,
          entries: exists ? listTopEntries(entry.path) : [],
          manifests: exists ? detectStacks(entry.path) : [],
          gitBranch: git.branch,
          gitChanged: git.changed,
        };
      });
      return { directories };
    },
  });

  ctx.tools.register({
    name: 'pair_grep',
    description:
      '在本会话的多目录范围内跨目录检索文本（正则）。一次调用即可同时搜索多个根，'
      + '自动跳过 node_modules、构建产物与版本库目录。只读。'
      + '比逐个目录调用 grep 更省调用轮次；需要精确控制时再回退到官方 grep。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['pattern'],
      properties: {
        pattern: { type: 'string', description: '正则源。不要太宽泛，以免结果被截断。' },
        target: { type: 'string', description: '只检索某个目录（label 或绝对路径）；省略则检索范围内全部目录。' },
        glob: { type: 'string', description: '路径过滤：支持 `*.ts` 后缀形式或 `src/api` 子串形式；省略则不过滤。' },
        maxResults: { type: 'integer', description: `最多返回多少条命中，默认 ${DEFAULT_MAX_RESULTS}，上限 ${HARD_MAX_RESULTS}。` },
        caseSensitive: { type: 'boolean', description: '是否区分大小写，默认 false。' },
      },
    },
    output: {
      schema: GREP_OUTPUT_SCHEMA,
      render: (_args, value) => renderGrep(value),
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('pair_grep 需要一个会话上下文');
      const { primary, scope } = await resolveScope(exec.agent, exec.signal);
      const entries = buildScope(primary, scope);

      let selected = entries;
      if (typeof args.target === 'string' && args.target.trim() !== '') {
        const hit = pickTarget(entries, args.target);
        if (hit === undefined) {
          const known = entries.map((entry) => `${entry.label}(${entry.path})`).join('、');
          throw new Error(`范围内没有 "${args.target}"；当前范围：${known}`);
        }
        selected = [hit];
      }

      const source = args.pattern;
      if (source.length > 200) throw new Error('pattern 过长（上限 200 字符）');
      let regex;
      try {
        regex = new RegExp(source, args.caseSensitive === true ? '' : 'i');
      }
      catch (error) {
        throw new Error(`pattern 不是合法正则：${error instanceof Error ? error.message : String(error)}`);
      }

      const requested = Number.isInteger(args.maxResults) ? args.maxResults : DEFAULT_MAX_RESULTS;
      const limit = Math.max(1, Math.min(HARD_MAX_RESULTS, requested));
      const state = { scanned: 0, startedAt: Date.now(), truncated: false };
      const matches = [];
      for (const entry of selected) {
        if (!existsSync(entry.path)) continue;
        const remaining = limit - matches.length;
        if (remaining <= 0) {
          state.truncated = true;
          break;
        }
        const glob = typeof args.glob === 'string' ? args.glob.trim() : '';
        matches.push(...grepDirectory(entry, regex, glob, remaining, state));
        if (matches.length >= limit) state.truncated = true;
      }

      return { pattern: source, scannedFiles: state.scanned, truncated: state.truncated, matches };
    },
  });

  // 提示段按会话渲染：text 是函数，组装上下文携带 agent（assembleContextFor），
  // 因此每个会话看到的是"自己已关联的目录"。关联后下一次请求立即生效。
  // interpolate:false 是必需的：目录路径里可能出现 `{{`，不能被当成提示变量。
  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: (context) => {
      const agent = context?.agent ?? context?.scope;
      if (agent === undefined) return '';
      const config = loadConfig();
      const key = sessionKeyOf(agent);
      // 提示组装每轮都会发生，是最可靠的"活跃会话"采样点。
      if (key !== '') lastSessionKey = key;
      return renderPrompt(scopeForSession(key, config.defaults), config.conventions);
    },
    interpolate: false,
  });

  // ── Client ↔ Host 数据通道（GUI 的读写接口）──────────────────────────────
  // 已实测：第三方插件可通过 `connection.fetch.register` 注册 `/api/` 下的精确路由，
  // 浏览器页面（含 Desktop 的 dsh-app:// 载体）能直接 fetch 到它。下面的路由就是
  // 工作区右键菜单的实现基础。
  // 用 `ctx.inject` 而不是顶层 inject：connection 服务缺席时插件仍保持激活，
  // 只是拿不到这条路（不影响工具与提示段）。
  ctx.inject(['connection'], (connectionCtx) => {
    const connection = connectionCtx.connection;

    // 约束（来自 client-connection 实现）：
    // - 路径必须形如 `/api/<段>`，每段只允许 [A-Za-z0-9_$.-]；
    // - 同一个 path 的多个方法写进 methods 数组，由 handler 自行分支；
    // - 注册 effect 归 connection 服务自己的 ctx，因此必须显式把 disposer 绑到插件 ctx。
    connectionCtx.effect(() => connection.fetch.register({
      path: HEALTH_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: () => Promise.resolve(jsonResponse({ ok: true, plugin: name, at: new Date().toISOString() })),
    }), 'fullstack-pair: health route');

    // 范围读写：GUI 的「加入/移出本次任务范围」直接调它，点完立即生效。
    connectionCtx.effect(() => connection.fetch.register({
      path: SCOPE_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: (request) => handleScopeRequest(request, resolvePrimary),
    }), 'fullstack-pair: scope route');

    // Client 加载自检：页面里的 Client 半部挂载时上报一次，落盘供 agent 读，
    // 用于确认"Client 插件确实被页面加载了"，不依赖人眼或截图。
    connectionCtx.effect(() => connection.fetch.register({
      path: CLIENT_READY_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const payload = await request.json();
          writeFileSync(CLIENT_READY_FILE, JSON.stringify({ at: new Date().toISOString(), payload }, null, 2), 'utf8');
          return jsonResponse({ ok: true });
        }
        catch (error) {
          return jsonResponse({ ok: false, error: messageOf(error) }, 400);
        }
      },
    }), 'fullstack-pair: client-ready route');
  });

  // ── fork 精确来源：包装 SessionStore.fork ────────────────────────────────
  // fork() 不把父会话写进 header，事件里也没有来源标记，所以前缀比对只能"推理"。
  // 在调用点记录一次是最省事的精确方案：包装器只做三件事——透传参数、调原方法、
  // 把 (childId → parentId) 写进映射，**不改变任何 fork 语义**；插件卸载时恢复原方法。
  ctx.inject(['sessions'], (sessionCtx) => {
    const sessions = sessionCtx.sessions;
    const original = sessions?.fork;
    if (typeof original !== 'function') return;

    // 用 rest 参数转发：即使将来 fork 增加可选参数，包装也不会丢参数或错位。
    const wrapped = function wrappedFork(...args) {
      const child = original.apply(this, args);
      try {
        const [source] = args;
        const parentId = typeof source === 'string' ? source : source?.id;
        if (typeof parentId === 'string' && parentId !== '' && typeof child?.id === 'string' && child.id !== '') {
          // 落盘记录：即使分叉后立刻重启，打开子会话时也能精确找到父。
          rememberFork(child.id, parentId);
        }
      }
      catch {
        // 记录失败只影响继承精度（回落到前缀比对），绝不影响 fork 本身。
      }
      return child;
    };

    sessions.fork = wrapped;
    sessionCtx.effect(() => () => {
      // 只有仍是我们的包装时才恢复，避免覆盖其它消费者后来的改动。
      if (sessions.fork === wrapped) sessions.fork = original;
    }, 'fullstack-pair: fork parent hook');
  });

  // 跟踪活跃会话：GUI 请求不带 sessionId 时靠它定位到要改的范围。
  // 事件名或 payload 若与当前版本不符，这里只是不触发——工具调用与提示组装
  // 仍会更新 lastSessionKey，功能不受影响。
  ctx.on('agent/created', (payload) => {
    // payload 形态在不同版本可能是 `{ agent }` 或 agent 本身，两种都兼容。
    const agent = payload?.agent ?? payload;
    const key = sessionKeyOf(agent);
    if (key !== '') {
      lastSessionKey = key;
      AGENTS.set(key, agent);
    }
    // fork 出来的会话在这里尝试继承父会话范围；不成立时只写诊断文件，不影响任何功能。
    void maybeInheritForkScope(agent);
  });
  ctx.on('agent/disposed', (payload) => {
    const agent = payload?.agent ?? payload;
    const key = sessionKeyOf(agent);
    if (key !== '') {
      SCOPES.delete(key);
      AGENTS.delete(key);
    }
  });

  /**
   * fork 继承：识别"刚分叉出来的会话"，把父会话的范围复制过来。
   *
   * ## 判定依据（不是启发式）
   *
   * `SessionStore.fork()` 把父会话事件**原样复制**成子会话前缀，并在 Session 上记录
   * `inheritedEventCount`（复制了多少条）；header 的 `isSeeded` 标记这是 seeded 会话。
   * 因此拿子会话的前 N 条事件，与其他 live 会话同位置事件逐条比对 `type + data`：
   * 完全相同的那一个就是父会话。
   *
   * 为什么可以据此断定：不同会话不可能产出完全相同的事件前缀；而同一个父会话被多次
   * fork 时前缀相同、复制同一份范围也是正确结果。
   *
   * ## 降级
   *
   * 父会话不在 live 列表（已归档/已关闭）、前缀不足、没有 sessions 服务时，一律跳过并
   * 记录原因，不做任何猜测性复制。
   *
   * @param agent - 刚创建的 agent（可能没有 session，此时直接返回）。
   * @returns 无；结论写入 `FORK_PROBE_FILE`。
   */
  async function maybeInheritForkScope(agent) {
    const session = agent?.session;
    if (session === undefined) return;
    const sessionKey = sessionKeyOf(agent);
    if (sessionKey === '') return;

    const report = { at: new Date().toISOString(), sessionId: sessionKey };
    const writeReport = () => {
      try {
        writeFileSync(FORK_PROBE_FILE, JSON.stringify(report, null, 2), 'utf8');
      }
      catch {
        // 诊断文件写失败不影响继承本身，也不改内存状态。
      }
    };

    try {
      loadPersisted();
      report.isSeeded = session.header?.isSeeded === true;
      if (!report.isSeeded) {
        report.skipped = 'not-seeded';
        writeReport();
        return;
      }

      // 已有范围（内存或磁盘）就不覆盖：用户手动加过的优先于自动继承。
      const existing = SCOPES.get(sessionKey) ?? persisted.sessions.get(sessionKey)?.entries;
      if (existing !== undefined && existing.size > 0) {
        report.skipped = 'already-has-scope';
        writeReport();
        return;
      }

      /**
       * 把父会话的范围复制到本会话，并把过程写进报告。
       *
       * @param parentKey - 父会话标识。
       * @param source - 来源标记：`fork-hook`（精确）或 `prefix-match`（推理兜底）。
       * @returns 无。
       */
      const adoptFrom = (parentKey, source) => {
        report.source = source;
        report.matchedParent = parentKey;
        const parentScope = SCOPES.get(parentKey) ?? persisted.sessions.get(parentKey)?.entries;
        report.parentEntries = parentScope === undefined ? [] : [...parentScope.keys()];
        if (parentScope !== undefined && parentScope.size > 0) {
          const scope = scopeForSession(sessionKey, []);
          for (const [dir, label] of parentScope) scope.set(dir, label);
          persistSession(sessionKey, scope);
          report.copied = [...scope.keys()];
        }
        writeReport();
      };

      // 首选：fork 调用点记录下来的精确来源（已落盘，跨重启有效），不需要任何推理。
      const hookedParent = persisted.forks.get(sessionKey);
      if (typeof hookedParent === 'string' && hookedParent !== '') {
        adoptFrom(hookedParent, 'fork-hook');
        return;
      }

      const inherited = Number(session.inheritedEventCount ?? 0);
      report.inheritedEventCount = Number.isFinite(inherited) ? inherited : 0;
      if (!Number.isFinite(inherited) || inherited <= 0) {
        report.skipped = 'no-inherited-events';
        writeReport();
        return;
      }

      const sessions = ctx.get('sessions');
      if (sessions === undefined) {
        report.skipped = 'no-sessions-service';
        writeReport();
        return;
      }

      // 判定规则（缺一不可）：
      //   1. 候选的**事件总数**必须覆盖完整的继承前缀（`seq >= inherited`）——
      //      祖先会话的事件数比直接父少，这一步就能把 A 从 A→A1→A2 的链里排除掉；
      //   2. 比对前缀的**头 10 条 + 尾 10 条**：头能区分不同源，尾能区分"从同一父分叉、
      //      但父之后又各自增长的兄弟会话"；前缀很短时退化为全量比对；
      //   3. 多个候选同时匹配时，选事件数最接近继承长度的（最可能是直接父）。
      const edge = 10;
      const headCount = Math.min(edge, inherited);
      const tailStart = Math.max(headCount, inherited - edge);
      const head = session.snapshotEvents(0, headCount).map(eventKey);
      const tail = tailStart < inherited ? session.snapshotEvents(tailStart, inherited).map(eventKey) : [];
      report.probeLength = headCount + tail.length;
      report.prefix = head;
      report.suffix = tail;

      /**
       * 判断一个候选是否完整覆盖子会话的继承前缀。
       *
       * @param other - 候选会话。
       * @returns 是否匹配。
       */
      const matchesPrefix = (other) => {
        const total = Number(other.seq ?? 0);
        if (!Number.isFinite(total) || total < inherited) return false;
        const otherHead = other.snapshotEvents(0, headCount).map(eventKey);
        if (otherHead.length < head.length) return false;
        if (!head.every((value, index) => value === otherHead[index])) return false;
        if (tail.length === 0) return true;
        const otherTail = other.snapshotEvents(tailStart, inherited).map(eventKey);
        if (otherTail.length < tail.length) return false;
        return tail.every((value, index) => value === otherTail[index]);
      };

      const candidates = [];
      let best;
      for (const other of sessions.list()) {
        if (other.id === session.id) continue;
        let matched = false;
        try {
          matched = matchesPrefix(other);
        }
        catch {
          matched = false;
        }
        const total = Number(other.seq ?? -1);
        candidates.push({ id: other.id, seq: Number.isFinite(total) ? total : -1, cwd: other.header?.cwd ?? null, matched });
        if (!matched) continue;
        // 事件数最接近继承长度的候选最可能是直接父（祖先已被规则 1 排除）。
        if (best === undefined || total < best.seq) best = { session: other, seq: total };
      }

      report.candidates = candidates;
      if (best === undefined) {
        report.skipped = 'no-parent-match';
        writeReport();
        return;
      }
      // 没有 fork 钩子记录时（插件重启后等），回落到事件前缀推理。
      adoptFrom(best.session.id, 'prefix-match');
    }
    catch (error) {
      report.error = messageOf(error);
      writeReport();
    }
  }
}
