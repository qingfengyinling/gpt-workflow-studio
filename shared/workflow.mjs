export const TYPES = {start:'起点',llm:'GPT 任务',tool:'工具',branch:'分支',human:'人工确认',output:'交付'};
export const TEXT_FIELDS = ['title','owner','model','instruction','acceptance','notes'];
export const LIST_FIELDS = ['inputs','outputs','forbidden'];
export const WORKFLOW_FIELDS = ['name','goal','delivery','constraints'];
export const clone = x=>JSON.parse(JSON.stringify(x));
const text = x=>Array.isArray(x)?x.join('\n'):String(x??'');
export const lines = x=>Array.isArray(x)?x.map(text).filter(Boolean):text(x).split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
export function makeNode(id,type='llm',title='新任务') {
  return {id,type,title,owner:'当前执行者',model:'',instruction:'',inputs:[],outputs:[],acceptance:'',forbidden:[],notes:'',humanCheckpoint:type==='human',timeoutSec:type==='llm'?600:type==='tool'?300:0,retry:type==='llm'?1:0};
}
export function normalize(input) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('工作流必须是对象');
  const w=input.workflow??input;
  if(!Array.isArray(w.nodes)||!Array.isArray(w.edges))throw Error('需要 nodes 和 edges 数组');
  if(w.nodes.length>500||w.edges.length>3000)throw Error('单图最多 500 个节点、3000 条边');
  const wf={id:text(w.id),name:text(w.name)||'未命名工作流',goal:text(w.goal),delivery:text(w.delivery),constraints:text(w.constraints),nodes:[],edges:[]};
  wf.nodes=w.nodes.map((n,i)=>{
    if(!n||!Object.hasOwn(TYPES,n.type))throw Error(`节点 ${i+1} 类型不支持`);
    const v=makeNode(text(n.id),n.type,text(n.title));
    for(const f of TEXT_FIELDS)v[f]=text(n[f]??(f==='owner'?n.role:undefined));
    for(const f of LIST_FIELDS)v[f]=lines(n[f]);
    v.humanCheckpoint=n.type==='human'||n.humanCheckpoint===true||n.humanCheck===true;
    v.timeoutSec=v.humanCheckpoint?0:Math.max(0,Math.floor(Number(n.timeoutSec)||0));
    v.retry=Math.max(0,Math.min(5,Math.floor(Number(n.retry)||0)));
    if(Number.isFinite(n.x)&&Number.isFinite(n.y)){v.x=n.x;v.y=n.y;}
    // 完成勾选与设计分离；保留导入态，但 AI 补丁不可写。
    v.confirmed=n.confirmed===true||n.checked===true;
    return v;
  });
  wf.edges=w.edges.map((e,i)=>({id:text(e.id)||`edge_${i+1}`,from:text(e.from),to:text(e.to),label:text(e.label)}));
  return wf;
}
export function topology(wf) {
  const ids=new Set(wf.nodes.map(n=>n.id)),deg=new Map(wf.nodes.map(n=>[n.id,0]));
  for(const e of wf.edges)if(ids.has(e.from)&&ids.has(e.to))deg.set(e.to,deg.get(e.to)+1);
  const q=wf.nodes.filter(n=>deg.get(n.id)===0).map(n=>n.id),order=[];
  while(q.length){const id=q.shift();order.push(id);for(const e of wf.edges.filter(e=>e.from===id)){if(!deg.has(e.to))continue;deg.set(e.to,deg.get(e.to)-1);if(deg.get(e.to)===0)q.push(e.to);}}
  return {order,cyclic:order.length!==wf.nodes.length};
}
export function validate(wf) {
  const errors=[],warnings=[],ids=new Set(),edgeIds=new Set();
  for(const n of wf.nodes){
    if(!n.id||ids.has(n.id))errors.push(`节点 ID 为空或重复：${n.id}`);ids.add(n.id);
    if(!Object.hasOwn(TYPES,n.type))errors.push(`未知节点类型：${n.type}`);
    if(!n.title.trim())warnings.push(`${n.id} 缺少标题`);
    if(!n.outputs.length)warnings.push(`${n.title||n.id} 未声明输出`);
    if(!n.acceptance.trim())warnings.push(`${n.title||n.id} 未声明验收标准`);
    if(['llm','tool'].includes(n.type)&&!n.instruction.trim())warnings.push(`${n.title||n.id} 未声明执行指令`);
    if(n.humanCheckpoint&&n.timeoutSec!==0)errors.push(`${n.id} 人工确认不能超时放行`);
  }
  if(wf.nodes.filter(n=>n.type==='start').length!==1)warnings.push('建议保留唯一的起点节点');
  if(!wf.nodes.some(n=>n.type==='output'))warnings.push('缺少交付节点');
  const pairs=new Set();
  for(const e of wf.edges){
    if(edgeIds.has(e.id))errors.push(`连线 ID 重复：${e.id}`);edgeIds.add(e.id);
    if(!ids.has(e.from)||!ids.has(e.to))errors.push(`连线端点不存在：${e.from} → ${e.to}`);
    if(e.from===e.to)errors.push(`节点不能连向自身：${e.from}`);
    const pair=e.from+'\0'+e.to;if(pairs.has(pair))errors.push(`重复连线：${e.from} → ${e.to}`);pairs.add(pair);
  }
  const {order,cyclic}=topology(wf);if(cyclic)errors.push('存在循环依赖；返工应写入说明，不画回边');
  for(const n of wf.nodes){
    if(n.type!=='start'&&!wf.edges.some(e=>e.to===n.id))warnings.push(`${n.title} 没有上游`);
    if(n.type!=='output'&&!wf.edges.some(e=>e.from===n.id))warnings.push(`${n.title} 没有下游`);
    if(n.type==='branch'&&wf.edges.some(e=>e.from===n.id&&!e.label.trim()))warnings.push(`${n.title} 的分支连线缺少条件`);
  }
  const products=new Map();
  for(const n of wf.nodes)for(const p of n.outputs)products.set(p,n.id);
  for(const n of wf.nodes)for(const p of n.inputs){const owner=products.get(p);if(owner&&owner!==n.id&&order.indexOf(owner)>=order.indexOf(n.id))warnings.push(`${n.title} 引用了尚未产生的输出：${p}`);}
  return {passed:errors.length===0,errors,warnings,order,nodeCount:wf.nodes.length,edgeCount:wf.edges.length,humanCheckpoints:wf.nodes.filter(n=>n.humanCheckpoint).length};
}
export function layout(wf) {
  const {order}=topology(wf),level={};
  for(const id of order)level[id]=Math.max(0,...wf.edges.filter(e=>e.to===id).map(e=>(level[e.from]??0)+1));
  const rows={};
  wf.nodes.forEach((n,i)=>{const col=level[n.id]??i;const row=rows[col]??0;n.x=55+col*270;n.y=65+row*160;rows[col]=row+1;});
  return wf;
}
export function applyPatches(input,patches) {
  if(!Array.isArray(patches)||patches.length<1||patches.length>100)throw Error('补丁数量应为 1–100');
  const wf=clone(input);
  for(const p of patches){
    if(!p||typeof p!=='object')throw Error('无效补丁');
    if(p.op==='set'){
      if(p.nodeId){
        const n=wf.nodes.find(n=>n.id===p.nodeId);if(!n)throw Error(`节点不存在：${p.nodeId}`);
        if(TEXT_FIELDS.includes(p.field))n[p.field]=text(p.value);
        else if(LIST_FIELDS.includes(p.field))n[p.field]=lines(p.value);
        else if(p.field==='type'){if(!Object.hasOwn(TYPES,p.value))throw Error('未知类型');n.type=p.value;if(n.type==='human'){n.humanCheckpoint=true;n.timeoutSec=0;}}
        else if(p.field==='humanCheckpoint'){if(typeof p.value!=='boolean')throw Error('人工卡点必须为布尔值');if(n.type==='human'&&!p.value)throw Error('人工节点必须保留确认');n.humanCheckpoint=p.value;if(p.value)n.timeoutSec=0;}
        else if(['timeoutSec','retry'].includes(p.field)){if(!Number.isInteger(p.value)||p.value<0)throw Error('需要非负整数');if(p.field==='retry'&&p.value>5)throw Error('重试上限为5');if(p.field==='timeoutSec'&&n.humanCheckpoint&&p.value!==0)throw Error('人工节点不能超时放行');n[p.field]=p.value;}
        else throw Error(`禁止修改节点字段：${p.field}`);
      }else{if(!WORKFLOW_FIELDS.includes(p.field))throw Error(`禁止修改工作流字段：${p.field}`);wf[p.field]=text(p.value);}
    }else if(p.op==='add-node'){
      if(!p.node?.id||wf.nodes.some(n=>n.id===p.node.id))throw Error('新节点需要唯一 ID');
      const n=normalize({nodes:[p.node],edges:[]}).nodes[0];n.confirmed=false;delete n.x;delete n.y;wf.nodes.push(n);
    }else if(p.op==='remove-node'){
      if(!wf.nodes.some(n=>n.id===p.nodeId))throw Error('待删除节点不存在');
      wf.nodes=wf.nodes.filter(n=>n.id!==p.nodeId);wf.edges=wf.edges.filter(e=>e.from!==p.nodeId&&e.to!==p.nodeId);
    }else if(p.op==='link'){
      wf.edges.push({id:p.id||`e_${Date.now()}_${wf.edges.length}`,from:text(p.from),to:text(p.to),label:text(p.label)});
    }else if(p.op==='unlink'){
      if(!wf.edges.some(e=>e.from===p.from&&e.to===p.to))throw Error('待删除连线不存在');
      wf.edges=wf.edges.filter(e=>e.from!==p.from||e.to!==p.to);
    }else throw Error(`未知补丁操作：${p.op}`);
  }
  const result=validate(wf);if(!result.passed)throw Error(result.errors.join('；'));
  return wf;
}
export function exportFile(wf) {
  return {$schema:'gpt-workflow-studio/v1',format:'workflow-file',schemaVersion:'1.0',generator:'GPT Workflow Studio',exportedAt:new Date().toISOString(),readme:'依赖图与任务契约，不是自动执行结果。分支条件与人工卡点由执行者落实。',workflow:clone(wf)};
}
export function handoff(wf) {
  const v=validate(wf),map=new Map(wf.nodes.map(n=>[n.id,n]));
  const md=s=>String(s).replace(/\r/g,'');
  let s=`# 工作流交接包：${md(wf.name)}\n\n目标：${md(wf.goal)}\n\n交付：${md(wf.delivery)}\n\n## 全局约束\n\n${md(wf.constraints)}\n\n## 结构检查\n\n${v.errors.length} 个错误、${v.warnings.length} 个待补项。此结果不代表任务已执行。\n`;
  for(const [i,id] of v.order.entries()){
    const n=map.get(id);s+=`\n## ${i+1}. ${md(n.title)}\n\nID：${n.id}；类型：${TYPES[n.type]}；负责人：${md(n.owner)}；人工确认：${n.humanCheckpoint?'必须等待真实用户':'否'}。\n\n执行：${md(n.instruction)}\n\n输入：\n${n.inputs.map(x=>'- '+md(x)).join('\n')}\n\n输出：\n${n.outputs.map(x=>'- '+md(x)).join('\n')}\n\n验收：\n${md(n.acceptance)}\n\n禁止：${n.forbidden.map(md).join('；')}\n\n说明：${md(n.notes)}\n`;
  }
  if(v.errors.length)s+='\n## 未解决的结构错误\n\n'+v.errors.map(x=>'- '+x).join('\n');
  s+='\n## 连线与条件\n\n'+wf.edges.map(e=>`- ${e.from} → ${e.to}${e.label?'：'+md(e.label):''}`).join('\n')+'\n';
  return s;
}
