import {useEffect,useState} from "react";
import type {RpcClient} from "./protocol";
type WindowQuota={usedPercent:number;windowDurationMins:number;resetsAt:number|null};
type LimitBucket={primary?:WindowQuota|null;secondary?:WindowQuota|null};
type RateLimits={rateLimits?:LimitBucket|null;rateLimitsByLimitId?:Record<string,LimitBucket>};
function windowLabel(minutes:number) {
  if(minutes===300)return "5h";
  if(minutes===10080)return "7d";
  return minutes<60?minutes+"m":minutes%1440===0?minutes/1440+"d":minutes%60===0?minutes/60+"h":minutes+"m";
}
export default function SidebarQuota({rpc,online}:{rpc:RpcClient|null;online:boolean}) {
  const [windows,setWindows]=useState<WindowQuota[]>([]);
  const [error,setError]=useState(false);
  useEffect(()=>{
    if(!rpc||!online){setWindows([]);return;}
    let cancelled=false;
    const refresh=()=>void rpc.request<RateLimits>("account/rateLimits/read")
      .then(data=>{
        if(cancelled)return;
        const bucket=data.rateLimitsByLimitId?.codex || data.rateLimits ||
          Object.values(data.rateLimitsByLimitId||{})[0];
        setWindows([bucket?.primary,bucket?.secondary].filter((v):v is WindowQuota=>!!v));
        setError(false);
      }).catch(()=>{if(!cancelled)setError(true)});
    refresh();
    const timer=window.setInterval(refresh,60_000);
    return ()=>{cancelled=true;window.clearInterval(timer);};
  },[rpc,online]);
  if(!online)return null;
  if(error && !windows.length)return <span className="sidebar-quota-error" title="Quota unavailable">Quota —</span>;
  if(!windows.length)return null;
  return <div className="sidebar-quota" aria-label="Codex remaining quota">
    {windows.map((quota,i)=>{
      const remaining=Math.max(0,Math.min(100,100-quota.usedPercent));
      return <span key={i} title={`${windowLabel(quota.windowDurationMins)} window: ${remaining.toFixed(1)}% remaining. Resets ${quota.resetsAt?new Date(quota.resetsAt*1000).toLocaleString():"unknown"}`}>
        <strong>{windowLabel(quota.windowDurationMins)}</strong> {Math.round(remaining)}%
      </span>;
    })}
  </div>;
}
