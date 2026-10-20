/**
 * dsh-workflow-studio — host-half selftest.
 *
 * The host half has no DSH dependency at all: it is `apply(ctx, config)` plus
 * two request handlers over plain node:http req/res objects. So it can be
 * exercised end to end in bare Node by faking the one cordis service it asks
 * for (`webServer`) and driving real streams through the registered handlers.
 *
 * This is the fast feedback loop. The browser half is verified separately,
 * against the live GUI, because it only exists inside the shell.
 *
 * Run:
 *   node selftest.mjs
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { Readable } from "node:stream"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { apply, inject, name } from "./lib/index.js"

const HERE = fileURLToPath(new URL(".", import.meta.url))
const WORKSPACE = resolve(HERE, "..")
const SANDBOX = join(WORKSPACE, ".tmp-ws-selftest")

let passed = 0
const failures = []

function ok(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${label}`)
    return
  }
  failures.push(label)
  console.log(`  FAIL  ${label}${detail === undefined ? "" : ` — ${detail}`}`)
}

function eq(label, actual, expected) {
  ok(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

/* --------------------------------------------------------------- fakes --- */

/** Minimal node:http ServerResponse stand-in. */
function fakeRes() {
  const state = {
    status: 0,
    headers: null,
    body: null,
    writableEnded: false
  }
  return {
    state,
    writeHead(status, headers) {
      state.status = status
      state.headers = headers ?? {}
    },
    end(body) {
      state.writableEnded = true
      if (body !== undefined && body !== null) {
        state.body = Buffer.isBuffer(body) ? body : Buffer.from(String(body))
      }
    }
  }
}

/** Minimal IncomingMessage stand-in; body is optional. */
function fakeReq({ method = "GET", url, body }) {
  const stream = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(body, "utf8")])
  stream.method = method
  stream.url = url
  return stream
}

/**
 * Drive one handler and resolve with the response state.
 *
 * The registered handlers are fire-and-forget by design (`handle(...).catch(...)`
 * with no returned promise), so the response cannot be awaited directly — poll
 * until the response object reports itself ended, exactly like a real client
 * would wait for bytes.
 */
async function call(handler, reqInit) {
  const res = fakeRes()
  handler(fakeReq(reqInit), res)
  for (let tick = 0; tick < 500 && !res.state.writableEnded; tick += 1) {
    await new Promise((done) => setTimeout(done, 2))
  }
  return res.state
}

const settle = () => new Promise((done) => setTimeout(done, 60))

const text = (state) => (state.body === null ? "" : state.body.toString("utf8"))
const json = (state) => JSON.parse(text(state))

/* ----------------------------------------------------------------- run --- */

console.log("dsh-workflow-studio · host selftest\n")
console.log(`plugin name: ${name}`)
console.log(`inject:      ${JSON.stringify(inject)}`)
console.log(`workspace:   ${WORKSPACE}`)
console.log(`sandbox:     ${SANDBOX}\n`)

await rm(SANDBOX, { recursive: true, force: true })
await mkdir(SANDBOX, { recursive: true })

/* -- 1. registration ------------------------------------------------------ */

console.log("1. bundle registration")
/**
 * Minimal stand-in for a cordis Context — with the one dimension the old flat
 * `{ get }` table did not have: *time*.
 *
 * Real hosts publish `webServer` and then, later, `tools`: `ctx.get` answers
 * `undefined` until a service is published, and cordis only re-evaluates fibers
 * that declared the service in their own `inject`. A table that is fully
 * populated before `apply` runs is the one shape DSH never has — which is
 * exactly how the v0.3.0 inject bug shipped under a green suite while the tool
 * failed to register in every real process.
 *
 * `inject(names, callback)` mirrors cordis: the callback runs once every named
 * service is published, immediately if they already are.
 */
function fakeHost(seed = {}) {
  const store = { ...seed }
  const waiters = []

  const view = () => ({
    get: (service) => store[service],
    inject(names, callback) {
      waiters.push({ names: [...names], callback })
      flush()
    }
  })

  function flush() {
    for (let i = 0; i < waiters.length; i += 1) {
      const waiter = waiters[i]
      if (!waiter.names.every((service) => store[service] !== undefined)) continue
      waiters.splice(i, 1)
      i -= 1
      waiter.callback(view())
    }
  }

  return {
    ctx: view(),
    /** Publish a service — in a real host this happens *after* `apply`. */
    provide(service, value) {
      store[service] = value
      flush()
    }
  }
}

/** Mount a fresh plugin instance on a fresh fake web server. */
function mount(config, services = {}) {
  return mountHost(config, services).routes
}

/** Same, but hands the host back so a test can publish services late. */
function mountHost(config, services = {}) {
  const routes = []
  const server = { register: (route) => routes.push(route) }
  const host = fakeHost({ webServer: server, ...services })
  apply(host.ctx, config)
  return { routes, host }
}

const routes = mount({ appRoot: WORKSPACE, appDirName: "workflow-studio", outDirName: "workflows" })

eq("two routes registered", routes.length, 2)
eq("app route path", routes[0]?.path, "/workflow-studio/app")
eq("app route kind", routes[0]?.kind, "prefix")
eq("api route path", routes[1]?.path, "/workflow-studio/api")
ok("handlers are functions", typeof routes[0]?.handler === "function" && typeof routes[1]?.handler === "function")

// The boot event is the host half's proof of life; it must land in appRoot.
await settle()
const bootLog = await readFile(join(WORKSPACE, ".workflow-studio", "events.log"), "utf8").catch(() => "")
ok("boot event recorded in appRoot", bootLog.includes("host:registered"), bootLog.slice(-200))

const appHandler = routes[0].handler
const apiHandler = routes[1].handler

// `webServer` absent ⇒ apply must be a silent no-op, never a throw.
let noServerThrew = false
try {
  apply({ get: () => undefined }, {})
} catch {
  noServerThrew = true
}
ok("apply() without webServer is a no-op", noServerThrew === false)
ok("no-server apply registers nothing", mount(undefined).length === 2)

/* -- 2. serving the local HTML ------------------------------------------- */

console.log("\n2. serving the workspace HTML")
const entryPath = join(WORKSPACE, "workflow-studio", "index.html")
const entryBytes = (await stat(entryPath)).size

const served = await call(appHandler, { url: `/workflow-studio/app?cwd=${encodeURIComponent(WORKSPACE)}` })
eq("bonus app GET status", served.status, 200)
eq("content-type is html", served.headers?.["content-type"], "text/html; charset=utf-8")
eq("content-length matches the file", served.headers?.["content-length"], entryBytes)
const servedText = text(served)
ok("serves the studio, not a stub", servedText.includes("wb_workflow_studio_v1"))
ok("serves the studio's own script", servedText.includes("function buildWorkflowFile"))

// No ?cwd= ⇒ the configured appRoot is the fallback.
const viaConfig = await call(appHandler, { url: "/workflow-studio/app" })
eq("falls back to config appRoot", viaConfig.status, 200)

// A ?cwd= without its own workflow-studio/ falls back to appRoot, so a
// workspace that does not carry the studio still opens the panel (the studio is
// shared; the data root is per-workspace).
const viaFallback = await call(appHandler, {
  url: `/workflow-studio/app?cwd=${encodeURIComponent(join(SANDBOX, "no-studio-workspace"))}`
})
eq("workspace without a studio falls back to appRoot", viaFallback.status, 200)
eq("fallback serves the appRoot copy", text(viaFallback), servedText)

// No candidate has the studio ⇒ the styled 404 page lists every directory tried.
// process.cwd() is pinned too, so the third fallback cannot accidentally supply
// the studio from the checkout that runs this file.
eq("a fresh mount still registers two routes", mount({}).length, 2)
const previousCwd = process.cwd()
process.chdir(SANDBOX)
try {
  const routesNoStudio = mount({ appRoot: SANDBOX })
  const missing = await call(routesNoStudio[0].handler, {
    url: `/workflow-studio/app?cwd=${encodeURIComponent(SANDBOX)}`
  })
  eq("no studio anywhere is a 404", missing.status, 404)
  ok("404 explains the expected path", text(missing).includes("workflow-studio"))
  ok("404 lists the directories tried", text(missing).includes("已按顺序找过"))
  ok("404 page is html", String(missing.headers?.["content-type"]).startsWith("text/html"))
} finally {
  process.chdir(previousCwd)
}

/* -- 3. traversal containment -------------------------------------------- */

console.log("\n3. path containment")
for (const attack of [
  "/workflow-studio/app/../../../../../../Windows/win.ini",
  "/workflow-studio/app/..%2f..%2f..%2fpackage.json",
  "/workflow-studio/app/subdir/../../../package.json"
]) {
  const blocked = await call(appHandler, { url: `${attack}?cwd=${encodeURIComponent(WORKSPACE)}` })
  ok(`blocked ${attack.slice(0, 46)}`, blocked.status === 403 || blocked.status === 404, `status ${blocked.status}`)
}

/* -- 4. the workspace api ------------------------------------------------ */

console.log("\n4. workflow file api")
const ping = await call(apiHandler, { url: "/workflow-studio/api?op=png" })
eq("unknown op is a 400", ping.status, 400)
const ping2 = await call(apiHandler, { url: "/workflow-studio/api?op=ping" })
eq("ping status", ping2.status, 200)
eq("ping identifies the plugin", json(ping2).plugin, "dsh-workflow-studio")

const empty = await call(apiHandler, { url: `/workflow-studio/api?op=list&cwd=${encodeURIComponent(SANDBOX)}` })
eq("empty list status", empty.status, 200)
eq("empty list has no files", json(empty).files.length, 0)
eq("list reports the out dir", json(empty).dir, join(SANDBOX, "workflows"))

const payload = {
  cwd: SANDBOX,
  op: "save",
  files: [
    { name: "上料机械臂.workflow.json", text: '{"$schema":"workflow-studio/v1","workflow":{"name":"上料机械臂"}}' },
    { name: "上料机械臂-交接包.md", text: "# 交接包\n\n一、目标\n" }
  ]
}
const saved = await call(apiHandler, { method: "POST", url: "/workflow-studio/api", body: JSON.stringify(payload) })
eq("save status", saved.status, 200)
eq("save wrote two files", json(saved).written.length, 2)
ok("both files exist on disk", (await stat(join(SANDBOX, "workflows", "上料机械臂.workflow.json"))).size > 0)
const listed = json(saved).files
eq("list sees both files", listed.length, 2)
eq("json classified as workflow", listed.find((f) => f.name.endsWith(".json"))?.kind, "workflow")
eq("md classified as handoff", listed.find((f) => f.name.endsWith(".md"))?.kind, "handoff")

const readBack = await call(
  apiHandler,
  { url: `/workflow-studio/api?op=read&cwd=${encodeURIComponent(SANDBOX)}&name=${encodeURIComponent("上料机械臂-交接包.md")}` }
)
eq("read status", readBack.status, 200)
ok("read returns the file text", json(readBack).text.includes("交接包"))

for (const bad of ["../../evil.json", "..\\evil.json", ".hidden.json", "notes.txt", "", "a/b.json"]) {
  const rejected = await call(
    apiHandler,
    { method: "POST", url: "/workflow-studio/api", body: JSON.stringify({ cwd: SANDBOX, op: "save", files: [{ name: bad, text: "x" }] }) }
  )
  ok(`rejected file name ${JSON.stringify(bad)}`, rejected.status === 400, `status ${rejected.status}`)
}

const traversal = await call(
  apiHandler,
  { url: `/workflow-studio/api?op=read&cwd=${encodeURIComponent(SANDBOX)}&name=${encodeURIComponent("../../KANBAN.json")}` }
)
eq("read rejects traversal", traversal.status, 400)

const noText = await call(
  apiHandler,
  { method: "POST", url: "/workflow-studio/api", body: JSON.stringify({ cwd: SANDBOX, op: "save", files: [{ name: "a.json" }] }) }
)
eq("save requires text", noText.status, 400)

const badJson = await call(apiHandler, { method: "POST", url: "/workflow-studio/api", body: "{not json" })
eq("malformed body is a 400", badJson.status, 400)

const logged = await call(
  apiHandler,
  { method: "POST", url: "/workflow-studio/api", body: JSON.stringify({ cwd: SANDBOX, op: "log", event: "client:iframe-load", detail: { studioReady: true } }) }
)
eq("log status", logged.status, 200)
const logText = await readFile(join(SANDBOX, ".workflow-studio", "events.log"), "utf8")
ok("client event reached the log", logText.includes("client:iframe-load"))
ok("client detail reached the log", logText.includes("studioReady"))
ok("api:save reached the log", logText.includes("api:save"))

const deleted = await call(
  apiHandler,
  { method: "POST", url: "/workflow-studio/api", body: JSON.stringify({ cwd: SANDBOX, op: "delete", name: "上料机械臂-交接包.md" }) }
)
eq("delete status", deleted.status, 200)
eq("delete leaves one file", json(deleted).files.length, 1)

const wrongMethod = await call(apiHandler, { method: "PUT", url: "/workflow-studio/api" })
eq("unsupported method is a 405", wrongMethod.status, 405)

const missingApi = await call(apiHandler, { url: `/workflow-studio/api?op=read&cwd=${encodeURIComponent(SANDBOX)}&name=absent.json` })
eq("missing file is a 404", missingApi.status, 404)

/* -- 5. the same contract over a real socket ------------------------------ */

/*
 * Everything above drives the registered handlers directly, so the response
 * object is a stand-in. That leaves exactly one combination untested: the save
 * op over a real HTTP socket. The browser proved the others live (its
 * `client:app-probe` arrives as a real POST), so this section pins the last one
 * down here rather than depending on a human click.
 */

console.log("5. real-socket round trip")

const REAL = await mkdtemp(join(tmpdir(), "ws-http-"))
const server = createServer((req, res) => {
  const raw = typeof req.url === "string" && req.url !== "" ? req.url : "/"
  const handler = raw.startsWith("/workflow-studio/api") ? apiHandler : appHandler
  handler(req, res)
})
await new Promise((done) => server.listen(0, "127.0.0.1", done))
const base = `http://127.0.0.1:${server.address().port}`

const post = (payload) =>
  fetch(`${base}/workflow-studio/api`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  })

const realList = await fetch(`${base}/workflow-studio/api?op=list&cwd=${encodeURIComponent(REAL)}`)
eq("real: list is a 200", realList.status, 200)
ok("real: fresh workspace is empty", (await realList.json()).files.length === 0)

const realSave = await post({
  cwd: REAL,
  op: "save",
  files: [
    { name: "示例.workflow.json", text: '{"$schema":"workflow-studio/v1"}' },
    { name: "示例-交接包.md", text: "# 交接包\n" }
  ]
})
eq("real: save is a 200", realSave.status, 200)
const realSaved = await realSave.json()
eq("real: two files acknowledged", realSaved.written.length, 2)
eq("real: json landed byte-identical", await readFile(join(REAL, "workflows", "示例.workflow.json"), "utf8").catch(() => null), '{"$schema":"workflow-studio/v1"}')
eq("real: markdown landed byte-identical", await readFile(join(REAL, "workflows", "示例-交接包.md"), "utf8").catch(() => null), "# 交接包\n")
ok("real: save names the folder it wrote", String(realSaved.dir).toLowerCase() === join(REAL, "workflows").toLowerCase(), realSaved.dir)

const realRead = await fetch(`${base}/workflow-studio/api?op=read&cwd=${encodeURIComponent(REAL)}&name=${encodeURIComponent("示例.workflow.json")}`)
eq("real: read-back is a 200", realRead.status, 200)
eq("real: read-back matches", (await realRead.json()).text, '{"$schema":"workflow-studio/v1"}')

const realEvil = await post({ cwd: REAL, op: "save", files: [{ name: "../escape.json", text: "{}" }] })
eq("real: traversal name is a 400", realEvil.status, 400)
ok("real: nothing escaped the folder", (await stat(join(REAL, "escape.json")).catch(() => null)) === null)

const realDel = await post({ cwd: REAL, op: "delete", name: "示例-交接包.md" })
eq("real: delete is a 200", realDel.status, 200)
ok("real: delete removed the file", (await stat(join(REAL, "workflows", "示例-交接包.md")).catch(() => null)) === null)
ok("real: delete kept the other file", (await stat(join(REAL, "workflows", "示例.workflow.json")).catch(() => null)) !== null)

await new Promise((done) => server.close(done))
await rm(REAL, { recursive: true, force: true })

/* -- 6. orchestration assistant ------------------------------------------ */

console.log("\n6. orchestration assistant")

/**
 * Scriptable stand-in for the `llm` service.
 *
 * `chunks` is either an array (yielded once) or a function of the options, and
 * every call is recorded so the test can assert on the request the plugin built.
 */
function fakeLlm(chunks) {
  const calls = []
  const llm = {
    calls,
    async *stream(options) {
      calls.push(options)
      const list = typeof chunks === "function" ? chunks(options) : chunks
      for (const chunk of list) yield chunk
    },
    listProviders: async () => [{ id: "catalog-p", name: "Catalog" }],
    listModels: async (id) => [{ id: `catalog-${id}-m`, name: "Catalog model" }]
  }
  return llm
}

const ASSIST_NODES = [
  { id: "n1", step: 1, type: "start", title: "接收任务" },
  { id: "n2", step: 2, type: "llm", title: "生成方案" }
]

const ASSIST_BODY = (extra = {}) => ({
  cwd: SANDBOX,
  op: "assist",
  task: "review",
  workflow: { id: "wf1", name: "示例", goal: "g", delivery: "", constraints: "" },
  nodes: ASSIST_NODES,
  edges: [{ id: "e1", from: "n1", to: "n2", label: "" }],
  order: ["n1", "n2"],
  focus: [],
  ...extra
})

const assistPost = (handler, body) =>
  call(handler, { method: "POST", url: "/workflow-studio/api", body: JSON.stringify(body) })

// 6a. route resolution: config > agent default > first catalog provider.
const llmCatalog = fakeLlm([])
const routesCatalog = mount({ appRoot: WORKSPACE }, { llm: llmCatalog })
const pingCatalog = json(await call(routesCatalog[1].handler, { url: "/workflow-studio/api?op=ping" }))
eq("ping reports a usable assistant route", pingCatalog.assist?.ok, true)
eq("route falls back to the first catalog provider", pingCatalog.assist?.provider, "catalog-p")
eq("route falls back to that provider's first model", pingCatalog.assist?.model, "catalog-catalog-p-m")
eq("fallback route is labelled", pingCatalog.assist?.source, "first-provider")

const agentDefault = {
  currentSelection: () => ({ provider: "agent-p", model: "agent-m", reasoningEffort: "high" })
}
const routesAgent = mount({ appRoot: WORKSPACE }, { llm: fakeLlm([]), agentDefaultModel: agentDefault })
const pingAgent = json(await call(routesAgent[1].handler, { url: "/workflow-studio/api?op=ping" }))
eq("agent default beats the catalog", pingAgent.assist?.provider, "agent-p")
eq("agent default carries reasoningEffort", pingAgent.assist?.reasoningEffort, "high")

const routesConfig = mount(
  { appRoot: WORKSPACE, assistProvider: "cfg-p", assistModel: "cfg-m", assistReasoningEffort: "low", assistMaxTokens: 1234 },
  { llm: fakeLlm([]), agentDefaultModel: agentDefault }
)
const pingConfig = json(await call(routesConfig[1].handler, { url: "/workflow-studio/api?op=ping" }))
eq("explicit config beats the agent default", pingConfig.assist?.provider, "cfg-p")
eq("config route is labelled", pingConfig.assist?.source, "config")

// 6b. a missing adapter is one op's 503, not a broken plugin.
const routesNoLlm = mount({ appRoot: WORKSPACE })
const pingNoLlm = json(await call(routesNoLlm[1].handler, { url: "/workflow-studio/api?op=ping" }))
eq("no llm service: ping still answers", pingNoLlm.ok, true)
eq("no llm service: assist is reported unavailable", pingNoLlm.assist?.ok, false)
ok("no llm service: the reason is human-readable", typeof pingNoLlm.assist?.reason === "string" && pingNoLlm.assist.reason.length > 0)
const noAdapter = await assistPost(routesNoLlm[1].handler, ASSIST_BODY())
eq("no llm service: assist is a 503", noAdapter.status, 503)
eq("no llm service: stable code NO_ADAPTER", json(noAdapter).code, "NO_ADAPTER")
const noAdapterPing = json(await call(routesNoLlm[1].handler, { url: "/workflow-studio/api?op=ping" }))
ok("no llm service: the workspace app is unaffected", noAdapterPing.version !== undefined)

// 6c. the happy path: fenced JSON with a chatty preface is still recovered.
const ENVELOPE = {
  summary: "补齐了交付物与人工闸门",
  findings: [
    { severity: "error", target: "n2", title: "缺验收", detail: "没有 acceptance" },
    { severity: "warn", target: "wf", title: "缺交付物", detail: "delivery 为空" },
    { severity: "info", target: "wf", title: "可加失败分支", detail: "仅建议" },
    { severity: "banana", target: "wf", title: "未知级别", detail: "应归一到 info" }
  ],
  patches: [
    { op: "set", target: "wf", field: "delivery", value: "可执行编排包" },
    { op: "set", target: "n2", field: "acceptance", value: "三段齐全" }
  ]
}
const HAPPY_TEXT = `好的，我检查完了：\n\n\`\`\`json\n${JSON.stringify(ENVELOPE)}\n\`\`\`\n`
const llmHappy = fakeLlm([
  { type: "block-start", index: 0, blockType: "text" },
  { type: "reasoning-delta", index: 1, text: "私密草稿不该出现在返回里" },
  { type: "text-delta", index: 0, text: HAPPY_TEXT.slice(0, 40) },
  { type: "text-delta", index: 0, text: HAPPY_TEXT.slice(40) },
  { type: "usage", usage: { inputTokens: 900, outputTokens: 120, totalTokens: 1020 } },
  { type: "finish", reason: { kind: "stop" } }
])
const routesHappy = mount(
  { appRoot: WORKSPACE, assistProvider: "cfg-p", assistModel: "cfg-m", assistReasoningEffort: "low" },
  { llm: llmHappy }
)
const happy = await assistPost(routesHappy[1].handler, ASSIST_BODY())
const happyBody = json(happy)
eq("assist happy path is a 200", happy.status, 200)
eq("assist echoes the task", happyBody.task, "review")
eq("assist echoes provider/model", `${happyBody.provider}/${happyBody.model}`, "cfg-p/cfg-m")
eq("assist echoes reasoningEffort", happyBody.reasoningEffort, "low")
eq("assist surfaces the summary", happyBody.summary, ENVELOPE.summary)
eq("findings survive and are capped in shape", happyBody.findings.length, 4)
eq("an unknown severity is normalized to info", happyBody.findings[3].severity, "info")
eq("patches are passed through untouched", happyBody.patches.length, 2)
eq("no parseError on a recoverable reply", happyBody.parseError, null)
eq("raw text is echoed verbatim", happyBody.text, HAPPY_TEXT)
ok("reasoning deltas never reach the panel", !happyBody.text.includes("私密草稿"))
eq("usage is echoed", happyBody.usage?.totalTokens, 1020)

const sent = llmHappy.calls[0]
eq("one model call", llmHappy.calls.length, 1)
eq("the call targets the resolved route", `${sent.provider}/${sent.model}`, "cfg-p/cfg-m")
eq("the call carries the inherited effort", sent.reasoningEffort, "low")
eq("the call uses the default maxTokens", sent.maxTokens, 16384)
eq("the call is a single user message", sent.messages.length, 1)
eq("the message content is a text block", sent.messages[0].content[0].type, "text")
eq("the system prompt carries the review brief", sent.system.includes("体检整条工作流"), true)
ok("the system prompt is not interpolated", sent.system.includes("${") === false)
const projection = JSON.parse(sent.messages[0].content[0].text)
eq("the projection carries the task", projection.task, "review")
eq("the projection carries the nodes", projection.nodes.length, 2)
eq("the projection carries the order", projection.order.join(","), "n1,n2")
eq("the projection carries an empty focus for a whole-flow review", projection.focus.length, 0)
eq("the projection sends no layout coordinates", Object.hasOwn(projection.nodes[0], "x"), false)
eq("the projection sends no checked state", Object.hasOwn(projection.nodes[0], "checked"), false)

ok("a prompt/response record is written", typeof happyBody.recordPath === "string" && happyBody.recordPath.length > 0, String(happyBody.recordPath))
const recordText = await readFile(happyBody.recordPath, "utf8").catch(() => "")
ok("the record lives under <cwd>/.workflow-studio/assist", String(happyBody.recordPath).includes(join(".workflow-studio", "assist")))
ok("the record keeps the prompt", recordText.includes("体检整条工作流"))
ok("the record keeps the raw reply", recordText.includes("私密草稿") === false && recordText.includes(ENVELOPE.summary))
const recordJson = recordText === "" ? {} : JSON.parse(recordText)
eq("the record keeps the parsed envelope", recordJson.response?.envelope?.patches?.length, 2)

// 6d. recordAssist can be switched off, and never writes without a named root.
const routesNoRecord = mount({ appRoot: WORKSPACE, recordAssist: false, assistProvider: "cfg-p", assistModel: "cfg-m" }, { llm: fakeLlm([{ type: "text-delta", index: 0, text: JSON.stringify(ENVELOPE) }, { type: "finish", reason: { kind: "stop" } }]) })
const noRecord = json(await assistPost(routesNoRecord[1].handler, ASSIST_BODY()))
eq("recordAssist:false keeps no prompt record", noRecord.recordPath, null)
eq("but the call still succeeds", noRecord.ok, true)

// 6e. an unrecoverable reply must not look like "nothing to fix".
const llmGarbage = fakeLlm([{ type: "text-delta", index: 0, text: "抱歉，我这次无法完成。" }, { type: "finish", reason: { kind: "stop" } }])
const routesGarbage = mount({ appRoot: WORKSPACE, assistProvider: "cfg-p", assistModel: "cfg-m" }, { llm: llmGarbage })
const garbage = json(await assistPost(routesGarbage[1].handler, ASSIST_BODY()))
eq("unparseable reply is still a 200 (the user can read the text)", garbage.ok, true)
ok("unparseable reply carries a parseError", typeof garbage.parseError === "string" && garbage.parseError.length > 0)
eq("unparseable reply returns no findings", garbage.findings.length, 0)

// 6f. 推理吃光输出预算：deepseek-flash 在 reasoningEffort=high 下的真实失败形态是
// `outputTokens === maxTokens` 且 text 为空（2026-10-06 实测：4748 in / 4096 out / 0 字符正文）。
// 这种「空回复」必须报出真实原因，否则用户会去查网络和 provider，而不是调小 effort 或调大预算。
const llmThinkingOnly = fakeLlm([
  { type: "reasoning-delta", index: 1, text: "先看节点……" },
  { type: "reasoning-delta", index: 1, text: "再看边……" },
  { type: "usage", usage: { inputTokens: 4748, outputTokens: 4096, totalTokens: 8844 } },
  { type: "finish", reason: { kind: "stop" } }
])
const routesThinking = mount(
  { appRoot: WORKSPACE, assistMaxTokens: 4096, assistProvider: "cfg-p", assistModel: "cfg-m" },
  { llm: llmThinkingOnly }
)
const thinking = json(await assistPost(routesThinking[1].handler, ASSIST_BODY()))
eq("a thinking-only reply is still a 200 (the panel can show the reason)", thinking.ok, true)
eq("the visible text really is empty", thinking.text, "")
ok(
  "the empty reply names the reasoning budget, not a vague failure",
  /推理/.test(thinking.parseError) && /assistMaxTokens/.test(thinking.parseError),
  thinking.parseError
)
ok("it reports how much thinking was produced", thinking.parseError.includes("11"), thinking.parseError)
const thinkingRecord = JSON.parse(await readFile(thinking.recordPath, "utf8"))
eq("the record keeps the reasoning length for diagnosis", thinkingRecord.reasoningChars, 11)
eq("unparseable reply returns no patches", garbage.patches.length, 0)
ok("unparseable reply keeps the raw text", garbage.text.includes("无法完成"))

// 6f. failures keep the partial answer and use a routable code.
const llmError = fakeLlm([
  { type: "text-delta", index: 0, text: "我先看了一部分：" },
  { type: "finish", reason: { kind: "error", failure: { code: "RATE_LIMIT", message: "太频繁，稍后再试" } } }
])
const routesError = mount({ appRoot: WORKSPACE, assistProvider: "cfg-p", assistModel: "cfg-m" }, { llm: llmError })
const errored = await assistPost(routesError[1].handler, ASSIST_BODY())
eq("a model error is a 502", errored.status, 502)
eq("the failure code is routable", json(errored).code, "RATE_LIMIT")
ok("the failure response still carries the partial text", json(errored).text.includes("我先看了一部分"))
ok("a failed call is still recorded for prompt iteration", json(errored).recordPath !== null)

const llmAborted = fakeLlm([
  { type: "text-delta", index: 0, text: "部分" },
  { type: "finish", reason: { kind: "aborted", failure: { code: "ABORTED", message: "用户取消" } } }
])
const routesAborted = mount({ appRoot: WORKSPACE, assistProvider: "cfg-p", assistModel: "cfg-m" }, { llm: llmAborted })
const aborted = await assistPost(routesAborted[1].handler, ASSIST_BODY())
eq("an aborted call is a 504", aborted.status, 504)

// 6g. request validation happens before any model I/O.
const llmGuard = fakeLlm([])
const routesGuard = mount({ appRoot: WORKSPACE, assistProvider: "cfg-p", assistModel: "cfg-m" }, { llm: llmGuard })
const emptyFlow = await assistPost(routesGuard[1].handler, ASSIST_BODY({ nodes: [], edges: [], order: [] }))
eq("an empty workflow is a 400", emptyFlow.status, 400)
eq("no model I/O for a rejected empty workflow", llmGuard.calls.length, 0)
const customNoInstruction = await assistPost(routesGuard[1].handler, ASSIST_BODY({ task: "custom" }))
eq("custom without instruction is a 400", customNoInstruction.status, 400)
eq("no model I/O for a rejected custom request", llmGuard.calls.length, 0)
const unknownTask = json(await assistPost(routesGuard[1].handler, ASSIST_BODY({ task: "hack" })))
eq("an unknown task degrades to review instead of erroring", unknownTask.task, "review")
eq("the degraded request does reach the model", llmGuard.calls.length, 1)
const tooBig = await assistPost(
  routesGuard[1].handler,
  ASSIST_BODY({ nodes: [{ id: "n1", step: 1, type: "llm", title: "大", instruction: "x".repeat(420000) }] })
)
eq("an oversized projection is a 413", tooBig.status, 413)
eq("no extra model I/O for an oversized request", llmGuard.calls.length, 1)

const assistLog = await readFile(join(SANDBOX, ".workflow-studio", "events.log"), "utf8").catch(() => "")
ok("every assistant call lands in the event log", assistLog.includes("ai:assist"))
ok("the log records patch counts, not the prompt", assistLog.includes('"patches":2'))

/* -- 7. the model tool ---------------------------------------------------- */

console.log("\n7. the model tool (workflow_studio)")

/** Registry stand-in: records the definition so the test can invoke it. */
function fakeTools() {
  const registered = []
  return { registered, register: (definition) => registered.push(definition) }
}

/** Strict `eq` cannot compare structures; compare their JSON instead. */
function okJson(label, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  ok(label, a === b, `expected ${b}, got ${a}`)
}

const TOOL_DOC = {
  $schema: "workflow-studio/v1",
  format: "workflow-file",
  schemaVersion: "1.0",
  generator: "工作流编排台 (Workflow Studio)",
  workflow: {
    id: "wf1",
    name: "示例流程",
    goal: "把选题变成发布包",
    delivery: "",
    constraints: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    stats: { nodeCount: 3, edgeCount: 2, humanCheckpoints: 1, completenessScore: 90 },
    order: [
      { step: 1, id: "n1", title: "接收任务", type: "start" },
      { step: 2, id: "n2", title: "生成方案", type: "llm" },
      { step: 3, id: "n3", title: "人工确认", type: "human" }
    ],
    nodes: [
      {
        id: "n1",
        step: 1,
        type: "start",
        typeLabel: "开始",
        title: "接收任务",
        owner: "运营",
        model: "",
        instruction: "接住需求",
        inputs: ["任务目标"],
        outputs: ["任务单"],
        acceptance: "",
        forbidden: [],
        timeoutSec: 0,
        retry: 0,
        humanCheckpoint: false,
        confirmed: false,
        notes: "",
        dependsOn: [],
        next: ["n2"]
      },
      {
        id: "n2",
        step: 2,
        type: "llm",
        typeLabel: "模型",
        title: "生成方案",
        owner: "",
        model: "deepseek-flash",
        instruction: "写方案",
        inputs: ["任务单"],
        outputs: ["方案"],
        acceptance: "有一份方案",
        forbidden: ["编造数据"],
        timeoutSec: 300,
        retry: 1,
        humanCheckpoint: false,
        confirmed: false,
        notes: "",
        dependsOn: ["n1"],
        next: ["n3"]
      },
      {
        id: "n3",
        step: 3,
        type: "human",
        typeLabel: "人工",
        title: "人工确认",
        owner: "负责人",
        model: "",
        instruction: "看方案",
        inputs: ["方案"],
        outputs: [],
        acceptance: "签字",
        forbidden: [],
        timeoutSec: 0,
        retry: 0,
        humanCheckpoint: true,
        confirmed: false,
        notes: "",
        dependsOn: ["n2"],
        next: []
      }
    ],
    edges: [
      { id: "e1", from: "n1", to: "n2", label: "" },
      { id: "e2", from: "n2", to: "n3", label: "通过" }
    ],
    contracts: [],
    validation: { passed: false, errors: ["缺交付物"], warnings: [] }
  }
}

const TOOL_REPLY = JSON.stringify({
  summary: "把交付物与验收补上",
  findings: [{ severity: "warn", target: "n2", title: "缺可判定的产物", detail: "outputs 没有形态与去处" }],
  patches: [
    { op: "set", target: "wf", field: "delivery", value: "发布包（正文 + 配图说明）", why: "流程要有终点交付物" },
    { op: "set", target: "n2", field: "role", value: "内容 agent", why: "写清谁来做" },
    { op: "set", target: "n2", field: "humanCheck", value: "true", why: "方案要人确认一次" },
    { op: "set", target: "n2", field: "timeoutSec", value: "600", why: "长文生成需要更久" },
    { op: "set", target: "n2", field: "inputs", value: "任务单\n选题方向", why: "输入不完整" },
    { op: "set", target: "n9", field: "title", value: "x", why: "不存在的节点" },
    { op: "set", target: "n2", field: "id", value: "n7", why: "id 不在白名单" },
    { op: "set", target: "n2", field: "title", value: "生成方案", why: "值没有变化" },
    { op: "add-node", after: "n2", node: { type: "human", title: "复核", instruction: "核对数据来源" }, why: "缺人工复核" },
    { op: "add-node", after: "n2", node: { type: "quantum", title: "量子步骤" }, why: "类型不存在" },
    { op: "link", from: "n1", to: "n3", why: "失败时直接找人" },
    { op: "link", from: "n1", to: "n2", why: "已经连过" },
    { op: "unlink", from: "n1", to: "n3", why: "还没有这条线" },
    { op: "remove-node", target: "n3", why: "并入 n2" },
    { op: "explode", target: "wf", why: "未知 op" }
  ]
})

const toolLlms = []
const toolWs = join(SANDBOX, "tool-ws")
const toolOut = join(toolWs, "workflows")
const toolFile = "示例.workflow.json"
await mkdir(toolOut, { recursive: true })
await writeFile(join(toolOut, toolFile), JSON.stringify(TOOL_DOC, null, 2), "utf8")
await writeFile(join(toolOut, "示例-交接包.md"), "# 交接包\n\n给人读的。\n", "utf8")

/** Mount a full instance (routes + tool) and return the registered definition. */
function mountTool(services) {
  const registry = fakeTools()
  mount({ appRoot: toolWs }, { tools: registry, ...services })
  return registry.registered[0]
}

const toolLlmA = fakeLlm([
  { type: "text-delta", index: 0, text: TOOL_REPLY },
  { type: "usage", usage: { inputTokens: 11, outputTokens: 22 } },
  { type: "finish", reason: { kind: "stop" } }
])
toolLlms.push(toolLlmA)
const toolA = mountTool({
  llm: toolLlmA,
  agentDefaultModel: { currentSelection: () => ({ provider: "agent-p", model: "agent-m", reasoningEffort: "high" }) }
})
await settle()

// 7a. the registered definition
ok("a tool is registered when the service exists", toolA !== undefined)
eq("tool name", toolA?.name, "workflow_studio")
ok("description says what it reads", String(toolA?.description).includes("workflows"))
eq("parameters are an object schema", toolA?.parameters?.type, "object")
okJson("action is an enum", toolA?.parameters?.properties?.action?.enum, ["list", "read", "assist"])
okJson("action is required", toolA?.parameters?.required, ["action"])
ok("every parameter carries a description", Object.values(toolA?.parameters?.properties ?? {}).every((spec) => typeof spec.description === "string"))
ok("output.render is a function", typeof toolA?.output?.render === "function")
ok("output.schema declares no nullables", Object.values(toolA?.output?.schema?.properties ?? {}).every((spec) => typeof spec.type === "string" || Object.keys(spec).length === 0))
ok("execute is a function", typeof toolA?.execute === "function")
const presented = toolA?.presentCall?.({ action: "assist", file: toolFile })
eq("presentCall card", presented?.card, "generic")
eq("presentCall kind", presented?.kind, "other")
okJson("presentCall passes the raw input through", presented?.rawInput, { action: "assist", file: toolFile })
ok("a presentation never throws on an empty call", typeof toolA?.presentCall?.({})?.title === "string")

// 7b. it must not be fatal when the registry is absent
const noToolsRoutes = mount({ appRoot: toolWs }, { llm: toolLlmA })
eq("no tools service still registers the two routes", noToolsRoutes.length, 2)
const throwingRegistry = {
  register() {
    throw new Error("registry says no")
  }
}
const throwingRoutes = mount({ appRoot: toolWs }, { tools: throwingRegistry })
eq("a refusing registry still registers the two routes", throwingRoutes.length, 2)

// 7b-late. Loader order — the shape v0.3.0 could not survive, and the reason
// this suite now models service *arrival* and not just service *presence*.
// `tools` is published strictly after `apply` has returned, which is what real
// DSH does (webServer first, tools later). Under the old code the registry here
// stayed empty for the life of the process, silently.
const lateRegistry = fakeTools()
const late = mountHost({ appRoot: toolWs }, {})
eq("routes register before `tools` exists", late.routes.length, 2)
eq("…and the tool waits rather than being skipped", lateRegistry.registered.length, 0)

late.host.provide("tools", lateRegistry)
await settle()
eq("a `tools` published after apply still gets the tool", lateRegistry.registered.length, 1)
eq("…and it is the studio tool", lateRegistry.registered[0]?.name, "workflow_studio")
ok("…with its renderer intact", typeof lateRegistry.registered[0]?.output?.render === "function")

await settle()
const toolLog = await readFile(join(toolWs, ".workflow-studio", "events.log"), "utf8").catch(() => "")
ok("a refused registration is reported", toolLog.includes("host:tool-failed"))
ok("a successful registration is reported", toolLog.includes("host:tool-registered"))
const pkgVersion = JSON.parse(await readFile(join(HERE, "package.json"), "utf8")).version
ok(
  "…stamped with the version the running process loaded",
  toolLog.includes("host:tool-registered") && toolLog.includes(`"version":"${pkgVersion}"`)
)
// The boot line used to carry a `tools` boolean sampled before the service
// existed. It was 'false' on every real host and said nothing; the outcome is
// now its own event, written by the fiber that actually attempts the register.
ok("the boot line no longer guesses at the tool", !toolLog.includes('"tools":'))
ok("a host that simply has no registry is never called unavailable", !toolLog.includes("host:tool-unavailable"))

const exec = { agent: { session: { header: { cwd: toolWs } } } }

// 7c. list / read come straight off the workspace api
const toolListed = await toolA.execute({ action: "list" }, exec)
eq("list succeeds", toolListed.ok, true)
eq("list sees both files", toolListed.files?.length, 2)
ok("list names the directory", String(toolListed.dir).endsWith("workflows"))
okJson("list marks the kinds", toolListed.files?.map((file) => file.kind), ["handoff", "workflow"])
eq("list defaults cwd to the calling session", toolListed.cwd, resolve(toolWs))

const toolRead = await toolA.execute({ action: "read", file: toolFile }, exec)
eq("read succeeds", toolRead.ok, true)
okJson("read returns the file verbatim", JSON.parse(toolRead.content), TOOL_DOC)
eq("read reports the byte size", toolRead.bytes, (await stat(join(toolOut, toolFile))).size)

const traversed = await toolA.execute({ action: "read", file: "../../package.json" }, exec)
eq("a traversal attempt fails", traversed.ok, false)
ok("the refusal explains the file rule", String(traversed.error).includes("file 必须是"))
ok("nothing outside the folder leaks", !String(traversed.error).includes("dsh-workflow-studio"))
const notThere = await toolA.execute({ action: "read", file: "没有这个.workflow.json" }, exec)
ok("a missing file lists nothing but says to run list", String(notThere.error).includes("action:\"list\""))
const unknownAction = await toolA.execute({ action: "summon" }, exec)
ok("an unknown action is refused", String(unknownAction.error).includes("action 只能是"))

// 7d. assist: the model call, the projection, and patch validation
const assisted = await toolA.execute({ action: "assist", file: toolFile, task: "review" }, exec)
eq("assist succeeds", assisted.ok, true)
eq("assist names the file", assisted.file, toolFile)
eq("assist reports the resolved route", assisted.model?.provider, "agent-p")
eq("assist carries the agent's effort", assisted.model?.reasoningEffort, "high")
eq("eight patches survive validation", assisted.applyable, 8)
eq("seven are refused", assisted.skipped, 7)
eq("every patch is reported, ok or not", assisted.patches?.length, 15)
okJson("findings come back as sent", assisted.findings?.[0]?.severity, "warn")
eq("the summary survives", assisted.summary, "把交付物与验收补上")

const patchAt = (index) => assisted.patches[index]
const accepted = assisted.patches.filter((patch) => patch.ok === true)
const okAt = (index) => accepted[index]
okJson("wf set keeps the exported field name", [patchAt(0).op, patchAt(0).field, patchAt(0).before, patchAt(0).after], ["set", "delivery", "", "发布包（正文 + 配图说明）"])
okJson("a prompt-vocabulary field is translated", [patchAt(1).field, patchAt(1).modelField, patchAt(1).after], ["owner", "role", "内容 agent"])
okJson("humanCheck maps to humanCheckpoint as a boolean", [patchAt(2).field, patchAt(2).modelField, patchAt(2).before, patchAt(2).after], ["humanCheckpoint", "humanCheck", false, true])
okJson("timeoutSec is a number", [patchAt(3).before, patchAt(3).after], [300, 600])
okJson("a list field shows the live-DB text form", [patchAt(4).before, patchAt(4).after], ["任务单", "任务单\n选题方向"])
ok("a list field says it is stored as an array", String(patchAt(4).write).includes("数组"))
okJson("add-node is placed after its anchor", [okAt(5).op, okAt(5).after, okAt(5).index, okAt(5).node.type], ["add-node", "n2", 2, "human"])
eq("add-node has no id of its own", okAt(5).node.id, undefined)
okJson("link is reported as a pair", [okAt(6).op, okAt(6).from, okAt(6).to], ["link", "n1", "n3"])
okJson("remove-node counts what it detaches", [okAt(7).op, okAt(7).target, okAt(7).removesEdges], ["remove-node", "n3", 1])

const reasons = assisted.patches.filter((patch) => patch.ok !== true).map((patch) => patch.reason)
eq("seven reasons are given", reasons.length, 7)
ok("an unknown node is refused by name", reasons.some((reason) => reason.includes("n9")))
ok("a non-whitelisted field is refused", reasons.some((reason) => reason.includes("id") && reason.includes("白名单")))
ok("a no-op patch is refused", reasons.some((reason) => reason.includes("没有变化")))
ok("an unknown node type is refused", reasons.some((reason) => reason.includes("quantum")))
ok("a duplicate link is refused", reasons.some((reason) => reason.includes("已经连过")))
ok("a missing edge is refused", reasons.some((reason) => reason.includes("没有连线")))
ok("an unknown op is refused", reasons.some((reason) => reason.includes("不支持的 op")))
ok("no declared key is ever null", Object.keys(assisted).every((key) => assisted[key] !== null))

// 7e. the projection the model actually saw
const sentOptions = toolLlmA.calls[0]
eq("the model call uses the agent default", `${sentOptions.provider}/${sentOptions.model}`, "agent-p/agent-m")
eq("the effort is carried over", sentOptions.reasoningEffort, "high")
const sentPayload = JSON.parse(sentOptions.messages[0].content[0].text)
okJson("the projection speaks the prompt vocabulary", [sentPayload.nodes[0].role, sentPayload.nodes[1].humanCheck], ["运营", false])
ok("no exported-only field is forwarded", Object.hasOwn(sentPayload.nodes[1], "owner") === false)
ok("no checkpoint field is forwarded", Object.hasOwn(sentPayload.nodes[1], "humanCheckpoint") === false)
ok("derived fields are not forwarded", Object.hasOwn(sentPayload.workflow, "stats") === false && Object.hasOwn(sentPayload.nodes[0], "confirmed") === false)
okJson("order is plain node ids", sentPayload.order, ["n1", "n2", "n3"])
okJson("an array input becomes text", sentPayload.nodes[0].inputs, "任务目标")
okJson("edges keep their label", [sentPayload.edges[1].from, sentPayload.edges[1].to, sentPayload.edges[1].label], ["n2", "n3", "通过"])
eq("review says so in the system prompt", sentOptions.system.includes("体检整条工作流"), true)

// 7f. focus and task validation
const focused = await toolA.execute({ action: "assist", file: toolFile, task: "optimize", focus: ["n2"] }, exec)
eq("optimize with a focus reaches the model", focused.ok, true)
const focusPayload = JSON.parse(toolLlmA.calls[1].messages[0].content[0].text)
okJson("focus is forwarded", focusPayload.focus, ["n2"])
eq("the second call is the second recorded call", toolLlmA.calls.length, 2)
const noFocus = await toolA.execute({ action: "assist", file: toolFile, task: "optimize" }, exec)
ok("optimize without a focus is refused", String(noFocus.error).includes("optimize 需要 focus"))
const badFocus = await toolA.execute({ action: "assist", file: toolFile, focus: ["n9"] }, exec)
ok("an unknown focus id is refused by name", String(badFocus.error).includes("n9"))
eq("no model call was made by the refusals", toolLlmA.calls.length, 2)
const mdAssist = await toolA.execute({ action: "assist", file: "示例-交接包.md" }, exec)
ok("assist refuses the markdown handoff", String(mdAssist.error).includes("Markdown"))

// 7g. records and diagnostics
ok("the call is recorded next to the workspace", String(assisted.recordPath).includes(join(toolWs, ".workflow-studio", "assist")))
const toolRecord = JSON.parse(await readFile(assisted.recordPath, "utf8"))
eq("the record says it came from the tool", toolRecord.source, "tool")
eq("the record keeps the file it read", toolRecord.file, toolFile)
eq("the record keeps the prompt", typeof toolRecord.request.system, "string")
const toolEvents = await readFile(join(toolWs, ".workflow-studio", "events.log"), "utf8").catch(() => "")
ok("the event log marks the tool as the source", toolEvents.includes('"source":"tool"'))
ok("the event log records how many patches applied", toolEvents.includes('"applyable":8'))

// 7h. the rendered text is what the model reads
const rendered = toolA.output.render({ action: "assist" }, assisted)
ok("the render returns one text block", rendered.length === 1 && rendered[0].type === "text")
ok("the render counts the patches", rendered[0].text.includes("补丁 8/15 条可用"))
ok("the render repeats every skipped reason", rendered[0].text.includes("已跳过"))
ok("the render shows the diff", rendered[0].text.includes("现在：任务单") && rendered[0].text.includes("改为：任务单"))
ok("the render tells the caller not to hand-write derived fields", rendered[0].text.includes("派生字段"))
const renderedList = toolA.output.render({ action: "list" }, toolListed)
ok("the list render names the files", renderedList[0].text.includes(toolFile))
const renderedRead = toolA.output.render({ action: "read" }, toolRead)
ok("the read render carries the content", renderedRead[0].text.includes("workflow-studio/v1"))
const renderedError = toolA.output.render({ action: "read" }, notThere)
ok("an error renders as an error, not a crash", renderedError[0].text.startsWith("❌"))

// 7i. no adapter is a refusal, never a broken plugin
const toolB = mountTool({})
await settle()
const toolNoAdapter = await toolB.execute({ action: "assist", file: toolFile }, exec)
eq("assist without an llm service fails", toolNoAdapter.ok, false)
eq("the failure is routable", toolNoAdapter.code, "NO_ADAPTER")
const stillLists = await toolB.execute({ action: "list" }, exec)
eq("list still works without an llm service", stillLists.ok, true)

/* -- 8. report ----------------------------------------------------------- */

await rm(SANDBOX, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const label of failures) console.log(`  - ${label}`)
  process.exitCode = 1
}
