import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubagentReturnLoop, relayClientId } from "./subagent-return-loop.js";

const assert = (condition: unknown, message: string) => {
  if (!condition) throw Error(message);
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const childSource = { subAgent:{thread_spawn:{parent_thread_id:"parent"}} };

async function check() {
  const dir=await mkdtemp(join(tmpdir(),"codex-relay-queue-test-"));
  const path=join(dir,"state.json");
  const now=Math.floor(Date.now()/1000);
  let updated=now-240, turnId="old-turn", parentStatus="active";
  let failAddAfterPersist=false, consumeBeforeAck=false, cold=false, resumeCalls=0;
  let queueAdds=0, oldTurnStarts=0, queueListCalls=0;
  const queued: {id:string;clientUserMessageId:string;input:unknown[]}[]=[];
  const consumed: typeof queued=[];
  const parent=()=>({id:"parent",status:{type:parentStatus},updatedAt:now-200});
  const child=()=>({id:"child",status:{type:"idle"},updatedAt:updated,source:childSource});
  const sibling={id:"sibling",status:{type:"active"},updatedAt:now-50,source:childSource};
  const historyless={id:"historyless",status:{type:"notLoaded"},updatedAt:now-300,source:childSource};
  const connect=async()=>({
    call:async(method:string,params:any)=>{
      if(method==="thread/list")
        return {data:params.sourceKinds.includes("subAgent")?[child(),sibling,historyless]:[parent()],nextCursor:null};
      if(method==="thread/turns/list"){
        if(params.threadId==="historyless")return {data:[],nextCursor:null};
        if(params.threadId==="parent")return {data:consumed.map(x=>({id:x.id,items:[{type:"userMessage",clientId:x.clientUserMessageId,content:x.input}]})),nextCursor:null};
        return {data:[{id:turnId,status:"completed",items:params.itemsView==="full"?
          [{type:"agentMessage",text:"Completed research."}]:[]}],nextCursor:null};
      }
      if(method==="thread/queue/list"){
        queueListCalls++;
        return {data:queued,nextCursor:null};
      }
      if(method==="thread/queue/add"){
        queueAdds++;
        assert(params.threadId==="parent","wrong destination");
        assert(params.input?.[0]?.text.includes("Completed research."),"missing child result");
        assert(typeof params.clientUserMessageId==="string","missing stable ID");
        queued.push({id:"q-"+queueAdds,clientUserMessageId:params.clientUserMessageId,input:params.input});
        if(failAddAfterPersist){failAddAfterPersist=false;if(consumeBeforeAck){consumeBeforeAck=false;consumed.push(queued.pop()!);}throw Error("ack lost");}
        return {queuedSubmission:queued.at(-1)};
      }
      if(method==="thread/read")return {thread:{status:{type:cold?"notLoaded":parentStatus}}};
      if(method==="thread/resume"){resumeCalls++;return {thread:{status:{type:"idle"}}};}
      if(method==="turn/start"){oldTurnStarts++;throw Error("must never call turn/start");}
      throw Error("Unexpected RPC "+method);
    },
    close:()=>{},
  });
  const loop=new SubagentReturnLoop(path,connect as any);
  try {
    await loop.start();
    await sleep(100);
    assert(loop.status().initialized,"baseline absent");
    const baseline=JSON.parse(await readFile(path,"utf8"));
    assert(Object.keys(baseline.seen).length===2,"historical child baseline wrong");
    assert(queueAdds===0,"old work replayed");

    // The parent and a sibling are active: the completion still enters Queue.
    updated+=30;turnId="first-new";
    await (loop as any).tick();await sleep(100);
    assert(queueAdds===1&&loop.status().delivered===1,"active parent or sibling blocked queue");
    assert(oldTurnStarts===0,"legacy turn/start was used");
    const key="child:first-new";
    assert(queued[0].clientUserMessageId===relayClientId(key),"unstable queue client ID");
    await (loop as any).tick();await sleep(50);
    assert(queueAdds===1,"duplicate queue add after success");

    // A lost ACK cannot authorize an immediate second queue/add.
    updated+=30;turnId="second-new";failAddAfterPersist=true;
    await (loop as any).tick();await sleep(100);
    assert(loop.status().uncertain===1&&queueAdds===2,"lost ACK not marked uncertain");
    (loop as any).retryAt.clear();
    await (loop as any).tick();await sleep(100);
    assert(queueAdds===2&&loop.status().delivered===2,"reconciliation duplicated a queued message");
    assert(queueListCalls>0,"uncertain submission never checked Queue");

    updated+=30;turnId="third-new";failAddAfterPersist=true;consumeBeforeAck=true;
    await (loop as any).tick();await sleep(100);
    assert(queueAdds===3&&loop.status().uncertain===1,"consumed ACK failure");
    (loop as any).retryAt.clear();
    await (loop as any).tick();await sleep(100);
    assert(queueAdds===3&&loop.status().delivered===3,"consumed result duplicated");

    // A cold parent is resumed after queue/add so Codex dispatches it.
    cold=true;parentStatus="notLoaded";
    updated+=30;turnId="fourth-new";
    await (loop as any).tick();await sleep(100);
    assert(queueAdds===4&&resumeCalls===1,"cold parent did not resume after queueing");
    assert(loop.status().delivered===4,"cold queue submission not recorded");
    assert(oldTurnStarts===0,"legacy direct turn execution called");
    const saved=JSON.parse(await readFile(path,"utf8"));
    assert(Object.values(saved.jobs).length===4,"persistent job checkpoint missing");
    console.log("SUBAGENT_QUEUE_TESTS_PASS baseline/parent-active/sibling-active/ack-reconciliation/dedupe/consumed-ack-recovery/cold-resume/no-turn-start");
  } finally {
    loop.stop();
    await rm(dir,{recursive:true,force:true});
  }
}
await check();
