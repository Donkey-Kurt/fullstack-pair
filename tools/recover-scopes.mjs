/**
 * 从会话日志恢复「多目录任务范围」（范围写盘静默失败后的应急救援）。
 *
 * ## 为什么能从日志恢复
 *
 * 插件每轮都会把当前范围渲染进系统提示（`## 多目录任务范围` → `本次任务已纳入以下额外目录`），
 * 这段文本随每一轮请求写进会话日志。因此「某会话在某个时刻真实拥有哪些目录」
 * 在日志里有完整、带时间戳的记录——这正是 `scopes.json` 丢失后唯一还活着的证据。
 *
 * ## 恢复策略（保守优先）
 *
 * 1. 只恢复**日志里最后一次出现**的范围快照，并使用该快照的时间戳，而不是"现在"；
 *    这样它只会在确实比快照记录更新时才生效，不会覆盖用户后来真正做过的修改。
 * 2. 只恢复**磁盘上仍然存在**且**仍在会话目录里存在**的会话，避免无意义条目。
 * 3. 结果写成 `scopes.journal.jsonl` 的追加行——由插件在下次启动时按 `at` 重放合并，
 *    不直接改 `scopes.json`，避免与运行中的旧版插件内存互相覆盖。
 * 4. 运行前先把当前 `scopes.json` 复制成 `scopes.bak.json`（若备份还不存在）。
 *
 * ## 用法
 *
 *   node recover-scopes.mjs            只报告，不写任何文件
 *   node recover-scopes.mjs --apply    追加恢复记录到变更日志
 *
 * 只读会话日志；--apply 时只写状态目录。
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { homedir } from 'node:os';

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const SESSIONS_DIR = join(DSH_HOME, 'sessions');
const STATE_DIR = join(DSH_HOME, 'storages', 'fullstack-pair');
const SCOPES_FILE = join(STATE_DIR, 'scopes.json');
const BACKUP_FILE = join(STATE_DIR, 'scopes.bak.json');
const JOURNAL_FILE = join(STATE_DIR, 'scopes.journal.jsonl');
const APPLY = process.argv.includes('--apply');

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const TITLE = '本次任务已纳入以下额外目录';

/** 多帧追加的 zstd 日志：按魔数切帧，逐帧解压后拼接。 */
function decompressFrames(buf) {
  const starts = [];
  let at = buf.indexOf(MAGIC, 0);
  while (at !== -1) {
    starts.push(at);
    at = buf.indexOf(MAGIC, at + 1);
  }
  const parts = [];
  let index = 0;
  while (index < starts.length) {
    let attempt = index;
    let ok = false;
    while (attempt < starts.length && !ok) {
      const begin = starts[index];
      const end = attempt + 1 < starts.length ? starts[attempt + 1] : buf.length;
      try {
        parts.push(zstdDecompressSync(buf.subarray(begin, end)));
        ok = true;
      }
      catch {
        attempt += 1;
      }
    }
    if (!ok) break;
    index = attempt + 1;
  }
  return Buffer.concat(parts).toString('utf8');
}

/** 递归收集对象里所有字符串（日志事件嵌套层级不固定）。 */
function collectStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) collectStrings(item, out);
  return out;
}

/** 从一段注入文本里解析出目录清单。 */
function parseEntries(text) {
  const lines = text.split('\n');
  const entries = [];
  for (const line of lines) {
    const match = /^-\s+(.+?)：`(.+)`$/.exec(line.trim());
    if (match === null) continue;
    const label = match[1].trim();
    const dir = match[2].trim().replace(/〔路径当前不存在〕$/, '');
    if (dir === '') continue;
    entries.push({ path: dir, label: label === dir ? '' : label });
  }
  return entries;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (name.endsWith('.zstd')) out.push(full);
  }
  return out;
}

/** 磁盘上仍存在的会话 id 集合（目录名即会话 id）。 */
const liveSessions = new Set();
for (const workspaceDir of readdirSync(SESSIONS_DIR)) {
  const full = join(SESSIONS_DIR, workspaceDir);
  if (!statSync(full).isDirectory()) continue;
  for (const sessionDir of readdirSync(full)) liveSessions.add(sessionDir);
}

const found = [];
for (const file of walk(SESSIONS_DIR)) {
  let text;
  try {
    text = decompressFrames(readFileSync(file));
  }
  catch (error) {
    console.error(`[跳过] ${file}: ${String(error?.message ?? error)}`);
    continue;
  }

  let sessionId = '';
  let latest = null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    }
    catch {
      continue;
    }
    if (event?.type === 'session' && typeof event.id === 'string') sessionId = event.id;
    if (event?.type !== 'system/message') continue;
    const when = typeof event.time === 'number' ? event.time : null;
    if (when === null) continue;

    for (const value of collectStrings(event)) {
      if (!value.includes(TITLE)) continue;
      // 只认插件渲染出来的那一节：标题后面紧跟空行 + 固定引导语。
      const at = value.indexOf(`## 多目录任务范围`);
      if (at === -1) continue;
      const section = value.slice(at);
      if (!section.includes(TITLE)) continue;
      const entries = parseEntries(section);
      if (entries.length === 0) continue;
      if (latest === null || when > latest.at) latest = { at: when, entries };
    }
  }

  if (sessionId === '' || latest === null) continue;
  const record = { session: sessionId, at: latest.at, entries: latest.entries, file };
  if (!liveSessions.has(sessionId)) record.stale = true;
  found.push(record);
}

// 当前快照里的记录，用于判断"日志里的范围是否真的更新"。
let snapshot = { sessions: {} };
if (existsSync(SCOPES_FILE)) {
  try {
    snapshot = JSON.parse(readFileSync(SCOPES_FILE, 'utf8'));
  }
  catch {
    console.warn('当前 scopes.json 无法解析，将按"无快照"处理');
  }
}

console.log(`会话日志目录：${SESSIONS_DIR}`);
console.log(`磁盘上的会话数：${liveSessions.size}`);
console.log(`带范围快照的会话：${found.length}\n`);

const restore = [];
for (const record of found.sort((a, b) => a.at - b.at)) {
  const known = snapshot?.sessions?.[record.session];
  const knownAt = known === undefined ? 0 : Date.parse(known.updatedAt) || 0;
  const newer = record.at > knownAt;
  const exists = record.entries.every((entry) => existsSync(entry.path));
  const flag = record.stale === true ? '（会话已不在磁盘）' : '';
  console.log(`${record.session}${flag}`);
  console.log(`  日志内范围时间：${new Date(record.at).toISOString()}  快照记录：${knownAt === 0 ? '无' : new Date(knownAt).toISOString()}`);
  for (const entry of record.entries) {
    console.log(`    - ${entry.label === '' ? '(无标签)' : entry.label}  ${entry.path}${existsSync(entry.path) ? '' : '  〔目录不存在〕'}`);
  }
  const eligible = newer && record.stale !== true && exists;
  console.log(`  → ${eligible ? '可恢复（日志比快照新）' : (newer ? '跳过（目录缺失或会话已删除）' : '跳过（快照已更新）')}\n`);
  if (eligible) restore.push(record);
}

if (!APPLY) {
  console.log(`演练完成：${restore.length} 个会话可恢复。加 --apply 才会写入变更日志。`);
  process.exit(0);
}

if (restore.length === 0) {
  console.log('没有需要恢复的会话，未写入任何文件。');
  process.exit(0);
}

mkdirSync(STATE_DIR, { recursive: true });
if (existsSync(SCOPES_FILE) && !existsSync(BACKUP_FILE)) {
  copyFileSync(SCOPES_FILE, BACKUP_FILE);
  console.log(`已备份当前快照 → ${BACKUP_FILE}`);
}
for (const record of restore) {
  appendFileSync(
    JOURNAL_FILE,
    `${JSON.stringify({ at: record.at, session: record.session, entries: record.entries })}\n`,
    'utf8',
  );
}
console.log(`已写入 ${restore.length} 条恢复记录 → ${JOURNAL_FILE}`);
console.log('这些记录会在插件下次启动时按时间重放合并；请重启 DSH 让恢复生效。');
