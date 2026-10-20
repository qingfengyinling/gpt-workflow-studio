/**
 * dsh-workflow-studio — browser half.
 *
 * Registers a DSH global panel ("工作流编排台"):
 *   - a `sidebar.panellist` entry (the sidebar glyph + label), and
 *   - a `main` slot occupant keyed by the same PANEL_ID, which is what actually
 *     puts the page in the centre column while the panel is selected.
 *
 * The centre column does NOT redraw the studio. It hosts the workspace's
 * existing single-file HTML in a same-origin iframe, so all ~176 of the
 * studio's functions and its passing selftest/static-audit keep applying
 * untouched. Because the iframe is same-origin, this file can, without
 * modifying index.html by one byte:
 *   - read the studio's own localStorage record (LS_KEY),
 *   - call its top-level functions (`buildWorkflowFile`, `buildHandoff`,
 *     `safeFileName`, `doImport`) — classic-script function declarations are
 *     properties of the frame's window,
 *   - discover its current state through `eval("DB")` when the record is absent
 *     (`DB` is a top-level `let`, so it is NOT a window property).
 *
 * The toolbar therefore does what a browser download cannot: it writes the
 * studio's export products into `<workspace>/workflows/`, where other agents
 * can read them with ordinary file tools.
 *
 * Only `react` is required; it is a platform seed word, so no build step and no
 * extra externals are involved.
 */

window.__ModuleLoader__.load({
  id: "dsh-workflow-studio",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const h = react.createElement;

    /** Dictionary namespace owned by this plugin. */
    const NS = "dsh-workflow-studio";

    /**
     * Global-panel id: the sidebar list id and the `main` slot key must be the
     * same branded value — ui-sidebar resolves the row's label and the centre
     * column's occupant from it, and only the id/key pair ties them together.
     */
    const PANEL_ID = "workflow-studio";

    /** Must match lib/index.js. */
    const APP_ROUTE = "/workflow-studio/app";
    const API_ROUTE = "/workflow-studio/api";

    /** The studio's own persistence key (index.html:713). */
    const LS_KEY = "wb_workflow_studio_v1";

    /**
     * Where the assistant parks its last review. Deliberately a separate key:
     * the studio's record must stay exactly what the studio wrote, and this is
     * the plugin's own state — kept outside React so a 60-second review is not
     * thrown away because the panel unmounted or the page reloaded.
     */
    const ASSIST_KEY = "wb_ws_assist_v1";

    /** Node types the studio can render; mirrors TYPE_META (index.html:715-722). */
    const NODE_TYPES = ["start", "llm", "tool", "branch", "human", "output"];

    /** Cordis fiber services. `sessions`/`workspaces` only resolve the cwd. */
    const inject = ["slots", "locale", "sessions", "workspaces"];

    /* ------------------------------------------------------------ copy ---- */

    const zh = {
      nav: "工作流编排台",
      title: "工作流编排台",
      intro: "工作区内本地 HTML 工作台 · 导出直落工作区 workflows\\",
      close: "关闭",
      reload: "重载工作台",
      openTab: "新标签打开",
      workspace: "工作区",
      choose: "选择工作区…",
      saveActive: "保存当前工作流到工作区",
      saveAll: "保存全部工作流",
      saved: "已写入工作区",
      loadHint: "点击 chips 载入到工作台（JSON）；.md 为交接包，供人和 Agent 阅读",
      files: "工作区 workflows\\",
      noFiles: "还没有导出文件",
      refreshFiles: "刷新列表",
      loading: "加载中…",
      ready: "就绪",
      notReady: "工作台未就绪",
      noWorkspace: "没有可用工作区，请先打开一个会话",
      noWorkflow: "工作台里没有工作流",
      frameBlocked: "工作台加载失败：宿主可能禁止了同源 iframe，或文件不存在",
      assetMissing: "这个工作区里没有工作台 HTML（workflow-studio/index.html），appRoot 里也没找到。请把工作台放进该工作区，或在插件配置里把 appRoot 指向含工作台的目录。",
      importNote: "载入会新增一份副本，名字追加「（导入）」",
      imported: "已载入工作台",
      deleted: "已删除",
      confirmDelete: "删除工作区里的这个文件？",
      fileGone: "该文件已不存在",

      assist: "AI 助手",
      assistIntro: "让模型体检这条工作流：补验收、改指令、指出断掉的逻辑",
      review: "体检整条工作流",
      optimize: "优化选中节点",
      runCustom: "按指令修改",
      instruction: "补充要求",
      instructionPlaceholder: "例如：每一步都要有失败分支；给所有节点补齐验收标准",
      focus: "聚焦节点",
      wholeFlow: "整条工作流",
      running: "模型正在思考…",
      elapsed: "已用时",
      findings: "发现的问题",
      patches: "可应用的修改",
      noFindings: "没有发现问题",
      noPatches: "没有需要修改的地方",
      applyPicked: "应用选中",
      selectAll: "全选",
      selectNone: "全不选",
      confirmApply: "把这些修改写进工作台当前的工作流？可以用 Ctrl+Z 撤销。",
      applied: "已应用",
      places: "处修改",
      undoHint: "可在工作台里按 Ctrl+Z 撤销",
      why: "理由",
      beforeLabel: "现在",
      afterLabel: "改为",
      skipped: "已跳过",
      needFocus: "先选一个要优化的节点",
      needInstruction: "先写下你的要求",
      modelUnavailable: "这个 DSH 没有可用的模型",
      aiFailed: "助手调用失败",
      parseWarn: "模型返回的不是完整 JSON，无法生成可应用的修改（原始文本见下）",
      raw: "原始返回",
      recordPath: "完整记录",
      aiNote: "修改会直接改进工作台当前的这条工作流",
      patchSet: "修改",
      patchAdd: "新增节点",
      patchRemove: "删除节点",
      patchLink: "连线",
      patchUnlink: "断线",
      fieldName: "名称",
      fieldGoal: "目标",
      fieldDelivery: "交付",
      fieldConstraints: "约束",
      fieldTitle: "标题",
      fieldType: "类型",
      fieldRole: "执行者",
      fieldModel: "模型",
      fieldInstruction: "指令",
      fieldInputs: "输入",
      fieldOutputs: "产出",
      fieldAcceptance: "验收",
      fieldForbidden: "禁止",
      fieldHumanCheck: "人工确认",
      fieldTimeoutSec: "超时秒数",
      fieldRetry: "重试次数",
      fieldNotes: "备注",
      severityError: "错误",
      severityWarn: "警告",
      severityInfo: "建议"
    };

    const en = {
      nav: "Workflow Studio",
      title: "Workflow Studio",
      intro: "The workspace's local HTML studio · exports land in workflows\\",
      close: "Close",
      reload: "Reload studio",
      openTab: "Open in new tab",
      workspace: "Workspace",
      choose: "Choose a workspace…",
      saveActive: "Save current workflow to workspace",
      saveAll: "Save all workflows",
      saved: "Written to the workspace",
      loadHint: "Click a chip to load it into the studio (.json); .md handoff packs are for humans and agents to read",
      files: "Workspace workflows\\",
      noFiles: "No exported files yet",
      refreshFiles: "Refresh list",
      loading: "Loading…",
      ready: "Ready",
      notReady: "Studio not ready",
      noWorkspace: "No workspace available — open a session first",
      noWorkflow: "The studio has no workflow",
      frameBlocked: "The studio failed to load: the host may block same-origin iframes, or the file is missing",
      assetMissing: "This workspace has no studio HTML (workflow-studio/index.html) and none was found under appRoot either. Put the studio in this workspace, or point the plugin's appRoot at the directory that holds it.",
      importNote: "Loading adds a copy; its name gains a marker",
      imported: "Loaded into the studio",
      deleted: "Deleted",
      confirmDelete: "Delete this file from the workspace?",
      fileGone: "That file no longer exists",

      assist: "AI assistant",
      assistIntro: "Have the model review this workflow: fix instructions, add acceptance, name the broken links",
      review: "Review whole workflow",
      optimize: "Improve focused node",
      runCustom: "Apply instruction",
      instruction: "Extra requirements",
      instructionPlaceholder: "e.g. every step needs a failure branch; add acceptance criteria everywhere",
      focus: "Focus node",
      wholeFlow: "Whole workflow",
      running: "The model is thinking…",
      elapsed: "Elapsed",
      findings: "Findings",
      patches: "Proposed changes",
      noFindings: "No findings",
      noPatches: "Nothing to change",
      applyPicked: "Apply selected",
      selectAll: "Select all",
      selectNone: "Select none",
      confirmApply: "Apply these changes to the studio's current workflow? Ctrl+Z undoes it.",
      applied: "Applied",
      places: "changes",
      undoHint: "Ctrl+Z inside the studio undoes it",
      why: "Why",
      beforeLabel: "now",
      afterLabel: "to be",
      skipped: "skipped",
      needFocus: "Pick a node to improve first",
      needInstruction: "Write your requirement first",
      modelUnavailable: "This DSH has no usable model",
      aiFailed: "Assistant call failed",
      parseWarn: "The model did not return complete JSON, so no changes can be applied (raw text below)",
      raw: "Raw response",
      recordPath: "Full record",
      aiNote: "Changes are written straight into the studio's current workflow",
      patchSet: "Set",
      patchAdd: "Add node",
      patchRemove: "Remove node",
      patchLink: "Link",
      patchUnlink: "Unlink",
      fieldName: "name",
      fieldGoal: "goal",
      fieldDelivery: "delivery",
      fieldConstraints: "constraints",
      fieldTitle: "title",
      fieldType: "type",
      fieldRole: "role",
      fieldModel: "model",
      fieldInstruction: "instruction",
      fieldInputs: "inputs",
      fieldOutputs: "outputs",
      fieldAcceptance: "acceptance",
      fieldForbidden: "forbidden",
      fieldHumanCheck: "human check",
      fieldTimeoutSec: "timeout (s)",
      fieldRetry: "retries",
      fieldNotes: "notes",
      severityError: "error",
      severityWarn: "warning",
      severityInfo: "info"
    };

    /* ----------------------------------------------------------- styles --- */

    /* Re-declared against the official --dsw-alias-* tokens so the panel
       follows the active theme instead of hardcoding a palette. */
    const STYLES = `
.ws-panel { display:flex; flex-direction:column; height:100%; min-height:0; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
.ws-header { display:flex; align-items:flex-start; gap:12px; padding:10px 14px; border-bottom:1px solid var(--dsw-alias-border-l2); }
.ws-header-main { min-width:0; }
.ws-title { margin:0; font-size:14px; line-height:20px; font-weight:600; }
.ws-header-sub { margin:2px 0 0; font-size:12px; line-height:18px; color: var(--dsw-alias-label-tertiary); }
.ws-header-actions { margin-left:auto; display:flex; align-items:center; gap:8px; flex-wrap:wrap; justify-content:flex-end; }
.ws-btn { appearance:none; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-primary); font: inherit; font-size:12px; line-height:18px; padding:4px 10px; cursor:pointer; white-space:nowrap; }
.ws-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.ws-btn:disabled { opacity:.5; cursor:not-allowed; }
.ws-btn-primary { background: var(--dsw-alias-button-primary-fill); border-color: transparent; color: var(--dsw-alias-label-primary-foreground); }
.ws-toolbar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:8px 14px; border-bottom:1px solid var(--dsw-alias-border-l2); }
.ws-status { font-size:12px; line-height:18px; color: var(--dsw-alias-label-secondary); }
.ws-pill { border-radius:999px; padding:1px 8px; font-size:11px; line-height:16px; border:1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
.ws-pill-ready { color: var(--dsw-alias-brand-primary); }
.ws-pill-error { color: var(--dsw-alias-state-error-primary); }
.ws-body { position:relative; flex:1; min-height:0; }
.ws-frame { width:100%; height:100%; border:0; display:block; background:#0f1115; }
.ws-files { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:8px 14px; border-top:1px solid var(--dsw-alias-border-l2); font-size:12px; line-height:18px; color: var(--dsw-alias-label-tertiary); }
.ws-chip { display:inline-flex; align-items:center; gap:4px; border:1px solid var(--dsw-alias-border-l2); border-radius:999px; padding:1px 4px 1px 10px; background: var(--dsw-alias-bg-module-platform); }
.ws-chip-name { appearance:none; border:0; background:transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size:12px; cursor:pointer; padding:0; }
.ws-chip-name:disabled { color: var(--dsw-alias-label-tertiary); cursor:default; }
.ws-chip-drop { appearance:none; border:0; background:transparent; color: var(--dsw-alias-label-tertiary); font: inherit; font-size:13px; line-height:1; cursor:pointer; padding:2px 4px; border-radius:999px; }
.ws-chip-drop:hover { color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-interactive-bg-hover); }
.ws-note { padding:6px 14px; font-size:12px; line-height:18px; border-top:1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); }
.ws-note-error { color: var(--dsw-alias-state-error-primary); }
.ws-picker { position:relative; }
.ws-menu { position:absolute; right:0; top:calc(100% + 6px); z-index:30; min-width:240px; max-height:320px; overflow:auto; border:1px solid var(--dsw-alias-border-l2); border-radius:10px; background: var(--dsw-alias-bg-module-platform); box-shadow:0 8px 24px rgba(0,0,0,.28); padding:4px; }
.ws-menu-item { display:block; width:100%; text-align:left; border:0; background:transparent; color: var(--dsw-alias-label-primary); font:inherit; font-size:12px; line-height:18px; padding:6px 8px; border-radius:6px; cursor:pointer; }
.ws-menu-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
.ws-icon { display:inline-flex; align-items:center; justify-content:center; }
.ws-btn-ai { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.ws-ai { position:absolute; top:0; right:0; bottom:0; width:420px; max-width:92%; display:flex; flex-direction:column; border-left:1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); box-shadow:-8px 0 24px rgba(0,0,0,.24); z-index:20; }
.ws-ai-head { display:flex; align-items:center; gap:8px; padding:8px 12px; border-bottom:1px solid var(--dsw-alias-border-l2); }
.ws-ai-title { margin:0; font-size:13px; font-weight:600; }
.ws-ai-model { margin-left:auto; font-size:11px; line-height:16px; color: var(--dsw-alias-label-tertiary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:170px; }
.ws-ai-body { flex:1; min-height:0; overflow:auto; padding:10px 12px; display:flex; flex-direction:column; gap:10px; }
.ws-ai-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.ws-ai-hint { font-size:12px; line-height:18px; color: var(--dsw-alias-label-tertiary); }
.ws-ai-input { width:100%; box-sizing:border-box; resize:vertical; min-height:52px; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-primary); font: inherit; font-size:12px; line-height:18px; padding:6px 8px; }
.ws-ai-select { border:1px solid var(--dsw-alias-border-l2); border-radius:8px; background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-primary); font: inherit; font-size:12px; padding:3px 6px; max-width:100%; }
.ws-ai-section { border-top:1px solid var(--dsw-alias-border-l2); padding-top:8px; }
.ws-ai-section-title { font-size:12px; font-weight:600; color: var(--dsw-alias-label-secondary); margin:0 0 6px; }
.ws-ai-finding { border:1px solid var(--dsw-alias-border-l2); border-left-width:3px; border-radius:8px; padding:6px 8px; margin-bottom:6px; font-size:12px; line-height:18px; }
.ws-ai-finding-error { border-left-color: var(--dsw-alias-state-error-primary); }
.ws-ai-finding-warn { border-left-color: var(--dsw-alias-state-warn-primary); }
.ws-ai-finding-info { border-left-color: var(--dsw-alias-border-l2); }
.ws-ai-finding-title { font-weight:600; }
.ws-ai-finding-meta { color: var(--dsw-alias-label-tertiary); font-size:11px; }
.ws-ai-patch { border:1px solid var(--dsw-alias-border-l2); border-radius:8px; padding:6px 8px; margin-bottom:6px; font-size:12px; line-height:18px; background: var(--dsw-alias-bg-module-platform); }
.ws-ai-patch-off { opacity:.55; }
.ws-ai-patch-head { display:flex; align-items:center; gap:6px; }
.ws-ai-patch-head input { margin:0; }
.ws-ai-target { font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ws-ai-badge { border-radius:999px; padding:0 6px; font-size:11px; line-height:16px; border:1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); white-space:nowrap; }
.ws-ai-why { color: var(--dsw-alias-label-tertiary); font-size:11px; line-height:16px; margin-top:2px; }
.ws-ai-diff { margin-top:4px; display:flex; flex-direction:column; gap:2px; }
.ws-ai-before, .ws-ai-after { border-radius:6px; padding:2px 6px; white-space:pre-wrap; word-break:break-word; max-height:88px; overflow:auto; }
.ws-ai-before { background: rgba(255,255,255,.04); color: var(--dsw-alias-label-tertiary); }
.ws-ai-after { background: rgba(79,140,255,.16); }
.ws-ai-skip { color: var(--dsw-alias-state-warn-primary); font-size:11px; line-height:16px; }
.ws-ai-foot { display:flex; align-items:center; gap:8px; padding:8px 12px; border-top:1px solid var(--dsw-alias-border-l2); }
.ws-ai-spin { display:inline-block; width:10px; height:10px; border-radius:50%; border:2px solid var(--dsw-alias-border-l2); border-top-color: var(--dsw-alias-brand-primary); animation: ws-ai-rot 1s linear infinite; }
@keyframes ws-ai-rot { to { transform: rotate(360deg); } }
.ws-ai-raw { max-height:180px; overflow:auto; white-space:pre-wrap; word-break:break-word; font-family: var(--ds-font-family-code); font-size:11px; line-height:16px; color: var(--dsw-alias-label-secondary); border:1px solid var(--dsw-alias-border-l2); border-radius:8px; padding:6px; }
`;

    /** Inject once, keyed by plugin id (the DSH client-plugin convention). */
    function injectStyles(pluginId) {
      if (document.querySelector(`style[data-dsh-plugin-css="${pluginId}"]`) !== null) return;
      const tag = document.createElement("style");
      tag.setAttribute("data-dsh-plugin-css", pluginId);
      tag.textContent = STYLES;
      document.head.appendChild(tag);
    }

    /* ------------------------------------------- workspace resolution ----- */

    /**
     * The Session currently on stage (the main view's occupant), or undefined
     * when none is — e.g. while this very panel is the occupant.
     * @param sessions - the `useSessions`/`ctx.sessions.list` snapshot.
     */
    function currentSessionId(sessions) {
      if (sessions === undefined || sessions === null) return void 0;
      const legacy = sessions.current;
      if (typeof legacy === "string" && legacy !== "") return legacy;
      const byId = sessions.byId;
      if (byId === undefined || byId === null) return void 0;
      for (const [sessionId, summary] of Object.entries(byId)) {
        if ((summary?.retainedBy?.mainView ?? 0) > 0) return sessionId;
      }
      return void 0;
    }

    /** Pick the most-recently-active workspace id, or undefined when empty. */
    function recentWorkspaceId(items, byId) {
      let selected;
      let selectedTime = Number.NEGATIVE_INFINITY;
      for (const workspace of items) {
        let latest = Number.NEGATIVE_INFINITY;
        for (const sessionId of workspace.sessionIds ?? []) {
          const session = byId?.[sessionId];
          if (session !== undefined && typeof session.updatedAt === "number") {
            latest = Math.max(latest, session.updatedAt);
          }
        }
        if (latest === Number.NEGATIVE_INFINITY && workspace.createdAt !== undefined) {
          const parsed = Date.parse(workspace.createdAt);
          if (!Number.isNaN(parsed)) latest = parsed;
        }
        if (selected === undefined || latest > selectedTime) {
          selected = workspace.workspaceId;
          selectedTime = latest;
        }
      }
      return selected;
    }

    /**
     * Build the workspace list plus the default one. Default order: the current
     * session's cwd, the most recently active workspace, the first workspace.
     * Mirrors dsh-kanban so both panels agree on what "this workspace" means.
     */
    function resolveWorkspaces(sessionList, workspaceList) {
      const items = workspaceList?.items ?? [];
      const all = items.map((item) => ({
        workspaceId: item.workspaceId,
        cwd: item.path,
        title: item.title ?? item.path
      }));
      const current = currentSessionId(sessionList);
      if (current !== undefined) {
        const cwd = sessionList?.byId?.[current]?.cwd;
        if (cwd !== undefined && cwd !== "") {
          const base = cwd.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? cwd;
          return {
            all,
            current: all.find((ws) => ws.cwd === cwd) ?? { workspaceId: cwd, cwd, title: base }
          };
        }
      }
      const recentId = recentWorkspaceId(items, sessionList?.byId);
      return { all, current: all.find((ws) => ws.workspaceId === recentId) ?? all[0] };
    }

    /* ------------------------------------------------------------- api ---- */

    /** Fetch-backed access to the host half, bound to this origin. */
    function createStudioApi() {
      const request = async (url, init) => {
        const response = await fetch(url, init);
        let body = null;
        try {
          body = await response.json();
        } catch {
          body = null;
        }
        if (body === null || body.ok !== true) {
          throw new Error((body && body.error) || `workflow-studio: HTTP ${response.status}`);
        }
        return body;
      };
      const post = (cwd, payload) =>
        request(API_ROUTE, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cwd, ...payload })
        });
      /**
       * The assistant is the one call whose *failure* body is worth keeping: a
       * 502 still carries the partial text, which is what the user needs to see
       * after waiting a minute. The generic `request` would discard it.
       */
      const assist = async (cwd, payload) => {
        const response = await fetch(API_ROUTE, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cwd, op: "assist", ...payload })
        });
        let body = null;
        try {
          body = await response.json();
        } catch {
          body = null;
        }
        if (body === null) throw new Error(`workflow-studio: HTTP ${response.status}`);
        if (body.ok !== true) {
          const error = new Error(body.error || `workflow-studio: HTTP ${response.status}`);
          error.detail = body;
          throw error;
        }
        return body;
      };
      return {
        ping: () => request(`${API_ROUTE}?op=ping`),
        list: (cwd) => request(`${API_ROUTE}?op=list&cwd=${encodeURIComponent(cwd)}`),
        read: (cwd, name) =>
          request(`${API_ROUTE}?op=read&cwd=${encodeURIComponent(cwd)}&name=${encodeURIComponent(name)}`),
        save: (cwd, files) => post(cwd, { op: "save", files }),
        remove: (cwd, name) => post(cwd, { op: "delete", name }),
        log: (cwd, event, detail) => post(cwd, { op: "log", event, detail }),
        assist
      };
    }

    /* --------------------------------------------------- studio bridge ---- */

    /**
     * Reach into the embedded studio.
     *
     * Returns null until the studio's own script has run: `buildWorkflowFile` is
     * a top-level function declaration, which a classic script installs as a
     * window property — a reliable readiness probe (the host's error page has
     * no script at all, so a 404 can never be mistaken for a loaded studio).
     */
    function openStudio(frameRef) {
      const frame = frameRef.current;
      if (frame === null) return null;
      let win = null;
      try {
        win = frame.contentWindow;
      } catch {
        return null;
      }
      if (win === null || typeof win.buildWorkflowFile !== "function") return null;

      let db = null;
      // Preferred path: the studio's own persisted record, same origin.
      try {
        const raw = window.localStorage.getItem(LS_KEY);
        if (raw !== null) db = JSON.parse(raw);
      } catch {
        db = null;
      }
      // Fallback: `DB` is a top-level `let`, so it is a global *lexical* binding
      // and only reachable through evaluation, never as win.DB.
      if (db === null || typeof db !== "object") {
        try {
          db = win.eval("DB");
        } catch {
          db = null;
        }
      }
      return { win, db: db !== null && typeof db === "object" ? db : null };
    }

    /** Drop characters the host's file-name guard would reject. */
    function safeStem(win, name) {
      let stem = "workflow";
      try {
        stem = String(win.safeFileName(name) || "workflow");
      } catch {
        stem = String(name || "workflow");
      }
      stem = stem.replace(/^[.\s]+/, "").replace(/[\\/]+/g, "_");
      return stem === "" ? "workflow" : stem.slice(0, 60);
    }

    /**
     * Turn the studio's live state into the two files it would have downloaded:
     * the machine-readable `*.workflow.json` and the human/agent handoff `*.md`.
     * Both are produced by the studio's own builders, so the payload is byte-for
     * -byte what its 导出 button produces.
     */
    function buildExportPayload(win, db, scope) {
      const workflows = Array.isArray(db?.workflows) ? db.workflows : [];
      const active = workflows.filter((wf) => wf?.id === db?.activeWfId);
      const picked = scope === "all" ? workflows : active.length > 0 ? active : workflows;
      const files = [];
      for (const wf of picked) {
        if (wf === null || typeof wf !== "object") continue;
        const stem = safeStem(win, wf.name);
        files.push({
          name: `${stem}.workflow.json`,
          text: JSON.stringify(win.buildWorkflowFile(wf), null, 2)
        });
        files.push({ name: `${stem}-交接包.md`, text: String(win.buildHandoff(wf)) });
      }
      return { files, count: picked.length };
    }

    /* --------------------------------------------------------- assistant -- */

    function asText(value) {
      return typeof value === "string" && value !== "" ? value : null;
    }

    function isObj(value) {
      return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    /** The assistant's parked review. Nothing here touches the studio's key. */
    const EMPTY_ASSIST = {
      phase: "idle",
      task: "review",
      instruction: "",
      scopeTitle: "",
      startedAt: 0,
      meta: null,
      summary: "",
      findings: [],
      patches: [],
      raw: "",
      picked: [],
      note: null,
      error: null
    };

    /** A corrupt or absent entry is not an error — it is an empty review. */
    function readAssistState() {
      try {
        const raw = window.localStorage.getItem(ASSIST_KEY);
        if (raw !== null) {
          const parsed = JSON.parse(raw);
          if (isObj(parsed)) return { ...EMPTY_ASSIST, ...parsed };
        }
      } catch {
        /* fall through */
      }
      return { ...EMPTY_ASSIST };
    }

    function writeAssistState(state) {
      try {
        window.localStorage.setItem(ASSIST_KEY, JSON.stringify(state));
      } catch {
        /* the review still works; it just will not survive a reload */
      }
    }

    /**
     * Assistant state lives outside React on purpose: a review is a 30–90 s
     * round trip, and the panel unmounts the moment the user looks at the
     * conversation. Component state would throw the answer away mid-flight.
     */
    const assistStore = (() => {
      let state = readAssistState();
      const listeners = new Set();
      const emit = () => {
        for (const listener of listeners) {
          try {
            listener();
          } catch {
            /* one bad subscriber must not stop the others */
          }
        }
      };
      return {
        get: () => state,
        set(patch) {
          state = { ...state, ...patch };
          writeAssistState(state);
          emit();
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        }
      };
    })();

    function activeWorkflow(db) {
      const workflows = Array.isArray(db?.workflows) ? db.workflows : [];
      return workflows.find((wf) => wf?.id === db?.activeWfId) ?? workflows[0] ?? null;
    }

    function orderOf(win, wf) {
      try {
        const sorted = win.topoSort(wf);
        if (Array.isArray(sorted)) return sorted.map((node) => node?.id).filter(Boolean);
      } catch {
        /* a cyclic graph still has a usable node order */
      }
      return (Array.isArray(wf.nodes) ? wf.nodes : []).map((node) => node.id);
    }

    /**
     * Project the live workflow into exactly what the model needs.
     *
     * Field names are the DB's (`role`, `humanCheck`), never the export's
     * (`owner`, `humanCheckpoint`): the patches come back keyed the same way and
     * are applied by direct assignment, so a second vocabulary would just be a
     * second place to be wrong. Positional and transient fields stay home.
     */
    function projectWorkflow(win, db, focusId) {
      const wf = activeWorkflow(db);
      if (wf === null) return null;
      const order = orderOf(win, wf);
      const stepOf = new Map(order.map((id, index) => [id, index + 1]));
      const nodes = (Array.isArray(wf.nodes) ? wf.nodes : []).map((node) => ({
        id: node.id,
        type: node.type,
        step: stepOf.get(node.id) ?? null,
        title: node.title,
        role: node.role ?? "",
        model: node.model ?? "",
        instruction: node.instruction ?? "",
        inputs: node.inputs ?? "",
        outputs: node.outputs ?? "",
        acceptance: node.acceptance ?? "",
        forbidden: node.forbidden ?? "",
        humanCheck: node.humanCheck === true,
        timeoutSec: node.timeoutSec ?? 0,
        retry: node.retry ?? 0,
        notes: node.notes ?? ""
      }));
      const focused = focusId === "" ? null : nodes.find((node) => node.id === focusId) ?? null;
      return {
        scopeTitle: focused === null ? wf.name : `${wf.name} · ${focused.title}`,
        payload: {
          workflow: {
            id: wf.id,
            name: wf.name,
            goal: wf.goal ?? "",
            delivery: wf.delivery ?? "",
            constraints: wf.constraints ?? ""
          },
          nodes,
          edges: (Array.isArray(wf.edges) ? wf.edges : []).map((edge) => ({
            from: edge.from,
            to: edge.to,
            label: edge.label ?? ""
          })),
          order,
          focus: focused === null ? [] : [focused.id]
        }
      };
    }

    const WF_TEXT_FIELDS = ["name", "goal", "delivery", "constraints"];
    const NODE_TEXT_FIELDS = [
      "title", "type", "role", "model", "instruction",
      "inputs", "outputs", "acceptance", "forbidden", "notes"
    ];
    const FIELD_KEYS = {
      name: "fieldName", goal: "fieldGoal", delivery: "fieldDelivery", constraints: "fieldConstraints",
      title: "fieldTitle", type: "fieldType", role: "fieldRole", model: "fieldModel",
      instruction: "fieldInstruction", inputs: "fieldInputs", outputs: "fieldOutputs",
      acceptance: "fieldAcceptance", forbidden: "fieldForbidden", humanCheck: "fieldHumanCheck",
      timeoutSec: "fieldTimeoutSec", retry: "fieldRetry", notes: "fieldNotes"
    };
    const OP_KEYS = {
      set: "patchSet",
      "add-node": "patchAdd",
      "remove-node": "patchRemove",
      link: "patchLink",
      unlink: "patchUnlink"
    };
    /** Long enough for a real instruction, short enough to stay a prompt. */
    const MAX_FIELD_CHARS = 20000;

    function asBool(value) {
      if (value === true || value === false) return value;
      if (value === "true" || value === 1) return true;
      if (value === "false" || value === 0) return false;
      return null;
    }

    function asCount(value) {
      const number = typeof value === "number" ? value : Number(String(value ?? "").trim());
      if (!Number.isFinite(number) || number < 0) return null;
      return Math.floor(number);
    }

    /**
     * Turn one model-proposed patch into a normalized edit, or a reason to skip.
     *
     * This is the security boundary of the feature: the model's JSON is
     * untrusted input about to be written into the studio's live DB, so every
     * op, field, target and value type is checked against an allow-list here —
     * and this function is the only thing that decides what `applyEdits` may
     * touch. Anything unrecognized is skipped and shown as skipped, never
     * dropped silently.
     */
    function validatePatch(patch, wf) {
      const bad = (reason) => ({ ok: false, reason, patch });
      const op = asText(patch.op);
      const nodes = Array.isArray(wf.nodes) ? wf.nodes : [];
      const byId = new Map(nodes.map((node) => [node.id, node]));
      const edges = Array.isArray(wf.edges) ? wf.edges : [];

      if (op === "set") {
        const target = asText(patch.target);
        const field = asText(patch.field);
        if (field === null) return bad("缺少 field");
        if (target === null || target === "wf") {
          if (!WF_TEXT_FIELDS.includes(field)) return bad(`工作流没有可改字段 ${field}`);
          const value = String(patch.value ?? "");
          if (value.length > MAX_FIELD_CHARS) return bad("内容过长");
          return { ok: true, patch, edit: { op: "set", target: "wf", field, value } };
        }
        const node = byId.get(target);
        if (node === undefined) return bad(`找不到节点 ${target}`);
        if (NODE_TEXT_FIELDS.includes(field)) {
          const value = String(patch.value ?? "");
          if (value.length > MAX_FIELD_CHARS) return bad("内容过长");
          return { ok: true, patch, edit: { op: "set", target, field, value } };
        }
        if (field === "humanCheck") {
          const value = asBool(patch.value);
          if (value === null) return bad("humanCheck 不是布尔值");
          return { ok: true, patch, edit: { op: "set", target, field, value } };
        }
        if (field === "timeoutSec" || field === "retry") {
          const value = asCount(patch.value);
          if (value === null) return bad(`${field} 不是非负数字`);
          return { ok: true, patch, edit: { op: "set", target, field, value } };
        }
        return bad(`节点没有可改字段 ${field}`);
      }

      if (op === "add-node") {
        const node = patch.node;
        if (!isObj(node)) return bad("node 不是对象");
        const title = asText(node.title);
        if (title === null) return bad("新节点缺少 title");
        const after = asText(patch.after);
        if (after !== null && !byId.has(after)) return bad(`after 指向不存在的节点 ${after}`);
        let type = asText(node.type) ?? "llm";
        let note = null;
        if (!NODE_TYPES.includes(type)) {
          note = `类型 ${type} 工作台不认识，已按「模型指令」创建`;
          type = "llm";
        }
        const text = (key) => {
          const value = node[key];
          return typeof value === "string" ? value.slice(0, MAX_FIELD_CHARS) : "";
        };
        return {
          ok: true,
          patch,
          edit: {
            op: "add-node",
            after,
            type,
            note,
            node: {
              type,
              title,
              role: text("role"),
              model: text("model"),
              instruction: text("instruction"),
              inputs: text("inputs"),
              outputs: text("outputs"),
              acceptance: text("acceptance"),
              forbidden: text("forbidden"),
              notes: text("notes"),
              humanCheck: asBool(node.humanCheck) === true
            }
          }
        };
      }

      if (op === "remove-node") {
        const target = asText(patch.target);
        if (target === null || !byId.has(target)) return bad(`找不到节点 ${String(patch.target)}`);
        return { ok: true, patch, edit: { op: "remove-node", target } };
      }

      if (op === "link" || op === "unlink") {
        const from = asText(patch.from);
        const to = asText(patch.to);
        if (from === null || to === null) return bad("缺少 from 或 to");
        if (!byId.has(from) || !byId.has(to)) return bad("连线两端必须都是已有节点");
        if (from === to) return bad("不能连到自身");
        const exists = edges.some((edge) => edge.from === from && edge.to === to);
        if (op === "link" && exists) return bad("这条连线已经存在");
        if (op === "unlink" && !exists) return bad("这条连线不存在");
        return {
          ok: true,
          patch,
          edit: { op, from, to, label: op === "link" ? String(patch.label ?? "").slice(0, 200) : "" }
        };
      }

      return bad(`不支持的 op：${String(patch.op)}`);
    }

    /**
     * Write validated edits into the studio's live workflow.
     *
     * The order is the studio's own idiom, repeated at 47 sites in index.html:
     * `touchWf` → `saveData(true)` → `commit(label)` → `refreshAll()`. `commit`
     * runs *after* the mutation because its snapshot is the post-change state —
     * that is precisely what makes Ctrl+Z inside the studio restore the
     * pre-assistant version.
     */
    function applyEdits(win, edits) {
      const wf = win.getActiveWf();
      if (wf === null || wf === undefined) throw new Error("工作台里没有活动工作流");
      if (!Array.isArray(wf.nodes)) wf.nodes = [];
      if (!Array.isArray(wf.edges)) wf.edges = [];

      const byId = new Map(wf.nodes.map((node) => [node.id, node]));
      const lastOfOrder = () => {
        const order = orderOf(win, wf);
        return order.length === 0 ? null : byId.get(order[order.length - 1]) ?? null;
      };
      // Place new nodes next to an anchor instead of re-running the studio's
      // full auto-layout, which would discard the user's own arrangement.
      const freeSpot = (anchor) => {
        if (anchor !== null) return { x: (Number(anchor.x) || 0) + 240, y: Number(anchor.y) || 0 };
        let maxX = 0;
        let minY = 0;
        wf.nodes.forEach((node, index) => {
          maxX = Math.max(maxX, Number(node.x) || 0);
          minY = index === 0 ? Number(node.y) || 0 : Math.min(minY, Number(node.y) || 0);
        });
        return { x: maxX + 240, y: minY };
      };

      let changed = 0;
      for (const edit of edits) {
        if (edit.op === "set") {
          if (edit.target === "wf") {
            wf[edit.field] = edit.value;
          } else {
            const node = byId.get(edit.target);
            if (node === undefined) continue;
            node[edit.field] = edit.value;
          }
          changed += 1;
          continue;
        }
        if (edit.op === "add-node") {
          const anchor = edit.after === null ? lastOfOrder() : byId.get(edit.after) ?? null;
          const spot = freeSpot(anchor);
          const node = { ...edit.node, id: win.uid("n"), x: spot.x, y: spot.y, checked: false, timeoutSec: 0, retry: 0 };
          wf.nodes.push(node);
          byId.set(node.id, node);
          if (anchor !== null) {
            wf.edges.push({ id: win.uid("e"), from: anchor.id, to: node.id, label: "" });
          }
          changed += 1;
          continue;
        }
        if (edit.op === "remove-node") {
          wf.nodes = wf.nodes.filter((node) => node.id !== edit.target);
          wf.edges = wf.edges.filter((edge) => edge.from !== edit.target && edge.to !== edit.target);
          byId.delete(edit.target);
          changed += 1;
          continue;
        }
        if (edit.op === "link") {
          wf.edges.push({ id: win.uid("e"), from: edit.from, to: edit.to, label: edit.label });
          changed += 1;
          continue;
        }
        if (edit.op === "unlink") {
          wf.edges = wf.edges.filter((edge) => !(edge.from === edit.from && edge.to === edit.to));
          changed += 1;
        }
      }

      win.touchWf(wf);
      win.saveData(true);
      win.commit(`AI 助手：应用 ${changed} 处修改`);
      win.refreshAll();
      return changed;
    }

    function fieldLabel(t, field) {
      const key = FIELD_KEYS[field];
      return key === undefined ? String(field) : t(key);
    }

    function severityOf(value) {
      return value === "error" || value === "warn" ? value : "info";
    }

    function severityLabel(t, value) {
      const severity = severityOf(value);
      return t(severity === "error" ? "severityError" : severity === "warn" ? "severityWarn" : "severityInfo");
    }

    function titleOfNode(nodes, id) {
      const node = nodes.find((item) => item.id === id);
      return node === undefined ? String(id ?? "") : node.title;
    }

    function targetLabel(t, nodes, wf, target) {
      if (target === null || target === undefined || target === "wf") {
        return wf === null ? "workflow" : wf.name;
      }
      return titleOfNode(nodes, target);
    }

    function clip(value) {
      const text = String(value ?? "");
      return text.length > 400 ? `${text.slice(0, 400)}…` : text;
    }

    /**
     * The assistant drawer. Sits over the right edge of the frame so the studio
     * stays visible and usable while a review is being read.
     */
    function AssistDrawer(props) {
      const t = props.t;
      const api = props.api;
      const cwd = props.cwd;
      const ready = props.ready;
      const getStudio = props.getStudio;
      const state = react.useSyncExternalStore(assistStore.subscribe, assistStore.get);
      const [focusId, setFocusId] = react.useState("");
      const [info, setInfo] = react.useState(null);
      // Bumped once a second while a call is in flight: it is what re-renders
      // the elapsed clock, nothing else.
      const [tick, setTick] = react.useState(0);

      const running = state.phase === "running";
      // Reading the studio parses the whole DB; pointless while a call is in
      // flight, and the ticker would repeat it once a second.
      const studio = running ? null : getStudio();
      const wf = studio === null ? null : activeWorkflow(studio.db);
      const nodes = wf === null || !Array.isArray(wf.nodes) ? [] : wf.nodes;

      react.useEffect(() => {
        let alive = true;
        api
          .ping()
          .then((body) => {
            if (alive) setInfo(isObj(body?.assist) ? body.assist : null);
          })
          .catch(() => {
            if (alive) setInfo(null);
          });
        return () => {
          alive = false;
        };
      }, [api]);

      react.useEffect(() => {
        if (!running) return undefined;
        let alive = true;
        let timer = null;
        const loop = () => {
          if (!alive) return;
          setTick((value) => value + 1);
          timer = setTimeout(loop, 1000);
        };
        timer = setTimeout(loop, 1000);
        return () => {
          alive = false;
          clearTimeout(timer);
        };
      }, [running]);

      const run = react.useCallback(
        async (task) => {
          if (cwd === undefined) return;
          const current = getStudio();
          if (current === null) {
            assistStore.set({ phase: "error", error: t("notReady"), meta: null, raw: "" });
            return;
          }
          const projection = projectWorkflow(current.win, current.db, focusId);
          if (projection === null) {
            assistStore.set({ phase: "error", error: t("noWorkflow"), meta: null, raw: "" });
            return;
          }
          assistStore.set({
            phase: "running",
            task,
            instruction: state.instruction,
            scopeTitle: projection.scopeTitle,
            startedAt: Date.now(),
            meta: null,
            summary: "",
            findings: [],
            patches: [],
            raw: "",
            picked: [],
            note: null,
            error: null
          });
          try {
            const body = await api.assist(cwd, {
              task,
              instruction: state.instruction.trim() === "" ? null : state.instruction,
              ...projection.payload
            });
            const patches = Array.isArray(body.patches) ? body.patches : [];
            assistStore.set({
              phase: "done",
              meta: {
                provider: body.provider ?? null,
                model: body.model ?? null,
                elapsedMs: body.elapsedMs ?? null,
                usage: isObj(body.usage) ? body.usage : null,
                recordPath: body.recordPath ?? null,
                parseError: body.parseError ?? null
              },
              summary: typeof body.summary === "string" ? body.summary : "",
              findings: Array.isArray(body.findings) ? body.findings : [],
              patches,
              picked: patches.map(() => true),
              raw: typeof body.text === "string" ? body.text : ""
            });
          } catch (error) {
            // A failed call still carries the partial text; keep it visible.
            const detail = isObj(error?.detail) ? error.detail : null;
            assistStore.set({
              phase: "error",
              error: String(error?.message ?? error),
              meta:
                detail === null
                  ? null
                  : {
                      provider: detail.provider ?? null,
                      model: detail.model ?? null,
                      elapsedMs: detail.elapsedMs ?? null,
                      usage: isObj(detail.usage) ? detail.usage : null,
                      recordPath: detail.recordPath ?? null,
                      parseError: null
                    },
              raw: detail !== null && typeof detail.text === "string" ? detail.text : ""
            });
          }
        },
        [api, cwd, focusId, getStudio, state.instruction, t]
      );

      const views = state.patches.map((patch) =>
        wf === null ? { ok: false, reason: t("notReady"), patch } : validatePatch(patch, wf)
      );
      const usable = views.filter((view) => view.ok).length;
      const pickedCount = views.reduce((sum, view, index) => sum + (view.ok && state.picked[index] === true ? 1 : 0), 0);

      const toggle = (index) => {
        const picked = state.picked.slice();
        picked[index] = picked[index] !== true;
        assistStore.set({ picked });
      };

      const apply = () => {
        const current = getStudio();
        const edits = views.filter((view, index) => view.ok && state.picked[index] === true).map((view) => view.edit);
        if (current === null || edits.length === 0) return;
        if (window.confirm(t("confirmApply")) !== true) return;
        try {
          const changed = applyEdits(current.win, edits);
          assistStore.set({ note: `${t("applied")} ${changed} ${t("places")} · ${t("undoHint")}` });
        } catch (error) {
          assistStore.set({ note: `${t("aiFailed")}：${String(error?.message ?? error)}` });
        }
      };

      const diffRows = (edit) => {
        if (edit.op === "set") {
          const before =
            edit.target === "wf"
              ? (wf === null ? "" : wf[edit.field] ?? "")
              : (nodes.find((node) => node.id === edit.target)?.[edit.field] ?? "");
          const after = edit.value === true ? "✓" : edit.value === false ? "✗" : String(edit.value);
          return h(
            "div",
            { className: "ws-ai-diff" },
            h("div", { className: "ws-ai-before", title: t("beforeLabel") }, clip(before)),
            h("div", { className: "ws-ai-after", title: t("afterLabel") }, clip(after))
          );
        }
        if (edit.op === "add-node") {
          return h(
            "div",
            { className: "ws-ai-diff" },
            h("div", { className: "ws-ai-after" }, clip(`${edit.node.title}（${edit.type}）\n${edit.node.instruction}`)),
            h(
              "div",
              { className: "ws-ai-why" },
              edit.after === null ? "接在末尾" : `接在「${targetLabel(t, nodes, wf, edit.after)}」之后`
            )
          );
        }
        if (edit.op === "remove-node") {
          return h("div", { className: "ws-ai-diff" }, h("div", { className: "ws-ai-before" }, clip(titleOfNode(nodes, edit.target))));
        }
        return h(
          "div",
          { className: "ws-ai-diff" },
          h(
            "div",
            { className: "ws-ai-after" },
            `${titleOfNode(nodes, edit.from)} → ${titleOfNode(nodes, edit.to)}${edit.label === "" ? "" : `（${edit.label}）`}`
          )
        );
      };

      const renderPatch = (view, index) => {
        const patch = view.patch;
        const opKey = OP_KEYS[asText(patch.op)] ?? "patchSet";
        if (!view.ok) {
          return h(
            "div",
            { className: "ws-ai-patch ws-ai-patch-off", key: `p${index}` },
            h(
              "div",
              { className: "ws-ai-patch-head" },
              h("span", { className: "ws-ai-badge" }, t(opKey)),
              h("span", { className: "ws-ai-target" }, String(patch.target ?? patch.from ?? "")),
              h("span", { className: "ws-ai-skip" }, `${t("skipped")}：${view.reason}`)
            )
          );
        }
        const edit = view.edit;
        const checked = state.picked[index] === true;
        const why = asText(patch.why);
        return h(
          "div",
          { className: `ws-ai-patch${checked ? "" : " ws-ai-patch-off"}`, key: `p${index}` },
          h(
            "div",
            { className: "ws-ai-patch-head" },
            h("input", { type: "checkbox", checked, onChange: () => toggle(index) }),
            h("span", { className: "ws-ai-badge" }, t(opKey)),
            h("span", { className: "ws-ai-target" }, targetLabel(t, nodes, wf, edit.target ?? edit.from)),
            edit.op === "set" ? h("span", { className: "ws-ai-badge" }, fieldLabel(t, edit.field)) : null
          ),
          diffRows(edit),
          edit.note === null ? null : h("div", { className: "ws-ai-skip" }, edit.note),
          why === null ? null : h("div", { className: "ws-ai-why" }, `${t("why")}：${why}`)
        );
      };

      const modelLabel =
        info === null
          ? t("modelUnavailable")
          : info.ok === true
            ? `${info.provider} / ${info.model}`
            : String(info.reason ?? t("modelUnavailable"));
      const elapsedSec = Math.max(
        0,
        Math.round((running ? Date.now() - (state.startedAt || Date.now()) : state.meta?.elapsedMs ?? 0) / 1000)
      );
      const showRaw = state.raw !== "" && (state.meta?.parseError != null || state.error !== null);

      return h(
        "aside",
        { className: "ws-ai" },
        h(
          "div",
          { className: "ws-ai-head" },
          h("h3", { className: "ws-ai-title" }, t("assist")),
          h("span", { className: "ws-ai-model", title: modelLabel }, modelLabel),
          h("button", { className: "ws-btn", type: "button", onClick: props.onClose }, t("close"))
        ),
        h(
          "div",
          { className: "ws-ai-body" },
          h("p", { className: "ws-ai-hint" }, t("assistIntro")),
          h(
            "div",
            { className: "ws-ai-row" },
            h("span", { className: "ws-ai-hint" }, t("focus")),
            h(
              "select",
              {
                className: "ws-ai-select",
                value: focusId,
                disabled: running || nodes.length === 0,
                onChange: (event) => setFocusId(event.target.value)
              },
              h("option", { value: "" }, t("wholeFlow")),
              nodes.map((node) => h("option", { key: node.id, value: node.id }, node.title))
            )
          ),
          h(
            "div",
            { className: "ws-ai-row" },
            h(
              "button",
              {
                className: "ws-btn ws-btn-primary",
                type: "button",
                disabled: !ready || running || wf === null,
                onClick: () => run("review")
              },
              t("review")
            ),
            h(
              "button",
              {
                className: "ws-btn",
                type: "button",
                disabled: !ready || running || focusId === "",
                onClick: () => run("optimize")
              },
              t("optimize")
            )
          ),
          h("textarea", {
            className: "ws-ai-input",
            placeholder: t("instructionPlaceholder"),
            value: state.instruction,
            disabled: running,
            onChange: (event) => assistStore.set({ instruction: event.target.value })
          }),
          h(
            "div",
            { className: "ws-ai-row" },
            h(
              "button",
              {
                className: "ws-btn",
                type: "button",
                disabled: !ready || running || state.instruction.trim() === "",
                onClick: () => run("custom")
              },
              t("runCustom")
            )
          ),
          running
            ? h(
                "div",
                { className: "ws-ai-row", key: `tick-${tick}` },
                h("span", { className: "ws-ai-spin" }),
                h("span", { className: "ws-ai-hint" }, `${t("running")} ${state.scopeTitle} · ${t("elapsed")} ${elapsedSec}s`)
              )
            : null,
          state.error === null ? null : h("div", { className: "ws-note ws-note-error" }, `${t("aiFailed")}：${state.error}`),
          state.note === null ? null : h("div", { className: "ws-note" }, state.note),
          state.summary === "" ? null : h("p", { className: "ws-ai-hint" }, state.summary),
          state.meta === null
            ? null
            : h(
                "p",
                { className: "ws-ai-hint" },
                `${state.meta.provider ?? ""} ${state.meta.model ?? ""} · ${Math.round((state.meta.elapsedMs ?? 0) / 1000)}s` +
                  (isObj(state.meta.usage) && state.meta.usage.inputTokens !== undefined
                    ? ` · ${state.meta.usage.inputTokens}→${state.meta.usage.outputTokens ?? "?"} tokens`
                    : "")
              ),
          state.meta?.parseError == null ? null : h("div", { className: "ws-note ws-note-error" }, t("parseWarn")),
          state.findings.length === 0
            ? state.phase === "done"
              ? h("p", { className: "ws-ai-hint" }, t("noFindings"))
              : null
            : h(
                "section",
                { className: "ws-ai-section" },
                h("h4", { className: "ws-ai-section-title" }, `${t("findings")} · ${state.findings.length}`),
                state.findings.map((finding, index) =>
                  h(
                    "div",
                    {
                      className: `ws-ai-finding ws-ai-finding-${severityOf(finding?.severity)}`,
                      key: `f${index}`
                    },
                    h("div", { className: "ws-ai-finding-title" }, String(finding?.title ?? "")),
                    h(
                      "div",
                      { className: "ws-ai-finding-meta" },
                      `${severityLabel(t, finding?.severity)} · ${targetLabel(t, nodes, wf, finding?.target)}`
                    ),
                    h("div", null, String(finding?.detail ?? ""))
                  )
                )
              ),
          views.length === 0
            ? state.phase === "done"
              ? h("p", { className: "ws-ai-hint" }, t("noPatches"))
              : null
            : h(
                "section",
                { className: "ws-ai-section" },
                h("h4", { className: "ws-ai-section-title" }, `${t("patches")} · ${pickedCount}/${usable}`),
                views.map((view, index) => renderPatch(view, index))
              ),
          showRaw
            ? h(
                "details",
                { className: "ws-ai-section" },
                h("summary", { className: "ws-ai-section-title" }, t("raw")),
                h("div", { className: "ws-ai-raw" }, state.raw)
              )
            : null,
          state.meta?.recordPath == null
            ? null
            : h("p", { className: "ws-ai-hint" }, `${t("recordPath")}：${state.meta.recordPath}`)
        ),
        h(
          "div",
          { className: "ws-ai-foot" },
          h(
            "button",
            {
              className: "ws-btn ws-btn-primary",
              type: "button",
              disabled: running || pickedCount === 0,
              onClick: apply
            },
            `${t("applyPicked")} (${pickedCount})`
          ),
          h(
            "button",
            {
              className: "ws-btn",
              type: "button",
              disabled: running || usable === 0,
              onClick: () => assistStore.set({ picked: state.patches.map(() => true) })
            },
            t("selectAll")
          ),
          h(
            "button",
            {
              className: "ws-btn",
              type: "button",
              disabled: running || usable === 0,
              onClick: () => assistStore.set({ picked: state.patches.map(() => false) })
            },
            t("selectNone")
          ),
          h("span", { className: "ws-ai-hint" }, t("aiNote"))
        )
      );
    }

    /* ----------------------------------------------------------- icons ---- */

    /** Sidebar glyph: a two-node flow, sized the way the sidebar asks. */
    function StudioPanelIcon(props) {
      const size = props?.size ?? 20;
      return h(
        "span",
        { className: "ws-icon" },
        h(
          "svg",
          {
            width: size,
            height: size,
            viewBox: "0 0 24 24",
            fill: "none",
            stroke: "currentColor",
            strokeWidth: 1.6,
            strokeLinecap: "round",
            strokeLinejoin: "round",
            "aria-hidden": "true"
          },
          h("rect", { key: "a", x: 3, y: 3.5, width: 7, height: 5, rx: 1.5 }),
          h("rect", { key: "b", x: 14, y: 15.5, width: 7, height: 5, rx: 1.5 }),
          h("path", { key: "c", d: "M6.5 8.5 V17 a1.5 1.5 0 0 0 1.5 1.5 H14" })
        )
      );
    }

    /* ----------------------------------------------------------- panel ---- */

    /**
     * The `main` panel occupant. The frame renders it only while this panel is
     * selected, so it needs no visibility gate of its own.
     */
    function StudioPanel(props) {
      const t = props.t ?? ((key) => key);
      const api = props.api;
      const { all: workspaces, current } = resolveWorkspaces(
        props.useSessions?.((state) => state) ?? {},
        props.useWorkspaces?.((state) => state) ?? {}
      );

      const [selected, setSelected] = react.useState(current);
      const [nonce, setNonce] = react.useState(0);
      const [phase, setPhase] = react.useState("loading");
      const [appStatus, setAppStatus] = react.useState(null);
      const [note, setNote] = react.useState(null);
      const [files, setFiles] = react.useState([]);
      const [busy, setBusy] = react.useState(false);
      const [pickerOpen, setPickerOpen] = react.useState(false);
      const [drawer, setDrawer] = react.useState(false);
      const frameRef = react.useRef(null);
      const probedRef = react.useRef(false);
      // Re-read on demand: the studio mutates its own DB (and the assistant
      // mutates it back), so a snapshot taken at load time would go stale.
      const getStudio = react.useCallback(() => openStudio(frameRef), []);

      // `current` can resolve after the first render; adopt it once, then keep
      // the user's explicit pick (same policy as dsh-kanban's board page). When
      // the session's workspace never arrives (no session yet, or the session
      // list resolves empty), fall back to the first registered workspace —
      // otherwise `cwd` stays undefined forever, the frame never mounts, and the
      // panel shows only "no workspace" without producing a single log line.
      react.useEffect(() => {
        if (selected !== undefined) return;
        if (current !== undefined) setSelected(current);
        else if (workspaces.length > 0) setSelected(workspaces[0]);
      }, [current, selected, workspaces]);

      const cwd = selected?.cwd;
      const appUrl = cwd === undefined ? null : `${APP_ROUTE}?cwd=${encodeURIComponent(cwd)}`;

      const refreshFiles = react.useCallback(async () => {
        if (cwd === undefined) {
          setFiles([]);
          return;
        }
        try {
          const body = await api.list(cwd);
          setFiles(Array.isArray(body.files) ? body.files : []);
        } catch (error) {
          setFiles([]);
          setNote({ kind: "error", text: String(error.message ?? error) });
        }
      }, [api, cwd]);

      const report = react.useCallback(
        (event, detail) => {
          if (cwd === undefined) return;
          api.log(cwd, event, detail).catch(() => {});
        },
        [api, cwd]
      );

      react.useEffect(() => {
        probeOnce(probedRef, appUrl, report, setAppStatus);
      }, [appUrl, report]);

      react.useEffect(() => {
        refreshFiles();
      }, [refreshFiles]);

      // Reset readiness and turn the list over whenever the workspace changes.
      react.useEffect(() => {
        setPhase("loading");
      }, [appUrl]);

      react.useEffect(() => {
        if (note === null) return undefined;
        const timer = setTimeout(() => setNote(null), 5000);
        return () => clearTimeout(timer);
      }, [note]);

      const onFrameLoad = react.useCallback(() => {
        const frame = frameRef.current;
        let probe;
        try {
          const doc = frame?.contentDocument ?? null;
          const win = frame?.contentWindow ?? null;
          probe = {
            sameDocument: doc !== null,
            title: doc?.title ?? null,
            studioReady: typeof win?.buildWorkflowFile === "function",
            hasImport: typeof win?.doImport === "function"
          };
        } catch (error) {
          probe = { sameDocument: false, error: String(error) };
        }
        setPhase(probe.studioReady === true ? "ready" : "error");
        if (probe.studioReady !== true) {
          // A 404 from the app route means the workspace (and the fallback
          // roots) have no studio HTML — say that, instead of blaming iframe
          // sandboxing, which sends the reader hunting in the wrong place.
          const missing = appStatus === 404;
          setNote({ kind: "error", text: missing ? t("assetMissing") : t("frameBlocked") });
        }
        report("client:iframe-load", probe);
      }, [appStatus, report, t]);

      // The HEAD probe and the iframe load race: when the frame's own load event
      // lands first, the note starts as the generic "may be blocked" text. The
      // probe result upgrades it to the actionable message once it arrives.
      react.useEffect(() => {
        if (appStatus !== 404 || phase !== "error") return;
        setNote({ kind: "error", text: t("assetMissing") });
      }, [appStatus, phase, t]);

      const runSave = react.useCallback(
        async (scope) => {
          const studio = openStudio(frameRef);
          if (studio === null) {
            setNote({ kind: "error", text: t("notReady") });
            return;
          }
          const payload = buildExportPayload(studio.win, studio.db, scope);
          if (payload.files.length === 0) {
            setNote({ kind: "error", text: t("noWorkflow") });
            return;
          }
          setBusy(true);
          try {
            const body = await api.save(cwd, payload.files);
            setFiles(Array.isArray(body.files) ? body.files : []);
            setNote({
              kind: "ok",
              text: `${t("saved")} · ${payload.count} → ${body.dir}`
            });
          } catch (error) {
            setNote({ kind: "error", text: String(error.message ?? error) });
          } finally {
            setBusy(false);
          }
        },
        [api, cwd, t]
      );

      const runLoad = react.useCallback(
        async (file) => {
          const studio = openStudio(frameRef);
          if (studio === null) {
            setNote({ kind: "error", text: t("notReady") });
            return;
          }
          setBusy(true);
          try {
            const body = await api.read(cwd, file.name);
            // The studio's importer takes JSON text and persists + re-renders
            // itself (it appends a marker to the name and re-ids the nodes).
            studio.win.doImport(body.text);
            setNote({ kind: "ok", text: `${t("imported")} · ${file.name}` });
          } catch (error) {
            setNote({ kind: "error", text: String(error.message ?? error) });
          } finally {
            setBusy(false);
          }
        },
        [api, cwd, t]
      );

      const runDelete = react.useCallback(
        async (file) => {
          if (window.confirm(`${t("confirmDelete")}\n\n${file.name}`) !== true) return;
          setBusy(true);
          try {
            const body = await api.remove(cwd, file.name);
            setFiles(Array.isArray(body.files) ? body.files : []);
            setNote({ kind: "ok", text: `${t("deleted")} · ${file.name}` });
          } catch (error) {
            setNote({ kind: "error", text: String(error.message ?? error) });
          } finally {
            setBusy(false);
          }
        },
        [api, cwd, t]
      );

      const ready = phase === "ready";

      return h(
        "div",
        { className: "ws-panel" },
        h(
          "header",
          { className: "ws-header" },
          h(
            "div",
            { className: "ws-header-main" },
            h("h2", { className: "ws-title" }, t("title")),
            h("p", { className: "ws-header-sub" }, t("intro"))
          ),
          h(
            "div",
            { className: "ws-header-actions" },
            h(
              "span",
              { className: `ws-pill ${ready ? "ws-pill-ready" : phase === "error" ? "ws-pill-error" : ""}` },
              phase === "ready" ? t("ready") : phase === "error" ? t("notReady") : t("loading")
            ),
            h(WorkspacePicker, {
              workspaces,
              selected,
              open: pickerOpen,
              onToggle: () => setPickerOpen((value) => !value),
              onSelect: (workspace) => {
                setPickerOpen(false);
                setSelected(workspace);
              },
              t
            }),
            h(
              "button",
              {
                className: "ws-btn",
                type: "button",
                onClick: () => {
                  // Re-probe as well as re-mount: the probe is once per URL, and
                  // "reload" is the user's retry after fixing a missing studio.
                  probedRef.current = false;
                  setAppStatus(null);
                  setNonce((value) => value + 1);
                },
                title: t("reload")
              },
              t("reload")
            ),
            h(
              "button",
              {
                className: "ws-btn",
                type: "button",
                disabled: appUrl === null,
                onClick: () => {
                  if (appUrl !== null) window.open(appUrl, "_blank", "noopener");
                }
              },
              t("openTab")
            ),
            h("button", { className: "ws-btn", type: "button", onClick: props.onClose }, t("close"))
          )
        ),
        h(
          "div",
          { className: "ws-toolbar" },
          h(
            "button",
            {
              className: "ws-btn ws-btn-primary",
              type: "button",
              disabled: !ready || busy,
              onClick: () => runSave("active")
            },
            t("saveActive")
          ),
          h(
            "button",
            {
              className: "ws-btn",
              type: "button",
              disabled: !ready || busy,
              onClick: () => runSave("all")
            },
            t("saveAll")
          ),
          h(
            "button",
            {
              className: `ws-btn${drawer ? " ws-btn-primary" : " ws-btn-ai"}`,
              type: "button",
              disabled: !ready,
              onClick: () => setDrawer((value) => !value)
            },
            t("assist")
          ),
          h("span", { className: "ws-status" }, t("loadHint"))
        ),
        h(
          "div",
          { className: "ws-body" },
          appUrl === null
            ? h("div", { className: "ws-note" }, t("noWorkspace"))
            : h("iframe", {
                key: `${appUrl}#${nonce}`,
                ref: frameRef,
                className: "ws-frame",
                src: appUrl,
                title: t("title"),
                onLoad: onFrameLoad,
                // The studio is a self-contained local document; it needs no
                // privileges, so hand it none.
                sandbox: "allow-scripts allow-same-origin allow-downloads allow-modals allow-popups allow-forms"
              }),
          drawer
            ? h(AssistDrawer, {
                t,
                api,
                cwd,
                ready,
                getStudio,
                onClose: () => setDrawer(false)
              })
            : null
        ),
        note !== null
          ? h("div", { className: `ws-note ${note.kind === "error" ? "ws-note-error" : ""}` }, note.text)
          : null,
        h(
          "footer",
          { className: "ws-files" },
          h("span", null, `${t("files")} · ${files.length}`),
          files.length === 0
            ? h("span", null, t("noFiles"))
            : files.map((file) =>
                h(
                  "span",
                  { className: "ws-chip", key: file.name, title: `${file.kind} · ${file.bytes} B` },
                  h(
                    "button",
                    {
                      className: "ws-chip-name",
                      type: "button",
                      disabled: busy || file.kind !== "workflow" || !ready,
                      onClick: () => runLoad(file)
                    },
                    file.name
                  ),
                  h(
                    "button",
                    {
                      className: "ws-chip-drop",
                      type: "button",
                      disabled: busy,
                      title: t("confirmDelete"),
                      onClick: () => runDelete(file)
                    },
                    "\u00d7"
                  )
                )
              ),
          h(
            "button",
            { className: "ws-btn", type: "button", onClick: () => refreshFiles() },
            t("refreshFiles")
          )
        )
      );
    }

    /** Workspace switcher, mirroring dsh-kanban's placement and behaviour. */
    function WorkspacePicker(props) {
      const { workspaces, selected, open, onToggle, onSelect, t } = props;
      return h(
        "div",
        { className: "ws-picker" },
        h(
          "button",
          { className: "ws-btn", type: "button", onClick: onToggle },
          `${t("workspace")}: ${selected?.title ?? t("choose")}`
        ),
        open && workspaces.length > 0
          ? h(
              "div",
              { className: "ws-menu" },
              workspaces.map((workspace) =>
                h(
                  "button",
                  {
                    key: workspace.workspaceId,
                    className: "ws-menu-item",
                    type: "button",
                    "data-active": workspace.workspaceId === selected?.workspaceId ? "1" : "0",
                    onClick: () => onSelect(workspace)
                  },
                  `${workspace.title} — ${workspace.cwd}`
                )
              )
            )
          : null
      );
    }

    /**
     * One-shot probe of the app route through fetch, so the diagnostic log
     * distinguishes "the studio never loaded" from "the shell refused to frame
     * a same-origin document" (which would show up as framing headers here).
     * `onStatus` reports the HTTP status to the caller, which uses it to tell a
     * missing studio (404) apart from a framing refusal.
     */
    function probeOnce(probedRef, appUrl, report, onStatus) {
      if (appUrl === null || probedRef.current) return;
      probedRef.current = true;
      fetch(appUrl, { method: "HEAD" })
        .then((response) => {
          onStatus?.(response.status);
          report("client:app-probe", {
            url: appUrl,
            status: response.status,
            xFrameOptions: response.headers.get("x-frame-options"),
            frameAncestors: response.headers.get("content-security-policy"),
            contentType: response.headers.get("content-type")
          });
        })
        .catch((error) => {
          onStatus?.(null);
          report("client:app-probe", { url: appUrl, error: String(error) });
        });
    }

    /* ------------------------------------------------------------ apply --- */

    /**
     * Browser plugin body: own the copy dictionaries, one api binding, and the
     * sidebar entry + centre-column page pair.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-workflow-studio: copy dictionaries");

      injectStyles("dsh-workflow-studio");

      const api = createStudioApi();
      const t = ctx.locale.bind(NS);

      const panelInjected = () => ({
        api,
        t,
        onClose: () => {
          ctx.get("layout")?.selectPanel?.(null);
        }
      });

      ctx.slots.inject("main", () =>
        ctx.slots.register({ name: "main", key: PANEL_ID, locale: NS, inject: panelInjected }, StudioPanel)
      );

      ctx.slots.inject("sidebar.panellist", () =>
        ctx.slots.register(
          { name: "sidebar.panellist", id: PANEL_ID, order: 24, label: () => t("nav"), locale: NS },
          StudioPanelIcon
        )
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
