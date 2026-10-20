import {build} from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=await build({entryPoints:[path.join(root,'web/app.mjs')],bundle:true,format:'esm',minify:true,write:false,target:'es2022',metafile:true});
const js=out.outputFiles[0].text.replace(/<\/script/gi,'<\\/script');
const html=fs.readFileSync(path.join(root,'web/index.html'),'utf8').replace('/* STYLE */',()=>fs.readFileSync(path.join(root,'web/style.css'),'utf8')).replace('/* SCRIPT */',()=>js);
fs.mkdirSync(path.join(root,'dist'),{recursive:true});fs.writeFileSync(path.join(root,'dist/index.html'),html);
const server=await build({entryPoints:[path.join(root,'server/index.mjs')],bundle:true,platform:'node',format:'esm',target:'node20',outfile:path.join(root,'dist/server.mjs'),metafile:true,banner:{js:"import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"}});
const packages=new Map();
for(const input of [...Object.keys(out.metafile.inputs),...Object.keys(server.metafile.inputs)]){
  if(!input.includes('node_modules'))continue;
  let dir=path.dirname(path.resolve(input));
  while(dir!==path.dirname(dir)){
    const file=path.join(dir,'package.json');
    if(fs.existsSync(file)){const pkg=JSON.parse(fs.readFileSync(file,'utf8'));if(pkg.name){packages.set(pkg.name+'@'+pkg.version,{dir,pkg});break;}}
    dir=path.dirname(dir);
  }
}
let notices='# Third-party notices\n\nBundled dependencies retain their original licenses. This plugin is independently authored.\n';
for(const[name,{dir,pkg}]of [...packages].sort(([a],[b])=>a.localeCompare(b))){
  notices+=`\n## ${name}\n\nLicense: ${typeof pkg.license==='string'?pkg.license:JSON.stringify(pkg.license??'See package notice')}\n\n`;
  const file=fs.readdirSync(dir).find(n=>/^licen[cs]e(?:\.md|\.txt)?$/i.test(n));
  if(file&&fs.statSync(path.join(dir,file)).isFile())notices+=fs.readFileSync(path.join(dir,file),'utf8')+'\n';
}
fs.writeFileSync(path.join(root,'THIRD_PARTY_NOTICES.md'),notices);
console.log(`界面已构建：${Buffer.byteLength(html)} bytes`);
