import assert from "node:assert/strict";
import test from "node:test";
import {codexThreadLink,forkAtMessage} from "../client/conversation-actions";

test("copies a Codex-native thread reference, not a WebUI browser URL",()=>{
  const id="01a1782f-e308-73a0-8f48-cc7382e27650";
  assert.equal(codexThreadLink(id),`codex://threads/${id}`);
  assert.throws(()=>codexThreadLink(""),/Invalid Codex thread ID/);
  assert.throws(()=>codexThreadLink("relative-path"),/Invalid Codex thread ID/);
  assert.throws(()=>codexThreadLink("01a1782f-e308-73a0-8f48-cc7382e27650?token=x"),/Invalid Codex thread ID/);
});
test("fork user messages before their turn and assistant messages through their turn",()=>{
  assert.deepEqual(forkAtMessage("parent","turn-1","userMessage"),
    {threadId:"parent",beforeTurnId:"turn-1",excludeTurns:true});
  assert.deepEqual(forkAtMessage("parent","turn-1","agentMessage"),
    {threadId:"parent",lastTurnId:"turn-1",excludeTurns:true});
  assert.throws(()=>forkAtMessage("parent","","agentMessage"));
});
