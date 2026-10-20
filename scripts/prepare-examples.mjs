import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {makeNode,exportFile,layout} from '../shared/workflow.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
fs.mkdirSync(path.join(root,'examples'),{recursive:true});
const sourceIndex=process.argv.indexOf('--gomentor-source');
const source=sourceIndex>=0?process.argv[sourceIndex+1]:null;
if(sourceIndex>=0&&!source)throw Error('--gomentor-source 需要文件路径');
if(source){
  const w=JSON.parse(fs.readFileSync(source,'utf8')).workflow;
  w.name='示例 · 围棋学习系统 MVP';
  w.constraints='九路棋盘与落子—气—提子；围棋规则真值由程序产生；AI 动作先校验再执行。\n可打断、可恢复、低干扰；实际体验与模型验证分别记录。\n工作流定义设计契约，不表示已执行，也不构成实际研发授权。';
  w.nodes[0].inputs=['项目书与当前工作区状态','本轮用户指令'];
  w.nodes[0].instruction='读取项目书与当前工作区状态，建立来源和执行台账；按本轮用户指令确定规划或开发范围。';
  fs.writeFileSync(path.join(root,'examples/02-gomentor.json'),JSON.stringify(exportFile(w),null,2)+'\n');
}
const defs=[
  ['start','start','明确目标与约束','项目负责人',['需求与参考材料'],['目标与范围'],'确认目标、读者、交付形式和边界，记录未决问题。','- [ ] 已明确目标、范围、交付形式与验收负责人'],
  ['design','llm','设计方案','当前 GPT',['目标与范围'],['方案与任务契约'],'将目标拆成任务，明确各步输入、输出与验收。','- [ ] 方案中的每项任务均有可检查输出'],
  ['build','tool','制作与验证','执行者',['方案与任务契约'],['候选成果','验证记录'],'使用当前环境中可用的工具制作成果并验证，记录实际结果。','- [ ] 候选成果可复现\n- [ ] 验证结果附证据，未测项目明确列出'],
  ['review','human','体验与决定','实际使用者',['候选成果','验证记录'],['体验反馈与决定'],'实际使用候选成果，记录接受、修订或停止决定。','- [ ] 已得到真实使用者反馈，未回复保持等待'],
  ['deliver','output','交付与后续','项目负责人',['候选成果','验证记录','体验反馈与决定'],['交付包'],'按真实反馈交付成果，说明限制与后续事项。','- [ ] 交付清单、使用说明、已知限制与后续决定一致']
];
const nodes=defs.map(([id,type,title,owner,inputs,outputs,instruction,acceptance])=>({...makeNode(id,type,title),owner,inputs,outputs,instruction,acceptance,forbidden:['不编造执行结果'],notes:'失败时记录原因、受影响下游与恢复入口。'}));
const edges=nodes.slice(1).map((n,i)=>({id:'e'+i,from:nodes[i].id,to:n.id,label:''}));
const wf=layout({id:'example_general',name:'从想法到交付',goal:'把一个想法整理成可制作、可验证、可交付的成果。',delivery:'可使用的成果与交接说明，交项目负责人。',constraints:'记录事实与未定项；以可检查的产物交接；人工体验必须由真实用户完成。',nodes,edges});
fs.writeFileSync(path.join(root,'examples/01-general.json'),JSON.stringify(exportFile(wf),null,2)+'\n');
console.log('示例已准备；原围棋工作流未修改。');
