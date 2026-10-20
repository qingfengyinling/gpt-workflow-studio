# 数据契约

## 创建草稿

`studio_create({workflow})` 接受以下结构；工作流 ID 由服务端生成。每个 node.id 在图内唯一，edges.from/to 必须引用存在的节点。

```json
{
  "name": "研究与交付",
  "goal": "完成可核查的研究结论",
  "delivery": "报告和来源清单，交项目负责人",
  "constraints": "不编造来源；区分证据与推断",
  "nodes": [
    {
      "id": "intake",
      "type": "start",
      "title": "确定问题",
      "owner": "当前执行者",
      "model": "",
      "instruction": "明确研究范围与目标读者",
      "inputs": ["用户问题"],
      "outputs": ["范围说明"],
      "acceptance": "- [ ] 问题、范围和读者已记录",
      "forbidden": ["不擅自扩大主题"],
      "humanCheckpoint": false,
      "timeoutSec": 0,
      "retry": 0,
      "notes": "缺少关键背景时先完成不依赖缺项的部分"
    }
  ],
  "edges": []
}
```

示例只展示入口结构，真实图还应有任务与交付节点。缺少说明等不完整项可作为草稿保存并由校验警告；重复 ID、失效端点、重复边及循环依赖拒绝保存。分支边的 label 描述条件，不代表本插件具有自动条件调度能力。

## 提交候选补丁

先读取 revision，再调用 `studio_propose`。补丁只是候选设计，不会执行节点。服务端校验整批建议，界面选择子集后重新校验，避免拆分后造成失效依赖。

```json
{
  "id": "服务端返回的工作流ID",
  "revision": 3,
  "summary": "补充任务交付与验收标准",
  "patches": [
    {"op": "set", "nodeId": "research", "field": "outputs", "value": ["来源表", "结论草稿"]},
    {"op": "set", "nodeId": "research", "field": "acceptance", "value": "- [ ] 每条主要结论可回溯到来源"}
  ]
}
```

可写工作流字段：name、goal、delivery、constraints。可写节点字段：title、type、owner、model、instruction、inputs、outputs、acceptance、forbidden、notes、humanCheckpoint、timeoutSec、retry。列表字段可给数组或换行文本。不能改 id、x、y、confirmed、checked、step、order、stats、validation、dependsOn、next。

其他操作：

- add-node：`{"op":"add-node","node":{"id":"new_task","type":"llm","title":"新任务",...}}`。补全任务契约，用后续 link 显式接线。
- remove-node：`{"op":"remove-node","nodeId":"old_task"}`。同时删除关联边，应在同批中重建必要衔接。
- link：`{"op":"link","from":"a","to":"b","label":"条件满足"}`。
- unlink：`{"op":"unlink","from":"a","to":"b"}`。

人工节点始终保留 humanCheckpoint=true、timeoutSec=0。retry 范围0–5，timeoutSec 为非负整数。模型字段是偏好文本，工具不会自动调用该模型。
