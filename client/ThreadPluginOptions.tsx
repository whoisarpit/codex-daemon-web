import { useEffect, useState } from "react";
import type { RpcClient } from "./protocol";

type Plugin = {id:string; name:string; installed:boolean; enabled:boolean};
export default function ThreadPluginOptions({rpc,visible,threadId,disabledIds,onChange}:{
  rpc:RpcClient|null;visible:boolean;threadId:string|null;disabledIds:string[];onChange:(next:string[])=>void;
}) {
  const [plugins,setPlugins]=useState<Plugin[]>([]);
  const [loading,setLoading]=useState(false);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState("");
  useEffect(()=>{
    if(!rpc||!visible)return;
    let cancelled=false;
    setLoading(true);setError("");
    void rpc.request<{marketplaces:Array<{plugins:Plugin[]}>}>("plugin/installed",{})
      .then(res=>{if(cancelled)return;const unique=new Map<string,Plugin>();for(const m of res.marketplaces||[])for(const p of m.plugins||[])if(p.installed)unique.set(p.id,p);setPlugins([...unique.values()].sort((a,b)=>a.name.localeCompare(b.name)));})
      .catch(e=>{if(!cancelled)setError(String(e));})
      .finally(()=>{if(!cancelled)setLoading(false);});
    return ()=>{cancelled=true};
  },[rpc,visible]);
  const toggle=async(p:Plugin)=>{
    if(!rpc||saving)return;
    const next=disabledIds.includes(p.id)?disabledIds.filter(id=>id!==p.id):[...disabledIds,p.id];
    if(!threadId){onChange(next);return;}
    setSaving(true);setError("");
    try{await rpc.request("thread/settings/update",{threadId,disabledPluginIds:next});onChange(next);}
    catch(e){setError(e instanceof Error?e.message:String(e));}
    finally{setSaving(false);}
  };
  return <div className="codex-thread-plugins">
    <h3 className="settings-section-title">Current conversation · installed plugins</h3>
    <p className="codex-extensions-note"><strong>Preference only:</strong> Codex 0.166 stores disabled plugin IDs but does not yet filter plugin capabilities. Turning a plugin off here does not prevent its tools from being invoked.</p>
    {loading?<p className="codex-extensions-note">Loading installed plugins…</p>:plugins.map(p=><div className="codex-plugin-row" key={p.id}>
      <div><strong>{p.name}</strong><span>{p.enabled?"Globally enabled":"Globally disabled"}</span></div>
      <button type="button" className="settings-toggle" disabled={saving||!rpc||!p.enabled} aria-pressed={!disabledIds.includes(p.id)} onClick={()=>void toggle(p)}>{disabledIds.includes(p.id)?"Off":"On"}</button>
    </div>)}
    {error?<p className="codex-extension-error" role="alert">{error}</p>:null}
  </div>;
}
