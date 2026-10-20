# dsh-workflow-studio

把工作区里的单文件工作台 `workflow-studio/index.html` 作为 DSH 的一个中列面板跑起来，并把它导出的工作流文件直接写进工作区，供其他 agent 读取。

## 它做了什么

**宿主半区**（`lib/index.js`，注入 `webServer`）注册两条前缀路由：

- `GET /workflow-studio/app[?cwd=<工作区>]` —— 原样吐出 `<工作区>/workflow-studio/index.html` 及同目录兄弟资源，不做任何改写。
- `GET|POST /workflow-studio/api` —— `op=ping|list|read|save|delete|log|assist`。
- 模型工具 `workflow_studio`（`list` / `read` / `assist`）—— 同一套能力给会话里的 agent 用，不需要浏览器，见下节。

**浏览器半区**（`lib/client.js`）在中列 `main` 槽位注册面板（key = `workflow-studio`），并在侧栏 `sidebar.panellist`（order 24）放入口图标。面板用同源 `iframe` 承载工作台，上方工具栏提供：

| 按钮 | 作用 |
| --- | --- |
| 保存当前工作流 | 用工作台自己的 `buildWorkflowFile` / `buildHandoff` 生成 `<名字>.workflow.json` 与 `<名字>-交接包.md`，写进 `<工作区>/workflows/` |
| 保存全部工作流 | 同上，但覆盖工作台里的每一份工作流 |
| 载入 / 删除 | 从 `<工作区>/workflows/` 读回（喂给工作台的 `doImport`）或删除 |
| AI 助手 | 在右侧展开助手抽屉（见下节） |
| 重载 / 新标签打开 / 关闭 | 刷新 iframe、在独立标签打开工作台、关闭面板 |

面板下方列出 `<工作区>/workflows/` 的文件，按 `workflow`（`.json`）/ `handoff`（`.md`）分类。

## 编排助手

工作台自身零联网，所以模型调用由宿主半区发起：`POST /workflow-studio/api {op:"assist"}` 经 `ctx.llm.stream` 流式调用，客户端把结果渲染成「可勾选的补丁」再落回工作台。

三种任务：**体检整条**（`task:"review"`）、**优化选中节点**（`optimize`，需先在抽屉里选焦点）、**按指令修改**（`custom`，需填指令）。模型被要求只输出一个 JSON 信封 `{summary,findings[],patches[]}`（`lib/index.js` 的 `ASSIST_SYSTEM_PROMPT`）。

模型来源按 `config > agent 默认 > 第一个已注册 provider` 解析（`lib/index.js` 的 `resolveAssistRoute`），`reasoningEffort` 从 agent 默认继承。插件 config 可覆盖 `assistProvider` / `assistModel` / `assistReasoningEffort` / `assistMaxTokens` / `assistTimeoutMs` / `recordAssist`。`op=ping` 会回带解析结果，所以点之前就能在抽屉里看到将要调用的模型；没有适配器时点下去得到的是 503 `NO_ADAPTER` 与一句人话原因。

`assistMaxTokens` 默认 **16384**（原 4096 已废）：输出预算是**推理与正文共享**的，deepseek-flash 在 `reasoningEffort: high` 下实测把 4096 全用在思考上，正文 0 字符。

**边界（改代码前先读）**：

1. **白名单在客户端，不在宿主**（`lib/client.js` 的 `validatePatch`）。宿主看不见活 DB，只把 patches 粗筛成对象；真正会写数据的一侧才做逐字段校验。
2. **只写白名单字段**：工作流 `name/goal/delivery/constraints`，节点 `title/type/role/model/instruction/inputs/outputs/acceptance/forbidden/notes`，外加 `humanCheck`（转布尔）与 `timeoutSec`/`retry`（转非负整数）。`id`/`x`/`y`/`checked` 一律不可写——模型既不该改身份，也不该改排版与勾选态。
3. **补丁只有 5 种 op**：`set` / `add-node` / `remove-node` / `link` / `unlink`。`add-node` 的类型必须写在 `patch.node` 里（写在 patch 顶层会被忽略并静默降级成 `llm`），`after` 为 `null` 表示接在拓扑序末尾。未知类型降级为 `llm` 并在抽屉里注明。
4. **落盘顺序照抄工作台自己的惯用法**：`touchWf → saveData(true) → commit("AI 助手：应用 N 处修改") → refreshAll()`。`commit` 的快照是**改动之后**的状态，所以整批补丁只占**一步** Ctrl+Z。
5. **投影用活 DB 的字段名**（`role` / `humanCheck`），不是导出文件的 `owner` / `humanCheckpoint`；且投影里**不带** `x`/`y`/`checked`。
6. **往返可复现**：每次调用写一份 `<工作区>/.workflow-studio/assist/<ISO>.json`（含系统提示词、投影、原始回复、解析结果），并往 `events.log` 追加 `ai:assist`（只记条数，不记提示词）。提示词要迭代就得有原始记录；`recordAssist:false` 可关闭。
7. **失败也要能看到**：`aborted` 走 504、其余走 502，但两者都回带 partial `text`、`provider`/`model`、`elapsedMs` 与 `recordPath`——等了一分钟之后最不能接受的就是「什么都没有」。
8. **空回复必须说出原因**：`emptyReplyReason`（`lib/index.js`）在 `outputTokens >= maxTokens` 时直接指出推理吃光了输出预算、并给出当前 `assistMaxTokens` 与 `reasoningEffort`；只有「有思考内容但正文为空」才提示调大预算。`reasoningChars`（只计长度、不落思考原文）会随 assist 记录一起写盘，便于事后判断。把「模型没有返回任何文本」当成唯一解释，会让人去查网络和 provider 而不是调预算。

## 模型工具 `workflow_studio`

同一套「投影 → 模型 → 补丁」能力还以模型工具的形式暴露给任意会话里的 agent（宿主半区 `registerStudioTool`）：工作台的产物就是文件格式，而文件格式的消费者是 agent。它解决的是**没有浏览器也能用**。

| action | 做什么 |
| --- | --- |
| `list` | 列出 `<cwd>/workflows/` 下的工作流文件（`cwd` 默认取调用方会话自己的目录） |
| `read` | 读回某个文件的完整内容 |
| `assist` | 把一份 `.workflow.json` 投影给模型（`task` = `review`/`optimize`/`custom`，`focus` 指节点）并返回 findings 与**逐条校验过**的 patches |

**它从不写文件**（刻意如此，不是没做完）：导出文件里的 `order`/`stats`/`validation`/`completenessScore` 是工作台自己的导出器与校验器算出的派生物，在宿主侧重算就是给「拓扑序 + 规则集」再写第二份可能悄悄漂移的实现；语义正确的写入侧只有浏览器半区的 `applyEdits`。要落盘就由调用方写（它有自己的文件工具），或者在画布上的 AI 抽屉里应用同一批补丁。

其余边界：

1. **它只看文件面**：`<cwd>/workflows/*.json`。画布上还没保存的改动、每个浏览器各自的 localStorage 都看不到。文件面与画布面互补，不是替代。
2. **字段名跟着文件走**：返回的 patch 用导出名（`owner`/`humanCheckpoint`），因为调用方要改的就是那份 JSON；投影进模型时翻译成活 DB 名（`role`/`humanCheck`），与抽屉共用**同一份** `ASSIST_SYSTEM_PROMPT`。模型若写作 `role`，返回里会额外标 `modelField`。
3. **拒绝而不是改写**：抽屉把未知节点类型降级成 `llm`（用户正在编辑，丢掉补丁更糟），工具则直接拒（调用方正要写文件，被悄悄改掉的 `type` 会被当成模型自己的决定）。`id`/`step`/`checked`/派生字段都不可写；`focus` 里出现不存在的节点会被点名拒绝。
4. **`tools` 是等待，不是采样**：`tools` 不在 `inject` 里（否则没有工具注册表的宿主连两条 HTTP 路由会一起失去），但也不是在 `apply` 里 `ctx.get("tools")` 一读了事。真实宿主先提供 `webServer`、后提供 `tools`；`ctx.get` 在服务发布之前一律回答 `undefined`，而 cordis 只会唤醒**在自己 `inject` 里声明过**该服务的 fiber——本插件没声明，于是那一读永远是 `undefined`，注册永远不会被重试。所以模型工具注册在 `ctx.inject(["tools"], …)` 拉起的子 fiber 上：宿主没有注册表就永不触发、两条路由照常；有注册表就等它出现再注册。注册包了 try/catch，注册表拒绝这个定义不会把两条路由一起带走。三种结局各写一条自己的事件（见下）。
5. **调用同样留痕**：`.workflow-studio/assist/<ISO>.json`（多 `source:"tool"` 与 `file`）以及 `events.log` 的 `ai:assist`（多 `applyable` 计数）。

## 为什么不是重写

工作台是零依赖单文件（3458 行），已通过 176 个函数的静态审计与运行时自检。插件只做搬运与桥接，不改写工作台——所以工作台自己的「导出 / 交接」按钮（下载到浏览器下载目录）与本插件的「保存当前工作流」（写进工作区）产出的文件**逐字节相同**，因为背后是同一对构造函数。

## 安装与刷新（三条都是踩过的坑）

在 profile 里：

```
dsh plugin install file:<本目录>
```

等价于把本目录加进 profile 的 `dependencies` 与 `dsh.profile.bundles`。

1. **安装是拷贝，不是链接**：安装按 `package.json` 的 `files` 字段把文件**拷进** `<profile>/node_modules/dsh-workflow-studio`，因此**改源码不会影响运行中的插件**。改了 `lib/*.js` 却看到旧行为，先比字节数再怀疑代码——曾经的现场：装进去的 `lib/index.js` 只有 16506 字节，源码 63169；于是 0.2.0 的编排助手从头到尾没有真正上线过。
2. **刷新副本要先删目录**：直接再跑一次 `install_bundle` 只会得到 `ambiguous-install` 且 pnpm 报 `added 0`（它认为已是最新）。可靠做法是删掉 `<profile>/node_modules/dsh-workflow-studio` 再 `install_bundle file:<本目录>`；删之前务必备份，因为 `remove_bundle` 在当前 pnpm（11.7 + `minimumReleaseAge` 策略）上会撞 `ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED`，别指望它。
3. **改完要重启 DSH**：本插件注册的 `webServer` 前缀路由在插件被 disable 后不会被回收，同进程内再启用会直接撞 `webserver: duplicate prefix route "/workflow-studio/app"`，所以「关掉再打开插件」不是刷新手段。

版本号写死在两处（`package.json` 与 `lib/index.js` 的 `VERSION`）：引导日志靠它判断活进程载入的到底是哪一版。

`host:registered {version,pid}` 只证明宿主半区起来了，**不再臆测工具**。工具结局是它自己的事件：

| 事件 | 含义 |
| --- | --- |
| `host:tool-registered {version,pid,name}` | 工具进了注册表，模型能用 |
| `host:tool-unavailable {version,pid,reason}` | 服务被唤醒却没有可用的 `register()`（正常宿主不应出现，出现即说明服务形状变了） |
| `host:tool-failed {version,pid,error}` | 注册表在注册时抛错 |

一个 `tools` 始终没出现的宿主**不会写任何工具事件**——这本身就是答案。

0.3.0 曾把 `tools:<boolean>` 塞进 `host:registered`。那是假诊断：它在 `tools` 存在之前就采了样，于是在**每一个**真实宿主上都写 `false`，而真相并不是「服务缺失」，是「注册从来没被尝试过」。看到 `tools:false` 且**没有** `host:tool-failed`，就是那个缺陷的指纹。

## 资源根 ≠ 数据根（0.3.3）

`/workflow-studio/app?...` 提供的是**工作台 HTML 本身**，而 `?cwd` 指的是**这份面板要读写哪个工作区的 `workflows/`**。两者是两件事：

- **数据根**：只有 `?cwd` 决定。`workflows/` 的 list / read / save / delete 全部落在它下面。
- **资源根**：由 `pickAppDir`（`lib/index.js`）按 **请求 cwd → `appRoot` → 进程 cwd** 顺序取**第一个真的含 `index.html` 的目录**。没有一个候选命中才 404，且 404 页会把试过的目录逐条列出。

0.3.2 及以前是把资源根直接绑在 `?cwd` 上（`join(root, "workflow-studio")`），后果是：注册了多个工作区时，只有**恰好自带 `workflow-studio/` 目录的那一个**能打开面板，其它工作区一律 404，而客户端只能报一句「宿主可能禁止了同源 iframe，或文件不存在」——把人指向了错误的方向。工作台 HTML 是一份**共享的单文件文档**，不是工作区产物，所以资源根必须能回退。

客户端同时修了两处：`current`（当前会话的工作区）迟到时回退到**第一个已注册工作区**，而不是永远停在 `appUrl === null` 只显示「没有可用工作区」（那种状态下**一条日志都不会写**）；探针拿到 404 时显示专门的文案（`assetMissing`），不再与 iframe 沙箱问题混为一谈。

## 两条不变式（改代码前先读）

1. **不用 `new URL().pathname`**（`lib/index.js:138-155`）。它会先把 `..` 折掉，前缀切片随之失效：`/workflow-studio/app/../../x` 会变成 `/x`，穿越尝试反而拿到 200 的工作台页面。
2. **`path.basename` 不当消毒剂**（`lib/index.js:402-419`）。把 `../../x.json` 悄悄改写成 `x.json`，会让一次穿越尝试变成一次「成功的意外写入」。非法名字一律 400。

## 测试

```
node selftest.mjs        # 宿主半区，242 条断言：第 5 节走真实 socket，第 6 节桩 llm 覆盖助手（6f 覆盖「推理吃光输出预算」的空回复），第 7 节覆盖 workflow_studio 工具
node client-harness.mjs  # 浏览器半区，93 条断言，模拟 __ModuleLoader__ + 最小 reconciler
```

第 2 节覆盖资源根的整条回退链：`?cwd` 带工作台 ⇒ 200、无 `?cwd` ⇒ 走 `appRoot`、`?cwd` 指向没有工作台的工作区 ⇒ 回退到 `appRoot` 的副本、所有候选都没有 ⇒ 404 且列出试过的目录。`selftest.mjs` 第 5 节在 `os.tmpdir()` 下起一个真实的 `http.createServer`，用真实 `fetch` 走一遍 list → save → read → delete，断言落盘字节一致、`../escape.json` 被 400 拒绝且没有文件逃出目录。第 6 节注入假 `llm`/`agentDefaultModel` 服务，覆盖路由三级解析、503 `NO_ADAPTER`、`502/504/413/400` 各错误分支、围栏容错解析、往返记录，并断言被拒的请求不产生任何模型 I/O。第 7 节把工具注册到假注册表上再调用它：15 条补丁里 8 条通过、7 条被点名拒绝（不存在的节点、白名单外字段、无变化、未知类型、重复连线、不存在的边、未知 op），并断言投影里没有 `owner`/`humanCheckpoint`/`stats`/`confirmed`、`inputs` 数组被合成文本、`focus` 不存在时点名报错、没有 `llm` 时是 `NO_ADAPTER` 而 `list` 照常可用。

浏览器半区无法在 Node 里真跑，所以用 `client-harness.mjs` 模拟 `window.__ModuleLoader__` 与只提供 `react` 的 `require`：任何对未知包的依赖都会立刻炸掉。助手那一节用第二个独立实例 + 最小 reconciler（`useState` 的 setter 真的重绘），把 9 条合法补丁与 5 条越界补丁走完「投影 → 校验 → 落回」，并断言工作台的调用序列与 `Ctrl+Z` 语义。

**harness 的一个坑**：`createElement` 桩必须就地展开函数型子节点（`if (typeof type === "function") type(node.props)`），否则 `h(AssistDrawer, …)` 只是一个 children 为空的节点——抽屉在树里根本不存在，断言全红却是测试自己的错。函数组件的钩子按调用顺序落在同一个 fiber 上，与 React 的位置式钩子语义一致。

**harness 的另一个坑（真出过事）**：假宿主必须建模**服务到达的时序**，不能只有一张填满的服务表。`selftest.mjs` 的 `fakeHost` 支持 `inject(names, cb)` 与事后 `provide(name, value)`，第 7 节的 `7b-late` 就是拿它复现真实宿主的装载顺序（`webServer` 先、`tools` 后）。原先的假 ctx 是 `{ get: (service) => services[service] }`——`apply` 运行前服务就已就位，而这是真实 DSH **唯一不会出现**的形态；0.3.0 的 inject 时序缺陷因此在一整套全绿的断言下上线，工具在任何真实进程里都没有注册过。改这个 harness 的时序语义之前先读 `armStudioTool` 的注释。

## 诊断

宿主半区把事件追加到 `<工作区>/.workflow-studio/events.log`（制表符分隔：ISO 时间 / 事件 / JSON）。`app:served` 现在带 `from`（命中的是 `cwd` / `appRoot` / `processCwd` 哪一个候选）与 `appDir`，`app:missing` 带 `tried`（试过的全部目录）——「面板打不开」时先看这两行，不要从 iframe 沙箱猜起。浏览器半区挂载时会 POST `client:app-probe` 与 `client:iframe-load`；这两个事件是「面板真的挂载了」的唯一可靠证据——cordis 的 slot 树只枚举子槽位、不枚举注册者，查不到本插件是否注册成功。

注意 `client:*` 事件只在面板**挂载**时发出，而 `main` 槽位平时被会话占据：所以「刷新了但没点开面板」与「浏览器半区没加载」在日志上是一样的，不能拿「没有事件」当失败证据。
