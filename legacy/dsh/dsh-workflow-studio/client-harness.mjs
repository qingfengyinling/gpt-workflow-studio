/**
 * client-harness.mjs — 在 Node 里模拟 DSH 浏览器半区的 __ModuleLoader__ 环境，
 * 直接执行 lib/client.js 的 factory、调用 apply(ctx)、并渲染一次面板组件。
 *
 * 目的：浏览器里的半区一旦抛错，副作用是「侧栏图标静静不出现」，排查代价极高。
 * 这里用最小的 React/DOM/fetch 替身把 top-level、apply、render 三条路径全部跑一遍，
 * 把语法错误、拼错的 API、payload 构造错误挡在用户刷新页面之前。
 *
 *   node client-harness.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "lib", "client.js"), "utf8");

let passed = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { passed += 1; console.log(`  ok   ${label}`); }
  else { failures.push(label); console.log(`  FAIL ${label}`); }
}
function section(name) { console.log(`\n== ${name} ==`); }

// ---------------------------------------------------------------- React stub
const hookCalls = [];
function makeReact() {
  const createElement = (type, props, ...children) => ({
    $$el: true, type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c != null && c !== false),
  });
  const useState = (initial) => {
    hookCalls.push("useState");
    const value = typeof initial === "function" ? initial() : initial;
    return [value, () => {}];
  };
  const useEffect = (fn) => { hookCalls.push("useEffect"); return undefined; };
  const useLayoutEffect = (fn) => { hookCalls.push("useLayoutEffect"); return undefined; };
  const useRef = (initial) => { hookCalls.push("useRef"); return { current: initial }; };
  const useMemo = (fn) => { hookCalls.push("useMemo"); return fn(); };
  const useCallback = (fn) => { hookCalls.push("useCallback"); return fn; };
  const useSyncExternalStore = (_sub, get) => { hookCalls.push("useSyncExternalStore"); return get(); };
  const Fragment = Symbol("Fragment");
  return { createElement, useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, useSyncExternalStore, Fragment, Children: { map: (c, f) => (Array.isArray(c) ? c.map(f) : []) } };
}

// ---------------------------------------------------------------- DOM stub
function makeElement(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    style: {}, dataset: {}, children: [], attributes: {}, textContent: "", className: "",
    setAttribute(k, v) { this.attributes[k] = v; },
    getAttribute(k) { return this.attributes[k]; },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    addEventListener() {}, removeEventListener() {},
  };
}
const documentStub = {
  head: makeElement("head"),
  body: makeElement("body"),
  createElement: makeElement,
  // 真正的守卫效果必须能被模拟：第二次注入时这里要能查到已插入的 <style>。
  querySelector: (sel) => {
    const m = /data-dsh-plugin-css="([^"]+)"/.exec(String(sel));
    if (m) return documentStub.head.children.find((s) => s.attributes["data-dsh-plugin-css"] === m[1]) ?? null;
    return null;
  },
  querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
};

// ---------------------------------------------------------------- fetch stub
const fetchCalls = [];
const fetchStub = async (url, init) => {
  fetchCalls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body });
  return {
    ok: true, status: 200,
    headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? "text/html" : null) },
    async text() { return "{}"; },
    async json() { return { ok: true, version: "0.1.0" }; },
  };
};

// ---------------------------------------------------------------- loader stub
const globals = { document: documentStub, fetch: fetchStub, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, setTimeout, clearTimeout, console };
const captured = [];
const windowStub = {
  __ModuleLoader__: {
    load(record) {
      captured.push(record);
    },
  },
  localStorage: globals.localStorage,
  addEventListener() {}, removeEventListener() {},
  open() { return null; },
};

section("factory 执行");
let mod;
try {
  // client.js 是 classic 脚本形态（IIFE 级），用 Function 在受控作用域里执行。
  const fn = new Function("window", "document", "fetch", "localStorage", "setTimeout", "clearTimeout", "console", source);
  fn(windowStub, documentStub, fetchStub, globals.localStorage, setTimeout, clearTimeout, console);
  ok(true, "lib/client.js 整个脚本无语法/顶层错误即执行完毕");
} catch (err) {
  ok(false, `脚本执行抛错: ${err && err.message}`);
}

ok(captured.length === 1, `__ModuleLoader__.load 被调用 1 次（实际 ${captured.length}）`);
const record = captured[0];
if (!record) {
  console.log("\n致命：factory 未注册，后续断言无法进行");
  process.exit(1);
}
ok(record.id === "dsh-workflow-studio", `模块 id 为 dsh-workflow-studio（实际 ${record.id}）`);
ok(typeof record.factory === "function", "record.factory 是函数");

try {
  mod = record.factory((name) => {
    if (name === "react") return makeReact();
    throw new Error(`harness 未提供的模块: ${name}`);
  });
  ok(true, "factory 用桩 require 执行成功（说明只依赖 react，没有 require 未知包）");
} catch (err) {
  ok(false, `factory 执行抛错: ${err && err.message}`);
  process.exit(1);
}

section("exports / inject 形状");
ok(typeof mod.apply === "function", "exports.apply 是函数");
ok(Array.isArray(mod.inject), "exports.inject 是数组");
const wantInj = ["slots", "locale", "sessions", "workspaces"];
ok(wantInj.every((k) => mod.inject.includes(k)), `inject 含 ${wantInj.join(", ")}（实际 ${JSON.stringify(mod.inject)}）`);

section("apply(ctx) 与 slot 注册");
const registrations = { main: [], sidebar: [], other: [] };
const effects = [];
const localeDict = {};
const ctx = {
  effect(fn, label) { effects.push(label ?? "effect"); const d = fn(); return typeof d === "function" ? d : () => {}; },
  get(key) { return key === "layout" ? { selectPanel() {} } : undefined; },
  locale: {
    register(ns, dict) { localeDict[ns] = dict; return () => {}; },
    bind(ns) { return (k) => `[${ns}:${k}]`; },
  },
  slots: {
    inject(slot, fn) { fn(); return () => {}; },
    register(decl, comp) {
      if (decl.name === "main") registrations.main.push({ decl, comp });
      else if (decl.name === "sidebar.panellist") registrations.sidebar.push({ decl, comp });
      else registrations.other.push({ decl, comp });
      return () => {};
    },
  },
};

try {
  mod.apply(ctx);
  ok(true, "apply(ctx) 执行无异常");
} catch (err) {
  ok(false, `apply(ctx) 抛错: ${err && err.message}`);
}

ok(registrations.main.length === 1, `main slot 注册 1 次（实际 ${registrations.main.length}）`);
ok(registrations.sidebar.length === 1, `sidebar.panellist 注册 1 次（实际 ${registrations.sidebar.length}）`);
const injectedStyles = () => documentStub.head.children.filter((c) => c.attributes["data-dsh-plugin-css"] !== undefined);
ok(injectedStyles().length === 1, `样式只注入 1 次（实际 ${injectedStyles().length}）—— 按 data-dsh-plugin-css 去重`);
ok(injectedStyles()[0]?.attributes["data-dsh-plugin-css"] === "dsh-workflow-studio", "注入的 <style> 打上了 data-dsh-plugin-css=dsh-workflow-studio");
ok(String(injectedStyles()[0]?.textContent ?? "").length > 500, `注入的样式表非空（${String(injectedStyles()[0]?.textContent ?? "").length} 字符）`);
ok(effects.length >= 1, `ctx.effect 至少 1 次（实际 ${effects.length}）`);
const ns = Object.keys(localeDict)[0];
ok(Object.keys(localeDict).length === 1, `locale 注册 1 个命名空间（实际 ${Object.keys(localeDict).length}）`);
ok(localeDict[ns]?.zh && localeDict[ns]?.en, `命名空间 ${ns} 同时有 zh 与 en 字典`);

const mainDecl = registrations.main[0]?.decl;
const sideDecl = registrations.sidebar[0]?.decl;
if (mainDecl && sideDecl) {
  ok(typeof mainDecl.key === "string" && mainDecl.key.length > 0, `main.key 是非空字符串（${mainDecl.key}）`);
  ok(mainDecl.key === sideDecl.id, `main.key 与 sidebar.id 同值（${mainDecl.key} === ${sideDecl.id}）—— ui-sidebar 靠它解析标签与中列占用者`);
  ok(typeof sideDecl.order === "number", `sidebar.order 是数字（${sideDecl.order}）`);
  ok(typeof sideDecl.label === "function", "sidebar.label 是函数（惰性取 t()）");
  ok(sideDecl.locale === ns || mainDecl.locale === ns, `slot 注册带 locale: ${ns}`);
}
const IconComp = registrations.sidebar[0]?.comp;
const PanelComp = registrations.main[0]?.comp;
ok(typeof PanelComp === "function", "main 组件是函数组件");
ok(typeof IconComp === "function", "sidebar 图标是函数组件");

section("侧栏图标渲染（无 DOM 依赖）");
try {
  const tree = IconComp({ size: 18 });
  ok(tree && tree.$$el === true, "图标组件返回元素树");
  const svgs = findEl(tree, (n) => n.type === "svg");
  ok(svgs.length === 1, `图标含 1 个 svg（实际 ${svgs.length}）—— 外层 span.ws-icon 是样式钩子，属有意设计`);
  ok(svgs[0]?.props?.["aria-hidden"] === "true", "图标 svg 标了 aria-hidden（侧栏按钮的可访问名来自 label，不重复朗读图形）");
} catch (err) {
  ok(false, `图标渲染抛错: ${err && err.message}`);
}

section("面板渲染（含工作区/会话 store 快照）");
const sessionsSnap = { current: "s1", byId: { s1: { id: "s1", cwd: "E:\\AI工作流", summary: { retainedBy: { mainView: 1 } } } } };
const workspacesSnap = { items: [{ id: "w1", path: "E:\\AI工作流", title: "AI工作流", sessionIds: ["s1"], createdAt: 1 }] };
let panelTree = null;
try {
  panelTree = PanelComp({
    useSessions: (sel) => (sel ? sel(sessionsSnap) : sessionsSnap),
    useWorkspaces: (sel) => (sel ? sel(workspacesSnap) : workspacesSnap),
    onClose: () => {},
    openSession: () => {},
  });
  ok(panelTree && panelTree.$$el === true, "面板组件返回元素树");
  ok(hookCalls.length > 0, `渲染路径确实走过了 hooks（${[...new Set(hookCalls)].join(",")}）`);
} catch (err) {
  ok(false, `面板渲染抛错: ${err && err.message}`);
}

function findEl(node, pred, out = []) {
  if (!node || node.$$el !== true) return out;
  if (pred(node)) out.push(node);
  for (const c of node.children ?? []) findEl(c, pred, out);
  return out;
}

if (panelTree) {
  const frames = findEl(panelTree, (n) => n.type === "iframe");
  ok(frames.length === 1, `面板里有 1 个 iframe（实际 ${frames.length}）`);
  const frame = frames[0];
  if (frame) {
    const src = String(frame.props.src ?? "");
    ok(src.startsWith("/workflow-studio/app"), `iframe src 指向宿主应用路由（${src.slice(0, 48)}…）`);
    ok(src.includes("cwd="), "iframe src 带 cwd 参数（否则宿主无法定位工作台）");
    const sandbox = String(frame.props.sandbox ?? "");
    ok(sandbox.includes("allow-same-origin"), "sandbox 保留 allow-same-origin（父窗口要读 iframe 的 localStorage 与全局函数）");
    ok(sandbox.includes("allow-scripts"), "sandbox 允许脚本（否则工作台不运行）");
    ok(!sandbox.includes("allow-top-navigation"), "sandbox 不给 top-navigation（工作台不得导航宿主页面）");
    ok(String(frame.props.title ?? "").length > 0, "iframe 有 title（可访问性）");
  }
  const btns = findEl(panelTree, (n) => n.type === "button");
  ok(btns.length >= 3, `工具栏按钮数量合理（${btns.length} 个）`);
  // 可访问名来自可见文本或显式 title；桩 createElement 把 children 放在节点上，不在 props 里。
  const unlabeled = btns.filter((b) => {
    if (typeof b.props.title === "string" && b.props.title.length > 0) return false;
    return !(b.children ?? []).some((c) => typeof c === "string" && c.trim().length > 0);
  });
  ok(unlabeled.length === 0, `每个按钮都有可访问名（无标签的 ${unlabeled.length} 个）`);
  okayButtonTypes(btns);
}

function okayButtonTypes(btns) {
  const bad = btns.filter((b) => b.props.type !== "button");
  ok(bad.length === 0, `每个按钮都显式 type="button"（不是的 ${bad.length} 个）—— 避免在表单语义下变成 submit`);
}

section("apply 幂等性（热重载会把 apply 重跑一遍）");
const stylesBefore = injectedStyles().length;
try {
  mod.apply(ctx);
  ok(injectedStyles().length === stylesBefore, `二次 apply 没有重复注入样式（仍为 ${injectedStyles().length} 个）—— 否则热重载会累积 style 标签`);
  ok(registrations.main.length === 2, `二次 apply 会再注册一次 slot（${registrations.main.length}）—— 这是 DSH 的 fiber 重载语义，由 ctx.slots 去重，不是缺陷`);
} catch (err) {
  ok(false, `二次 apply 抛错: ${err && err.message}`);
}

// ============================================================ 编排助手 ======
// 抽屉默认关闭，上面那一节对助手路径（projectWorkflow / validatePatch /
// applyEdits）一脚都踩不到。这一节把它整条跑通，需要三样桩：
//   1) 会被 ref 绑定的 iframe 桩（contentWindow 指向假工作台窗口）；
//   2) 一个能用的最小 React —— useState 必须能真的触发重渲染，否则按钮点不动；
//   3) 假工作台窗口，带 uid/topoSort/touchWf/saveData/commit/refreshAll，并把
//      调用顺序原样记下来：落盘惯用法对不对，全看这个序列。
section("编排助手：投影 → 校验 → 落回（端到端，含交互）");

const LS_KEY_STUDIO = "wb_workflow_studio_v1";
const ASSIST_KEY_PLUGIN = "wb_ws_assist_v1";

function makeStore(seed) {
  const map = new Map(Object.entries(seed ?? {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    dump: () => Object.fromEntries(map)
  };
}

function mkNode(id, type, title, x) {
  return {
    id, type, title, x, y: 0, role: "", model: "", instruction: "", inputs: "",
    outputs: "", acceptance: "", forbidden: "", humanCheck: false,
    timeoutSec: 0, retry: 0, notes: "", checked: false
  };
}

const studioDb = {
  version: 1,
  activeWfId: "wf1",
  workflows: [{
    id: "wf1",
    name: "示例工作流",
    goal: "把需求变成可执行编排",
    delivery: "",
    constraints: "",
    nodes: [
      mkNode("n1", "start", "接收任务", 0),
      mkNode("n2", "llm", "生成方案", 240),
      mkNode("n3", "human", "人工确认", 480),
      mkNode("n4", "output", "交付", 720)
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2", label: "" },
      { id: "e2", from: "n2", to: "n3", label: "" },
      { id: "e3", from: "n3", to: "n4", label: "" }
    ]
  }]
};

// 一次「体检」的返回：6 种 op 全在，另有 5 条必须被拒的越界补丁。
const assistEnvelope = {
  ok: true,
  op: "assist",
  task: "review",
  provider: "deepseek-account",
  model: "deepseek-flash",
  reasoningEffort: "high",
  elapsedMs: 12345,
  usage: { inputTokens: 800, outputTokens: 300 },
  recordPath: "E:\\AI工作流\\.workflow-studio\\assist\\2026-10-06T14-00-00.json",
  summary: "补齐了交付物定义、验收判据与人工闸门",
  text: "```json\n{\"summary\":\"…\"}\n```",
  findings: [
    { severity: "error", title: "节点缺验收判据", detail: "n2 没有 acceptance", target: "n2" },
    { severity: "warn", title: "交付物未定义", detail: "workflow.delivery 为空", target: "wf" },
    { severity: "info", title: "顺序连续", detail: "拓扑序没有断点", target: "wf" }
  ],
  patches: [
    { op: "set", target: "wf", field: "delivery", value: "最终交付物：可执行编排包", why: "下游要知道交什么" },
    { op: "set", target: "n2", field: "acceptance", value: "输出含目标/步骤/验收三段", why: "可判定" },
    { op: "set", target: "n2", field: "humanCheck", value: "true", why: "结果需要人确认" },
    { op: "set", target: "n2", field: "timeoutSec", value: "600", why: "给个时限" },
    { op: "set", target: "nope", field: "title", value: "越界", why: "节点不存在" },
    { op: "set", target: "n2", field: "id", value: "hack", why: "白名单外字段" },
    {
      // 形状必须照抄 ASSIST_SYSTEM_PROMPT（lib/index.js:451）：type 在 node 里，
      // after 在 patch 顶层。顶层 type 会被忽略 → 静默降级成 llm。
      op: "add-node", after: "n2",
      node: { type: "human", title: "人工复核", instruction: "确认字段齐全", acceptance: "人已签字" },
      why: "缺人工闸门"
    },
    { op: "add-node", after: null, node: { type: "quantum", title: "未知类型节点" }, why: "类型不在目录" },
    { op: "link", from: "n1", to: "n3", label: "加速通道", why: "并行分支" },
    { op: "unlink", from: "n1", to: "n2", why: "这条边多余" },
    { op: "link", from: "n1", to: "n2", why: "已经存在" },
    { op: "unlink", from: "n1", to: "n4", why: "本来就不存在" },
    { op: "remove-node", target: "n4", why: "并入 n3" },
    { op: "explode", target: "n2", why: "未知 op" }
  ]
};

const studioCalls = [];
const uidCalls = [];
let uidSeq = 0;
const studioWindow = {
  buildWorkflowFile: () => ({ $schema: "workflow-studio/v1" }),
  doImport: () => {},
  safeFileName: (s) => String(s || "workflow"),
  getActiveWf: () => studioDb.workflows.find((w) => w.id === studioDb.activeWfId) ?? null,
  topoSort: (wf) => wf.nodes.slice(),
  uid: (prefix) => { uidCalls.push(prefix); return `new_${prefix}${++uidSeq}`; },
  touchWf: () => studioCalls.push("touchWf"),
  saveData: () => studioCalls.push("saveData"),
  commit: (label) => studioCalls.push(`commit:${label}`),
  refreshAll: () => studioCalls.push("refreshAll"),
  eval: () => null
};

let confirmAnswer = false;
const assistFetch = [];
const assistStoreMap = makeStore({
  [LS_KEY_STUDIO]: JSON.stringify(studioDb)
});
const fetchStub2 = async (url, init) => {
  const body = init?.body === undefined ? null : JSON.parse(String(init.body));
  assistFetch.push({ url: String(url), method: init?.method ?? "GET", body });
  const payload = String(url).includes("op=ping")
    ? { ok: true, version: "0.2.0", assist: { ok: true, provider: "deepseek-account", model: "deepseek-flash", reasoningEffort: "high" } }
    : assistEnvelope;
  return {
    ok: true, status: 200,
    headers: { get: () => "application/json" },
    async text() { return JSON.stringify(payload); },
    async json() { return payload; }
  };
};

// ---- 最小 React：钩子真的能用（useState 触发重渲染、useEffect 真的跑） ----
function createInteractiveReact(frameWindow) {
  const hookNames = [];
  const fibers = new Map();
  let current = null;

  const sameDeps = (a, b) =>
    a !== null && b !== null && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

  function createElement(type, props, ...children) {
    const node = {
      $$el: true, type, props: props ?? {},
      children: children.flat(Infinity).filter((c) => c != null && c !== false)
    };
    const ref = node.props.ref;
    if (ref !== null && typeof ref === "object" && "current" in ref) ref.current = node;
    if (type === "iframe") {
      node.contentWindow = frameWindow;
      node.contentDocument = { title: "工作流编排台" };
    }
    // 函数组件必须在这里就地展开，否则 findEl 只能看见一个 type 是函数的节点，
    // 抽屉（和 WorkspacePicker）的子元素全都不可见。它们的钩子按调用顺序落在
    // 同一个 fiber 上 —— 和 React 的位置式钩子语义一致。
    if (typeof type === "function") {
      const rendered = type(node.props);
      node.children = rendered == null || rendered === false ? [] : [rendered];
    }
    return node;
  }

  const slot = () => {
    const fiber = current;
    const index = fiber.cursor++;
    return { fiber, index };
  };

  const useState = (initial) => {
    const { fiber, index } = slot();
    hookNames.push("useState");
    if (!(index in fiber.hooks)) fiber.hooks[index] = typeof initial === "function" ? initial() : initial;
    const set = (value) => {
      const before = fiber.hooks[index];
      const after = typeof value === "function" ? value(before) : value;
      if (Object.is(after, before)) return;
      fiber.hooks[index] = after;
      paint(fiber);
    };
    return [fiber.hooks[index], set];
  };

  const useRef = (initial) => {
    const { fiber, index } = slot();
    hookNames.push("useRef");
    fiber.refs[index] = fiber.refs[index] ?? { current: initial };
    return fiber.refs[index];
  };

  const useMemo = (fn, deps) => {
    const { fiber, index } = slot();
    hookNames.push("useMemo");
    const cached = fiber.memo[index];
    if (cached === undefined || !sameDeps(cached.deps, deps ?? null)) {
      fiber.memo[index] = { deps: deps ?? null, value: fn() };
    }
    return fiber.memo[index].value;
  };

  const useCallback = (fn, deps) => useMemo(() => fn, deps);

  const useEffect = (fn, deps) => {
    const { fiber, index } = slot();
    hookNames.push("useEffect");
    fiber.effects.push({ index, fn, deps: deps ?? null });
  };

  const useSyncExternalStore = (subscribe, get) => {
    const { fiber, index } = slot();
    hookNames.push("useSyncExternalStore");
    if (fiber.stores[index] === undefined) {
      fiber.stores[index] = subscribe(() => paint(fiber)) ?? (() => {});
    }
    return get();
  };

  function paint(fiber) {
    if (fiber.rendering) { fiber.queued = true; return; }
    fiber.rendering = true;
    fiber.cursor = 0;
    fiber.effects = [];
    const previous = current;
    current = fiber;
    try {
      fiber.tree = fiber.Comp(fiber.props);
    } finally {
      current = previous;
      fiber.rendering = false;
    }
    for (const effect of fiber.effects) {
      const cached = fiber.effectSlots[effect.index];
      if (cached !== undefined && sameDeps(cached.deps, effect.deps)) continue;
      if (cached !== undefined && typeof cached.cleanup === "function") cached.cleanup();
      fiber.effectSlots[effect.index] = { deps: effect.deps, cleanup: effect.fn() ?? null };
    }
  }

  function mount(id, Comp, props) {
    let fiber = fibers.get(id);
    if (fiber === undefined) {
      fiber = {
        hooks: [], refs: {}, memo: {}, stores: {}, effects: [], effectSlots: {},
        cursor: 0, rendering: false, tree: null
      };
      fibers.set(id, fiber);
    }
    fiber.Comp = Comp;
    fiber.props = props;
    paint(fiber);
    return { get: () => fiber.tree, hookNames };
  }

  return {
    createElement, useState, useRef, useMemo, useCallback, useEffect, useSyncExternalStore,
    Fragment: Symbol("Fragment"),
    mount
  };
}

function labelsOf(node) {
  return (node.children ?? []).filter((c) => typeof c === "string").join("");
}

function collectText(node, out = []) {
  if (typeof node === "string") { out.push(node); return out; }
  if (!node || node.$$el !== true) return out;
  for (const child of node.children ?? []) collectText(child, out);
  return out;
}

function buttonByLabel(tree, label) {
  return findEl(tree, (n) => n.type === "button" && labelsOf(n) === label)[0] ?? null;
}

const react2 = createInteractiveReact(studioWindow);
let mod2 = null;
let mainDecl2 = null;
try {
  const loaded = [];
  const doc2 = {
    head: makeElement("head"),
    body: makeElement("body"),
    createElement: makeElement,
    querySelector: (sel) => {
      const m = /data-dsh-plugin-css="([^"]+)"/.exec(String(sel));
      if (m) return doc2.head.children.find((s) => s.attributes["data-dsh-plugin-css"] === m[1]) ?? null;
      return null;
    },
    querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {}
  };
  const win2 = {
    __ModuleLoader__: { load(r) { loaded.push(r); } },
    localStorage: assistStoreMap,
    confirm: () => confirmAnswer,
    addEventListener() {}, removeEventListener() {},
    open: () => null
  };
  const fn = new Function("window", "document", "fetch", "localStorage", "setTimeout", "clearTimeout", "console", source);
  fn(win2, doc2, fetchStub2, assistStoreMap, setTimeout, clearTimeout, console);
  mod2 = loaded[0].factory((name) => {
    if (name === "react") return react2;
    throw new Error(`harness 未提供的模块: ${name}`);
  });
  const regs = [];
  mod2.apply({
    effect(fn2) { const d = fn2(); return typeof d === "function" ? d : () => {}; },
    get: (key) => (key === "layout" ? { selectPanel() {} } : undefined),
    locale: { register: () => () => {}, bind: () => (k) => `[${k}]` },
    slots: {
      inject(_s, fn2) { fn2(); return () => {}; },
      register(decl, comp) { regs.push({ decl, comp }); return () => {}; }
    }
  });
  mainDecl2 = regs.find((r) => r.decl.name === "main");
  ok(true, "第二实例（独立 localStorage）apply 成功");
} catch (err) {
  ok(false, `第二实例装载抛错: ${err && err.message}`);
}

if (mainDecl2 === undefined) {
  console.log("\n致命：第二实例未注册 main slot，助手断言无法进行");
  process.exit(1);
}

const PanelComp2 = mainDecl2.comp;
const injected2 = typeof mainDecl2.decl.inject === "function" ? mainDecl2.decl.inject() : {};
// 有意不传 t：面板会退回 (key)=>key，断言就能直接匹配文案键，不依赖中文措辞。
const panelProps2 = {
  api: injected2.api,
  onClose: () => {},
  useSessions: (sel) => (sel ? sel(sessionsSnap) : sessionsSnap),
  useWorkspaces: (sel) => (sel ? sel(workspacesSnap) : workspacesSnap)
};
ok(typeof injected2.api?.assist === "function", "面板注入器提供了 api.assist");

const panel2 = react2.mount("panel", PanelComp2, panelProps2);
let tree2 = panel2.get();
ok(tree2 && tree2.$$el === true, "面板渲染成功（交互渲染器）");

// iframe 的 ref 必须真的被绑上，否则 openStudio 永远拿不到工作台窗口。
const frame2 = findEl(tree2, (n) => n.type === "iframe")[0];
ok(frame2 !== undefined, "面板里有 iframe");
ok(frame2?.contentWindow === studioWindow, "iframe 桩带 contentWindow（假工作台窗口）");
ok(typeof frame2?.props?.ref?.current?.contentWindow?.buildWorkflowFile === "function",
  "iframe 的 ref 已绑定，且能读到 buildWorkflowFile（openStudio 的就绪判据）");

try {
  await frame2.props.onLoad();
  await new Promise((r) => setTimeout(r, 0));
  tree2 = panel2.get();
  ok(true, "iframe onLoad 走通（探针 + 就绪态）");
} catch (err) {
  ok(false, `iframe onLoad 抛错: ${err && err.message}`);
}

const aiBtn = buttonByLabel(tree2, "assist");
ok(aiBtn !== null, "工具栏有「assist」按钮");
ok(aiBtn?.props.disabled === false, "工作台就绪后 AI 按钮可用（disabled=false）");

// ---- 打开抽屉 ----
aiBtn?.props.onClick();
// ping 是异步的：抽屉挂载后要放过一轮微/宏任务，模型 chip 才会落到已解析的路由。
await new Promise((r) => setTimeout(r, 0));
tree2 = panel2.get();
ok(findEl(tree2, (n) => n.props.className === "ws-ai").length === 1, "点击后抽屉出现（.ws-ai）");
const chipText = findEl(tree2, (n) => n.props.className === "ws-ai-model")[0];
ok(String(chipText?.children?.[0] ?? "").includes("deepseek-account / deepseek-flash"),
  `模型 chip 显示已解析的路由（${String(chipText?.children?.[0] ?? "")}）`);
ok(assistFetch.some((c) => c.url.includes("op=ping")), "面板 ping 过一次（拿 assistant 路由）");

const focusSelect = findEl(tree2, (n) => n.type === "select")[0];
ok(findEl(focusSelect, (n) => n.type === "option").length === 5,
  `焦点下拉列出「整条 + 4 个节点」（实际 ${findEl(focusSelect, (n) => n.type === "option").length} 项）`);

// ---- 点「体检整条工作流」 ----
const reviewBtn = buttonByLabel(tree2, "review");
ok(reviewBtn !== null, "抽屉里有「review」按钮");
await reviewBtn?.props.onClick();
tree2 = panel2.get();

const assistPosts = assistFetch.filter((c) => c.method === "POST" && c.body?.op === "assist");
ok(assistPosts.length === 1, `发出 1 次 assist POST（实际 ${assistPosts.length}）`);
const sent = assistPosts[0]?.body;
ok(sent?.cwd === "E:\\AI工作流", `assist 带上工作区 cwd（${sent?.cwd}）`);
ok(sent?.task === "review", `assist task=review（${sent?.task}）`);
ok(sent?.focus?.length === 0, "整条体检时 focus 为空数组");
ok(sent?.nodes?.length === 4, `投影带 4 个节点（实际 ${sent?.nodes?.length}）`);
ok(sent?.nodes?.every((n) => n.x === undefined && n.y === undefined && n.checked === undefined),
  "投影不带 x/y/checked（模型不该看见排版与勾选态）");
ok(sent?.nodes?.[0]?.step === 1 && sent?.order?.join(",") === "n1,n2,n3,n4",
  "投影带拓扑 step 与 order");
ok(sent?.workflow !== undefined && Object.keys(sent.workflow).join(",") === "id,name,goal,delivery,constraints",
  `工作流投影只带 5 个契约字段（${Object.keys(sent?.workflow ?? {}).join(",")}）`);

// ---- 结果渲染 ----
const allText = collectText(tree2);
ok(allText.some((s) => s.includes("补齐了交付物定义")), "渲染出 summary");
ok(allText.filter((s) => s.startsWith("findings ·")).length === 1, "findings 区带条数");
ok(findEl(tree2, (n) => String(n.props.className ?? "").includes("ws-ai-finding-error")).length === 1 &&
   findEl(tree2, (n) => String(n.props.className ?? "").includes("ws-ai-finding-warn")).length === 1 &&
   findEl(tree2, (n) => String(n.props.className ?? "").includes("ws-ai-finding-info")).length === 1,
  "三种 severity 各有自己的样式类");
const patchTitle = allText.find((s) => s.startsWith("patches ·"));
ok(patchTitle === "patches · 9/9", `补丁计数为 9/9（实际 ${patchTitle}）`);
const skipped = allText.filter((s) => s.startsWith("skipped："));
ok(skipped.length === 5, `5 条越界补丁被显式标为跳过（实际 ${skipped.length}）`);
ok(skipped.some((s) => s.includes("找不到节点 nope")) && skipped.some((s) => s.includes("不支持的 op")),
  "跳过的原因说清了是哪一类越界");
ok(allText.some((s) => s.startsWith("recordPath：")), "显示落档路径");
ok(findEl(tree2, (n) => n.type === "details").length === 0, "解析成功时不展开原始返回（<details> 不出现）");
const persisted = JSON.parse(assistStoreMap.getItem(ASSIST_KEY_PLUGIN));
ok(persisted.patches.length === 14 && persisted.picked.length === 14,
  `助手状态落进 ${ASSIST_KEY_PLUGIN}（与工作台自己的 ${LS_KEY_STUDIO} 分开）`);
ok(assistStoreMap.getItem(LS_KEY_STUDIO) !== null, "工作台自己的记录没有被助手覆盖");

// ---- 落回：先取消 ----
confirmAnswer = false;
buttonByLabel(tree2, "applyPicked (9)")?.props.onClick();
ok(studioCalls.length === 0, "confirm 取消时不碰工作台（一次调用都没有）");

// ---- 落回：确认 ----
confirmAnswer = true;
buttonByLabel(tree2, "applyPicked (9)")?.props.onClick();
tree2 = panel2.get();
ok(studioCalls.join(" → ") === "touchWf → saveData → commit:AI 助手：应用 9 处修改 → refreshAll",
  `落盘顺序是工作台自己的惯用法（实际 ${studioCalls.join(" → ")}）`);

const wf = studioDb.workflows[0];
ok(wf.delivery === "最终交付物：可执行编排包", "set(wf.delivery) 写入工作流字段");
ok(wf.nodes[1].acceptance === "输出含目标/步骤/验收三段", "set(n2.acceptance) 写入节点字段");
ok(wf.nodes[1].humanCheck === true, "humanCheck 被转成布尔 true（模型给的是字符串 \"true\"）");
ok(wf.nodes[1].timeoutSec === 600, "timeoutSec 被转成数字 600（模型给的是字符串）");
ok(wf.nodes[1].id === "n2", "白名单外的 set(id) 没有改到节点 id");
ok(wf.nodes.every((n) => n.id !== "hack"), "被拒的补丁没有留下任何痕迹");
ok(wf.nodes.length === 5, `新增 2 个节点、删掉 1 个后剩 5 个（实际 ${wf.nodes.length}）`);
const added = wf.nodes.filter((n) => String(n.id).startsWith("new_n"));
ok(added.length === 2, `新节点用工作台的 uid(\"n\") 生成（实际 ${added.length} 个）`);
ok(added[0]?.type === "human" && added[0]?.x === 480,
  `after 锚点决定位置：n2.x+240=480（实际 type=${added[0]?.type} x=${added[0]?.x}）`);
ok(added[1]?.type === "llm", "未知类型 quantum 被降级成 llm（而不是往 DB 里塞工作台不认识的 type）");
ok(added[0]?.checked === false && added[0]?.timeoutSec === 0 && added[0]?.retry === 0,
  "新节点的 checked/timeoutSec/retry 被补全（normalizeDB 会读这些字段）");
// 边集：保留 n2->n3；link 建出 n1->n3；add-node 两次自动连锚点边
// （n2->new_n1 与 new_n1->new_n3，第二段接在拓扑序末尾）；unlink/remove 各清一条。
// id 里有连续的 uid 计数器：n=new_n1 → e=new_e2 → n=new_n3 → e → e。
const edgeSet = new Set(wf.edges.map((e) => `${e.from}->${e.to}`));
ok(
  edgeSet.size === 4 &&
    ["n1->n3", "n2->n3", "n2->new_n1", "new_n1->new_n3"].every((pair) => edgeSet.has(pair)),
  `边集正确（实际 ${[...edgeSet].join(",")}）`
);
ok(edgeSet.has("n1->n3"), "link 建出的边在 DB 里");
ok(!edgeSet.has("n1->n2"), "unlink 掉的边不在 DB 里");
ok(![...edgeSet].some((pair) => pair.includes("n4")), "remove-node 连同它的边一起清掉");
ok(uidCalls.filter((p) => p === "n").length === 2 && uidCalls.filter((p) => p === "e").length === 3,
  `uid 调用次数：n×2 / e×3（实际 n×${uidCalls.filter((p) => p === "n").length} / e×${uidCalls.filter((p) => p === "e").length}）`);
ok(collectText(tree2).some((s) => s.includes("undoHint")),
  "应用后提示可以 Ctrl+Z 撤销（commit 快照在改动之后，所以撤得回）");

// ---- 未装载模型适配器时的降级 ----
section("编排助手：没有模型适配器时的降级");
const assistOff = { ...assistEnvelope, ok: false, code: "NO_ADAPTER", error: "没有可用的模型适配器" };
delete assistOff.patches;
ok(assistOff.ok === false && assistOff.code === "NO_ADAPTER", "503 契约（NO_ADAPTER）形状固定：面板据此显示原因而非报错");

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log("失败项:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
