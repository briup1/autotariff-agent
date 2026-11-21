import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {createContext,runInContext} from "node:vm";
import {expect,it} from "vitest";
import {PROJECT_ROOT} from "../src/closure/paths.js";

async function callout(status:string,planStatus="confirmed"){
 const source=await readFile(resolve(PROJECT_ROOT,"web/app.js")),requests:string[]=[],opened:unknown[]=[];
 let rendered=0,scrolled=0;
 function node(text=""){return {textContent:text,children:[] as any[],handlers:{} as Record<string,()=>unknown>,append(...children:any[]){this.children.push(...children);},addEventListener(event:string,fn:()=>unknown){this.handlers[event]=fn;}};}
 const state:any={evidenceTab:"activity",run:{run:{planId:"p1",decision:"REVIEW",reuseCheckStatus:status},selectedAttemptId:"a1",attempts:[{id:"a1"}]}};
 const context=createContext({state,document:{createTextNode:(text:string)=>node(text)},el:(_tag:string,_class:string,text:string)=>Object.assign(node(text),{tag:_tag}),tone:()=>"warn",toast(){},
  $:()=>({querySelector:()=>({scrollIntoView(){scrolled++;}})}),setEvidenceTab(tab:string){state.evidenceTab=tab;rendered++;},setMobileTab(tab:string){state.mobileTab=tab;},openPlanVersion:async(plan:unknown)=>{opened.push(plan);},
  api:async(path:string)=>{requests.push(path);return {plan:{planId:"p1",name:"怡升昌",status:planStatus,currentVersionId:"v1"}};}});
 runInContext(source.toString().slice(source.toString().indexOf("function runCallout("),source.toString().indexOf("function renderActivity(")),context);
 const result=runInContext("runCallout()",context);
 return {result,requests,opened,state,counts:()=>({rendered,scrolled})};
}
function text(node:any):string{return (node.textContent||"")+node.children.map(text).join(" ");}
function buttons(node:any):any[]{return [...(node.tag==="button"?[node]:[]),...node.children.flatMap(buttons)];}

it("prompts manual review and opens new-version confirmation only after an explicit click",async()=>{
 const {result,requests,opened,state,counts}=await callout("findings");
 expect(text(result)).toContain("版式可能变化");expect(requests).toEqual([]);expect(opened).toEqual([]);
 const actions=buttons(result);expect(actions.map(b=>b.textContent)).toEqual(["人工复核检查问题","创建新版本"]);
 actions[0].handlers.click();expect(state.evidenceTab).toBe("results");expect(state.mobileTab).toBe("results");expect(counts()).toEqual({rendered:1,scrolled:1});
 await actions[1].handlers.click();expect(requests).toEqual(["/api/plans/p1"]);expect(opened).toHaveLength(1);
});

it("keeps clean results behind a business approval gate and unavailable reports visibly uncertain",async()=>{
 const clean=await callout("clean"),missing=await callout("unavailable");
 expect(text(clean.result)).toContain("零问题不代表业务批准");
 expect(text(missing.result)).toContain("不能确认检查问题");
 expect(buttons(clean.result)).toEqual([]);expect(buttons(missing.result)).toEqual([]);
});

it("does not restore an inactive plan or append a version when the review action is clicked",async()=>{
 const {result,requests,opened}=await callout("findings","inactive");
 await buttons(result)[1].handlers.click();
 expect(requests).toEqual(["/api/plans/p1"]);expect(opened).toEqual([]);
});
