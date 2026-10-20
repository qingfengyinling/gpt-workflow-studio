import {App} from '@modelcontextprotocol/ext-apps';
import {TYPES,TEXT_FIELDS,LIST_FIELDS,makeNode,normalize,validate,layout,applyPatches,clone} from '../shared/workflow.mjs';

const $=id=>document.getElementById(id),h=(tag,props={},...children)=>{const e=document.createElement(tag);for(const[k,v]of Object.entries(props)){if(k.startsWith('on'))e.addEventListener(k.slice(2),v);else if(k==='class')e.className=v;else if(k==='text')e.textContent=v;else if(k in e)e[k]=v;else e.setAttribute(k,v);}for(const c of children)if(c!==null&&c!==undefined)e.append(typeof c==='string'?document.createTextNode(c):c);return e;};
const labels={title:'节点名称',type:'节点类型',owner:'负责人 / 职责',model:'模型偏好（可留空）',instruction:'执行指令',inputs:'输入 · 每行一项',outputs:'输出 · 每行一项',acceptance:'验收标准',forbidden:'禁止事项 · 每行一项',notes:'失败策略与补充说明',timeoutSec:'单次超时 / 秒',retry:'重试上限',goal:'流程目标',delivery:'最终交付',constraints:'全局约束',name:'工作流名称'};
const state={record:null,selected:null,dirty:false,zoom:1,list:false,busy:false,workflows:[]};
let app=null,local=false,toastTimer;
function toast(s,error=false){$('toast').textContent=s;$('toast').className='toast'+(error?' error':'');$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,error?9000:4000);}
async function tool(name,args={}){
  if(local){const res=await fetch('/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,arguments:args})});const r=await res.json();if(!res.ok)throw Error(r.error);return r.data;}
  const r=await app.callServerTool({name,arguments:args});if(r.isError)throw Error(r.content?.find(c=>c.type==='text')?.text||'工具调用失败');return r.structuredContent;
}
function safe(fn){return async(...args)=>{try{return await fn(...args);}catch(e){toast(e.message,true);}};}
function wf(){return state.record?.workflow;}
function mark(){state.dirty=true;$('save-state').textContent='有未保存的修改';$('save').textContent='保存工作流 •';updateSummary();}
function accept(r){if(!r?.workflow)return;state.record=r;state.dirty=false;if(!r.workflow.nodes.some(n=>n.id===state.selected))state.selected=r.workflow.nodes[0]?.id??null;draw();}
async function refreshList(){const r=await tool('studio_open');state.workflows=r.workflows;drawLibrary();}
function drawLibrary(){const e=$('workflows');e.replaceChildren();for(const w of state.workflows)e.append(h('button',{class:'workflow-item'+(w.id===wf()?.id?' selected':''),onclick:safe(()=>load(w.id))},w.name,h('small',{},w.error?'数据待恢复':`${w.nodeCount} 个节点${w.pending?' · '+w.pending+' 批建议':''}`)));}
async function load(id){if(state.dirty&&!await confirmDialog('切换工作流','当前有未保存的修改。切换会放弃这些修改。','放弃修改并切换'))return;const r=await tool('studio_open',{id});state.selected=null;accept(r);drawLibrary();$('workspace').scrollTo(0,0);}
function openDialog(title,content,actions=[]){$('dialog-title').textContent=title;$('dialog-body').replaceChildren(...(Array.isArray(content)?content:[content]));$('dialog-actions').replaceChildren(...actions);$('dialog').showModal();}
function closeDialog(){$('dialog').close();}
function confirmDialog(title,text,button='确认'){return new Promise(resolve=>{let done=false;const finish=x=>{if(done)return;done=true;closeDialog();resolve(x);};const d=$('dialog');const cancel=()=>finish(false);d.addEventListener('cancel',cancel,{once:true});d.addEventListener('close',()=>{d.removeEventListener('cancel',cancel);if(!done){done=true;resolve(false);}},{once:true});openDialog(title,h('p',{},text),[h('button',{onclick:()=>finish(false)},'取消'),h('button',{class:'primary',onclick:()=>finish(true)},button)]);});}
$('dialog-close').onclick=closeDialog;
function draw(){
  if(!wf())return;
  $('flow-title').textContent=wf().name;$('flow-goal').textContent=wf().goal||'为这条流程写下一个明确的目标';
  $('node-count').textContent=`${wf().nodes.length} 个节点 · ${wf().edges.length} 条连线`;
  $('empty').hidden=wf().nodes.length>0;$('save-state').textContent=state.dirty?'有未保存的修改':`已保存 · 版本 ${state.record.revision}`;$('save').textContent=state.dirty?'保存工作流 •':'保存工作流';
  $('undo').disabled=!state.record.historyCount||state.dirty;
  drawCanvas();drawSteps();drawDetails();drawProposals();updateSummary();
}
function updateSummary(){if(!wf())return;const v=validate(wf());$('validation-summary').textContent=v.errors.length?`${v.errors.length} 个结构错误`:v.warnings.length?`${v.warnings.length} 项待补充`:'● 结构检查通过';}
function drawCanvas(){
  const box=$('nodes');box.replaceChildren();
  for(const [i,n]of wf().nodes.entries()){
    if(!Number.isFinite(n.x)||!Number.isFinite(n.y)){n.x=55+i*270;n.y=65;}
    const e=h('div',{class:'node '+n.type+(n.id===state.selected?' selected':''),tabIndex:0,role:'button','aria-label':n.title,'data-node-id':n.id},h('div',{class:'node-type'},h('span',{},String(i+1).padStart(2,'0')),TYPES[n.type]),h('h3',{},n.title||'未命名节点'),h('p',{},n.owner||'未指定职责'));
    e.style.left=n.x+'px';e.style.top=n.y+'px';
    e.addEventListener('keydown',event=>{if(['Enter',' '].includes(event.key)){event.preventDefault();select(n.id);}});
    e.addEventListener('pointerdown',event=>{
      if(event.button!==0)return;select(n.id,false);e.setPointerCapture(event.pointerId);
      const start={x:event.clientX,y:event.clientY,nx:n.x,ny:n.y};let moved=false;
      const move=ev=>{const dx=(ev.clientX-start.x)/state.zoom,dy=(ev.clientY-start.y)/state.zoom;if(Math.abs(dx)+Math.abs(dy)>3)moved=true;n.x=Math.max(10,start.nx+dx);n.y=Math.max(10,start.ny+dy);e.style.left=n.x+'px';e.style.top=n.y+'px';drawWires();};
      const up=()=>{e.removeEventListener('pointermove',move);e.removeEventListener('pointerup',up);e.removeEventListener('pointercancel',up);if(moved){mark();resizeCanvas();}};
      e.addEventListener('pointermove',move);e.addEventListener('pointerup',up);e.addEventListener('pointercancel',up);
    });box.append(e);
  }
  resizeCanvas();drawWires();
}
function resizeCanvas(){const w=Math.max(1000,...wf().nodes.map(n=>n.x+340)),height=Math.max(600,...wf().nodes.map(n=>n.y+230));$('canvas').style.width=w+'px';$('canvas').style.height=height+'px';$('canvas').style.transform=`scale(${state.zoom})`;$('zoom-label').textContent=Math.round(state.zoom*100)+'%';}
function svg(tag,props){const e=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const[k,v]of Object.entries(props))e.setAttribute(k,v);return e;}
function drawWires(){
  const wires=$('wires');wires.replaceChildren();
  const defs=svg('defs',{}),marker=svg('marker',{id:'arrow',viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:5,markerHeight:5,orient:'auto-start-reverse'});marker.append(svg('path',{d:'M 0 0 L 10 5 L 0 10 z',style:'fill:#9db9a9;stroke:none'}));defs.append(marker);wires.append(defs);
  for(const edge of wf().edges){const from=wf().nodes.find(n=>n.id===edge.from),to=wf().nodes.find(n=>n.id===edge.to);if(!from||!to)continue;const x1=from.x+216,y1=from.y+55,x2=to.x,y2=to.y+55,dx=Math.max(40,Math.abs(x2-x1)*.45),d=`M${x1},${y1} C${x1+dx},${y1} ${x2-dx},${y2} ${x2},${y2}`;
    const line=svg('path',{d,'marker-end':'url(#arrow)'}),hit=svg('path',{d,class:'wire-hit','aria-label':`${from.title}到${to.title}`});
    hit.addEventListener('click',()=>edgeDialog(edge));wires.append(line,hit);
    if(edge.label){const label=svg('text',{x:(x1+x2)/2,y:(y1+y2)/2-9,'text-anchor':'middle'});label.textContent=edge.label;wires.append(label);}
  }
}
function select(id,redraw=true){state.selected=id;if(redraw)drawCanvas();else document.querySelectorAll('.node').forEach(e=>e.classList.toggle('selected',e.dataset.nodeId===id));drawDetails();drawSteps();}
function drawSteps(){const e=$('steps');e.replaceChildren();const v=validate(wf()),ids=[...v.order,...wf().nodes.map(n=>n.id).filter(id=>!v.order.includes(id))];for(const [i,id]of ids.entries()){const n=wf().nodes.find(n=>n.id===id);e.append(h('div',{class:'step-item'+(id===state.selected?' selected':''),tabIndex:0,onclick:()=>select(id),onkeydown:ev=>{if(ev.key==='Enter')select(id);}},h('b',{},String(i+1).padStart(2,'0')),n.title,h('p',{},`${TYPES[n.type]} · ${n.owner}${n.humanCheckpoint?' · 等待真实用户确认':''}`),h('p',{},n.instruction||'尚未填写执行指令')));}}
function field(name,value,change,{area=false,selectOptions=null,type='text'}={}){
  const input=selectOptions?h('select',{},...Object.entries(selectOptions).map(([v,t])=>h('option',{value:v,selected:v===value},t))):h(area?'textarea':'input',area?{rows:3}:{type});
  if(!selectOptions)input.value=value??'';
  input.name=name;input.addEventListener('input',()=>change(input.value));return h('label',{},labels[name]||name,input);
}
function drawDetails(){
  const e=$('details'),n=wf().nodes.find(n=>n.id===state.selected);e.replaceChildren();if(!n){e.append(h('div',{class:'placeholder'},'选择节点，编辑它的任务契约。'));return;}
  e.append(h('div',{class:'node-heading'},h('h2',{},'任务契约'),h('small',{},n.id)));
  function update(name,value){n[name]=LIST_FIELDS.includes(name)?value.split('\n').filter(Boolean):value;mark();if(['title','owner','type'].includes(name))drawCanvas();}
  e.append(field('title',n.title,v=>update('title',v)),field('type',n.type,v=>{n.type=v;if(v==='human'){n.humanCheckpoint=true;n.timeoutSec=0;}mark();drawCanvas();drawDetails();},{selectOptions:TYPES}));
  for(const name of ['owner','model','instruction','inputs','outputs','acceptance','forbidden','notes'])e.append(field(name,LIST_FIELDS.includes(name)?n[name].join('\n'):n[name],v=>update(name,v),{area:!['owner','model'].includes(name)}));
  const check=h('input',{type:'checkbox',checked:n.humanCheckpoint,disabled:n.type==='human',onchange:event=>{n.humanCheckpoint=event.target.checked;if(n.humanCheckpoint)n.timeoutSec=0;mark();drawDetails();}});
  e.append(h('label',{class:'toggle'},check,'执行前等待真实用户确认'));
  e.append(h('div',{class:'field-row'},field('timeoutSec',n.timeoutSec,v=>{n.timeoutSec=n.humanCheckpoint?0:Math.max(0,Number(v)||0);mark();},{type:'number'}),field('retry',n.retry,v=>{n.retry=Math.max(0,Math.min(5,Number(v)||0));mark();},{type:'number'})));
  e.append(h('p',{class:'hint'},'这些字段定义执行约定。编排台不会自行运行代码或替用户确认。'));
  e.append(h('button',{class:'danger full',onclick:safe(async()=>{if(!await confirmDialog('删除节点',`删除“${n.title}”及其关联连线？`,'删除节点'))return;wf().nodes=wf().nodes.filter(x=>x.id!==n.id);wf().edges=wf().edges.filter(x=>x.from!==n.id&&x.to!==n.id);state.selected=null;mark();draw();})},'删除此节点'));
}
function switchPanel(assistant){$('details').hidden=assistant;$('assistant').hidden=!assistant;$('detail-tab').classList.toggle('active',!assistant);$('assist-tab').classList.toggle('active',assistant);}
$('detail-tab').onclick=()=>switchPanel(false);$('assist-tab').onclick=()=>switchPanel(true);
function drawProposals(){
  const proposals=state.record.proposals||[];$('proposal-count').textContent=proposals.length?'· '+proposals.length:'';const box=$('proposals');box.replaceChildren();
  for(const p of proposals){
    const chosen=new Set(p.patches.map((_,i)=>i));const card=h('div',{class:'proposal'},h('h2',{},'待审建议'),h('p',{},p.summary));
    p.patches.forEach((patch,i)=>{const check=h('input',{type:'checkbox',checked:true,onchange:e=>e.target.checked?chosen.add(i):chosen.delete(i)});const before=patch.op==='set'?(patch.nodeId?wf().nodes.find(n=>n.id===patch.nodeId)?.[patch.field]:wf()[patch.field]):null;
      card.append(h('label',{class:'patch-item'},check,h('div',{},h('b',{},`${patch.op} · ${patch.nodeId||'工作流'}${patch.field?' / '+(labels[patch.field]||patch.field):''}`),before!==null?h('small',{},'当前：'+JSON.stringify(before)):null,h('pre',{},JSON.stringify(patch.value??patch.node??patch,null,2)))));
    });
    card.append(h('button',{class:'primary full',onclick:safe(async()=>{if(state.dirty)throw Error('请先保存或放弃当前修改，再应用建议');const indexes=[...chosen].sort((a,b)=>a-b);if(!indexes.length)throw Error('请至少选择一项建议');const preview=applyPatches(wf(),indexes.map(i=>p.patches[i]));const v=validate(preview);openDialog('预览选中的修改',[h('p',{},`将应用 ${indexes.length} 项修改。应用后 ${v.nodeCount} 个节点、${v.edgeCount} 条连线；${v.warnings.length} 项待补充。`),h('pre',{},JSON.stringify(indexes.map(i=>p.patches[i]),null,2))],[h('button',{onclick:closeDialog},'返回'),h('button',{class:'primary',onclick:safe(async()=>{const r=await tool('studio_apply_proposal',{id:wf().id,revision:state.record.revision,proposalId:p.id,selected:indexes});closeDialog();accept(r);await refreshList();toast('建议已应用，可撤销');})},'确认应用')]);})},'预览并应用所选建议'));
    card.append(h('button',{class:'full',onclick:safe(async()=>{if(state.dirty)throw Error('请先保存当前修改');accept(await tool('studio_discard_proposal',{id:wf().id,revision:state.record.revision,proposalId:p.id}));})},'忽略这批建议'));box.append(card);
  }
  if(!proposals.length)box.append(h('p',{class:'hint'},'还没有待审建议。请 GPT 审查后，在此刷新。'));
}
$('save').onclick=safe(async()=>{if(!wf())return;accept(await tool('studio_save',{id:wf().id,revision:state.record.revision,workflow:wf()}));await refreshList();toast('工作流已保存');});
$('undo').onclick=safe(async()=>{if(state.dirty)throw Error('请先保存当前修改');accept(await tool('studio_undo',{id:wf().id,revision:state.record.revision}));await refreshList();toast('已撤销上一次修改');});
$('layout').onclick=()=>{if(!wf())return;layout(wf());mark();drawCanvas();};
$('zoom-in').onclick=()=>{state.zoom=Math.min(1.5,state.zoom+.1);if(wf())resizeCanvas();};$('zoom-out').onclick=()=>{state.zoom=Math.max(.3,state.zoom-.1);if(wf())resizeCanvas();};
$('canvas-tab').onclick=()=>{state.list=false;$('canvas').hidden=false;$('steps').hidden=true;$('canvas-tab').classList.add('active');$('list-tab').classList.remove('active');};
$('list-tab').onclick=()=>{state.list=true;$('canvas').hidden=true;$('steps').hidden=false;$('canvas-tab').classList.remove('active');$('list-tab').classList.add('active');};
$('validate').onclick=()=>{if(!wf())return;const v=validate(wf());openDialog('工作流检查',[h('p',{},`${v.nodeCount} 个节点 · ${v.edgeCount} 条连线 · ${v.humanCheckpoints} 个人工卡点。检查设计结构，不证明任务已执行。`),h('pre',{},[...v.errors.map(x=>'错误：'+x),...v.warnings.map(x=>'待补充：'+x)].join('\n')||'结构检查通过。')]);};
$('settings').onclick=()=>{
  if(!wf())return;const copy=clone(wf()),fields=['name','goal','delivery','constraints'].map(name=>field(name,copy[name],v=>copy[name]=v,{area:name!=='name'}));
  if(innerWidth<800)fields.unshift(field('切换工作流',wf().id,v=>{closeDialog();safe(()=>load(v))();},{selectOptions:Object.fromEntries(state.workflows.map(w=>[w.id,w.name]))}));
  openDialog('流程设置',fields,[h('button',{onclick:()=>{closeDialog();$('create').click();}},'新建工作流'),h('button',{onclick:closeDialog},'取消'),h('button',{class:'primary',onclick:()=>{for(const f of ['name','goal','delivery','constraints'])wf()[f]=copy[f];mark();closeDialog();draw();}},'应用到画布')]);
};
$('add-node').onclick=()=>{
  if(!wf())return;const n=makeNode('n_'+crypto.randomUUID().replaceAll('-',''));const fields=[field('title',n.title,v=>n.title=v),field('type',n.type,v=>n.type=v,{selectOptions:TYPES})];
  openDialog('添加节点',fields,[h('button',{onclick:closeDialog},'取消'),h('button',{class:'primary',onclick:()=>{const selected=wf().nodes.find(x=>x.id===state.selected);n.x=(selected?.x??0)+270;n.y=selected?.y??65;while(wf().nodes.some(x=>Math.abs(x.x-n.x)<230&&Math.abs(x.y-n.y)<130))n.y+=160;if(n.type==='human'){n.humanCheckpoint=true;n.timeoutSec=0;}wf().nodes.push(n);state.selected=n.id;mark();closeDialog();draw();}},'添加')]);
};
function edgeDialog(existing=null){
  if(!wf()?.nodes.length)return;const nodes=Object.fromEntries(wf().nodes.map(n=>[n.id,n.title]));const value={from:existing?.from??state.selected??wf().nodes[0].id,to:existing?.to??wf().nodes.find(n=>n.id!==state.selected)?.id??wf().nodes[0].id,label:existing?.label??''};
  const fields=[field('起始节点',value.from,v=>value.from=v,{selectOptions:nodes}),field('后续节点',value.to,v=>value.to=v,{selectOptions:nodes}),field('连线条件（分支时必填）',value.label,v=>value.label=v)];
  const actions=[h('button',{onclick:closeDialog},'取消')];
  if(existing)actions.push(h('button',{class:'danger',onclick:()=>{wf().edges=wf().edges.filter(e=>e.id!==existing.id);mark();closeDialog();draw();}},'删除连线'));
  actions.push(h('button',{class:'primary',onclick:safe(()=>{const candidate=clone(wf());if(existing)candidate.edges=candidate.edges.filter(e=>e.id!==existing.id);candidate.edges.push({id:existing?.id??'e_'+crypto.randomUUID().replaceAll('-',''),...value});const v=validate(candidate);if(!v.passed)throw Error(v.errors.join('；'));state.record.workflow=candidate;mark();closeDialog();draw();})},existing?'修改连线':'连接'));openDialog(existing?'编辑连线':'连接节点',fields,actions);
}
$('add-edge').onclick=()=>edgeDialog();
$('create').onclick=()=>{let name='我的新工作流';openDialog('新建工作流',field('name',name,v=>name=v),[h('button',{onclick:closeDialog},'取消'),h('button',{class:'primary',onclick:safe(async()=>{if(state.dirty&&!await confirmDialog('新建工作流','当前修改尚未保存。继续将放弃未保存的修改。','继续新建'))return;const a=makeNode('start','start','明确目标'),b=makeNode('task','llm','完成任务'),c=makeNode('deliver','output','验收与交付');const workflow=layout({name,goal:'',nodes:[a,b,c],edges:[{id:'e1',from:'start',to:'task',label:''},{id:'e2',from:'task',to:'deliver',label:''}]});accept(await tool('studio_create',{workflow}));closeDialog();await refreshList();})},'创建')]);};
$('import').onclick=()=>$('import-file').click();
$('import-file').onchange=safe(async event=>{
  const file=event.target.files?.[0];if(!file)return;
  try{if(file.size>2*1024*1024)throw Error('导入文件超过2MB');const data=JSON.parse(await file.text()),items=Array.isArray(data.workflows)?data.workflows:[data.workflow??data];if(!items.length||items.length>30)throw Error('每次导入1–30个工作流');items.forEach(x=>{const v=validate(normalize(x));if(!v.passed)throw Error(v.errors.join('；'));});if(state.dirty&&!await confirmDialog('导入工作流','导入会切换到新图，并放弃当前未保存修改。','继续导入'))return;let last;for(const item of items)last=await tool('studio_create',{workflow:item});accept(last);await refreshList();toast(`已导入 ${items.length} 个工作流，原图保持不变`);}finally{event.target.value='';}
});
function download(name,text,type){const url=URL.createObjectURL(new Blob([text],{type}));const a=h('a',{href:url,download:name});document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),2000);}
$('export').onclick=safe(async()=>{if(!wf())return;if(state.dirty)throw Error('请先保存，再导出与保存版本一致的文件');const r=await tool('studio_export',{id:wf().id});const name=wf().name.replace(/[\\/:*?"<>|]/g,'_');openDialog('导出工作流',[h('p',{},'JSON 用于备份、迁移与再次导入；Markdown 用于交给人或 GPT 执行。')],[h('button',{onclick:()=>download(name+'.workflow.json',JSON.stringify(r.json,null,2),'application/json')},'下载 JSON'),h('button',{class:'primary',onclick:()=>download(name+'-交接包.md',r.markdown,'text/markdown')},'下载 Markdown')]);});
$('ask-gpt').onclick=safe(async()=>{
  if(!wf())return;if(state.dirty)throw Error('请先保存当前工作流，让 GPT 读取同一版本');
  const prompt=`请使用工作流编排台审查工作流 ${wf().id}（${wf().name}）。先调用 studio_review_context 读取最新版本。${$('assist-instruction').value||'检查输入输出交接、执行指令、验收标准、人工卡点和失败恢复。'}如需修改，调用 studio_propose 提交候选补丁，保留原图等待我在界面选择应用。`;
  if(!local){await app.sendMessage({role:'user',content:[{type:'text',text:prompt}]});toast('已请求当前对话中的 GPT 审查');}
  else{openDialog('交给当前对话中的 GPT',[h('p',{},'本地浏览器不能直接向 GPT 对话发消息。复制以下指令到已连接本插件的对话；GPT 提交补丁后，点击“刷新待审建议”。'),h('textarea',{rows:7,value:prompt,readOnly:true})],[h('button',{class:'primary',onclick:safe(async()=>{try{await navigator.clipboard.writeText(prompt);toast('指令已复制');}catch{toast('请选择上面的指令并复制');}})},'复制指令')]);}
});
$('refresh-proposals').onclick=safe(async()=>{if(state.dirty)throw Error('请先保存修改，或切换后放弃草稿');accept(await tool('studio_open',{id:wf().id}));await refreshList();toast('已刷新工作流与建议');});
window.addEventListener('beforeunload',e=>{if(state.dirty){e.preventDefault();e.returnValue='';}});
async function boot(){
  local=['127.0.0.1','localhost','[::1]'].includes(location.hostname)&&location.protocol==='http:';
  if(!local){
    app=new App({name:'gpt-workflow-studio-ui',version:'0.1.0'},{},{autoResize:false});
    app.ontoolresult=r=>{const data=r.structuredContent;if(!data)return;if(data.workflow){if(state.dirty){toast('GPT 有新的数据，请先保存或放弃草稿后刷新');return;}accept(data);}if(data.workflows){state.workflows=data.workflows;drawLibrary();}};
    await app.connect(undefined,{timeout:10000});
    $('connection').textContent='● 已连接当前 GPT';
  }else{$('connection').textContent='● 本地编排台';$('assist-hint').textContent='连接插件后，可将审查请求交给 GPT 对话。无需另填模型 API Key。';}
  await refreshList();if(!wf()&&state.workflows.find(w=>!w.error))await load(state.workflows.find(w=>!w.error).id);
}
safe(boot)();
