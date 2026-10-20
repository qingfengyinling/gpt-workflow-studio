/**
 * dsh-workflow-studio — host half.
 *
 * The workspace already contains a finished, zero-dependency, single-file
 * Workflow Studio (`workflow-studio/index.html`, 167 KB, one classic <script>
 * with ~176 top-level functions and passing selftest/static-audit reports).
 * This plugin does NOT reimplement or modify it. Node does the two things the
 * browser cannot do on its own:
 *
 *   1. serve that file over same-origin HTTP, so the DSH shell can put it in an
 *      iframe inside a `main` panel;
 *   2. accept the workflow files the studio exports and write them into
 *      `<workspace>/workflows/`, where any agent can read them with ordinary
 *      file tools — that is the "hand off to another agent" half of the ask,
 *      which a browser download to the Downloads folder does not deliver.
 *
 * Routes (registered on the injected `webServer`, prefix kind, same origin):
 *   GET  /workflow-studio/app[?cwd=]        static files from <root>/workflow-studio
 *   GET  /workflow-studio/api?op=...        ping | list | read
 *   POST /workflow-studio/api               { op: "save" | "delete" | "log" | "assist" }
 *
 * `op: "assist"` is the orchestration assistant. The studio has no network code
 * of any kind (one offline HTML file), so a model call can only originate here:
 * the client projects the live workflow, this half streams exactly one
 * `ctx.llm.stream()` call with the workspace's own default model, and returns a
 * strict JSON envelope of findings plus `patches`. This half never mutates the
 * studio — the client applies the patches the user ticked into the live DB.
 *
 * The same capability is also exposed as the model tool `workflow_studio`
 * (`list` / `read` / `assist`), so an agent in any session can use the exported
 * files without a browser. It shares this half's prompt, route resolution and
 * streamed call with the panel; it never writes (see the model-tool section).
 *
 * Design boundaries:
 *   - The host half never touches browser storage. The client half owns the
 *     bridge between the embedded studio's localStorage and this file API.
 *   - `cwd` is taken from the client verbatim (same trust model as dsh-kanban,
 *     which writes KANBAN.json into whatever cwd the client names). Requests
 *     without `cwd` fall back to the `appRoot` config, then to process.cwd().
 *   - Static serving is confined to `<root>/<appDirName>`; path traversal is
 *     rejected, not normalized away.
 *   - The only writes outside `<root>/<outDirName>` are diagnostics under
 *     `<root>/.workflow-studio/`, and a failure there never fails a request.
 *   - `ctx.llm` and `ctx.agentDefaultModel` are resolved lazily through
 *     `ctx.get`, never listed in `inject`: a DSH without an LLM adapter must
 *     still serve the studio, so a missing capability is a 503 on one op
 *     instead of a plugin that fails to load.
 *   - `tools` is the one service that is *waited for* rather than sampled.
 *     Samples only work for capabilities read after the fact (an assist op
 *     arrives minutes after boot); `tools` is acted on during load, and real
 *     DSH provides it *after* `webServer`, so a lazy read in `apply` answers
 *     `undefined` forever. The model tool therefore registers on a child fiber
 *     armed by `ctx.inject(["tools"], …)` — see `armStudioTool`.
 */

import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { extname, join, resolve, sep } from "node:path"

/** Loader entry id; must match `cordis.patch.yml` and the sidebar panel id. */
export const name = "dsh-workflow-studio"

/**
 * Cordis fiber services this plugin needs; without them `apply` is a no-op.
 *
 * `tools` is deliberately NOT listed. Declaring it would hold the whole plugin
 * — including the two HTTP routes — hostage to a tool registry existing, and an
 * HTTP-only shell must still serve the studio. It is instead waited for on its
 * own fiber (`armStudioTool`), which is how a service that may or may not
 * appear is meant to be consumed.
 */
export const inject = ["webServer"]

const VERSION = "0.3.3"

/** Same-origin route names. The client half hardcodes the same two strings. */
const APP_ROUTE = "/workflow-studio/app"
const API_ROUTE = "/workflow-studio/api"

const APP_DIR_NAME = "workflow-studio"
const OUT_DIR_NAME = "workflows"
const APP_ENTRY = "index.html"
const EVENTS_DIR = ".workflow-studio"
const EVENTS_FILE = "events.log"
const ASSIST_DIR = "assist"

/** Exported workflow bundles are small; 4 MiB is generous and bounded. */
const MAX_BODY = 4 * 1024 * 1024
/** Keep the diagnostic log from growing without bound. */
const MAX_LOG = 512 * 1024
/** A projected workflow past this size is a bug upstream, not a prompt. */
const MAX_ASSIST_CHARS = 400 * 1024
const DEFAULT_ASSIST_MAX_TOKENS = 16384
const DEFAULT_ASSIST_TIMEOUT_MS = 180000

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8"
}

/* ------------------------------------------------------------------ http io */

/** Register both routes on the injected web server, if it exists. */
export function apply(ctx, config) {
  const server = ctx.get("webServer")
  if (server === undefined) return

  const settings = {
    appRoot: str(config?.appRoot),
    appDirName: str(config?.appDirName) ?? APP_DIR_NAME,
    outDirName: str(config?.outDirName) ?? OUT_DIR_NAME,
    // Orchestration assistant. `provider`/`model` default to whatever the
    // workspace's own agent would use, so the panel follows the model picker
    // instead of pinning a second, silently-diverging choice.
    assistProvider: str(config?.assistProvider),
    assistModel: str(config?.assistModel),
    assistReasoningEffort: str(config?.assistReasoningEffort),
    assistMaxTokens: num(config?.assistMaxTokens) ?? DEFAULT_ASSIST_MAX_TOKENS,
    assistTimeoutMs: num(config?.assistTimeoutMs) ?? DEFAULT_ASSIST_TIMEOUT_MS,
    recordAssist: config?.recordAssist !== false
  }

  server.register({
    kind: "prefix",
    path: APP_ROUTE,
    handler: (req, res) => {
      handleApp(req, res, settings).catch((error) => fail(res, error))
    }
  })

  server.register({
    kind: "prefix",
    path: API_ROUTE,
    handler: (req, res) => {
      handleApi(req, res, settings, ctx).catch((error) => fail(res, error))
    }
  })

  // Boot-time proof of life for the host half — and *only* that. It lands in the
  // configured workspace (or, without appRoot, in the DSH process cwd) so the
  // install/verification step has a version to read back. It deliberately says
  // nothing about the tool: that outcome is a separate event, written from the
  // tool's own fiber, because the two happen at different times.
  recordEvent(settings.appRoot, "host:registered", { version: VERSION, pid: process.pid })

  // The model tool lives on its own fiber, which starts only once `tools`
  // exists. See `armStudioTool` for why a lazy `ctx.get("tools")` here cannot
  // work in a real host.
  armStudioTool(ctx, settings)
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  })
  res.end(body)
}

function fail(res, error) {
  if (res.writableEnded) return
  sendJson(res, 500, {
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  })
}

function str(value) {
  return typeof value === "string" && value !== "" ? value : undefined
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/**
 * Split a request target into its RAW path and query.
 *
 * `new URL(...).pathname` is deliberately not used here: it collapses `..`
 * segments *before* the plugin sees them, so `/workflow-studio/app/../../x`
 * would arrive as `/x`, the prefix slice below would silently fall back to the
 * entry document, and a traversal attempt would be answered with a cheerful 200
 * of the studio instead of a 403. The route matcher uses the raw path too, so
 * raw is also what this handler must agree with.
 */
function parseTarget(req) {
  const raw = typeof req.url === "string" && req.url !== "" ? req.url : "/"
  const mark = raw.indexOf("?")
  return {
    path: mark === -1 ? raw : raw.slice(0, mark),
    query: new URLSearchParams(mark === -1 ? "" : raw.slice(mark + 1))
  }
}

/** Read and decode a request body, bounded by `limit`. */
async function readBody(req, limit = MAX_BODY) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      req.destroy?.()
      throw new Error(`request body exceeds ${limit} bytes`)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString("utf8")
}

/* -------------------------------------------------------------- static app */

/**
 * Serve the Workflow Studio document.
 *
 * `/workflow-studio/app` maps to `<appDir>/index.html`;
 * `/workflow-studio/app/<rel>` maps to `<appDir>/<rel>`. The studio is
 * single-file, so in practice only the entry point is ever requested, but
 * sibling assets (the preview PNGs) resolve too. `<appDir>` comes from
 * `pickAppDir`, not from `?cwd` alone — see that function for why.
 */
async function handleApp(req, res, settings) {
  const { path, query } = parseTarget(req)
  const { root, log } = resolveRoot(query.get("cwd"), settings)
  const picked = await pickAppDir(root, settings)

  let rel
  try {
    rel = decodeURIComponent(path.slice(APP_ROUTE.length))
  } catch {
    rel = ""
  }
  rel = rel.replace(/^[/\\]+/, "")
  if (rel === "") rel = APP_ENTRY

  if (picked.dir === null) {
    recordEvent(log, "app:missing", { rel, tried: picked.tried })
    sendHtml(
      res,
      404,
      errorPage(
        "找不到工作台文件",
        `期望的文件不存在：<code>${escapeHtml(join(picked.tried[0] ?? root, APP_ENTRY))}</code><br>` +
          `已按顺序找过：<br>${picked.tried
            .map((dir) => `<code>${escapeHtml(dir)}</code>`)
            .join("<br>")}<br>` +
          `当前工作区：<code>${escapeHtml(root)}</code>`
      )
    )
    return
  }

  const appDir = picked.dir
  const target = resolve(appDir, rel)
  if (!isInside(appDir, target)) {
    recordEvent(log, "app:denied", { rel })
    sendHtml(res, 403, errorPage("路径越界", `只允许访问 ${appDir} 下的文件。`))
    return
  }

  const info = await stat(target).catch(() => null)
  if (info === null || !info.isFile()) {
    recordEvent(log, "app:missing", { rel, target })
    sendHtml(
      res,
      404,
      errorPage(
        "找不到工作台文件",
        `期望的文件不存在：<code>${escapeHtml(target)}</code><br>` +
          `当前工作区：<code>${escapeHtml(root)}</code>`
      )
    )
    return
  }

  const body = await readFile(target)
  recordEvent(log, "app:served", { rel, bytes: body.length, from: picked.from, appDir })
  res.writeHead(200, {
    "content-type": MIME_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream",
    "content-length": body.length,
    // Never cache: the studio is edited in place, and a stale copy inside the
    // iframe is indistinguishable from a broken build.
    "cache-control": "no-store"
  })
  if (req.method === "HEAD") res.end()
  else res.end(body)
}

/**
 * Locate the directory the studio assets are served from.
 *
 * The studio is one shared document, not a workspace artifact: most workspaces
 * have no `workflow-studio/` folder of their own. Binding the asset root to
 * `?cwd` therefore turned the panel into a 404 in every workspace but the one
 * that happens to carry the folder (observed 2026-10-08: four registered
 * workspaces, one with the folder), and the client could only report the
 * misleading "the file is missing or the host blocks iframes".
 *
 * The lookup walks a short chain and serves the first copy that exists:
 * requested workspace → configured `appRoot` → this process's cwd. The resolved
 * `cwd` still decides where `workflows/` is read and written, so the asset root
 * and the data root stay independent on purpose.
 *
 * @param root - the resolved data root (see `resolveRoot`).
 * @param settings - plugin settings.
 * @returns `{dir, from, tried}`; `dir` is null when no candidate has the entry.
 */
async function pickAppDir(root, settings) {
  const tried = []
  const add = (dir, from) => {
    if (dir === undefined) return
    const abs = resolve(dir)
    if (!tried.some((entry) => entry.dir === abs)) tried.push({ dir: abs, from })
  }
  add(join(root, settings.appDirName), "cwd")
  if (settings.appRoot !== undefined) add(join(settings.appRoot, settings.appDirName), "appRoot")
  add(join(process.cwd(), settings.appDirName), "processCwd")

  for (const entry of tried) {
    const info = await stat(join(entry.dir, APP_ENTRY)).catch(() => null)
    if (info !== null && info.isFile()) {
      return { dir: entry.dir, from: entry.from, tried: tried.map((item) => item.dir) }
    }
  }
  return { dir: null, from: null, tried: tried.map((item) => item.dir) }
}

/* -------------------------------------------------------------------- api */

async function handleApi(req, res, settings, ctx) {
  const { query } = parseTarget(req)
  const method = req.method ?? "GET"

  if (method === "GET" || method === "HEAD") {
    const op = query.get("op") ?? "list"

    if (op === "ping") {
      sendJson(res, 200, {
        ok: true,
        plugin: name,
        version: VERSION,
        appRoot: settings.appRoot ?? null,
        processCwd: process.cwd(),
        // Reported, not hidden: the panel shows which model its assistant will
        // call, and a missing adapter is visible before the user clicks.
        assist: await resolveAssistRoute(ctx, settings)
      })
      return
    }

    const { root, log } = resolveRoot(query.get("cwd"), settings)
    if (op === "list") {
      const listing = await listWorkflows(root, settings)
      recordEvent(log, "api:list", { files: listing.files.length })
      sendJson(res, 200, { ok: true, op, ...listing })
      return
    }
    if (op === "read") {
      const file = safeOutName(query.get("name"))
      if (file === null) {
        sendJson(res, 400, { ok: false, error: "name 必须是 .json 或 .md 的文件名" })
        return
      }
      const target = join(root, settings.outDirName, file)
      const text = await readFile(target, "utf8").catch(() => null)
      if (text === null) {
        sendJson(res, 404, { ok: false, error: `工作区里没有 ${file}` })
        return
      }
      recordEvent(log, "api:read", { name: file })
      sendJson(res, 200, { ok: true, op, name: file, text })
      return
    }
    sendJson(res, 400, { ok: false, error: `unknown op: ${op}` })
    return
  }

  if (method === "POST") {
    const raw = await readBody(req)
    let body
    try {
      body = JSON.parse(raw)
    } catch {
      sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" })
      return
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      sendJson(res, 400, { ok: false, error: "请求体必须是 JSON 对象" })
      return
    }

    const { root, log } = resolveRoot(str(body.cwd), settings)
    const op = str(body.op) ?? "save"
    const dir = join(root, settings.outDirName)

    if (op === "assist") {
      await handleAssist(res, body, log, settings, ctx)
      return
    }

    if (op === "log") {
      await recordEvent(log, str(body.event) ?? "client:event", body.detail)
      sendJson(res, 200, { ok: true, op })
      return
    }

    if (op === "delete") {
      const file = safeOutName(body.name)
      if (file === null) {
        sendJson(res, 400, { ok: false, error: "name 必须是 .json 或 .md 的文件名" })
        return
      }
      await rm(join(dir, file)).catch(() => {})
      recordEvent(log, "api:delete", { name: file })
      sendJson(res, 200, { ok: true, op, ...(await listWorkflows(root, settings)) })
      return
    }

    if (op === "save") {
      const files = Array.isArray(body.files) ? body.files : []
      if (files.length === 0) {
        sendJson(res, 400, { ok: false, error: "files 不能为空" })
        return
      }
      const pending = []
      for (const file of files) {
        const outName = safeOutName(file?.name)
        if (outName === null) {
          sendJson(res, 400, { ok: false, error: `非法文件名：${String(file?.name)}` })
          return
        }
        if (typeof file?.text !== "string") {
          sendJson(res, 400, { ok: false, error: `${outName} 缺少 text` })
          return
        }
        pending.push({ outName, text: file.text })
      }
      await mkdir(dir, { recursive: true })
      const written = []
      for (const item of pending) {
        await writeFile(join(dir, item.outName), item.text, "utf8")
        written.push({ name: item.outName, bytes: Buffer.byteLength(item.text) })
      }
      recordEvent(log, "api:save", { dir, written })
      sendJson(res, 200, { ok: true, op, dir, written, ...(await listWorkflows(root, settings)) })
      return
    }

    sendJson(res, 400, { ok: false, error: `unknown op: ${op}` })
    return
  }

  sendJson(res, 405, { ok: false, error: `method not allowed: ${method}` })
}

/** List `<root>/workflows` — the folder other agents read from. */
async function listWorkflows(root, settings) {
  const dir = join(root, settings.outDirName)
  let names = []
  try {
    names = await readdir(dir)
  } catch {
    names = []
  }
  const files = []
  for (const entry of names.sort()) {
    if (!/\.(json|md)$/i.test(entry)) continue
    const info = await stat(join(dir, entry)).catch(() => null)
    if (info === null || !info.isFile()) continue
    files.push({
      name: entry,
      bytes: info.size,
      mtime: info.mtimeMs,
      kind: /\.json$/i.test(entry) ? "workflow" : "handoff"
    })
  }
  return { cwd: root, dir, files }
}

/* ------------------------------------------------------ orchestration assistant */

/**
 * The contract handed to the model. Deliberately long: every rule here is a
 * failure that was observed or is structurally likely (invented node ids,
 * renames of untouched nodes, prose instead of JSON, "请注意" filler).
 *
 * Field names are the studio's *live DB* names (`role`, `humanCheck`), not the
 * exported names (`owner`, `humanCheckpoint`): patches are applied by direct
 * assignment into the live object, so any translation layer between the model's
 * vocabulary and the DB's would be a second place to get it wrong.
 */
const ASSIST_SYSTEM_PROMPT = `你是「工作流编排台」的编排助手。用户正在一张节点图上编排多智能体 / 人机协作流程。你的职责是减少用户手工编排的工作量：把含糊的节点写成可直接执行的契约，把缺失的验收与交付补上，把断掉的逻辑指出来。

你只做两件事：体检逻辑、改写文案。你不执行流程，不臆造业务事实，不引入用户没提到的工具或系统。

输入是一个 JSON：{ task, instruction, workflow, nodes, edges, order, focus }
- workflow: { id, name, goal, delivery, constraints }
- nodes: 每个节点 { id, type, step, title, role, model, instruction, inputs, outputs, acceptance, forbidden, humanCheck, timeoutSec, retry, notes }
- edges: [{ from, to, label }]
- order: 拓扑顺序上的节点 id 数组；节点的 step 是它在该顺序里的序号（从 1 起）

只输出一个 JSON 对象。不要 markdown 围栏，不要任何解释性文字，不要在 JSON 前后加句子。形状：

{
  "summary": "一到三句话，说明这次最值得改的是什么",
  "findings": [
    { "severity": "error|warn|info", "target": "节点 id 或 wf", "title": "短标题", "detail": "为什么是问题、应该怎么改" }
  ],
  "patches": [ ... ]
}

patch 只允许以下 6 种 op，其它一律不要输出：
1. { "op": "set", "target": "wf", "field": "name|goal|delivery|constraints", "value": "新文本", "why": "一句理由" }
2. { "op": "set", "target": "<节点 id>", "field": "title|type|role|model|instruction|inputs|outputs|acceptance|forbidden|humanCheck|timeoutSec|retry|notes", "value": "新值（humanCheck 是布尔、timeoutSec/retry 是数字，其余是字符串）", "why": "一句理由" }
3. { "op": "add-node", "after": "<节点 id，或 null 表示接在末尾>", "node": { "type": "节点类型", "title": "标题", "role": "谁来做", "instruction": "怎么做的完整指令", "inputs": "需要什么", "outputs": "产出什么", "acceptance": "完成判据" }, "why": "一句理由" }
4. { "op": "remove-node", "target": "<节点 id>", "why": "一句理由" }
5. { "op": "link", "from": "<节点 id>", "to": "<节点 id>", "label": "分支条件（可空）", "why": "一句理由" }
6. { "op": "unlink", "from": "<节点 id>", "to": "<节点 id>", "why": "一句理由" }

硬规则：
- 节点 id 只能使用输入里真实出现过的 id，绝不发明。新增节点不要写 id、不要写坐标，前端会生成。
- 不要输出 id、x、y、checked 这些字段的 patch；它们不在白名单里，写了也会被丢弃。
- 节点的 type 只能用输入里出现过的 type 值。
- instruction 是写给「执行这一步的 agent」的指令：祈使句、可直接执行、写清要用的输入与要交付的产物。禁止写"请注意质量""尽量做好"这类无法执行的空话。
- acceptance 必须是可判定的完成判据（能勾选、能验证的客观条件），禁止写"质量好""用户满意"。
- outputs 写清产物的形态与去处（文件名、格式、给谁看）。
- humanCheck 为 true 的节点，instruction 要写清「人需要看什么、确认什么、确认后流程如何继续」。
- 只有确实缺环节时才 add-node；不要为了显得有产出而加节点。没有改动就返回空的 patches 数组。
- 每条 patch 的 why 必须说明这次改动带来的具体收益，不要复述改动本身。
- 与用户 instruction 冲突时，以用户 instruction 为准。
- 全部用中文输出。`

const ASSIST_TASK_BRIEF = {
  review:
    "本次任务：体检整条工作流。逐节点检查目标是否可执行、输入与上游产物是否衔接、验收标准是否可判定、是否缺人工确认或失败分支、拓扑顺序是否断链或存在孤立节点。把问题写进 findings；能直接落地的修改写进 patches，一次给出可用的完整版本，不要只给建议。",
  optimize:
    "本次任务：只优化 focus 里列出的节点，把它们的 instruction / inputs / outputs / acceptance 改写到可直接执行、可判定的程度，并与直接上下游保持一致。focus 之外的节点不要发 patch；如果发现它们有明显矛盾，只写 finding。",
  custom:
    "本次任务：严格执行 instruction 里用户的要求。不要顺手扩大改动范围；用户要求之外的其它问题只写 finding，不发 patch。"
}

/**
 * Resolve the provider/model the assistant will call.
 *
 * Order: explicit plugin config > the workspace's own agent default > the first
 * registered provider. `reasoningEffort` is carried over from the agent default
 * on purpose: it is the same provider/model pair the running agent already uses
 * with that effort, so passing it cannot trip the "unsupported effort rejects
 * before provider I/O" rule, and omitting it would silently answer with a
 * cheaper setting than the user's own sessions.
 */
async function resolveAssistRoute(ctx, settings) {
  const llm = ctx?.get?.("llm")
  if (llm === null || llm === undefined || typeof llm.stream !== "function") {
    return { ok: false, reason: "这个 DSH 里没有可用的 llm 服务（未挂载模型适配器）" }
  }

  let selection = null
  try {
    selection = ctx.get("agentDefaultModel")?.currentSelection?.() ?? null
  } catch {
    selection = null
  }

  const provider = settings.assistProvider ?? str(selection?.provider)
  const reasoningEffort = settings.assistReasoningEffort ?? str(selection?.reasoningEffort)
  let model = settings.assistModel ?? str(selection?.model)
  const source = settings.assistProvider !== undefined ? "config" : "agent-default"

  if (provider !== undefined && model !== undefined) {
    return { ok: true, provider, model, reasoningEffort, source }
  }

  // Last resort: the first registered route, and its first catalog model.
  let providers = []
  try {
    providers = (await llm.listProviders?.()) ?? []
  } catch {
    providers = []
  }
  const first = Array.isArray(providers) ? providers[0] : null
  if (!isPlainObject(first) || typeof first.id !== "string") {
    return { ok: false, reason: "找不到任何已注册的模型提供方" }
  }
  const id = provider ?? first.id
  if (model === undefined) {
    let models = []
    try {
      models = (await llm.listModels?.(id)) ?? []
    } catch {
      models = []
    }
    const head = Array.isArray(models) ? models[0] : null
    model = isPlainObject(head) ? str(head.id) : undefined
  }
  if (model === undefined) {
    return { ok: false, reason: `提供方 ${id} 没有可用模型，请在插件配置里指定 assistModel` }
  }
  return { ok: true, provider: id, model, reasoningEffort, source: source === "config" ? "config" : "first-provider" }
}

/** Validate and shape one assist request; `{ error }` means "reject with 400". */
function buildAssistRequest(body) {
  const task = ["review", "optimize", "custom"].includes(body.task) ? body.task : "review"
  const instruction = str(body.instruction)
  if (task === "custom" && instruction === undefined) {
    return { error: "自由指令模式下 instruction 不能为空" }
  }
  const nodes = Array.isArray(body.nodes) ? body.nodes.filter(isPlainObject) : []
  if (nodes.length === 0) return { error: "这条工作流还没有节点，先建节点再让助手体检" }

  const payload = {
    task,
    instruction: instruction ?? null,
    workflow: isPlainObject(body.workflow) ? body.workflow : {},
    nodes,
    edges: Array.isArray(body.edges) ? body.edges.filter(isPlainObject) : [],
    order: Array.isArray(body.order) ? body.order.map(String) : [],
    focus: Array.isArray(body.focus) ? body.focus.map(String) : []
  }
  return {
    task,
    payload,
    system: `${ASSIST_SYSTEM_PROMPT}\n\n${ASSIST_TASK_BRIEF[task]}`,
    userText: JSON.stringify(payload)
  }
}

/**
 * One streamed call, accumulated to text.
 *
 * A stream always ends with exactly one terminal `finish` chunk; only `error`
 * and `aborted` carry a `failure`, and consumers route on its stable `code`
 * rather than on message text. `reasoning-delta` is not shown (it is the model's
 * private scratchpad and would be noise in a review UI) but it IS counted: when
 * a reasoning model spends the whole output budget thinking, the visible text
 * comes back empty, and the character count is what lets the caller say so
 * instead of reporting "the model returned nothing".
 */
async function streamAssist(llm, route, system, userText, settings) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), settings.assistTimeoutMs)
  const options = {
    provider: route.provider,
    model: route.model,
    system,
    messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
    maxTokens: settings.assistMaxTokens,
    signal: controller.signal
  }
  if (route.reasoningEffort !== undefined) options.reasoningEffort = route.reasoningEffort

  const started = Date.now()
  let text = ""
  let reasoningChars = 0
  let usage = null
  let failure = null
  try {
    for await (const chunk of llm.stream(options)) {
      if (!isPlainObject(chunk)) continue
      if (chunk.type === "text-delta") {
        if (typeof chunk.text === "string") text += chunk.text
      } else if (chunk.type === "reasoning-delta") {
        if (typeof chunk.text === "string") reasoningChars += chunk.text.length
      } else if (chunk.type === "usage") {
        usage = isPlainObject(chunk.usage) ? chunk.usage : null
      } else if (chunk.type === "finish") {
        const reason = isPlainObject(chunk.reason) ? chunk.reason : {}
        if (reason.kind === "error" || reason.kind === "aborted") {
          const detail = isPlainObject(reason.failure) ? reason.failure : {}
          failure = {
            kind: reason.kind,
            code: str(detail.code) ?? reason.kind.toUpperCase(),
            message: str(detail.message) ?? (reason.kind === "aborted" ? "模型调用被取消或超时" : "模型调用失败")
          }
        }
        break
      }
    }
  } finally {
    clearTimeout(timer)
  }
  if (failure === null && controller.signal.aborted) {
    failure = { kind: "aborted", code: "ABORTED", message: "模型调用超时（可在插件配置里调大 assistTimeoutMs）" }
  }
  return { text, reasoningChars, usage, failure, elapsedMs: Date.now() - started }
}

/**
 * Recover the JSON envelope from whatever the model actually returned.
 *
 * The prompt asks for bare JSON; models still occasionally wrap it in a fence or
 * preface it with a sentence, and both are cheap to recover. A truncated
 * document is not recoverable and must surface as `parseError` with the raw text
 * intact — an empty result that looks like "nothing to fix" is the one outcome
 * that would quietly cost the user real work.
 */
function parseAssistEnvelope(raw, hint) {
  const text = String(raw ?? "").trim()
  if (text === "") return { envelope: null, parseError: emptyReplyReason(hint) }

  const candidates = []
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced !== null && typeof fenced[1] === "string") candidates.push(fenced[1].trim())
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1))
  candidates.push(text)

  for (const candidate of candidates) {
    let parsed = null
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    if (isPlainObject(parsed)) return { envelope: normalizeEnvelope(parsed), parseError: null }
  }
  return { envelope: null, parseError: "模型返回的内容里找不到合法 JSON 对象" }
}

/**
 * Say why the reply came back empty.
 *
 * Verified failure mode (2026-10-06, deepseek-account/deepseek-flash, reasoningEffort
 * high): the model spends the whole `maxTokens` budget on reasoning and emits zero
 * text — `outputTokens === maxTokens` with `text === ""`. The old message ("the
 * model returned no text") reads like a provider hiccup and sends the user hunting
 * for the wrong thing, so when the numbers pin it down, say the real cause.
 */
function emptyReplyReason(hint) {
  const usage = isPlainObject(hint?.usage) ? hint.usage : {}
  const output = num(usage.outputTokens)
  const maxTokens = num(hint?.maxTokens)
  const reasoning = num(hint?.reasoningChars) ?? 0
  const effort = str(hint?.effort)
  if (maxTokens !== undefined && output !== undefined && output >= maxTokens) {
    return (
      `模型把 ${maxTokens} 个输出 token 全用在推理上了，正文 0 字符（reasoningEffort=${effort ?? "默认"}，思考内容 ${reasoning} 字符）：` +
      `把 assistMaxTokens 调大（当前 ${maxTokens}）或把 reasoningEffort 降到 low/medium`
    )
  }
  if (reasoning > 0) {
    return `模型只输出了思考内容（${reasoning} 字符）就停了，正文 0 字符：把 assistMaxTokens 调大（当前 ${maxTokens ?? "未知"}）`
  }
  return "模型没有返回任何文本"
}

/**
 * Shape the envelope. Patches are only checked for being objects here — the
 * client half owns the real allow-list, because it is the side that touches the
 * live DB and therefore the side that must refuse anything unexpected.
 */
function normalizeEnvelope(raw) {
  const findings = Array.isArray(raw.findings)
    ? raw.findings.filter(isPlainObject).slice(0, 40).map((item) => ({
        severity: ["error", "warn", "info"].includes(item.severity) ? item.severity : "info",
        target: str(item.target) ?? "wf",
        title: str(item.title) ?? "（未命名问题）",
        detail: str(item.detail) ?? ""
      }))
    : []
  const patches = Array.isArray(raw.patches) ? raw.patches.filter(isPlainObject).slice(0, 200) : []
  return { summary: str(raw.summary) ?? "", findings, patches }
}

/** Full prompt/response record, so prompt quality can be iterated on later. */
async function recordAssist(root, settings, record) {
  if (root === undefined || settings.recordAssist !== true) return null
  try {
    const dir = join(root, EVENTS_DIR, ASSIST_DIR)
    await mkdir(dir, { recursive: true })
    const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`)
    await writeFile(file, JSON.stringify(record, null, 2), "utf8")
    return file
  } catch {
    return null
  }
}

async function handleAssist(res, body, log, settings, ctx) {
  const route = await resolveAssistRoute(ctx, settings)
  if (route.ok !== true) {
    await recordEvent(log, "ai:assist", { error: "no-adapter", detail: route.reason })
    sendJson(res, 503, { ok: false, error: route.reason, code: "NO_ADAPTER" })
    return
  }

  const request = buildAssistRequest(body)
  if (request.error !== undefined) {
    sendJson(res, 400, { ok: false, error: request.error })
    return
  }
  if (request.userText.length > MAX_ASSIST_CHARS) {
    sendJson(res, 413, {
      ok: false,
      error: `这条工作流投影后 ${request.userText.length} 字符，超过 ${MAX_ASSIST_CHARS} 的上限`
    })
    return
  }

  const llm = ctx.get("llm")
  const result = await streamAssist(llm, route, request.system, request.userText, settings)
  const parsed =
    result.failure === null
      ? parseAssistEnvelope(result.text, {
          usage: result.usage,
          maxTokens: settings.assistMaxTokens,
          reasoningChars: result.reasoningChars,
          effort: route.reasoningEffort
        })
      : { envelope: null, parseError: null }

  const recordPath = await recordAssist(log, settings, {
    at: new Date().toISOString(),
    task: request.task,
    provider: route.provider,
    model: route.model,
    reasoningEffort: route.reasoningEffort ?? null,
    elapsedMs: result.elapsedMs,
    usage: result.usage,
    reasoningChars: result.reasoningChars,
    request: { system: request.system, payload: request.payload },
    response: { text: result.text, envelope: parsed.envelope, parseError: parsed.parseError },
    failure: result.failure
  })

  await recordEvent(log, "ai:assist", {
    task: request.task,
    provider: route.provider,
    model: route.model,
    ms: result.elapsedMs,
    usage: result.usage,
    findings: parsed.envelope === null ? null : parsed.envelope.findings.length,
    patches: parsed.envelope === null ? null : parsed.envelope.patches.length,
    parseError: parsed.parseError,
    failure: result.failure === null ? null : result.failure.code,
    record: recordPath
  })

  const echo = {
    op: "assist",
    task: request.task,
    provider: route.provider,
    model: route.model,
    reasoningEffort: route.reasoningEffort ?? null,
    elapsedMs: result.elapsedMs,
    usage: result.usage,
    text: result.text,
    recordPath
  }

  if (result.failure !== null) {
    sendJson(res, result.failure.kind === "aborted" ? 504 : 502, {
      ok: false,
      error: result.failure.message,
      code: result.failure.code,
      ...echo
    })
    return
  }

  sendJson(res, 200, {
    ok: true,
    ...echo,
    summary: parsed.envelope === null ? "" : parsed.envelope.summary,
    findings: parsed.envelope === null ? [] : parsed.envelope.findings,
    patches: parsed.envelope === null ? [] : parsed.envelope.patches,
    parseError: parsed.parseError
  })
}

/* -------------------------------------------------------------- model tool */

/**
 * A host-side model tool, so an agent in any session can use the studio's
 * exported files without a browser.
 *
 * `op: "assist"` above only serves the panel: a human ticks the drawer. This
 * tool is the other face of the same capability — `list`/`read` the files in
 * `<cwd>/workflows`, and `assist` one of them through the SAME prompt, the same
 * route resolution and the same streamed call. It exists because the studio's
 * output is a file format, and the consumer of a file format is an agent.
 *
 * Two boundaries are deliberate:
 *   - It never writes. The exported file's `order`/`stats`/`validation`/
 *     `completenessScore` are derived by the studio's own exporters and
 *     validators; recomputing them here would be a second implementation of the
 *     studio's topological order and rule set, free to drift silently. The
 *     semantics-correct write path is the client half's `applyEdits`, and a
 *     caller that wants to persist has file tools of its own.
 *   - It only sees the *file* face. The live canvas in the iframe (unsaved
 *     edits, per-browser localStorage) is not reachable from here.
 */
const TOOL_NAME = "workflow_studio"

const TOOL_DESCRIPTION =
  "读取并体检工作区里的工作流编排文件（工作流编排台导出的 <cwd>/workflows/*.workflow.json）。" +
  'action="list" 列出有哪些文件；action="read" 读回完整 JSON；action="assist" 把一份工作流投影给模型做体检、' +
  "优化指定节点或按指令改写，返回 findings 与逐条校验过的 patches（字段名与导出文件一致）。" +
  "本工具从不写文件：ok:true 的 patch 由调用方写进文件，或由用户在编排台面板的 AI 抽屉里一键应用。" +
  "它只看得见已经导出到 workflows/ 的文件；浏览器画布里未保存的改动看不到。"

/** A workflow file is small; refuse to pull an unrelated JSON into a prompt. */
const MAX_FILE_BYTES = 2 * 1024 * 1024
/** One rewritten field is text, not a document. */
const MAX_FIELD_CHARS = 20000

/**
 * Node keys a `set` patch may touch in an *exported* file, and the value kind
 * enforced for each.
 *
 * Names are the exported ones (`owner`, `humanCheckpoint`) because the caller
 * edits the JSON it just read — not the studio's live-DB names (`role`,
 * `humanCheck`) that `ASSIST_SYSTEM_PROMPT` documents. Absent on purpose: `id`,
 * `step`, `dependsOn`/`next` (rebuilt by the exporter), `confirmed`, and the
 * derived `stats`/`validation`/`completenessScore`.
 */
const FILE_NODE_FIELDS = {
  title: "text",
  type: "text",
  owner: "text",
  model: "text",
  instruction: "text",
  inputs: "list",
  outputs: "list",
  forbidden: "list",
  acceptance: "text",
  notes: "text",
  humanCheckpoint: "bool",
  timeoutSec: "count",
  retry: "count"
}
const FILE_WF_FIELDS = { name: "text", goal: "text", delivery: "text", constraints: "text" }

/**
 * Exported field → the live-DB name `ASSIST_SYSTEM_PROMPT` documents.
 *
 * The prompt is shared with the client half, which speaks the live-DB
 * vocabulary; translating on the way in (and back on the way out) keeps ONE
 * prompt instead of a second, file-flavoured copy that would drift from it.
 * Only these two names differ.
 */
const FILE_TO_PROMPT_FIELDS = { owner: "role", humanCheckpoint: "humanCheck" }
const PROMPT_TO_FILE_FIELDS = { role: "owner", humanCheck: "humanCheckpoint" }

/** The studio's own text normalisation (same rule as `toText`, index.html:900). */
function toText(value) {
  if (Array.isArray(value)) {
    return value
      .filter((item) => item !== null && item !== undefined && String(item).trim() !== "")
      .join("\n")
  }
  return value === null || value === undefined ? "" : String(value)
}

function asBool(value) {
  return value === true || value === "true" || value === 1 || value === "1"
}

/** A non-negative integer, or undefined. `num()` cannot be reused: it rejects 0. */
function asCount(value) {
  const n = typeof value === "number" ? value : Number(str(value))
  if (!Number.isFinite(n) || n < 0) return undefined
  return Math.floor(n)
}

/** Drop null/undefined keys: the registered output schema declares no nullables. */
function compact(value) {
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null) continue
    out[key] = item
  }
  return out
}

/** Bound one value for a text render (the model reads the render, so keep it whole-ish). */
function clip(value, limit = 400) {
  const text = toText(value)
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/**
 * Resolve one file inside `<root>/<outDirName>`.
 *
 * `safeOutName` (see its own comment) is the whole traversal defence: a bare
 * name, no separators, no leading dot, `.json`/`.md` only. The `isInside` check
 * is belt-and-braces, not the primary guard.
 */
function resolveOutFile(root, settings, rawFile) {
  const file = safeOutName(rawFile)
  if (file === null) {
    return {
      error: `file 必须是 ${settings.outDirName}/ 下的一个 .json 或 .md 文件名（先用 action:"list" 看有哪些）`
    }
  }
  const dir = join(root, settings.outDirName)
  const target = resolve(dir, file)
  if (!isInside(dir, target)) return { error: `拒绝读取 ${file}` }
  return { file, dir, target }
}

/** Read one workflow file; `{ error }` is a message the caller should be shown. */
async function readOutFile(root, settings, rawFile) {
  const located = resolveOutFile(root, settings, rawFile)
  if (located.error !== undefined) return located
  const info = await stat(located.target).catch(() => null)
  if (info === null || !info.isFile()) {
    return { error: `工作区里没有 ${settings.outDirName}/${located.file}（action:"list" 看全部）` }
  }
  if (info.size > MAX_FILE_BYTES) {
    return { error: `${located.file} 有 ${info.size} 字节，超过 ${MAX_FILE_BYTES} 字节上限` }
  }
  const text = await readFile(located.target, "utf8")
  return { ...located, text, bytes: info.size, mtime: info.mtimeMs }
}

/**
 * Project an exported workflow file into the shape the assist prompt documents.
 *
 * `order` is the studio's topological order, stored as `{step,id,title,type}`
 * objects; the prompt speaks plain node-id strings, and a node's `step` is its
 * position there. `inputs`/`outputs`/`forbidden` are arrays in the file and
 * newline-joined text in the live DB, so they are normalised to text here (the
 * form the model was told to expect); a `set` patch on them is reported the same
 * way and split back into an array when written.
 */
function projectWorkflowFile(env, rawNodes) {
  const wf = isPlainObject(env.workflow) ? env.workflow : {}

  const ordered = []
  const seen = new Set()
  const push = (id) => {
    if (id === undefined || seen.has(id)) return
    seen.add(id)
    ordered.push(id)
  }
  if (Array.isArray(wf.order)) for (const entry of wf.order) push(isPlainObject(entry) ? str(entry.id) : str(entry))
  for (const node of rawNodes) push(str(node.id))

  const rawById = new Map()
  for (const node of rawNodes) {
    const id = str(node.id)
    if (id !== undefined) rawById.set(id, node)
  }

  const nodes = ordered.map((id, index) => {
    const node = rawById.get(id) ?? {}
    return {
      id,
      type: str(node.type) ?? "llm",
      step: index + 1,
      title: toText(node.title),
      role: toText(node.owner),
      model: toText(node.model),
      instruction: toText(node.instruction),
      inputs: toText(node.inputs),
      outputs: toText(node.outputs),
      acceptance: toText(node.acceptance),
      forbidden: toText(node.forbidden),
      humanCheck: asBool(node.humanCheckpoint),
      timeoutSec: asCount(node.timeoutSec) ?? 0,
      retry: asCount(node.retry) ?? 0,
      notes: toText(node.notes)
    }
  })

  const edges = Array.isArray(wf.edges)
    ? wf.edges
        .filter(isPlainObject)
        .map((edge) => compact({ from: str(edge.from), to: str(edge.to), label: str(edge.label) }))
        .filter((edge) => edge.from !== undefined && edge.to !== undefined)
    : []

  return {
    workflow: {
      id: str(wf.id) ?? "",
      name: toText(wf.name),
      goal: toText(wf.goal),
      delivery: toText(wf.delivery),
      constraints: toText(wf.constraints)
    },
    nodes,
    edges,
    order: ordered,
    rawById
  }
}

/**
 * Check one model-authored patch against the file it would be applied to.
 *
 * Same allow-list idea as the client half's `validatePatch`, with two honest
 * differences: it speaks the exported vocabulary, and it refuses instead of
 * coercing. The client rewrites an unknown node `type` to `llm` because the user
 * is mid-edit there and losing the patch would be worse; here the caller is
 * about to write a file, and a silently rewritten `type` would look like the
 * model's own decision.
 */
function validateFilePatch(patch, context) {
  const op = str(patch.op)
  const why = toText(patch.why)
  const { workflow, order, edges, rawById } = context
  const available = [...rawById.keys()].join(", ")

  if (op === "set") {
    const named = str(patch.field)
    if (named === undefined) return { ok: false, reason: "set 缺少 field" }
    const field = PROMPT_TO_FILE_FIELDS[named] ?? named
    const modelField = field === named ? undefined : named

    if (str(patch.target) === "wf") {
      const kind = FILE_WF_FIELDS[field]
      if (kind === undefined) {
        return { ok: false, reason: `工作流字段 ${field} 不在白名单里（可用：${Object.keys(FILE_WF_FIELDS).join(" / ")}）` }
      }
      return checkSet({ op, target: "wf", field, modelField, before: toText(workflow[field]), value: patch.value, why })
    }

    const target = str(patch.target)
    if (target === undefined || !rawById.has(target)) {
      return { ok: false, reason: `节点 ${String(patch.target)} 不存在（可用：${available}）` }
    }
    const kind = FILE_NODE_FIELDS[field]
    if (kind === undefined) {
      return { ok: false, reason: `节点字段 ${field} 不在白名单里（可用：${Object.keys(FILE_NODE_FIELDS).join(" / ")}）` }
    }
    const node = rawById.get(target)
    const before = kind === "bool" ? asBool(node[field]) : kind === "count" ? asCount(node[field]) ?? 0 : toText(node[field])
    return checkSet({ op, target, field, modelField, kind, before, value: patch.value, why })
  }

  if (op === "add-node") {
    const anchor = patch.after === null || patch.after === undefined ? null : str(patch.after)
    if (anchor !== null && !rawById.has(anchor)) {
      return { ok: false, reason: `after=${anchor} 不是这份工作流里的节点（可用：${available}）` }
    }
    const spec = isPlainObject(patch.node) ? patch.node : {}
    const title = toText(spec.title)
    if (title === "") return { ok: false, reason: "add-node 的 node.title 不能为空" }
    const types = [...new Set([...rawById.values()].map((node) => str(node.type)).filter((type) => type !== undefined))]
    const type = str(spec.type) ?? "llm"
    if (types.length > 0 && !types.includes(type)) {
      return { ok: false, reason: `节点类型 ${type} 不在这份工作流已出现的类型里（可用：${types.join(" / ")}）` }
    }
    const index = anchor === null ? order.length : order.indexOf(anchor) + 1
    return {
      ok: true,
      op,
      after: anchor,
      index,
      node: compact({
        type,
        title,
        role: toText(spec.role),
        instruction: toText(spec.instruction),
        inputs: toText(spec.inputs),
        outputs: toText(spec.outputs),
        acceptance: toText(spec.acceptance)
      }),
      why
    }
  }

  if (op === "remove-node") {
    const target = str(patch.target)
    if (target === undefined || !rawById.has(target)) {
      return { ok: false, reason: `节点 ${String(patch.target)} 不存在（可用：${available}）` }
    }
    return {
      ok: true,
      op,
      target,
      title: toText(rawById.get(target).title),
      removesEdges: edges.filter((edge) => edge.from === target || edge.to === target).length,
      why
    }
  }

  if (op === "link" || op === "unlink") {
    const from = str(patch.from)
    const to = str(patch.to)
    if (from === undefined || !rawById.has(from)) {
      return { ok: false, reason: `from=${String(patch.from)} 不存在（可用：${available}）` }
    }
    if (to === undefined || !rawById.has(to)) {
      return { ok: false, reason: `to=${String(patch.to)} 不存在（可用：${available}）` }
    }
    if (from === to) return { ok: false, reason: "不能把一个节点连到它自己" }
    const exists = edges.some((edge) => edge.from === from && edge.to === to)
    if (op === "link" && exists) return { ok: false, reason: `${from} → ${to} 已经连过了` }
    if (op === "unlink" && !exists) return { ok: false, reason: `${from} → ${to} 之间没有连线` }
    return compact({ ok: true, op, from, to, label: op === "link" ? toText(patch.label) : undefined, why })
  }

  return { ok: false, reason: `不支持的 op ${JSON.stringify(patch.op)}（只有 set / add-node / remove-node / link / unlink）` }
}

/** Shared tail of the two `set` forms: type-check the value, then diff it. */
function checkSet({ op, target, field, modelField, kind = "text", before, value, why }) {
  let after
  if (kind === "bool") after = asBool(value)
  else if (kind === "count") {
    after = asCount(value)
    if (after === undefined) return { ok: false, reason: `set ${field} 需要一个非负数字，收到 ${JSON.stringify(value) ?? "undefined"}` }
  } else {
    after = toText(value)
    if (after === "") return { ok: false, reason: `set ${field} 的 value 是空的` }
    if (after.length > MAX_FIELD_CHARS) {
      return { ok: false, reason: `set ${field} 的 value 有 ${after.length} 字符，超过 ${MAX_FIELD_CHARS}` }
    }
  }
  if (before === after) return { ok: false, reason: `set ${field} 的值没有变化，已跳过` }
  return compact({
    ok: true,
    op,
    target,
    field,
    modelField,
    before,
    after,
    write: kind === "list" ? "导出文件里是数组：按换行/逗号拆开写入" : undefined,
    why
  })
}

/** One `assist` call against a file: read → project → stream → validate. */
async function assistOnFile(root, log, settings, ctx, args) {
  const action = "assist"
  const found = await readOutFile(root, settings, args?.file)
  if (found.error !== undefined) return { ok: false, action, error: found.error }
  if (!/\.json$/i.test(found.file)) {
    return { ok: false, action, error: `${found.file} 是交接包 Markdown，assist 只处理 .workflow.json` }
  }

  let env = null
  try {
    env = JSON.parse(found.text)
  } catch {
    return { ok: false, action, error: `${found.file} 不是合法 JSON` }
  }
  if (!isPlainObject(env) || !isPlainObject(env.workflow)) {
    return { ok: false, action, error: `${found.file} 里没有 workflow 对象（format=${JSON.stringify(env?.format) ?? "undefined"}）` }
  }
  const rawNodes = Array.isArray(env.workflow.nodes) ? env.workflow.nodes.filter(isPlainObject) : []
  if (rawNodes.length === 0) {
    return { ok: false, action, error: `${found.file} 里没有节点：先在工作台里建节点再保存` }
  }

  const context = projectWorkflowFile(env, rawNodes)
  const task = str(args?.task) ?? "review"
  const focus = []
  for (const item of Array.isArray(args?.focus) ? args.focus : []) {
    const id = str(item)
    if (id === undefined) continue
    if (!context.rawById.has(id)) {
      return { ok: false, action, error: `focus 里的 ${id} 不在这份工作流里（可用：${context.order.join(", ")}）` }
    }
    focus.push(id)
  }
  if (task === "optimize" && focus.length === 0) {
    return { ok: false, action, error: "optimize 需要 focus：要改哪些节点 id" }
  }

  const request = buildAssistRequest({
    task,
    instruction: args?.instruction,
    workflow: context.workflow,
    nodes: context.nodes,
    edges: context.edges,
    order: context.order,
    focus
  })
  if (request.error !== undefined) return { ok: false, action, error: request.error }
  if (request.userText.length > MAX_ASSIST_CHARS) {
    return {
      ok: false,
      action,
      code: "TOO_LARGE",
      error: `这条工作流投影后 ${request.userText.length} 字符，超过 ${MAX_ASSIST_CHARS} 的上限`
    }
  }

  const route = await resolveAssistRoute(ctx, settings)
  if (route.ok !== true) {
    await recordEvent(log, "ai:assist", { source: "tool", file: found.file, error: "no-adapter", detail: route.reason })
    return { ok: false, action, code: "NO_ADAPTER", error: route.reason }
  }

  const result = await streamAssist(ctx.get("llm"), route, request.system, request.userText, settings)
  const parsed =
    result.failure === null
      ? parseAssistEnvelope(result.text, {
          usage: result.usage,
          maxTokens: settings.assistMaxTokens,
          reasoningChars: result.reasoningChars,
          effort: route.reasoningEffort
        })
      : { envelope: null, parseError: null }
  const recordPath = await recordAssist(log, settings, {
    at: new Date().toISOString(),
    source: "tool",
    file: found.file,
    task: request.task,
    focus,
    provider: route.provider,
    model: route.model,
    reasoningEffort: route.reasoningEffort ?? null,
    elapsedMs: result.elapsedMs,
    usage: result.usage,
    reasoningChars: result.reasoningChars,
    request: { system: request.system, payload: request.payload },
    response: { text: result.text, envelope: parsed.envelope, parseError: parsed.parseError },
    failure: result.failure
  })

  const patches = parsed.envelope === null ? [] : parsed.envelope.patches
  const validated = patches.map((patch) => validateFilePatch(patch, context))
  const applyable = validated.filter((item) => item.ok === true).length

  await recordEvent(log, "ai:assist", {
    source: "tool",
    file: found.file,
    task: request.task,
    provider: route.provider,
    model: route.model,
    ms: result.elapsedMs,
    usage: result.usage,
    findings: parsed.envelope === null ? null : parsed.envelope.findings.length,
    patches: patches.length,
    applyable,
    parseError: parsed.parseError,
    failure: result.failure === null ? null : result.failure.code,
    record: recordPath
  })

  const echo = {
    action,
    cwd: root,
    file: found.file,
    model: compact({
      provider: route.provider,
      model: route.model,
      reasoningEffort: route.reasoningEffort,
      source: route.source
    }),
    task: request.task,
    elapsedMs: result.elapsedMs,
    usage: result.usage,
    recordPath
  }

  if (result.failure !== null) {
    return compact({ ok: false, ...echo, code: result.failure.code, error: result.failure.message, text: result.text })
  }

  return compact({
    ok: true,
    ...echo,
    summary: parsed.envelope === null ? "" : parsed.envelope.summary,
    findings: parsed.envelope === null ? [] : parsed.envelope.findings,
    patches: validated,
    applyable,
    skipped: validated.length - applyable,
    parseError: parsed.parseError,
    // Only on a parse failure: the raw text is the salvage path, and it would be
    // noise (and tokens) on a normal answer.
    text: parsed.parseError === null ? undefined : result.text,
    next:
      `把 ok:true 的 patch 写进 ${settings.outDirName}/${found.file} 的 workflow.nodes / workflow.edges：` +
      "字段名就是 field（inputs/outputs/forbidden 写数组，按换行或逗号拆开），新节点自己生成 id 与坐标并按 order 重排 step。" +
      "stats / validation / completenessScore / order 是工作台自己导出的派生字段，改完请让工作台重新导出，不要手写。" +
      "也可以在编排台面板的 AI 抽屉里对同一份工作流应用这批 patch。"
  })
}

/** One call of the model tool. */
async function runStudioTool(args, exec, settings, ctx) {
  const action = str(args?.action) ?? "list"
  const sessionCwd = str(exec?.agent?.session?.header?.cwd)
  const { root, log } = resolveRoot(str(args?.cwd) ?? sessionCwd ?? settings.appRoot, settings)

  if (action === "list") {
    return compact({ ok: true, action, ...(await listWorkflows(root, settings)) })
  }

  if (action === "read") {
    const found = await readOutFile(root, settings, args?.file)
    if (found.error !== undefined) return { ok: false, action, error: found.error }
    return compact({
      ok: true,
      action,
      cwd: root,
      file: found.file,
      dir: found.dir,
      bytes: found.bytes,
      content: found.text
    })
  }

  if (action === "assist") return assistOnFile(root, log, settings, ctx, args)

  return { ok: false, action, error: `action 只能是 list / read / assist（收到 ${JSON.stringify(args?.action)}）` }
}

/**
 * The tool's argument schema, in the *compiled* JSON-Schema form the registry
 * holds (`defineTool` compiles the author-facing shape into exactly this before
 * registering). Only keywords from the supported subset are used.
 */
const STUDIO_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["list", "read", "assist"],
      description:
        "list 列出 <cwd>/workflows 下的工作流文件；read 读回一个文件的完整内容；" +
        "assist 把一份 .workflow.json 投影给模型体检、优化或改写。"
    },
    cwd: { type: "string", description: "工作区根目录；默认取调用方会话自己的目录。" },
    file: { type: "string", description: "workflows/ 下的文件名，如 空白草稿.workflow.json；read 与 assist 需要。" },
    task: {
      type: "string",
      enum: ["review", "optimize", "custom"],
      description: "assist 的任务：review 体检整条；optimize 只改 focus 里的节点；custom 执行 instruction。默认 review。"
    },
    instruction: { type: "string", description: "custom 任务的用户要求原文。" },
    focus: { type: "array", items: { type: "string" }, description: "要改的节点 id 列表；optimize 必填。" }
  },
  required: ["action"]
}

/**
 * The tool's result schema. Property types are declared only where this half
 * always produces that type, so a too-strict declaration cannot turn a working
 * call into a validation failure; `compact()` above is what keeps that promise
 * by dropping null-valued keys.
 */
const STUDIO_TOOL_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    action: { type: "string" },
    cwd: { type: "string" },
    dir: { type: "string" },
    file: { type: "string" },
    bytes: { type: "integer" },
    content: { type: "string" },
    error: { type: "string" },
    code: { type: "string" },
    task: { type: "string" },
    summary: { type: "string" },
    text: { type: "string" },
    parseError: { type: "string" },
    recordPath: { type: "string" },
    elapsedMs: { type: "integer" },
    applyable: { type: "integer" },
    skipped: { type: "integer" },
    next: { type: "string" },
    files: {},
    findings: {},
    patches: {},
    model: {},
    usage: {}
  }
}

/**
 * Render a tool result as text.
 *
 * This text is what the model reads, so the load-bearing parts are repeated in
 * full: every finding, every patch with its `why`, and the reason each skipped
 * patch was refused.
 */
function renderStudioTool(_args, value) {
  const v = isPlainObject(value) ? value : {}
  const lines = []

  if (v.ok !== true) {
    lines.push(`❌ ${str(v.error) ?? "调用失败"}${str(v.code) === undefined ? "" : `（${v.code}）`}`)
    if (str(v.file) !== undefined) lines.push(`文件：${v.file}`)
    if (str(v.text) !== undefined) lines.push("", "模型原文：", v.text)
    return [{ type: "text", text: lines.join("\n") }]
  }

  if (v.action === "list") {
    lines.push(`工作流文件目录：${v.dir}`)
    const files = Array.isArray(v.files) ? v.files : []
    if (files.length === 0) lines.push("（还没有导出过任何工作流：在编排台面板点「保存当前工作流」）")
    for (const file of files) {
      lines.push(`- ${file.name}（${file.kind === "workflow" ? "工作流 JSON" : "交接包 Markdown"}，${file.bytes} 字节）`)
    }
    lines.push('提示：assist 只处理 .workflow.json；.md 是给人读的交接包。')
    return [{ type: "text", text: lines.join("\n") }]
  }

  if (v.action === "read") {
    lines.push(`文件：${v.file}（${v.bytes} 字节）`, "", v.content ?? "")
    return [{ type: "text", text: lines.join("\n") }]
  }

  const model = isPlainObject(v.model) ? v.model : {}
  const effort = str(model.reasoningEffort) === undefined ? "" : ` (${model.reasoningEffort})`
  lines.push(`编排助手 · ${v.task} · ${v.file} · ${model.provider}/${model.model}${effort} · ${v.elapsedMs} ms`)
  if (str(v.summary) !== undefined) lines.push("", v.summary)
  if (str(v.parseError) !== undefined) {
    lines.push("", `⚠️ 模型没有返回合法 JSON：${v.parseError}`, "", "模型原文：", v.text ?? "")
  }

  const findings = Array.isArray(v.findings) ? v.findings : []
  if (findings.length > 0) {
    lines.push("", `问题 ${findings.length} 条：`)
    findings.forEach((item, index) => {
      lines.push(`${index + 1}. [${item.severity}] ${item.target}｜${item.title}`, `   ${item.detail}`)
    })
  }

  const patches = Array.isArray(v.patches) ? v.patches : []
  lines.push("", `补丁 ${v.applyable}/${patches.length} 条可用（本工具不写文件）：`)
  patches.forEach((patch, index) => {
    if (patch.ok !== true) {
      lines.push(`${index + 1}. 已跳过：${patch.reason}`)
      return
    }
    const where =
      patch.target !== undefined
        ? patch.target
        : patch.from !== undefined
          ? `${patch.from} → ${patch.to}`
          : `接在 ${patch.after ?? "末尾"} 之后`
    const field = patch.field === undefined ? "" : ` ${patch.field}${patch.modelField === undefined ? "" : `（模型写作 ${patch.modelField}）`}`
    lines.push(`${index + 1}. [${patch.op}]${field} @ ${where}｜${patch.why ?? ""}`)
    if (patch.op === "set") lines.push(`   现在：${clip(patch.before)}`, `   改为：${clip(patch.after)}`)
    if (patch.op === "add-node") {
      lines.push(`   新节点：${patch.node.type}「${patch.node.title}」，插到第 ${patch.index + 1} 位`)
    }
    if (patch.op === "remove-node") lines.push(`   会同时删掉 ${patch.removesEdges ?? 0} 条连线`)
  })
  if (str(v.next) !== undefined) lines.push("", v.next)
  if (str(v.recordPath) !== undefined) lines.push(`调用记录：${v.recordPath}`)
  return [{ type: "text", text: lines.join("\n") }]
}

/**
 * Wait for the `tools` service, then put the model tool in its registry.
 *
 * This exists because reading the store directly does not work here. v0.3.0
 * called `registerStudioTool(ctx, settings)` straight from `apply`, which read
 * `ctx.get("tools")` at that instant — and cordis documents `ctx.get` as "the
 * service value, or `undefined` when not (yet) provided". The host provides
 * `webServer` before `tools`, so in every real DSH that read answered
 * `undefined`, registration was skipped, and nothing retried: cordis only
 * re-evaluates fibers that declared the service in their *own* `inject`
 * (`if (!(name in fiber.inject)) continue`), and this plugin declares only
 * `webServer`. Live hosts logged `host:registered … "tools":false` with no
 * `host:tool-failed` to explain it, on every boot, forever.
 *
 * `ctx.inject(deps, callback)` is cordis's own answer to exactly this shape:
 * "start a callback once the requested dependencies are available". The callback
 * runs on a child fiber, so the plugin still loads with `webServer` alone — an
 * HTTP-only shell keeps serving the studio and simply never fires the callback —
 * while a real host gets the tool the moment its registry appears.
 *
 * Adding `tools` to this module's `inject` would also have fixed the symptom and
 * is what dsh-kanban does, but it would make both HTTP routes hostage to a tool
 * registry existing on every platform. The tool is an addition, not a
 * precondition.
 *
 * The child fiber is deliberately not stored: cordis owns its lifetime and tears
 * it down with this plugin's fiber on reload.
 */
function armStudioTool(ctx, settings) {
  // `ctx.inject` is a cordis fiber API — absent in the bare-Node selftest
  // harness and in any non-cordis embedder. Falling back to a direct attempt
  // keeps those hosts working; their service store is already populated by the
  // time `apply` runs, which is precisely the property real DSH lacks.
  if (typeof ctx?.inject !== "function") {
    registerStudioTool(ctx, settings)
    return
  }

  ctx.inject(["tools"], function registerWorkflowStudioTool(toolCtx) {
    registerStudioTool(toolCtx, settings)
  })
}

/**
 * Put the model tool in a `tools` registry, reporting the outcome.
 *
 * Guarded on both sides: a missing service and a refusing registry each leave
 * the two HTTP routes intact, so nothing here can take the studio down. Every
 * outcome reaches the diagnostic log, because the v0.3.0 bug was invisible by
 * being silent — an operator could see the tool was absent but not whether the
 * service was missing, the registry had refused, or nobody had looked yet. A
 * host whose `tools` never appears writes no tool event at all, which is itself
 * the answer.
 */
function registerStudioTool(ctx, settings) {
  const tools = ctx?.get?.("tools")
  if (tools === null || tools === undefined || typeof tools.register !== "function") {
    const reason = tools === null || tools === undefined
      ? "no tools service"
      : "tools service exposes no register()"
    recordEvent(settings.appRoot, "host:tool-unavailable", { version: VERSION, pid: process.pid, reason })
    return false
  }
  try {
    tools.register({
      name: TOOL_NAME,
      description: TOOL_DESCRIPTION,
      parameters: STUDIO_TOOL_PARAMETERS,
      output: { schema: STUDIO_TOOL_OUTPUT_SCHEMA, render: renderStudioTool },
      presentCall: (args) => ({
        card: "generic",
        title: `工作流编排台 · ${str(args?.action) ?? "list"}`,
        kind: str(args?.action) === "assist" ? "other" : "read",
        rawInput: args
      }),
      execute: (args, exec) => runStudioTool(args, exec, settings, ctx)
    })
    recordEvent(settings.appRoot, "host:tool-registered", { version: VERSION, pid: process.pid, name: TOOL_NAME })
    return true
  } catch (error) {
    recordEvent(settings.appRoot, "host:tool-failed", {
      version: VERSION,
      pid: process.pid,
      error: error instanceof Error ? error.message : String(error)
    })
    return false
  }
}

/* ---------------------------------------------------------------- helpers */

/**
 * Resolve the workspace root for one request: client cwd > config > process cwd.
 *
 * Returns `{ root, log }`. `root` always resolves to something usable for reads
 * and writes; `log` is the root only when it was named explicitly, so
 * diagnostics never scatter a `.workflow-studio/` directory into whatever
 * directory the DSH process happens to have been started from.
 */
function resolveRoot(rawCwd, settings) {
  const candidate = str(rawCwd) ?? settings.appRoot
  if (candidate === undefined) return { root: process.cwd(), log: undefined }
  try {
    const root = resolve(candidate)
    return { root, log: root }
  } catch {
    return { root: process.cwd(), log: undefined }
  }
}

/** True when `target` is `dir` itself or lives under it (no traversal escape). */
function isInside(dir, target) {
  const base = resolve(dir)
  return target === base || target.startsWith(base + sep)
}

/**
 * Accept only a bare file name that this plugin could have written.
 *
 * Rejects separators (so nothing escapes `<root>/workflows`), leading dots, and
 * any extension other than `.json`/`.md`. `path.basename` is deliberately NOT
 * used as a sanitizer: silently rewriting `../../x.json` into `x.json` would
 * turn a traversal attempt into a successful write somewhere unexpected.
 */
function safeOutName(rawName) {
  const value = str(rawName)
  if (value === undefined) return null
  const base = value.trim()
  if (base === "" || base.length > 160) return null
  if (base.includes("/") || base.includes("\\")) return null
  if (base.startsWith(".")) return null
  if (!/\.(json|md)$/i.test(base)) return null
  return base
}

/** Append one diagnostics line; never throws into the request path. */
async function recordEvent(root, event, detail) {
  if (root === undefined || root === "") return
  try {
    const dir = join(root, EVENTS_DIR)
    await mkdir(dir, { recursive: true })
    const file = join(dir, EVENTS_FILE)
    const info = await stat(file).catch(() => null)
    if (info !== null && info.size > MAX_LOG) {
      const text = await readFile(file, "utf8")
      await writeFile(file, text.slice(-Math.floor(MAX_LOG / 2)), "utf8")
    }
    await appendFile(file, `${new Date().toISOString()}\t${event}\t${JSON.stringify(detail ?? {})}\n`, "utf8")
  } catch {
    /* diagnostics only */
  }
}

function sendHtml(res, status, html) {
  const body = Buffer.from(html, "utf8")
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store"
  })
  res.end(body)
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** Minimal styled error card, in the studio's own visual language. */
function errorPage(title, body) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  html,body{height:100%;margin:0}
  body{display:flex;align-items:center;justify-content:center;background:#0f1115;color:#e6e8ee;
       font:14px/1.7 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;padding:32px}
  .card{max-width:680px;border:1px solid #262b36;border-radius:12px;padding:24px 28px;background:#151922}
  h1{margin:0 0 12px;font-size:18px}
  code{background:#0b0e14;border:1px solid #262b36;border-radius:6px;padding:1px 6px;font-size:12px;word-break:break-all}
  .hint{margin-top:16px;color:#8b93a7;font-size:12px}
</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1><div>${body}</div>
<div class="hint">由 dsh-workflow-studio v${VERSION} 提供。工作台文件应位于 <code>&lt;工作区&gt;/workflow-studio/index.html</code>。</div>
</div></body></html>`
}
