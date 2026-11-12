/**
 * 多目录任务范围 —— Client 半部（右键菜单）。
 *
 * ## 两个入口，按各自的维度放置
 *
 * - **会话右键菜单**（`session` target）：`本次任务范围：N 个目录 ›` 子菜单，完整列出
 *   该会话的主根（★，不可移除）与已关联目录（✓，点击移出）。范围本来就是会话级状态，
 *   放在这里语义才对；而且 target 自带 `sessionId`，不需要另找"当前会话"。
 * - **工作区右键菜单**（`workspace` target）：只保留动作项【加入本次任务范围】/
 *   【移出本次任务范围】—— 动作对象是工作区，作用目标是当前会话的范围，两个维度各自清楚。
 *
 * 准确性：每次打开菜单都实时向 Host 拉取，不做本地缓存。
 */
window.__ModuleLoader__.load({
  id: '@local/fullstack-pair',
  factory(require) {
    /** 范围读写端点。 */
    const SCOPE_PATH = '/api/fullstack-pair/scope';
    /** 加载自检端点。 */
    const READY_PATH = '/api/fullstack-pair/client-ready';
    /**
     * 页面内"范围已变化"事件。
     *
     * 菜单操作改完范围后立刻派发，让会话头部徽章同步刷新；模型通过 `pair_use`
     * 工具改的范围不经过 Client，由徽章的轮询兜底。
     */
    const SCOPE_CHANGED_EVENT = 'fullstack-pair:scope-changed';

    /**
     * 读取"当前主视图绑定的会话 id"。
     *
     * 只给工作区菜单用（它需要知道"当前会话"是谁）；会话菜单直接用 target 里的 sessionId。
     *
     * @param ctx - Client 插件上下文。
     * @returns 会话 id；没有当前会话时返回 undefined。
     */
    function currentSessionId(ctx) {
      try {
        const binding = ctx.uiSession?.adapter?.current?.getSnapshot?.();
        return typeof binding?.key === 'string' && binding.key !== '' ? binding.key : undefined;
      }
      catch {
        return undefined;
      }
    }

    /**
     * 读取某个会话的范围（含主根）。
     *
     * @param sessionId - 目标会话 id。
     * @returns 成功时返回 `{ ok, sessionId, primary, entries }`，失败返回 undefined。
     */
    async function readScope(sessionId) {
      try {
        const response = await fetch(`${SCOPE_PATH}?sessionId=${encodeURIComponent(sessionId)}`, {
          credentials: 'same-origin',
        });
        if (!response.ok) return undefined;
        const body = await response.json();
        return body?.ok === true ? body : undefined;
      }
      catch {
        return undefined;
      }
    }

    /**
     * 加入或移出一个目录。
     *
     * @param sessionId - 目标会话 id。
     * @param dir - 绝对路径。
     * @param remove - true 表示移出。
     * @returns 更新后的范围视图。
     */
    async function updateScope(sessionId, dir, remove) {
      const response = await fetch(SCOPE_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, path: dir, remove }),
      });
      const body = await response.json().catch(() => undefined);
      if (!response.ok || body?.ok !== true) {
        throw new Error(body?.error ?? `HTTP ${response.status}`);
      }
      // 通知页面内的徽章立即刷新：范围变了，UI 不该等下一轮轮询。
      try {
        window.dispatchEvent(new CustomEvent(SCOPE_CHANGED_EVENT));
      }
      catch {
        // 事件派发失败不影响操作本身；轮询仍会兜底。
      }
      return body;
    }

    /**
     * 路径比较用的规范化：去掉尾部斜杠、统一小写（Windows 大小写不敏感）。
     *
     * @param value - 任意路径文本。
     * @returns 规范化后的比较键。
     */
    function pathKey(value) {
      return String(value).replace(/[\\/]+$/, '').toLowerCase();
    }

    /**
     * 上报一次"Client 半部已加载"，Host 落盘供排障与自动验证读取。
     *
     * @returns 无。
     */
    function reportReady() {
      void fetch(READY_PATH, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          origin: globalThis.location?.origin ?? '',
          userAgent: (globalThis.navigator?.userAgent ?? '').slice(0, 120),
        }),
      }).catch(() => {
        // 自检失败不影响菜单功能，忽略即可。
      });
    }

    return {
      // contextMenus 提供右键菜单；uiSession 提供"当前主视图绑定的会话"；
      // uiWorkspace 提供 Web 载体的目录选择器；slots 让徽章挂进会话头部。
      inject: ['contextMenus', 'uiSession', 'uiWorkspace', 'slots'],
      apply(ctx) {
        /**
         * 调起平台的目录选择器。
         *
         * 桌面版走 preload 暴露的窄接口 `__DSH_DIRECTORY_PICKER__.pick()`：直接弹系统文件夹
         * 对话框，不经 Host Remote；Web 载体没有这个全局，退回官方 `uiWorkspace.pickDirectory()`。
         * 两者都不可用时抛错，由调用方转成提示，而不是静默失败。
         *
         * @returns 选中的绝对路径；用户取消时返回 null。
         */
        async function pickDirectory() {
          const desktop = globalThis.__DSH_DIRECTORY_PICKER__;
          if (desktop !== undefined && typeof desktop.pick === 'function') {
            return await desktop.pick();
          }
          if (typeof ctx.uiWorkspace?.pickDirectory === 'function') {
            return await ctx.uiWorkspace.pickDirectory();
          }
          throw new Error('当前环境没有可用的目录选择器');
        }

        /**
         * 把子菜单项组装成"完整范围清单"。
         *
         * 末尾固定带一项「添加其他目录…」（调平台目录选择器），随后是「最近使用」快捷项：
         * Host 已经逐项校验过目录存在，这里直接列出，点一下就加入，不用再开对话框。
         *
         * @param sessionId - 该范围所属会话。
         * @param primary - 主根（`{label,path}` 或 null）。
         * @param entries - 已关联目录。
         * @param recent - 最近使用过的目录（已校验存在）。
         * @returns 子菜单 action 数组。
         */
        function buildScopeChildren(sessionId, primary, entries, recent) {
          const children = [];
          if (primary !== null) {
            children.push({
              id: 'primary',
              label: `★ ${primary.label}（工作区）`,
              disabled: true,
              run: () => {},
            });
          }
          entries.forEach((entry, index) => {
            const entryLabel = typeof entry?.label === 'string' && entry.label !== ''
              ? entry.label
              : String(entry?.path ?? '');
            children.push({
              id: `remove-${index}`,
              label: `✓ ${entryLabel}`,
              run: () => {
                void (async () => {
                  try {
                    await updateScope(sessionId, entry.path, true);
                    ctx.contextMenus.notify?.(`已移出本次任务范围：${entryLabel}`, true);
                  }
                  catch (error) {
                    ctx.contextMenus.notify?.(`移出失败：${String(error?.message ?? error)}`, false);
                  }
                })();
              },
            });
          });

          children.push({
            id: 'add-directory',
            label: '＋ 添加其他目录…',
            run: () => {
              void (async () => {
                try {
                  const picked = await pickDirectory();
                  // 取消时返回 null/空串：什么都不做，也不打扰用户。
                  if (typeof picked !== 'string' || picked.trim() === '') return;
                  const result = await updateScope(sessionId, picked, false);
                  // Host 会拒绝把主根重复登记，此时 entries 里不会有它——提示要如实反映，
                  // 不能一律说"已加入"。
                  const added = Array.isArray(result?.entries)
                    && result.entries.some((entry) => typeof entry?.path === 'string' && pathKey(entry.path) === pathKey(picked));
                  ctx.contextMenus.notify?.(
                    added ? `已加入本次任务范围：${picked}` : '该目录就是当前会话的工作区，无需加入',
                    added,
                  );
                }
                catch (error) {
                  ctx.contextMenus.notify?.(`添加目录失败：${String(error?.message ?? error)}`, false);
                }
              })();
            },
          });

          // 最近使用：Host 已过滤掉不存在的目录，且这里再跳过"已在范围里"与"主根"的重复项。
          const seen = new Set(entries.map((entry) => pathKey(entry?.path ?? '')));
          if (primary !== null) seen.add(pathKey(primary.path));
          for (const item of recent) {
            if (typeof item?.path !== 'string' || item.path === '') continue;
            const key = pathKey(item.path);
            if (seen.has(key)) continue;
            seen.add(key);
            children.push({
              id: `recent-${children.length}`,
              label: `↺ ${item.label || item.path}`,
              run: () => {
                void (async () => {
                  try {
                    await updateScope(sessionId, item.path, false);
                    ctx.contextMenus.notify?.(`已加入本次任务范围：${item.path}`, true);
                  }
                  catch (error) {
                    ctx.contextMenus.notify?.(`添加目录失败：${String(error?.message ?? error)}`, false);
                  }
                })();
              },
            });
          }

          return children;
        }

        // ── 会话菜单：查看与管理"这个会话"的任务范围 ────────────────────────
        ctx.effect(() => ctx.contextMenus.register({
          id: 'fullstack-pair.session-scope',
          target: 'session',
          order: 200,
          resolve: async ({ sessionId }) => {
            if (typeof sessionId !== 'string' || sessionId === '') return [];
            const state = await readScope(sessionId);
            const primary = state?.primary ?? null;
            const entries = Array.isArray(state?.entries) ? state.entries : [];
            const recent = Array.isArray(state?.recent) ? state.recent : [];
            return [{
              id: 'scope',
              label: `本次任务范围：${(primary !== null ? 1 : 0) + entries.length} 个目录`,
              children: buildScopeChildren(sessionId, primary, entries, recent),
            }];
          },
        }), 'fullstack-pair: session scope menu');

        // ── 工作区菜单：把该工作区加入/移出"当前会话"的范围 ────────────────
        ctx.effect(() => ctx.contextMenus.register({
          id: 'fullstack-pair.workspace-scope',
          target: 'workspace',
          order: 200,
          resolve: async ({ path: workspacePath, workspaceId }) => {
            if (typeof workspacePath !== 'string' || workspacePath.trim() === '') return [];

            /**
             * 「新建会话并预设范围…」：空白新会话没有会话 id，无法在会话菜单里设范围，
             * 所以从工作区菜单发起——勾选目录后创建会话并写入范围。
             */
            const presetItem = {
              id: 'new-session-preset',
              label: '新建会话并预设范围…',
              run: () => {
                void (async () => {
                  try {
                    const currentId = currentSessionId(ctx);
                    const state = currentId === undefined ? undefined : await readScope(currentId);
                    const primary = state?.primary ?? null;
                    const entries = Array.isArray(state?.entries) ? state.entries : [];
                    const recent = Array.isArray(state?.recent) ? state.recent : [];

                    // 候选规则（只收集与**目标工作区**有关联的目录）：
                    //   1. 目标工作区自身 —— 必然是主根，默认勾选；
                    //   2. 当前会话的额外目录 —— 只有当前会话就在这个工作区时才默认勾选
                    //      （继承同工作区会话的范围）；否则它来自别的工作区，仅作为候选列出；
                    //   3. 最近使用目录 —— 仅作为候选，默认不勾。
                    // 当前会话的主根**不**作为候选：它要么就是目标工作区（已由 1 覆盖），
                    // 要么属于另一个工作区，对新会话来说是无关目录。
                    const currentInWorkspace = primary !== null && pathKey(primary.path) === pathKey(workspacePath);
                    const candidates = [];
                    const seen = new Set();
                    const push = (dir, label, preselect) => {
                      if (typeof dir !== 'string' || dir === '') return;
                      const key = pathKey(dir);
                      if (seen.has(key)) return;
                      seen.add(key);
                      candidates.push({ path: dir, label, preselect });
                    };
                    const dirName = workspacePath.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? workspacePath;
                    push(workspacePath, `📁 ${dirName}（本工作区，主根）`, true);
                    for (const entry of entries) {
                      // 额外目录是用户主动加过的"常用目录"，默认勾选；只在它来自其他
                      // 工作区的会话时标注来源，提示这不是本工作区的目录。
                      push(entry.path, `✓ ${entry.label}${currentInWorkspace ? '' : '（来自其他工作区的会话）'}`, true);
                    }
                    for (const item of recent) push(item.path, `↺ ${item.label}`, false);

                    openPresetRequest({
                      id: `${Date.now()}`,
                      workspaceId,
                      workspacePath,
                      candidates,
                      preselected: candidates.filter((item) => item.preselect).map((item) => item.path),
                    });
                  }
                  catch (error) {
                    ctx.contextMenus.notify?.(`打开预设对话框失败：${String(error?.message ?? error)}`, false);
                  }
                })();
              },
            };

            const sessionId = currentSessionId(ctx);
            if (sessionId === undefined) {
              return [presetItem, {
                id: 'no-session',
                label: '先打开一个会话，再设置任务范围',
                disabled: true,
                run: () => {},
              }];
            }

            const state = await readScope(sessionId);
            const primary = state?.primary ?? null;
            const entries = Array.isArray(state?.entries) ? state.entries : [];
            const inScope = entries.some((entry) => typeof entry?.path === 'string' && pathKey(entry.path) === pathKey(workspacePath));
            const isPrimary = primary !== null && pathKey(primary.path) === pathKey(workspacePath);

            if (isPrimary) {
              // 主根本来就在范围里且不可移除，给出明确的只读说明，而不是一个会误导的"移出"。
              return [presetItem, {
                id: 'primary',
                label: '该工作区已作为本次任务的主根（不可移出）',
                disabled: true,
                run: () => {},
              }];
            }

            return [presetItem, {
              id: inScope ? 'remove' : 'add',
              label: inScope ? '移出本次任务范围' : '加入本次任务范围',
              run: async () => {
                try {
                  // 再取一次会话 id，避免用户在这期间切换了会话。
                  const targetSession = currentSessionId(ctx) ?? sessionId;
                  await updateScope(targetSession, workspacePath, inScope);
                  ctx.contextMenus.notify?.(
                    inScope ? '已移出本次任务范围' : `已加入本次任务范围：${workspacePath}`,
                    true,
                  );
                }
                catch (error) {
                  ctx.contextMenus.notify?.(`范围更新失败：${String(error?.message ?? error)}`, false);
                }
              },
            }];
          },
        }), 'fullstack-pair: workspace scope menu');

        // ── 会话头部徽章：范围目录数 + git 分支 ────────────────────────────
        // 挂到 `conversation.session.header.utilities`（list、session 作用域），也就是
        // 标题右侧显示"智能体团队 / 标准模式 / 子智能体"那一行——不占正文，
        // 也不和工具栏争空间。
        const React = require('react');

        /**
         * 会话头部徽章：`📁 N · 分支`。
         *
         * 数据来自 Host 的 scope 端点（范围 + 各目录当前分支）。刷新策略是"事件 + 轮询"：
         * 菜单操作改范围后派发事件立即刷新；模型通过 `pair_use` 工具改的范围不经过
         * Client，15 秒轮询兜底。没有范围时返回 null，不留空徽章占位。
         *
         * @returns 徽章元素或 null。
         */
        function ScopeBadge() {
          const [state, setState] = React.useState(undefined);

          React.useEffect(() => {
            let alive = true;
            const load = () => {
              const sessionId = currentSessionId(ctx);
              if (sessionId === undefined) {
                if (alive) setState(null);
                return;
              }
              void readScope(sessionId).then((scope) => {
                if (alive) setState(scope ?? null);
              });
            };
            load();
            const timer = setInterval(load, 15000);
            const onChange = () => load();
            window.addEventListener(SCOPE_CHANGED_EVENT, onChange);
            return () => {
              alive = false;
              clearInterval(timer);
              window.removeEventListener(SCOPE_CHANGED_EVENT, onChange);
            };
          }, []);

          if (state === undefined || state === null) return null;
          const primary = state.primary ?? null;
          const entries = Array.isArray(state.entries) ? state.entries : [];
          const count = (primary !== null ? 1 : 0) + entries.length;
          if (count === 0) return null;

          // 分支名去重后展示：多目录同分支只显示一次，不同分支显示"首个 +N"。
          const branches = Array.isArray(state.branches) ? state.branches : [];
          const names = [...new Set(branches
            .map((item) => item?.branch)
            .filter((name) => typeof name === 'string' && name !== ''))];
          const branchText = names.length === 0
            ? ''
            : (names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`);

          // 悬停显示明细：主根、各目录、以及每个目录真实分支（非 git 仓库显式标注）。
          const title = [
            primary !== null ? `★ ${primary.label}（工作区）` : '',
            ...entries.map((entry) => `✓ ${entry.label}`),
            ...branches.map((item) => `${item.path} → ${item.branch === '' ? '(非 git 仓库)' : item.branch}`),
          ].filter((line) => line !== '').join('\n');

          return React.createElement('span', {
            title,
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              padding: '1px 8px',
              marginLeft: '6px',
              borderRadius: '999px',
              border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.35))',
              color: 'var(--dsw-alias-interactive-secondary, inherit)',
              fontSize: '12px',
              lineHeight: '18px',
              whiteSpace: 'nowrap',
              cursor: 'default',
              verticalAlign: 'middle',
            },
          }, `📁 ${count}${branchText === '' ? '' : ` · ${branchText}`}`);
        }

        // 槽位服务可用时才注册；无会话/首页不挂载头部，注册本身无害。
        if (ctx.slots?.inject !== undefined) {
          ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
            name: 'conversation.session.header.utilities',
            id: 'fullstack-pair-scope',
          }, ScopeBadge));
        }

        // ── 新建会话并预设范围 ─────────────────────────────────────────────
        // 背景：空白「新会话」在首条消息落地前只是占位行，拿不到会话 id，会话菜单里
        // 无法给它设范围。这里从工作区菜单发起：先勾选目录，再用 openWorkspace 的
        // beforeOpen 回调拿到新会话 id（此时会话已被 retain），把目录写进它的范围。
        /** 当前待确认的预设请求；null 表示对话框关闭。 */
        let presetRequest = null;
        /** 对话框订阅者：打开/关闭时唤醒组件重渲染。 */
        const presetListeners = new Set();

        /** 打开「新建会话并预设范围」对话框。 */
        function openPresetRequest(request) {
          presetRequest = request;
          for (const listener of [...presetListeners]) listener();
        }

        /** 关闭该对话框。 */
        function closePresetRequest() {
          presetRequest = null;
          for (const listener of [...presetListeners]) listener();
        }

        /**
         * 对话框宿主：负责订阅请求状态。
         *
         * 用 `key` 重建内层面板，使每次打开都以新的勾选状态开始（否则上一次的勾选
         * 会残留在 useState 的初值里）。
         *
         * @returns 面板元素或 null。
         */
        function ScopePresetDialog() {
          const [, force] = React.useReducer((value) => value + 1, 0);

          React.useEffect(() => {
            presetListeners.add(force);
            return () => {
              presetListeners.delete(force);
            };
          }, []);

          const request = presetRequest;
          if (request === null) return null;
          return React.createElement(ScopePresetPanel, { key: request.id, request });
        }

        /** 对话框按钮样式（跟随主题的边框与文字色）。 */
        const DIALOG_BUTTON_STYLE = {
          padding: '6px 14px',
          borderRadius: '8px',
          border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.4))',
          background: 'transparent',
          color: 'inherit',
          cursor: 'pointer',
          fontSize: '13px',
        };

        /**
         * 预设范围面板：勾选目录 → 新建会话 → 把勾选的目录写进新会话范围。
         *
         * @param props.request - 一次预设请求（工作区、候选目录、预勾选项）。
         * @returns 对话框元素。
         */
        function ScopePresetPanel({ request }) {
          const [candidates, setCandidates] = React.useState(request.candidates);
          const [selected, setSelected] = React.useState(() => new Set(request.preselected));
          const [busy, setBusy] = React.useState(false);

          const toggle = (dir) => {
            setSelected((previous) => {
              const next = new Set(previous);
              if (next.has(dir)) next.delete(dir);
              else next.add(dir);
              return next;
            });
          };

          /**
           * 用平台目录选择器追加一个候选目录，并自动勾选。
           *
           * 为什么需要它：候选只来自"本工作区 + 当前会话范围 + 最近使用"，首次使用时
           * 可能一个可用目录都没有；这里让用户直接把任意目录加进来，不必先去工作区里登记。
           */
          const addDirectory = () => {
            void (async () => {
              try {
                const picked = await pickDirectory();
                if (typeof picked !== 'string' || picked.trim() === '') return;
                const key = pathKey(picked);
                setCandidates((previous) => (previous.some((item) => pathKey(item.path) === key)
                  ? previous
                  : [...previous, {
                    path: picked,
                    label: `＋ ${picked.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? picked}`,
                  }]));
                setSelected((previous) => new Set(previous).add(picked));
              }
              catch (error) {
                ctx.contextMenus.notify?.(`选择目录失败：${String(error?.message ?? error)}`, false);
              }
            })();
          };

          const confirm = () => {
            const dirs = [...selected];
            setBusy(true);
            try {
              // beforeOpen 在目标会话被 retain 后同步执行，此时 sessionId 已可用。
              ctx.uiWorkspace.openWorkspace(request.workspaceId, (sessionId) => {
                void (async () => {
                  for (const dir of dirs) {
                    try {
                      await updateScope(sessionId, dir, false);
                    }
                    catch {
                      // 单个目录失败不阻断其余目录：范围写入本身幂等，重复加入无害。
                    }
                  }
                  try {
                    window.dispatchEvent(new CustomEvent(SCOPE_CHANGED_EVENT));
                  }
                  catch {
                    // 事件派发失败只影响徽章的即时刷新，轮询仍会兜底。
                  }
                })();
              });
            }
            catch (error) {
              ctx.contextMenus.notify?.(`新建会话失败：${String(error?.message ?? error)}`, false);
            }
            finally {
              closePresetRequest();
            }
          };

          return React.createElement('div', {
            style: {
              position: 'fixed',
              inset: 0,
              zIndex: 9999,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(0, 0, 0, 0.45)',
            },
            onClick: (event) => {
              if (event.target === event.currentTarget) closePresetRequest();
            },
          }, React.createElement('div', {
            style: {
              width: '520px',
              maxWidth: '90vw',
              maxHeight: '70vh',
              overflow: 'auto',
              padding: '16px',
              borderRadius: '12px',
              background: 'var(--dsw-alias-bg-elevated, #232323)',
              color: 'var(--dsw-alias-text-primary, #eeeeee)',
              boxShadow: '0 12px 48px rgba(0, 0, 0, 0.45)',
              fontSize: '13px',
            },
          },
          React.createElement('div', { style: { fontSize: '15px', fontWeight: 600, marginBottom: '2px' } }, '新建会话并预设任务范围'),
          React.createElement('div', { style: { opacity: 0.65, marginBottom: '12px', fontSize: '12px' } }, request.workspacePath),
          ...candidates.map((candidate) => React.createElement('label', {
            key: candidate.path,
            style: { display: 'flex', gap: '8px', alignItems: 'center', padding: '5px 4px', cursor: 'pointer' },
          },
          React.createElement('input', {
            type: 'checkbox',
            checked: selected.has(candidate.path),
            onChange: () => toggle(candidate.path),
          }),
          React.createElement('span', { style: { flex: 1 } }, candidate.label),
          React.createElement('span', { style: { opacity: 0.4, fontSize: '11px' } }, candidate.path))),
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '16px' } },
          React.createElement('button', { type: 'button', disabled: busy, onClick: addDirectory, style: DIALOG_BUTTON_STYLE }, '＋ 添加其他目录…'),
          React.createElement('div', { style: { display: 'flex', gap: '8px' } },
          React.createElement('button', { type: 'button', disabled: busy, onClick: closePresetRequest, style: DIALOG_BUTTON_STYLE }, '取消'),
          React.createElement('button', { type: 'button', disabled: busy, onClick: confirm, style: DIALOG_BUTTON_STYLE }, `新建会话（${selected.size} 个目录）`))),
          ));
        }

        // 注册到全局浮层：无待确认请求时渲染 null，不占位。
        if (ctx.slots?.inject !== undefined) {
          ctx.slots.inject('shell.overlay', () => ctx.slots.register({
            name: 'shell.overlay',
            id: 'fullstack-pair-preset',
          }, ScopePresetDialog));
        }

        // 注册之后再上报，这样自检文件能同时证明"Client 插件已加载"与"菜单已注册"。
        reportReady();
      },
    };
  },
});
