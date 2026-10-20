import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import {Store} from './store.mjs';
import {createMcp,execute} from './tools.mjs';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function arg(name,fallback){const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:fallback;}
export function seed(store){
  if(store.list().length)return;
  const examples=path.join(root,'examples');
  for(const file of fs.readdirSync(examples).filter(x=>x.endsWith('.json')))store.create(JSON.parse(fs.readFileSync(path.join(examples,file),'utf8')));
}
async function body(req){let data='';for await(const chunk of req){data+=chunk;if(Buffer.byteLength(data)>2*1024*1024)throw Error('请求超过2MB');}return data?JSON.parse(data):{};}
function send(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));}
export function createHttp(store,{htmlPath=path.join(root,'dist/index.html'),host='127.0.0.1',port=4318}={}){
  if(!['127.0.0.1','localhost','::1'].includes(host))throw Error('此本地单用户版仅绑定回环地址；远程部署需另加认证和用户隔离');
  const server=http.createServer(async(req,res)=>{
    try{
      const actualPort=server.address()?.port??port;
      const allowedHost=new Set([`127.0.0.1:${actualPort}`,`localhost:${actualPort}`,`[::1]:${actualPort}`]);
      if(!allowedHost.has(req.headers.host)){send(res,403,{error:'不允许的 Host'});return;}
      const origin=req.headers.origin;
      if(origin&&!new Set([`http://127.0.0.1:${actualPort}`,`http://localhost:${actualPort}`,`http://[::1]:${actualPort}`]).has(origin)){send(res,403,{error:'不允许跨来源访问本地服务'});return;}
      const url=new URL(req.url,'http://localhost');
      if(url.pathname==='/'&&req.method==='GET'){
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; frame-ancestors 'self'"});res.end(fs.readFileSync(htmlPath));return;
      }
      if(url.pathname==='/api'&&req.method==='POST'){
        if(!req.headers['content-type']?.startsWith('application/json')){send(res,415,{error:'需要 application/json'});return;}
        const a=await body(req);send(res,200,{data:execute(store,a.name,a.arguments??{})});return;
      }
      if(url.pathname==='/mcp'){
        const mcp=createMcp(store,htmlPath),transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
        res.on('close',()=>{transport.close();mcp.close();});await mcp.connect(transport);
        await transport.handleRequest(req,res,req.method==='POST'?await body(req):undefined);return;
      }
      if(url.pathname==='/health'&&req.method==='GET'){send(res,200,{status:'ok',version:'0.1.0'});return;}
      send(res,404,{error:'页面不存在'});
    }catch(e){if(!res.headersSent)send(res,400,{error:e.message});else res.end();}
  });
  return server;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const store=new Store(arg('--data',process.env.WORKFLOW_STUDIO_DATA||path.join(os.homedir(),'.gpt-workflow-studio','data')));seed(store);
  const html=path.join(root,'dist/index.html');
  if(!fs.existsSync(html))throw Error('缺少 dist/index.html；请先运行构建');
  if(process.argv.includes('--stdio'))await createMcp(store,html).connect(new StdioServerTransport());
  else{const port=Number(arg('--port',4318));const server=createHttp(store,{port,htmlPath:html});server.on('error',e=>{console.error(e.message);process.exitCode=1;});server.listen(port,'127.0.0.1',()=>console.error(`工作流编排台：http://127.0.0.1:${port}`));}
}
