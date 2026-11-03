import { useCallback, useEffect, useState } from "react";
import type { RpcClient } from "./protocol";

type AppEntry = { id: string; runtimeName: string | null; enabled: boolean; callable: boolean };
type PluginEntry = {id: string; name: string; installed: boolean; enabled: boolean};
type PluginMarketplace = {name: string; plugins: PluginEntry[]};
type AccountInfo = { type: string; email?: string; planType?: string; workspaceName?: string };
type LimitWindow = { usedPercent: number; windowDurationMins: number; resetsAt: number | null };
type LimitBucket = { limitId: string; limitName: string | null; primary: LimitWindow | null; secondary: LimitWindow | null; planType?: string };
type Limits = { rateLimits?: LimitBucket | null; rateLimitsByLimitId?: Record<string, LimitBucket>; rateLimitResetCredits?: {availableCount: number} | null };
type Usage = { summary?: Record<string, unknown> };

function localTime(seconds: number | null | undefined) {
  return typeof seconds === "number" && Number.isFinite(seconds) ? new Date(seconds * 1000).toLocaleString() : "Unknown";
}
function RateWindow({ label, data }: {label: string; data: LimitWindow | null}) {
  if (!data) return null;
  const used = Number.isFinite(data.usedPercent) ? Math.max(0, Math.min(100, data.usedPercent)) : null;
  return <div className="codex-rate-window">
    <div className="codex-rate-title"><strong>{label}</strong><span>{used === null ? "Unavailable" : `${(100-used).toFixed(1)}% remaining`}</span></div>
    <div className="codex-rate-track" role="progressbar" aria-label={`${label} used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={used ?? undefined}><div style={{width:`${used??0}%`}} /></div>
    <small>{used === null ? "Usage unknown" : `${used.toFixed(1)}% used`} · Resets {localTime(data.resetsAt)}</small>
  </div>;
}
export default function CodexAccountPlugins({ rpc, visible }: {rpc: RpcClient | null; visible: boolean}) {
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [limits, setLimits] = useState<Limits | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [installedPlugins, setInstalledPlugins] = useState<PluginEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const refresh = useCallback(async () => {
    if (!rpc) return;
    setBusy(true); setError("");
    const results = await Promise.allSettled([
      rpc.request<{account: AccountInfo | null}>("account/read", {refreshToken:false}),
      rpc.request<Limits>("account/rateLimits/read"),
      rpc.request<{apps: AppEntry[]}>("app/installed"),
      rpc.request<Usage>("account/usage/read"),
      rpc.request<{marketplaces:PluginMarketplace[]}>("plugin/installed",{}),
    ]);
    if (results[0].status === "fulfilled") setAccount(results[0].value.account);
    if (results[1].status === "fulfilled") setLimits(results[1].value);
    if (results[2].status === "fulfilled") setApps(results[2].value.apps || []);
    if (results[3].status === "fulfilled") setUsage(results[3].value);
    if (results[4].status === "fulfilled") {
      const list = new Map<string,PluginEntry>();
      for (const market of results[4].value.marketplaces || [])
        for (const plugin of market.plugins || []) if (plugin.installed) list.set(plugin.id,plugin);
      setInstalledPlugins([...list.values()].sort((a,b)=>a.name.localeCompare(b.name)));
    }
    const failed = results.map((result,index) => result.status === "rejected" ? ["Account", "Rate limits", "Apps", "Token usage", "Installed plugins"][index] : null).filter(Boolean);
    if (failed.length) setError(`Could not refresh: ${failed.join(", ")}. Other data may still be current.`);
    setBusy(false);
  }, [rpc]);
  useEffect(() => {
    if (!visible || !rpc) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(timer);
  }, [visible, rpc, refresh]);
  const setEnabled = async (app: AppEntry) => {
    if (!rpc || saving || !/^[a-zA-Z0-9_]+$/.test(app.id)) return;
    setSaving(app.id); setFeedback(""); setError("");
    try {
      await rpc.request("config/value/write", {
        keyPath:`apps.${app.id}.enabled`, value: !app.enabled, mergeStrategy:"upsert",
      });
      const result = await rpc.request<{apps:AppEntry[]}>("app/installed", {forceRefresh:true});
      setApps(result.apps || []);
      const actual = result.apps?.find((entry) => entry.id === app.id);
      setFeedback(actual?.enabled === !app.enabled
        ? `${app.runtimeName || app.id}: global setting saved and runtime state verified.`
        : `${app.runtimeName || app.id}: config saved, but the runtime has not reflected the change. Existing threads may retain their prior configuration.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update plugin setting");
    } finally { setSaving(null); }
  };
  const buckets = Object.values(limits?.rateLimitsByLimitId || {});
  if (!buckets.length && limits?.rateLimits) buckets.push(limits.rateLimits);
  const tokenTotal = usage?.summary?.lifetimeTokens;
  return <div className="codex-extensions">
    <div className="codex-extension-heading"><h3 className="settings-section-title">Codex account & limits</h3><button type="button" className="settings-toggle" onClick={() => void refresh()} disabled={busy || !rpc}>{busy ? "Refreshing…" : "Refresh"}</button></div>
    <div className="codex-account-lines">
      <div><span>Account</span><strong>{account?.email || account?.type || "Unavailable"}</strong></div>
      <div><span>Subscription</span><strong>{account?.planType || "Unknown"}</strong></div>
      {account?.workspaceName ? <div><span>Workspace</span><strong>{account.workspaceName}</strong></div> : null}
      {typeof tokenTotal === "number" ? <div><span>Lifetime tokens</span><strong>{tokenTotal.toLocaleString()}</strong></div> : null}
    </div>
    {buckets.length ? buckets.map((bucket,index) => <div className="codex-rate-bucket" key={bucket.limitId || index}>
      <strong>{bucket.limitName || bucket.limitId || "Codex quota"}</strong>
      <RateWindow label={bucket.primary?.windowDurationMins ? `${bucket.primary.windowDurationMins}-minute window` : "Primary window"} data={bucket.primary}/>
      <RateWindow label={bucket.secondary?.windowDurationMins ? `${bucket.secondary.windowDurationMins}-minute window` : "Secondary window"} data={bucket.secondary}/>
    </div>) : <p className="codex-extensions-note">No ChatGPT subscription quota reported by the daemon.</p>}
    {typeof limits?.rateLimitResetCredits?.availableCount === "number" ? <p className="codex-extensions-note">Available rate-limit resets: {limits.rateLimitResetCredits.availableCount}</p> : null}
    <div className="codex-extension-heading"><h3 className="settings-section-title">Installed Codex plugins</h3><span>{installedPlugins.length} installed</span></div>
    <p className="codex-extensions-note">Read from the daemon's installed-plugin registry. Disabled-plugin preferences saved per conversation are not yet enforced by Codex 0.166.</p>
    {installedPlugins.map(plugin => <div className="codex-plugin-row" key={plugin.id}>
      <div><strong>{plugin.name}</strong><span>{plugin.enabled ? "Installed · enabled" : "Installed · disabled"} · {plugin.id}</span></div>
    </div>)}
    <div className="codex-extension-heading"><h3 className="settings-section-title">Connected apps · global controls</h3><span>{apps.length} apps</span></div>
    <p className="codex-extensions-note">These switches change the daemon-wide app configuration for all conversations, not only this chat. Managed policy or authentication may still prevent an enabled app from being callable.</p>
    {apps.length ? apps.map(app => <div className="codex-plugin-row" key={app.id}>
      <div><strong>{app.runtimeName || app.id}</strong><span>{app.callable ? "Callable" : app.enabled ? "Enabled · not callable" : "Disabled"}</span></div>
      <button className="settings-toggle" type="button" aria-label={`${app.runtimeName || app.id} enabled`} aria-pressed={app.enabled} disabled={!!saving || busy || !rpc || !/^[a-zA-Z0-9_]+$/.test(app.id)} onClick={() => void setEnabled(app)}>{saving === app.id ? "Saving…" : app.enabled ? "On" : "Off"}</button>
    </div>) : <p className="codex-extensions-note">No installed apps returned. Check your connection or refresh.</p>}
    {feedback ? <p className="codex-extension-success" role="status">{feedback}</p> : null}
    {error ? <p className="codex-extension-error" role="alert">{error}</p> : null}
  </div>;
}
