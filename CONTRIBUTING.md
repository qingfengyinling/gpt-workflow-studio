# 开发与反馈

## 环境

- Node.js 20+
- pnpm（锁文件由 pnpm 11 生成）
- Python 3.9+，仅打包验证需要

```shell
pnpm install --frozen-lockfile --ignore-scripts
node scripts/build.mjs
node --test tests/*.test.mjs
node dist/server.mjs --http --data ./workspace-data
```

## 改动约定

数据规范、校验和补丁规则集中在 `shared/workflow.mjs`，前端与服务端共用。修改时同时检查节点输入输出和交接 Markdown，避免两边漂移。

涉及持久化、版本冲突、补丁应用、权限可见性或协议时，应补充有实际行为断言的测试。改前端后重新构建 `dist/`；改 MCP Apps 资源产生不兼容变更时更新资源 URI。不要把工作流数据、凭证、个人绝对路径或包管理缓存提交到仓库。

## 提交问题

请说明版本、Node 版本、客户端、复现步骤、预期和实际结果。可附最小化工作流；提交前移除个人资料和密钥。

本项目当前没有指定项目代码许可证；第三方依赖遵循 `THIRD_PARTY_NOTICES.md` 中列出的原许可证。
