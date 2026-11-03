/** Codex-native thread reference for sharing context with another Codex conversation.
 * It is not a browser URL and contains no credentials or conversation content. */
export function codexThreadLink(threadId:string):string{
  if(!/^[a-f0-9-]{20,}$/i.test(threadId))throw new Error("Invalid Codex thread ID.");
  return "codex://threads/"+threadId;
}

/** Codex app-server forks by turns, not arbitrary item IDs. */
export function forkAtMessage(threadId:string,turnId:string,kind:"userMessage"|"agentMessage"){
  if(!threadId||!turnId)throw new Error("This message has no saved Codex turn.");
  return kind==="userMessage"
    ? {threadId,beforeTurnId:turnId,excludeTurns:true}
    : {threadId,lastTurnId:turnId,excludeTurns:true};
}
