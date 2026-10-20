# DSH 工作流编排台 · 保留版

这里是 **DSH 版**，与仓库根目录的 **GPT 插件版** 分开保留。DSH 插件版本为 **0.3.3**，从用户提供的《工作流编排台-框架与构想.md》对应源码章节恢复。

## 目录与用途

```text
legacy/dsh/
├── dsh-workflow-studio/    DSH 插件、宿主／浏览器代码及测试
├── workflow-studio/       零依赖单文件工作台 index.html
├── source-manifest.json   原文档与恢复文件的散列校验
└── 验收记录.md            本次恢复与测试结果
```

- 只使用离线编辑器：用浏览器打开 `workflow-studio/index.html`。
- 在 DSH 内使用：安装 `dsh-workflow-studio/`，并让插件找到旁边的 `workflow-studio/` 资源。
- AI 助手调用 DSH 宿主配置的模型服务，不使用本仓库 GPT 版的 MCP 接口。
- 原插件说明位于 [dsh-workflow-studio/README.md](dsh-workflow-studio/README.md)。代码与该说明按源码快照保留；其中旧工作区路径仅表示原开发环境，安装时改为自己的路径。

## 安装要点

先将本目录中的 `workflow-studio/` 放到实际工作区根目录，例如 `<workspace>/workflow-studio/index.html`。然后在 DSH 的 profile 环境安装插件：

```text
dsh plugin install file:<本机 dsh-workflow-studio 目录的绝对路径>
```

插件按“请求 cwd → appRoot → 进程 cwd”查找 `workflow-studio/index.html`。如果实际工作区未放置资源，可将插件配置的 `appRoot` 指向包含 `workflow-studio/` 的目录。本恢复包本身的根目录就是这样的目录。

原 package.json 的发布 files 清单只包含插件文件，不会把同级的 HTML 自动安装进 profile，因此需要按上面的方法提供工作台资源。安装会复制插件；以后修改源码需要按原说明刷新 profile 副本并重启 DSH。

## 测试

在 `dsh-workflow-studio/` 中执行：

```shell
node selftest.mjs
node client-harness.mjs
```

前者通过模拟宿主服务测试 HTTP 与模型工具，后者模拟 DSH 浏览器模块加载环境。它们不能证明某一台实际 DSH 安装的兼容性；本次未在真实 DSH 宿主安装上线。

## 下载与来源

完整恢复包见仓库 `releases/dsh-workflow-studio-v0.3.3.zip`，包含插件与单文件工作台两部分。只恢复通用编排台的8个文件，不上传合订文档中的术数工作流生成器、私人工作区或历史代理笔记。

通过仓库根目录的 `scripts/restore-dsh.mjs` 可从自己的合订文档再生成源码快照；文档未包含在仓库中。再次生成会覆盖恢复文件，应先保留自己的修改。
