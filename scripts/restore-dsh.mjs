import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=process.argv[2];
if(!source)throw Error('用法：node scripts/restore-dsh.mjs <合订 Markdown 路径>');
const doc=fs.readFileSync(source,'utf8');
const names=['dsh-workflow-studio/README.md','dsh-workflow-studio/package.json','dsh-workflow-studio/cordis.patch.yml','dsh-workflow-studio/lib/index.js','dsh-workflow-studio/lib/client.js','dsh-workflow-studio/selftest.mjs','dsh-workflow-studio/client-harness.mjs','workflow-studio/index.html'];
const dest=path.join(root,'legacy/dsh'),files=[];
for(const name of names){
  const begin=`<!-- ===== BEGIN ${name} ===== -->`,end=`<!-- ===== END ${name} ===== -->`;
  const start=doc.indexOf(begin),finish=doc.indexOf(end,start+begin.length);
  if(start<0||finish<0||doc.indexOf(begin,start+begin.length)>=0)throw Error('缺失或重复章节：'+name);
  const body=doc.slice(start+begin.length,finish).replace(/^\r?\n/,'').replace(/\r?\n$/,'')+'\n';
  const file=path.join(dest,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,body);
  files.push({path:name,bytes:Buffer.byteLength(body),sha256:createHash('sha256').update(body).digest('hex')});
}
fs.writeFileSync(path.join(dest,'source-manifest.json'),JSON.stringify({sourceDocument:path.basename(source),sourceSha256:createHash('sha256').update(doc).digest('hex'),restoredAt:new Date().toISOString(),note:'Only the seven plugin files and the standalone HTML are restored. No subject-specific generators or historical agent notes are included.',files},null,2)+'\n');
console.log(JSON.stringify({files:files.length,bytes:files.reduce((n,f)=>n+f.bytes,0)},null,2));
