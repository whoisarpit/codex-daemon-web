import {useEffect,useState} from "react";
import type {RpcClient} from "./protocol";

export type ThreadGoalStatus = "active"|"paused"|"blocked"|"usageLimited"|"budgetLimited"|"complete";
export type ThreadGoal = {
  threadId:string;objective:string;status:ThreadGoalStatus;
  tokenBudget:number|null;tokensUsed:number;timeUsedSeconds:number;
  createdAt:number;updatedAt:number;
};
const labels:Record<ThreadGoalStatus,string>={
  active:"Active",paused:"Paused",blocked:"Blocked",
  usageLimited:"Usage limited",budgetLimited:"Budget limited",complete:"Complete",
};
const editableStatuses:ThreadGoalStatus[]=["active","paused","blocked","complete"];
const format=(value:number)=>Number.isFinite(value)?Math.round(value).toLocaleString():"—";

export default function ThreadGoalPanel({
  client,threadId,revision=0,onError,
}:{
  client:RpcClient|null;threadId:string;revision?:number;
  onError:(message:string)=>void;
}){
  const [goal,setGoal]=useState<ThreadGoal|null>(null);
  const [objective,setObjective]=useState("");
  const [budget,setBudget]=useState("");
  const [status,setStatus]=useState<ThreadGoalStatus>("active");
  const [loading,setLoading]=useState(true);
  const [reload,setReload]=useState(0);
  const [editing,setEditing]=useState(false);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");
  useEffect(()=>{
    let cancelled=false;
    setGoal(null);setLoading(true);setEditing(false);setMessage("");
    if(!client){setLoading(false);return;}
    void client.request<{goal:ThreadGoal|null}>("thread/goal/get",{threadId})
      .then(result=>{
        if(cancelled)return;
        setGoal(result.goal);
        setObjective(result.goal?.objective||"");
        setBudget(result.goal?.tokenBudget==null?"":String(result.goal.tokenBudget));
        setStatus(result.goal?.status||"active");
      })
      .catch(error=>{if(!cancelled)setMessage("Could not load goal: "+String(error));})
      .finally(()=>{if(!cancelled)setLoading(false);});
    return()=>{cancelled=true;};
  },[client,threadId,revision,reload]);

  const save=async()=>{
    if(!client||busy||!objective.trim())return;
    const value=budget.trim()?Number(budget):null;
    if(value!==null&&(!Number.isSafeInteger(value)||value<=0)){setMessage("Token budget must be a positive integer.");return;}
    setBusy(true);setMessage("");
    try{
      const result=await client.request<{goal:ThreadGoal}>("thread/goal/set",{
        threadId,origin:"user",objective:objective.trim(),status,tokenBudget:value,
      });
      setGoal(result.goal);setEditing(false);setMessage("Goal saved.");
    }catch(error){setMessage("Could not save goal: "+String(error));onError(String(error));}
    finally{setBusy(false);}
  };
  const changeStatus=async(next:ThreadGoalStatus)=>{
    if(!client||!goal||busy)return;
    setBusy(true);setMessage("");
    try{
      const result=await client.request<{goal:ThreadGoal}>("thread/goal/set",{
        threadId,origin:"user",status:next,
      });
      setGoal(result.goal);setStatus(result.goal.status);
    }catch(error){setMessage("Could not update goal status: "+String(error));}
    finally{setBusy(false);}
  };
  const clear=async()=>{
    if(!client||!goal||busy)return;
    if(!window.confirm("Clear this conversation goal? This does not delete the conversation."))return;
    setBusy(true);setMessage("");
    try{
      const result=await client.request<{cleared:boolean}>("thread/goal/clear",{threadId,origin:"user"});
      if(result.cleared){setGoal(null);setObjective("");setBudget("");setStatus("active");setEditing(false);}
      else setMessage("Codex did not clear the goal.");
    }catch(error){setMessage("Could not clear goal: "+String(error));}
    finally{setBusy(false);}
  };
  return <section className="thread-goal-panel" aria-label="Conversation goal">
    <div className="thread-goal-heading">
      <strong>Goal mode</strong>
      {goal?<span className={"thread-goal-state state-"+goal.status}>{labels[goal.status]}</span>:null}
      <span className="thread-goal-actions">
        {!loading&&!editing?<button type="button" onClick={()=>setReload(value=>value+1)}
          disabled={busy}>Refresh</button>:null}
        {goal&&!editing?<button type="button" onClick={()=>setEditing(true)} disabled={busy}>Edit</button>:null}
        {!goal&&!loading&&!editing?<button type="button" onClick={()=>setEditing(true)}>Set goal</button>:null}
      </span>
    </div>
    {loading?<small>Loading goal…</small>:null}
    {goal&&!editing?<>
      <p className="thread-goal-objective">{goal.objective}</p>
      <div className="thread-goal-metrics">
        <span>Tokens: {format(goal.tokensUsed)}{goal.tokenBudget!==null?" / "+format(goal.tokenBudget):" (no budget)"}</span>
        <span>Time: {format(goal.timeUsedSeconds)} sec</span>
      </div>
      {goal.tokenBudget&&goal.tokenBudget>0?<progress max={goal.tokenBudget} value={Math.min(goal.tokensUsed,goal.tokenBudget)} aria-label="Goal token budget usage"/>:null}
      <div className="thread-goal-actions">
        {editableStatuses.filter(next=>next!==goal.status).map(next=>
          <button key={next} type="button" onClick={()=>void changeStatus(next)} disabled={busy}>{labels[next]}</button>)}
        <button type="button" className="thread-goal-danger" onClick={()=>void clear()} disabled={busy}>Clear goal</button>
      </div>
    </>:null}
    {editing?<div className="thread-goal-editor">
      <label>Objective<textarea value={objective} rows={3} maxLength={12000}
        onChange={event=>setObjective(event.target.value)} placeholder="Define the outcome for this conversation…"/></label>
      <label>Token budget (optional)<input inputMode="numeric" type="number" min={1} step={1}
        value={budget} onChange={event=>setBudget(event.target.value)} placeholder="Unlimited"/></label>
      <label>Status<select value={status} onChange={event=>setStatus(event.target.value as ThreadGoalStatus)}>
        {editableStatuses.map(s=><option key={s} value={s}>{labels[s]}</option>)}
      </select></label>
      <div className="thread-goal-actions">
        <button type="button" disabled={busy||!objective.trim()} onClick={()=>void save()}>{busy?"Saving…":"Save goal"}</button>
        <button type="button" disabled={busy} onClick={()=>setEditing(false)}>Cancel</button>
      </div>
    </div>:null}
    {message?<small role="status">{message}</small>:null}
    <small className="thread-goal-note">Goal metadata is managed by Codex. Setting a goal does not itself start an automatic execution loop.</small>
  </section>;
}
