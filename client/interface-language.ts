/**
 * Reversible interface localization. Only known UI strings are translated:
 * arbitrary chat output, project names and user-provided thread titles are not.
 */
export type InterfaceLanguage = "en" | "zh";
export const languageStorageKey = "codexdesk.language";
export function readInterfaceLanguage(): InterfaceLanguage {
  try {
    const saved=localStorage.getItem(languageStorageKey);
    if(saved==="en"||saved==="zh")return saved;
  }catch { /* storage may be blocked */ }
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}
const strings:Record<string,string> = {
  "A few questions":"几个问题",
  "A saved queue recovery is waiting in another conversation. Resolve it there before steering another message.":"其他会话存在待恢复的消息队列，请先处理。",
  "ADDITIONAL PERMISSIONS":"附加权限",
  "Allow this session":"允许本次会话",
  "Allow once":"仅允许一次",
  "Allow this command?":"允许执行此命令？",
  "Allow these file changes?":"允许修改这些文件？",
  "Allow this turn":"允许本轮",
  "Decline":"拒绝",
  "Decline request":"拒绝请求",
  "Decline unsupported request":"拒绝不支持的请求",
  "Choose…":"选择…",
  "File changes":"文件修改",
  "Queued message":"已排队消息",
  "Sending…":"正在发送…",
  "Queuing…":"正在加入队列…",
  "Submitted · syncing…":"已提交 · 正在同步…",
  "Delivery unconfirmed":"未确认是否送达",
  "Check and restore draft":"检查并恢复草稿",
  "Message submitted":"消息已提交",
  "Message delivery could not be confirmed":"消息是否送达尚未确认",
  "Codex already received this message. No retry is needed.":"Codex 已收到这条消息，无须重发。",
  "This message is already in the queue. No retry is needed.":"消息已在队列中，无须重发。",
  "Draft restored. Verify it was not delivered before sending again.":"草稿已恢复。再次发送前请确认消息没有送达。",

  "Try again":"重试",
  "Image attachment":"图片附件",
  "Audio attachment":"音频附件",
  "Browser":"浏览器",
  "Browser tab":"浏览器标签页",
  "Command actions":"命令操作",
  "COMMAND APPROVAL":"命令审批",
  "FILE CHANGE APPROVAL":"文件修改审批",
  "CLIENT TOOL REQUEST":"客户端工具请求",
  "CODEX NEEDS YOUR INPUT":"CODEX 需要你的输入",
  "Can’t reach the server":"无法连接服务器",
  "Check status":"检查状态",
  "Checking queued messages…":"检查排队消息中…",
  "Codex daemon unavailable":"Codex daemon 不可用",
  "Codex is working":"Codex 正在工作",
  "Codex needs a response":"Codex 需要回复",
  "Full tool parameters":"完整工具参数",
  "Context":"上下文",
  "Context summarized":"上下文已总结",
  "At an interval":"按间隔执行",
  "Attach image":"附加图片",
  "Done":"完成",
  "Enter":"确认",
  "Explore this project":"探索此项目",
  "Get a quick overview of the codebase":"快速了解代码库",
  "Describe a task and work through it":"描述任务并逐步执行",
  "Ask Codex to explore, build, or explain something in your workspace.":"让 Codex 探索、开发或解释工作空间中的内容。",
  "Keep current policy":"保持当前策略",
  "Keep current sandbox":"保持当前沙箱",
  "Load earlier messages":"加载更早的消息",
  "All tasks":"全部任务",
  "Scheduled":"已计划",
  "Archived":"已归档",
  "Advanced":"高级",
  "Destination":"目标",
  "Command and output were not included in this activity item.":"此活动条目未包含命令和输出。",
  "I completed the request":"我已完成请求",
  // Primary navigation, projects, status.
  "YOUR PRIVATE WORKSPACE":"你的私人工作空间",
  "Connect to Codex":"连接到 Codex",
  "Enter your access token to open a secure connection to your Codex daemon.":"输入访问令牌，与 Codex daemon 建立安全连接。",
  "Access token":"访问令牌",
  "Paste your token":"粘贴访问令牌",
  "Open workspace":"打开工作空间",
  "Connecting…":"连接中…",
  "Your token stays on this server and is not stored in your browser.":"令牌仅保留在服务器上，不会存储在浏览器中。",
  "A focused interface for the official Codex daemon":"官方 Codex daemon 专用工作界面",
  "New chat":"新建会话",
  "New conversation":"新建会话",
  "Goal mode":"目标模式",
  "Set goal":"设置目标",
  "Save goal":"保存目标",
  "Clear goal":"清除目标",
  "Goal saved.":"目标已保存。",
  "Loading goal…":"正在读取目标…",
  "Objective":"目标描述",
  "Token budget (optional)":"Token 预算（可选）",
  "Unlimited":"无限制",
  "Active":"进行中",
  "Paused":"已暂停",
  "Blocked":"已阻塞",
  "Usage limited":"用量受限",
  "Budget limited":"预算受限",
  "Complete":"已完成",
  "Tokens:":"Token：",
  "Time:":"用时：",
  "Token budget must be a positive integer.":"Token 预算必须为正整数。",
  "Goal metadata is managed by Codex. Setting a goal does not itself start an automatic execution loop.":"目标状态由 Codex 管理。设置目标不会自动启动连续执行任务。",
  "File preview":"文件预览",
  "Preview image:":"预览图片：",
  "Reading file…":"正在读取文件…",
  "This path is a directory.":"目标路径是文件夹。",
  "Not a regular file.":"不是普通文件。",
  "File exceeds the 2.5 MB preview limit.":"文件超出 2.5MB 预览限制。",
  "Binary file; inline preview is unavailable.":"二进制文件暂不支持内嵌预览。",

  "Chats":"会话",
  "Conversations":"会话",
  "History":"历史记录",
  "Scheduled tasks":"定时任务",
  "Tasks":"任务",
  "Search conversations":"搜索会话",
  "Find a conversation":"搜索会话",
  "Close conversation search":"关闭会话搜索",
  "Close sidebar":"关闭侧边栏",
  "Collapse sidebar":"收起侧边栏",
  "Open history":"打开历史记录",
  "Projects":"项目",
  "Project":"项目",
  "View":"视图",
  "Work status":"工作状态",
  "Sort":"排序",
  "Recent activity":"最近活动",
  "Project name":"项目名称",
  "Load more":"加载更多",
  "Load more conversations":"加载更多会话",
  "Show more":"显示更多",
  "Show less":"收起",
  "No conversations":"没有会话",
  "No project":"未加入项目",
  "No project (remove from project)":"不属于任何项目（移出项目）",
  "Destination project":"目标项目",
  "New conversation project":"新会话所属项目",
  "New conversation project in options":"新会话所属项目",
  "Saved as the official Codex project ID when this conversation starts.":"会话创建时写入 Codex 官方项目 ID。",
  "Move this conversation to a Codex project":"移动当前会话至 Codex 项目",
  "Move conversation to project":"移动会话至项目",
  "This updates the Codex project assignment, not the conversation's working directory.":"此操作仅更新 Codex 项目归属，不更改会话工作目录。",
  "Move conversation":"移动会话",
  "Move to project…":"移入／移出项目…",
  "Plugins and files":"插件与文件",
  "No matching installed plugins or files.":"没有匹配的已安装插件或文件。",

  "Move":"移动",
  "Rename":"重命名",
  "Archive":"归档",
  "Archive conversation?":"确定归档会话？",
  "Subagent · ":"子智能体 · ",
  "This conversation will disappear from the active list. You can restore it from Archived conversations.":"归档后该会话将从当前列表移除，可在“已归档会话”中恢复。",
  "Confirm archive":"确认归档",
  "Archiving…":"正在归档…",
  "Restore":"恢复",
  "Delete":"删除",
  "Cancel":"取消",
  "Save":"保存",
  "Saving…":"保存中…",
  "Edit":"编辑",
  "Working":"工作中",
  "Idle":"空闲",
  "Error":"错误",
  "Needs decision":"需要决定",
  "Decision":"需要决定",
  "Waiting / Scheduled":"等待／定时任务",
  "Agent / Scheduled":"子代理／定时任务",
  "Conversation status legend":"会话状态说明",
  "Parent conversations and their child agents":"父会话及其子代理",
  "Workspace":"工作目录",
  "No root":"没有工作根目录",
  "Unassigned":"未分配",
  "Connected":"已连接",
  "Connecting":"连接中",
  "Reconnecting":"重新连接中",
  "Offline":"离线",
  "Quota unavailable":"额度不可用",
  // Compose, conversation operations.
  "Send":"发送",
  "Stop":"停止",
  "Retry":"重试",
  "Retry failed message":"重试失败的消息",
  "Continue":"继续",
  "Copy":"复制",
  "Copied":"已复制",
  "Copy message":"复制消息",
  "Expand":"展开",
  "Collapse":"收起",
  "Show details":"显示详情",
  "Hide details":"隐藏详情",
  "Details":"详情",
  "Ask a question":"输入问题",
  "Ask Codex":"询问 Codex",
  "Ask anything":"输入内容",
  "Type a message":"输入消息",
  "Message Codex…":"给 Codex 发送消息…",
  "Options":"选项",
  "Conversation Options":"会话选项",
  "Close options":"关闭选项",
  "Current conversation":"当前会话",
  "Back":"返回",
  "Back to conversation":"返回会话",
  "Approve":"批准",
  "Deny":"拒绝",
  "Allow":"允许",
  "Reject":"拒绝",
  "Always allow":"始终允许",
  "Run":"运行",
  "Run now":"立即运行",
  "Pause":"暂停",
  "Resume":"恢复运行",
  "Create":"创建",
  "Update":"更新",
  "Remove":"移除",
  "Refresh":"刷新",
  "Refreshing…":"刷新中…",
  "Loading…":"加载中…",
  // Settings and account.
  "Settings":"设置",
  "Global Settings":"全局设置",
  "Close settings":"关闭设置",
  "Run settings":"运行设置",
  "Model":"模型",
  "Reasoning":"推理强度",
  "Approval policy":"审批策略",
  "Sandbox":"沙箱",
  "Working directory":"工作目录",
  "Daemon default":"使用 daemon 默认值",
  "On request":"按需审批",
  "Untrusted":"不可信时审批",
  "Never":"从不审批",
  "Read only":"只读",
  "Workspace write":"工作目录可写",
  "Full access":"完全访问",
  "Current daemon policy":"当前 daemon 权限策略",
  "New choices apply to your next turn.":"新选择将在下一轮推理时生效。",
  "Used when this conversation starts.":"新会话启动时使用。",
  "Daemon permissions apply unless you choose an override.":"除非另行指定，否则使用 daemon 权限。",
  "Model, reasoning, permissions, and plugin preferences for this conversation.":"当前会话的模型、推理、权限和插件偏好。",
  "Codex account, usage, installed apps, device preferences, and history.":"账号、额度、已安装应用、设备偏好和历史记录。",
  "Codex account & limits":"Codex 账号和额度",
  "Account":"账号",
  "Subscription":"订阅",
  "Lifetime tokens":"累计 Token",
  "Unknown":"未知",
  "Unavailable":"不可用",
  "Usage unknown":"用量未知",
  "Primary window":"主要额度窗口",
  "Secondary window":"次要额度窗口",
  "Installed Codex plugins":"已安装的 Codex 插件",
  "Installed apps / plugins":"已安装应用／插件",
  "Installed plugins":"已安装插件",
  "Connected apps · global controls":"已连接应用 · 全局管理",
  "Connected apps":"已连接应用",
  "Apps":"应用",
  "Callable":"可调用",
  "Enabled":"已启用",
  "Disabled":"已禁用",
  "Installed":"已安装",
  "On":"开",
  "Off":"关",
  "Reset":"重置",
  "Device preferences":"设备偏好",
  "Conversation status markers":"会话状态标志",
  "Completion sound":"完成提示音",
  "Question notifications":"问题通知",
  "Notification settings":"通知设置",
  "Notifications":"通知",
  "Language":"语言",
  "Interface language":"界面语言",
  "Switch the interface between Chinese and English. Conversation content is unchanged.":"在中文和英文间切换界面语言，不改变会话内容。",
  "English":"English",
  "简体中文":"简体中文",
  "Session":"会话登录",
  "Sign out":"退出登录",
  "Browse archived chats":"浏览已归档会话",
  "Archived conversations":"已归档会话",
  "Recent":"最近",
  "Save changes":"保存更改",
  "Configure the visibility, color and shape of each status on this device.":"配置当前设备各状态标志的显示、颜色和形状。",
  "Play a short tone when a turn finishes in this tab.":"当前标签页中的推理完成时播放短提示音。",
  "View and restore conversations you’ve archived.":"查看并恢复已归档的会话。",
  "Sign out of this browser session.":"退出此浏览器的登录会话。",
  "Circle":"圆形",
  "Square":"方形",
  "Shape":"形状",
  "Color":"颜色",
  "Visible":"显示",
  "Hidden":"隐藏",
  "Theme":"主题",
  "System":"跟随系统",
  "Light":"浅色",
  "Dark":"深色",
  // Plugin controls.
  "Conversation plugin preferences":"会话插件偏好",
  "Current conversation · installed plugins":"当前会话 · 已安装插件",
  "Enabled · not callable":"已启用 · 不可调用",
  "Installed · enabled":"已安装 · 已启用",
  "Installed · disabled":"已安装 · 已禁用",
  "Globally enabled":"全局启用",
  "Globally disabled":"全局禁用",
  "Loading installed plugins…":"加载已安装插件…",
  "No installed plugins were returned.":"没有返回已安装插件。",
  // Global notifications.
  "Needs your decision":"需要你的决定",
  "Conversation completed":"会话执行完成",
  "Execution error":"执行错误",
  "Subagent completed":"子代理执行完成",
  "Scheduled task started":"定时任务已启动",
  "Scheduled task completed":"定时任务已完成",
  "Scheduled task failed":"定时任务失败",
  "Sound":"声音",
  "Vibration":"震动",
  "Banner":"横幅",
  "Lock screen":"锁屏",
  "Repeat":"重复提醒",
  "Summary only":"仅显示摘要",
  "Hide":"隐藏",
  "Save notification rules":"保存通知规则",
  "Send test notification":"发送测试通知",
  "Global notification rules saved.":"全局通知规则已保存。",
  "Notification permission":"通知权限",
  "Notification permission is granted.":"已授予通知权限。",
  "Notifications are not authorized for this app.":"尚未授权本应用发送通知。",
  "Request permission":"申请权限",
  // Scheduled task panel.
  "Scheduled Tasks":"定时任务",
  "New scheduled task":"新建定时任务",
  "New task":"新建任务",
  "Create task":"创建任务",
  "Edit task":"编辑任务",
  "Delete task":"删除任务",
  "Task name":"任务名称",
  "Prompt":"提示词",
  "Schedule":"计划",
  "Next run":"下次运行",
  "Last run":"上次运行",
  "Failed":"失败",
  "Completed":"已完成",
  "Running":"运行中",
  "Pending":"等待中",
  "Description":"描述",
  "Frequency":"频率",
  "Daily":"每天",
  "Weekly":"每周",
  "Hourly":"每小时",
  "Time":"时间",
  "Timezone":"时区",
  "Save task":"保存任务",
  "No scheduled tasks":"没有定时任务",
  "Run history":"运行历史",
  "Schedule task":"安排任务",
};
const originalText=new WeakMap<Text,string>();
const originalAttrs=new WeakMap<Element,Map<string,string>>();
const attrs=["title","aria-label","placeholder","alt"] as const;
let activeLanguage:InterfaceLanguage="en";
let observer:MutationObserver|null=null;
let scheduled=false;
const pending=new Set<Node>();
const protectedAncestor=".markdown,.markdown-content,.prose,.message-content,.user-message-bubble,.thread-name,.thread-preview,.agent-thread-name,.agent-thread-message,.queued-message-content,.queued-message-preview-text,.project-heading-copy strong,pre,code,textarea,[contenteditable=true]";
function ignored(element:Element|null):boolean {
  return Boolean(element?.closest(protectedAncestor));
}
function lookup(value:string):string {
  const trimmed=value.trim();
  if(!trimmed)return value;
  let result=strings[trimmed];
  if(!result){
    const remaining=trimmed.match(/^(\d+(?:\.\d+)?)% remaining$/);
    if(remaining) result=remaining[1]+"% 剩余";
    const used=trimmed.match(/^(\d+(?:\.\d+)?)% used$/);
    if(used) result=used[1]+"% 已用";
    const minutes=trimmed.match(/^(\d+)-minute window$/);
    if(minutes) result=minutes[1]+" 分钟额度窗口";
    const count=trimmed.match(/^(\d+) installed$/);
    if(count) result="已安装 "+count+" 个";
    const available=trimmed.match(/^(\d+) available in Codex$/);
    if(available) result="Codex 可用 "+available+" 个";
  }
  if(!result)return value;
  const start=value.length-value.trimStart().length;
  const end=value.length-value.trimEnd().length;
  return value.slice(0,start)+result+(end?value.slice(-end):"");
}
function localizeText(node:Text){
  if(ignored(node.parentElement))return;
  const current=node.data;
  const stored=originalText.get(node);
  if(stored===undefined)originalText.set(node,current);
  else if(current!==stored && current!==lookup(stored))originalText.set(node,current);
  const source=originalText.get(node)??current;
  const wanted=activeLanguage==="zh"?lookup(source):source;
  if(current!==wanted)node.data=wanted;
}
function localizeElement(element:Element){
  if(ignored(element))return;
  let original=originalAttrs.get(element);
  if(!original){original=new Map();originalAttrs.set(element,original);}
  for(const attribute of attrs){
    const current=element.getAttribute(attribute);
    if(current===null)continue;
    const previous=original.get(attribute);
    if(previous===undefined || (current!==previous && current!==lookup(previous)))original.set(attribute,current);
    const source=original.get(attribute)??current;
    const wanted=activeLanguage==="zh"?lookup(source):source;
    if(current!==wanted)element.setAttribute(attribute,wanted);
  }
}
function visit(node:Node){
  if(node.nodeType===Node.TEXT_NODE){localizeText(node as Text);return;}
  if(node.nodeType!==Node.ELEMENT_NODE)return;
  const element=node as Element;
  if(ignored(element))return;
  localizeElement(element);
  for(let child=element.firstChild;child;child=child.nextSibling)visit(child);
}
function flush(){
  scheduled=false;
  const roots=[...pending];pending.clear();
  for(const node of roots)visit(node);
}
function schedule(node:Node){
  pending.add(node);
  if(scheduled)return;
  scheduled=true;
  requestAnimationFrame(flush);
}
export function setInterfaceLanguage(language:InterfaceLanguage){
  activeLanguage=language;
  document.documentElement.lang=language==="zh"?"zh-CN":"en";
  try{localStorage.setItem(languageStorageKey,language);}catch{/* optional persistence */}
  schedule(document.body);
}
export function initializeInterfaceLanguage(){
  if(observer)return;
  activeLanguage=readInterfaceLanguage();
  document.documentElement.lang=activeLanguage==="zh"?"zh-CN":"en";
  schedule(document.body);
  observer=new MutationObserver(changes=>{
    for(const change of changes){
      if(change.type==="characterData")schedule(change.target);
      else if(change.type==="attributes")schedule(change.target);
      else for(const child of change.addedNodes)schedule(child);
    }
  });
  observer.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:[...attrs]});
}
