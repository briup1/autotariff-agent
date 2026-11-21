import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { PROJECT_ROOT } from '../src/closure/paths.js';

const digest = 'a'.repeat(64);
const contract = { version: 'v1', requirementsDigest: digest, requirementsSource: 'uploaded', fields: [{name:'港口',role:'text',source:{kind:'column'}}], checks: [{id:'required',quote:'港口必填'}], notes: ['核对原文'], questions: [] };
const content = JSON.stringify(contract);
const sha = Buffer.from(await webcrypto.subtle.digest('SHA-256', Buffer.from(content))).toString('hex');
function detail() { return {run:{runId:'r1',phase:'TERMINAL',decision:'REVIEW',contractStatus:'candidate',requirementsDigest:digest,contractSha256:sha,contractVersion:'v1',issueCount:0,sourceName:'上海宁波深圳运价表.xlsx'},attempts:[{id:'a1',reportStatus:'available',validationStatus:'REVIEW',issueCount:0}],selectedAttemptId:'a1',artifacts:[{kind:'contract',path:'contract/contract.json'}]}; }
function node(text = ''): any { return {textContent:text,hidden:false,disabled:false,open:false,isConnected:true,children:[],dataset:{},handlers:{},append(...children:any[]){this.children.push(...children);},replaceChildren(...children:any[]){this.children=children;},setAttribute(){},addEventListener(event:string,fn:any){this.handlers[event]=fn;},showModal(){this.open=true;},close(){this.open=false;},focus(){this.focused=true;}}; }
function text(n:any):string {return [n.textContent,...n.children.map(text)].join(' ');}
async function setup(saved = new Map<string,string>()) {
 const code = await readFile(resolve(PROJECT_ROOT,'web/app.js'),'utf8');
 const nodes = new Map<string,any>(), requests:any[]=[];
 let handler = async (path:string,_options?:any):Promise<any> => path.startsWith('/api/runs/') ? detail() : path.startsWith('/api/artifacts') ? {content,truncated:false} : {requirementsDigest:digest,contractSha256:sha,contractVersion:'v1',approvedAt:'2026-11-15T03:00:00Z'};
 const state:any = {bootstrap:{sources:[],conversations:[]},run:detail(),runId:'r1'};
 const trigger=node();
 const context = createContext({state,TextEncoder,URLSearchParams,CSS:{escape:(s:string)=>s},crypto:webcrypto,AbortController,setTimeout,clearTimeout,
 document:{activeElement:trigger,querySelectorAll:()=>[]}, $:(id:string)=>{if(!nodes.has(id)) nodes.set(id,node());return nodes.get(id);},el:(_tag:string,_class:string,t:string)=>node(t),
 storageGet:(key:string)=>saved.get(key)||null,storageSet:(key:string,val:string)=>saved.set(key,val),
 api:async(path:string,options?:any)=>{requests.push({path,options});return handler(path,options);},
 renderMessages(){},renderEvidence(){},toast(){},openArchivePlan:async()=>{},
 });
 runInContext(code.slice(code.indexOf('function contractMessage('),code.indexOf('function renderPlanLibrary(')),context);
 return {state,nodes,saved,requests,trigger,context,call:(s:string)=>runInContext(s,context),handle:(fn:typeof handler)=>{handler=fn;}};
}
it('requires positive latest report evidence; unknown, findings, BLOCKED and model failure cannot become waiting',async()=>{
 const h=await setup();
 expect(h.call('waitingForContract(state.run)')).toBe(true);
 for(const mutate of [(d:any)=>delete d.run.issueCount,(d:any)=>d.attempts[0].issueCount=1,(d:any)=>d.attempts[0].validationStatus='BLOCKED',(d:any)=>d.attempts[0].reportStatus='error',(d:any)=>d.run.decision='BLOCKED',(d:any)=>d.modelFailure='gateway error',(d:any)=>d.run.error='missing']){
  h.state.run=detail();mutate(h.state.run);expect(h.call('waitingForContract(state.run)')).toBe(false);
 }
});
it('loads a bound snapshot, cancels with focus restoration and ignores late reads without any POST',async()=>{
 const h=await setup();let finish:any;
 h.handle(async()=>new Promise(resolve=>finish=resolve));
 const pending=h.call("openContractPreview('r1')");
 expect(h.nodes.get('approve-contract').disabled).toBe(true);
 h.call('closeContractPreview()');finish(detail());await pending;
 expect(h.nodes.get('contract-dialog').open).toBe(false);expect(h.trigger.focused).toBe(true);
 expect(h.requests.every(r=>!r.options?.method)).toBe(true);
});
it('validates raw content SHA and identity before enabling an explicit approval',async()=>{
 const h=await setup();await h.call("openContractPreview('r1')");
 expect(h.nodes.get('approve-contract').disabled).toBe(false);
 expect(text(h.nodes.get('contract-preview-content'))).toContain('港口');
 expect(h.requests.map(r=>r.path)).toHaveLength(2);
 h.handle(async(path)=>path.startsWith('/api/runs/')?detail():{content:content+' ',truncated:false});
 await h.call('loadContractPreview()');expect(h.nodes.get('approve-contract').disabled).toBe(true);
 expect(h.nodes.get('contract-error').textContent).toContain('摘要');
});
it('sends all three fields only on approval, guards duplicate clicks and keeps success across reopening and reload',async()=>{
 const h=await setup();await h.call("openContractPreview('r1')");let finish:any;
 h.handle(async()=>new Promise(resolve=>finish=resolve));
 const pending=h.call('approveContract()');await h.call('approveContract()');
 const posts=h.requests.filter(r=>r.options?.method==='POST');expect(posts).toHaveLength(1);
 expect(JSON.parse(posts[0].options.body)).toEqual({runId:'r1',requirementsDigest:digest,contractSha256:sha});
 h.call('closeContractPreview()');expect(h.nodes.get('contract-dialog').open).toBe(true);
 finish({requirementsDigest:digest,contractSha256:sha,contractVersion:'v1',approvedAt:'2026-11-15T03:00:00Z'});await pending;
 expect(h.nodes.get('contract-status').textContent).toContain('已确认');
 expect(h.nodes.get('approve-contract').disabled).toBe(true);
 h.call('closeContractPreview()');h.handle(async(path)=>path.startsWith('/api/runs/')?detail():{content,truncated:false});
 await h.call("openContractPreview('r1')");expect(h.nodes.get('contract-status').textContent).toContain('已确认');
 expect(text(h.call('contractCard(state.run)'))).toContain('已确认');
 expect(h.saved.size).toBe(1);
 const changed=detail();changed.run.contractSha256='b'.repeat(64);h.state.run=changed;
 expect(text(h.call('contractCard(state.run)'))).not.toContain('契约已确认');
});
it.each(['network','500','malformed','wrong-sha'])('preserves an unknown frozen identity on %s and never automatically retries',async failure=>{
 const h=await setup();await h.call("openContractPreview('r1')");
 h.handle(async()=>{if(failure==='wrong-sha')return {requirementsDigest:digest,contractSha256:'b'.repeat(64),contractVersion:'v1'};throw Object.assign(new Error('回包丢失'),failure==='500'?{status:500}:{network:true});});
 await h.call('approveContract()');expect(h.nodes.get('contract-status').textContent).toContain('待核实');
 expect(h.requests.filter(r=>r.options?.method==='POST')).toHaveLength(1);
 h.call('closeContractPreview()');expect(h.nodes.get('contract-dialog').open).toBe(false);
 expect([...h.saved.values()][0]).toContain('unknown');
});
it('shows a human readable 409 rejection and requires rereading instead of resubmitting',async()=>{
 const h=await setup();await h.call("openContractPreview('r1')");
 h.handle(async()=>{throw Object.assign(new Error('当前登记的候选契约已替换，请重新打开预览。'),{status:409});});
 await h.call('approveContract()');expect(h.nodes.get('contract-error').textContent).toContain('已替换');expect(h.nodes.get('approve-contract').disabled).toBe(true);
 expect(h.nodes.get('reload-contract').hidden).toBe(false);
});
it('bounds an unfinished request and response body, unlocks cancel, and retains unknown outcome',async()=>{
 vi.useFakeTimers();
 try {const h=await setup();await h.call("openContractPreview('r1')");
 h.handle(async()=>new Promise(()=>{}));const pending=h.call('approveContract()');await vi.advanceTimersByTimeAsync(30000);await pending;
 expect(h.nodes.get('contract-status').textContent).toContain('待核实');expect(h.nodes.get('close-contract').disabled).toBe(false);
 h.call('closeContractPreview()');expect(h.nodes.get('contract-dialog').open).toBe(false);
 } finally {vi.useRealTimers();}
});
it.each(['missing-report','truncated','invalid-json','wrong-digest'])('disables approval for %s',async failure=>{
 const h=await setup();h.handle(async(path)=>{if(path.startsWith('/api/runs/')){const d=detail();if(failure==='missing-report')d.attempts=[];return d;}return {content:failure==='invalid-json'?'{':failure==='wrong-digest'?JSON.stringify({...contract,requirementsDigest:'c'.repeat(64)}):content,truncated:failure==='truncated'};});
 await h.call("openContractPreview('r1')");expect(h.nodes.get('approve-contract').disabled).toBe(true);
});

it('explains only a proven approval wait in the primary message, while preserving real failures', async()=>{
 const h=await setup();const message={role:'system',runId:'r1',content:'本次运行已结束：操作失败。请查看运行状态与已保存证据。'};
 h.context.message=message;expect(h.call('contractMessage(message).content')).toContain('等待人工确认契约');
 expect(message.content).toContain('操作失败');h.state.run.run.decision='BLOCKED';expect(h.call('contractMessage(message)')).toBe(message);
});
it('keeps a matched success in memory even if browser storage is unavailable',async()=>{
 const h=await setup();h.context.storageSet=()=>{};await h.call("openContractPreview('r1')");await h.call('approveContract()');
 expect(h.nodes.get('contract-status').textContent).toContain('已确认');expect(h.saved.size).toBe(0);
});
it('does not infer a same-content approval from global confirmed status',async()=>{
 const h=await setup();h.state.bootstrap={conversations:[{id:'c1',sourceId:'s1'}],sources:[{id:'s1',contractStatus:'confirmed'}]};h.state.run.run.conversationId='c1';
 expect(text(h.call('contractCard(state.run)'))).toContain('当前确认状态待核实');
});
it('keeps unknown status when retry of the frozen identity is rejected and never sends a new identity',async()=>{
 const h=await setup();await h.call("openContractPreview('r1')");h.handle(async()=>{throw Object.assign(new Error('lost'),{network:true});});await h.call('approveContract()');
 h.handle(async()=>{throw Object.assign(new Error('replaced'),{status:409});});await h.call('approveContract()');
 expect(h.nodes.get('contract-status').textContent).toContain('待核实');
 const posts=h.requests.filter(r=>r.options?.method==='POST');expect(posts).toHaveLength(2);expect(posts[0].options.body).toBe(posts[1].options.body);
});
it('ignores an old response after cancellation and reopening another preview',async()=>{
 const h=await setup();let finish:any;h.handle(async()=>new Promise(resolve=>finish=resolve));const old=h.call("openContractPreview('r1')");h.call('closeContractPreview()');
 h.handle(async(path)=>path.startsWith('/api/runs/')?detail():{content,truncated:false});await h.call("openContractPreview('r1')");
 const current=h.state.contractPreview;finish({...detail(),run:{...detail().run,contractSha256:'b'.repeat(64)}});await old;
 expect(h.state.contractPreview).toBe(current);expect(h.nodes.get('approve-contract').disabled).toBe(false);
});

it('prioritizes BLOCKED and findings over a global confirmed source label',async()=>{
 const h=await setup();h.state.bootstrap={conversations:[{id:'c1',sourceId:'s1'}],sources:[{id:'s1',contractStatus:'confirmed'}]};h.state.run.run.conversationId='c1';h.state.run.run.decision='BLOCKED';h.state.run.run.issueCount=3;
 expect(text(h.call('contractCard(state.run)'))).toContain('本次运行已阻断');expect(text(h.call('contractCard(state.run)'))).not.toContain('当前确认状态待核实');
});

it.each(['approved','unknown'])('keeps chat and card consistent for %s receipts, including a new page context restored from storage',async status=>{
 const h=await setup();await h.call("openContractPreview('r1')");h.context.status=status;h.call('saveContractApproval(state.contractPreview, status)');
 const restored=await setup(new Map(h.saved));
 for(const page of [h,restored]){
  page.context.message={role:'system',runId:'r1',content:'本次运行已结束：操作失败。请查看运行状态与已保存证据。'};
  const message=page.call('contractMessage(message).content');
  expect(message).toContain(status==='approved'?'已确认':'待核实');expect(message).not.toContain('等待人工确认契约');expect(message).not.toContain('核对规则后批准');
  expect(text(page.call('contractCard(state.run)'))).toContain(status==='approved'?'已确认':'待核实');
  if(page.nodes.get('contract-dialog')?.open) page.call('closeContractPreview()');
  await page.call("openContractPreview('r1')");expect(page.nodes.get('contract-status').textContent).toContain(status==='approved'?'已确认':'待核实');
 }
});
