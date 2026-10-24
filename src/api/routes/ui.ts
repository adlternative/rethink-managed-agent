import { Hono } from "hono";

/**
 * Minimal operator console served same-origin by the API at `/`. Create agent/env/session, send
 * messages, live-tail SSE, and resolve pending tool confirmations / client-tool results — enough
 * for a compose-up demo without the CLI. Bearer key optional via prompt + localStorage (fetch-based
 * SSE when set); with AUTH_REQUIRED=false, unauthenticated fetches act as prc_local.
 */
const PAGE = /* html */ `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>rethink · console</title><style>
:root{color-scheme:light dark;--bg:#f4f5f7;--panel:#fff;--line:#e2e5ea;--dim:#6b7280;--fg:#1a1d21;--accent:#2563eb;--accent-fg:#fff;--tool:#7c3aed;--ok:#16a34a;--err:#dc2626;--warn:#b45309;--rail:300px}
@media(prefers-color-scheme:dark){:root{--bg:#12141a;--panel:#1a1d24;--line:#2a303a;--dim:#9aa3b2;--fg:#e8ebf0;--accent:#5b9cff;--accent-fg:#0b1220;--tool:#c4a7f7;--ok:#5bd07f;--err:#f28b82;--warn:#fbbf24}}
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{font:14px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:var(--bg);color:var(--fg);display:flex;flex-direction:column}
#top{display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--line);background:var(--panel);flex-wrap:wrap}
#top .brand{font-weight:650;letter-spacing:-.02em}#top .spacer{flex:1}
#shell{flex:1;display:flex;min-height:0}
#rail{width:var(--rail);min-width:0;border-right:1px solid var(--line);background:var(--panel);display:flex;flex-direction:column;overflow:hidden}
#rail.collapsed{display:none}
#rail .rail-head{padding:10px 12px;border-bottom:1px solid var(--line);display:flex;gap:8px;align-items:center;flex-wrap:wrap}
#sessions{overflow:auto;flex:1}
#stage{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0}
#head{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--line);background:var(--panel);flex-wrap:wrap}
#timeline{flex:1;overflow:auto;padding:14px 16px 8px}
#composer{border-top:1px solid var(--line);background:var(--panel);padding:10px 12px;display:flex;flex-direction:column;gap:8px}
#pending{display:none;flex-direction:column;gap:8px}
#pending.show{display:flex}
.pending{border:1px solid var(--warn);background:color-mix(in srgb,var(--warn) 8%,var(--panel));border-radius:8px;padding:10px 12px}
.pending h3{margin:0 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--warn)}
.pending pre{margin:0 0 8px;white-space:pre-wrap;word-break:break-word;font:12px/1.45 ui-monospace,monospace;max-height:120px;overflow:auto}
.pending .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.pending textarea,.pending input[type=text]{width:100%;font:13px/1.4 ui-monospace,monospace;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
#msgbox{width:100%;min-height:64px;resize:vertical;font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
#sendrow{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
h1{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--dim);margin:0}
.s{padding:9px 12px;border-bottom:1px solid var(--line);cursor:pointer}.s:hover{background:var(--bg)}.s.sel{background:var(--bg);box-shadow:inset 3px 0 0 var(--accent)}
.s .id{font-family:ui-monospace,monospace;font-size:12px}.s .meta{color:var(--dim);font-size:12px;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.badge{display:inline-block;font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--line)}
.badge.run{border-color:color-mix(in srgb,var(--accent) 50%,var(--line));color:var(--accent)}
.badge.idle{opacity:.85}.badge.term{opacity:.6}
.ev{margin:0 0 10px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--panel)}
.ev .role{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--dim);margin-bottom:4px}
.user .role{color:var(--accent)}.tool .role{color:var(--tool)}.assistant .role{color:var(--fg)}.confirm .role{color:var(--warn)}
.ev pre{white-space:pre-wrap;word-break:break-word;margin:0;font:13px/1.5 ui-monospace,monospace}
.mono{font-family:ui-monospace,monospace;font-size:12px;color:var(--dim)}
.status{color:var(--dim);font-size:12px;text-align:center;margin:8px 0}
.ra{border-color:var(--err)}.ra .role{color:var(--err)}
button,.btn{font:inherit;padding:5px 11px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
button.danger{border-color:color-mix(in srgb,var(--err) 40%,var(--line));color:var(--err)}
button:disabled{opacity:.5;cursor:not-allowed}
select,input[type=text],input[type=password]{font:inherit;padding:5px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
dialog{border:1px solid var(--line);border-radius:10px;padding:0;background:var(--panel);color:var(--fg);max-width:min(440px,94vw);width:100%}
dialog::backdrop{background:rgba(0,0,0,.35)}
dialog form{display:flex;flex-direction:column;gap:10px;padding:16px}
dialog h2{margin:0;font-size:16px}
dialog label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--dim)}
dialog .actions{display:flex;gap:8px;justify-content:flex-end;margin-top:4px}
#toast{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:var(--fg);color:var(--bg);padding:8px 14px;border-radius:8px;font-size:13px;opacity:0;pointer-events:none;transition:opacity .2s;z-index:20;max-width:90vw}
#toast.show{opacity:1}
#empty{color:var(--dim);padding:24px 8px;text-align:center}
@media(max-width:720px){
  :root{--rail:100%}
  #shell{flex-direction:column}
  #rail{width:100%;max-height:38vh;border-right:0;border-bottom:1px solid var(--line)}
  #rail.collapsed{display:none}
  #msgbox{min-height:48px}
}
</style></head><body>
<div id="top">
  <button type="button" id="toggleRail" title="Sessions" aria-label="Toggle sessions">☰</button>
  <span class="brand">rethink</span>
  <span class="mono" id="authHint">auth: local</span>
  <span class="spacer"></span>
  <button type="button" id="btnKey">API key</button>
  <button type="button" id="btnNew" class="primary">New session</button>
</div>
<div id="shell">
  <aside id="rail">
    <div class="rail-head"><h1>Sessions</h1><button type="button" id="btnRefresh" title="Refresh">↻</button></div>
    <div id="sessions"><div id="empty">Loading…</div></div>
  </aside>
  <main id="stage">
    <div id="head"><span class="mono" id="headId">No session selected</span></div>
    <div id="timeline"><div id="empty">Create or pick a session to chat, approve tools, and watch the live event log.</div></div>
    <div id="composer">
      <div id="pending"></div>
      <textarea id="msgbox" placeholder="Message the agent…" disabled></textarea>
      <div id="sendrow">
        <button type="button" id="btnSend" class="primary" disabled>Send</button>
        <button type="button" id="btnInterrupt" disabled>Interrupt</button>
        <span class="mono" id="liveHint"></span>
      </div>
    </div>
  </main>
</div>
<dialog id="dlgNew">
  <form method="dialog" id="formNew">
    <h2>New session</h2>
    <label>Agent
      <select id="selAgent"></select>
    </label>
    <div class="row" style="display:flex;gap:8px;flex-wrap:wrap">
      <button type="button" id="btnCreateAgent">Create agent…</button>
    </div>
    <label>Environment
      <select id="selEnv"></select>
    </label>
    <div class="row" style="display:flex;gap:8px;flex-wrap:wrap">
      <button type="button" id="btnCreateEnv">Create environment…</button>
    </div>
    <label>First message (optional)
      <textarea id="firstMsg" rows="3" placeholder="Optional — starts a turn immediately"></textarea>
    </label>
    <div class="actions">
      <button type="submit" value="cancel">Cancel</button>
      <button type="submit" value="ok" class="primary" id="btnStart">Start</button>
    </div>
  </form>
</dialog>
<dialog id="dlgAgent">
  <form method="dialog" id="formAgent">
    <h2>Create agent</h2>
    <label>Name <input id="agentName" type="text" required placeholder="coder"></label>
    <label>Model <select id="selModel"></select></label>
    <label>Tools <input id="agentTools" type="text" value="bash,read,write,edit"></label>
    <div class="actions">
      <button type="submit" value="cancel">Cancel</button>
      <button type="submit" value="ok" class="primary">Create</button>
    </div>
  </form>
</dialog>
<dialog id="dlgEnv">
  <form method="dialog" id="formEnv">
    <h2>Create environment</h2>
    <label>Name <input id="envName" type="text" required placeholder="local"></label>
    <label>Provider
      <select id="envProvider">
        <option value="local">local</option>
        <option value="docker">docker</option>
        <option value="e2b">e2b</option>
      </select>
    </label>
    <div class="actions">
      <button type="submit" value="cancel">Cancel</button>
      <button type="submit" value="ok" class="primary">Create</button>
    </div>
  </form>
</dialog>
<div id="toast"></div>
<script>
const KEY="pma_api_key";
const $=s=>document.querySelector(s);
const el=(t,c,h)=>{const e=document.createElement(t);if(c)e.className=c;if(h!=null)e.textContent=h;return e};
let sel=null, sessionMeta=null, lastSeq=0, tailAbort=null, live=false, clientTools=new Set(), toastTimer=0;
/** Optimistic answers for tool_result (not persisted) / confirmations until the log catches up. */
let optimisticAnswered=new Set();

function token(){try{return localStorage.getItem(KEY)||""}catch(e){return ""}}
function setToken(t){try{if(t)localStorage.setItem(KEY,t);else localStorage.removeItem(KEY)}catch(e){}}
function authHeaders(extra){const h={accept:"application/json",...(extra||{})};const t=token();if(t)h.authorization="Bearer "+t;return h}
function refreshAuthHint(){$("#authHint").textContent=token()?"auth: bearer":"auth: local"}
function toast(msg){const t=$("#toast");t.textContent=msg;t.classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove("show"),2800)}
function blocks(cs){return (cs||[]).map(b=>b.type==="text"?b.text:"["+b.type+"]").join("")}
function esc(s){return String(s??"")}

async function api(method, path, body){
  const opt={method,headers:authHeaders(body!==undefined?{"content-type":"application/json"}:undefined)};
  if(body!==undefined)opt.body=JSON.stringify(body);
  const r=await fetch(path,opt);
  const text=await r.text();
  let data=null;try{data=text?JSON.parse(text):null}catch(e){data={raw:text}}
  if(!r.ok){
    const msg=(data&&data.error&&data.error.message)||text||r.status;
    const err=new Error(method+" "+path+" → "+r.status+": "+msg);err.status=r.status;throw err;
  }
  return data;
}

function derivePending(events, names){
  const client=new Set(names||[]);
  const answeredR=new Set(), answeredC=new Set();
  for(const e of events){
    const p=e.payload;
    if(p.type==="agent.tool_result"&&p.tool_use_id)answeredR.add(p.tool_use_id);
    if(p.type==="user.tool_confirmation"&&p.tool_use_id)answeredC.add(p.tool_use_id);
  }
  for(const id of optimisticAnswered){answeredR.add(id);answeredC.add(id)}
  const out=[], seenC=new Set(), seenT=new Set();
  for(const e of events){
    const p=e.payload;
    if(p.type==="agent.tool_confirmation_required"&&p.tool_use_id&&!answeredC.has(p.tool_use_id)&&!seenC.has(p.tool_use_id)){
      seenC.add(p.tool_use_id);out.push({kind:"confirmation",tool_use_id:p.tool_use_id,name:p.name||"",mcp_server:p.mcp_server});
    }
    if(p.type==="agent.tool_use"&&p.tool_use_id&&client.has(p.name)&&!answeredR.has(p.tool_use_id)&&!seenT.has(p.tool_use_id)){
      seenT.add(p.tool_use_id);out.push({kind:"client_tool",tool_use_id:p.tool_use_id,name:p.name,input:p.input});
    }
  }
  return out;
}

function renderEvent(tl,e){
  const p=e.payload,t=p.type;
  if(t==="user.message"){const d=el("div","ev user");d.append(el("div","role","user"));d.append(Object.assign(el("pre"),{textContent:blocks(p.content)}));tl.append(d)}
  else if(t==="agent.message"){const txt=blocks(p.content);if(!txt.trim())return;const d=el("div","ev assistant");d.append(el("div","role","assistant"));d.append(Object.assign(el("pre"),{textContent:txt}));tl.append(d)}
  else if(t==="agent.message_delta"){/* streamed; final agent.message replaces */}
  else if(t==="agent.tool_use"){const d=el("div","ev tool");d.append(el("div","role","tool call · "+esc(p.name)));d.append(Object.assign(el("pre"),{textContent:JSON.stringify(p.input,null,2)}));tl.append(d)}
  else if(t==="agent.tool_result"){const d=el("div","ev tool");d.append(el("div","role","tool result "+(p.is_error?"· error":"")));d.append(Object.assign(el("pre"),{textContent:blocks(p.content).slice(0,4000)}));tl.append(d)}
  else if(t==="agent.tool_confirmation_required"){const d=el("div","ev confirm");d.append(el("div","role","confirmation required · "+esc(p.name)+(p.mcp_server?" @"+p.mcp_server:"")));d.append(Object.assign(el("pre"),{textContent:"tool_use_id "+p.tool_use_id}));tl.append(d)}
  else if(t==="user.tool_confirmation"){const d=el("div","ev confirm");d.append(el("div","role","confirmation · "+esc(p.result)));d.append(Object.assign(el("pre"),{textContent:p.deny_message||p.tool_use_id}));tl.append(d)}
  else if(t==="session.status_idle"){tl.append(el("div","status","— turn ended: "+esc(p.stop_reason)+" —"))}
  else if(t==="session.status_running"){tl.append(el("div","status","— running —"))}
  else if(t==="session.status_terminated"){tl.append(el("div","status","— terminated —"))}
  else if(t==="session.error"){const d=el("div","ev ra");d.append(el("div","role","error"));d.append(Object.assign(el("pre"),{textContent:JSON.stringify(p.error)}));tl.append(d)}
}

function scrollTl(){const t=$("#timeline");t.scrollTop=t.scrollHeight}

function setComposerEnabled(on){
  $("#msgbox").disabled=!on;$("#btnSend").disabled=!on;$("#btnInterrupt").disabled=!on;
}

function renderPending(events){
  const box=$("#pending");
  const pending=derivePending(events, clientTools);
  box.innerHTML="";
  if(!pending.length){box.classList.remove("show");return}
  box.classList.add("show");
  for(const a of pending){
    const card=el("div","pending");
    if(a.kind==="confirmation"){
      card.append(el("h3","Confirm tool · "+a.name+(a.mcp_server?" @"+a.mcp_server:"")));
      card.append(Object.assign(el("pre"),{textContent:"call "+a.tool_use_id}));
      const row=el("div","row");
      const allow=el("button","primary","Allow");
      const deny=el("button","danger","Deny");
      allow.onclick=()=>postEvents([{type:"user.tool_confirmation",tool_use_id:a.tool_use_id,result:"allow"}]);
      deny.onclick=()=>{
        const msg=prompt("Deny message (optional)","")||undefined;
        postEvents([{type:"user.tool_confirmation",tool_use_id:a.tool_use_id,result:"deny",...(msg?{deny_message:msg}:{})}]);
      };
      row.append(allow,deny);card.append(row);
    } else {
      card.append(el("h3","Client tool result · "+a.name));
      card.append(Object.assign(el("pre"),{textContent:JSON.stringify(a.input,null,2)}));
      const ta=el("textarea");ta.rows=3;ta.placeholder="Tool result text…";
      const row=el("div","row");
      const ok=el("button","primary","Submit result");
      const err=el("button","danger","Submit error");
      ok.onclick=()=>postEvents([{type:"tool_result",tool_use_id:a.tool_use_id,content:[{type:"text",text:ta.value||""}],is_error:false}]);
      err.onclick=()=>postEvents([{type:"tool_result",tool_use_id:a.tool_use_id,content:[{type:"text",text:ta.value||"error"}],is_error:true}]);
      card.append(ta);row.append(ok,err);card.append(row);
    }
    box.append(card);
  }
}

let cachedEvents=[];
function noteEvent(e){
  if(!e||!e.seq)return;
  if(e.seq>lastSeq)lastSeq=e.seq;
  const i=cachedEvents.findIndex(x=>x.seq===e.seq);
  if(i>=0)cachedEvents[i]=e;else cachedEvents.push(e);
  cachedEvents.sort((a,b)=>a.seq-b.seq);
  renderPending(cachedEvents);
}

async function postEvents(events){
  if(!sel)return;
  try{
    await api("POST","/v1/sessions/"+sel+"/events",{events});
    toast("Submitted");
    // tool_result is not persisted; confirmations are. Mark both answered so the panel clears
    // immediately without inventing seq numbers (which would break the live SSE cursor).
    for(const ev of events){
      if((ev.type==="tool_result"||ev.type==="user.tool_confirmation")&&ev.tool_use_id)optimisticAnswered.add(ev.tool_use_id);
    }
    renderPending(cachedEvents);
    if(!live)await openSession(sel,true);
  }catch(e){toast(String(e.message||e))}
}

async function loadSessions(){
  try{
    const d=await api("GET","/v1/sessions?limit=200");
    const box=$("#sessions");box.innerHTML="";
    if(!d.data.length){box.append(el("div","", "No sessions yet. Start one with “New session”."));return}
    d.data.forEach(s=>{
      const row=el("div","s"+(s.id===sel?" sel":""));
      row.append(Object.assign(el("div","id"),{textContent:s.id}));
      const m=el("div","meta");
      const st=s.status||"";
      m.append(el("span","badge "+(st==="running"?"run":st==="terminated"?"term":"idle"),st));
      m.append(document.createTextNode(s.agent&&s.agent.name||""));
      row.append(m);
      row.onclick=()=>openSession(s.id);
      box.append(row);
    });
  }catch(e){
    $("#sessions").innerHTML="";
    $("#sessions").append(el("div","", String(e.message||e)));
    if(e.status===401)toast("Set an API key (top right)");
  }
}

function stopTail(){
  if(tailAbort){tailAbort.abort();tailAbort=null}
  live=false;$("#liveHint").textContent="";
}

async function startTail(id, since){
  stopTail();
  live=true;$("#liveHint").textContent="● live";
  const ac=new AbortController();tailAbort=ac;
  try{
    const r=await fetch("/v1/sessions/"+id+"/events/stream?since="+since,{headers:authHeaders({accept:"text/event-stream"}),signal:ac.signal});
    if(!r.ok||!r.body){toast("SSE "+r.status);stopTail();return}
    const reader=r.body.getReader();const dec=new TextDecoder();
    let buf="", eventType="message";
    const dispatch=(block)=>{
      let type=eventType, data=[];
      for(const line of block.split("\\n")){
        if(line.startsWith("event:"))type=line.slice(6).trim();
        else if(line.startsWith("data:"))data.push(line.slice(5).trimStart());
      }
      eventType="message";
      if(!data.length)return;
      try{
        const d=JSON.parse(data.join("\\n"));
        if(d&&d.payload){renderEvent($("#timeline"),d);noteEvent(d);scrollTl()}
        else if(d&&d.seq&&d.type){const ev={seq:d.seq,type:d.type,payload:d.payload||d};renderEvent($("#timeline"),ev);noteEvent(ev);scrollTl()}
      }catch(e){}
    };
    while(true){
      const {done,value}=await reader.read();
      if(done)break;
      buf+=dec.decode(value,{stream:true});
      let idx;
      while((idx=buf.indexOf("\\n\\n"))>=0){
        const block=buf.slice(0,idx);buf=buf.slice(idx+2);
        if(block.startsWith(":")||!block.trim())continue;
        dispatch(block);
      }
    }
  }catch(e){
    if(e.name!=="AbortError"){toast("live tail ended");live=false;$("#liveHint").textContent=""}
  }finally{
    if(tailAbort===ac){tailAbort=null;live=false;$("#liveHint").textContent=""}
  }
}

async function openSession(id, keepTail){
  sel=id;
  if(!keepTail)stopTail();
  loadSessions();
  const tl=$("#timeline");tl.innerHTML="";
  $("#headId").textContent=id;
  setComposerEnabled(true);
  cachedEvents=[];lastSeq=0;optimisticAnswered=new Set();
  try{
    sessionMeta=await api("GET","/v1/sessions/"+id);
    clientTools=new Set(((sessionMeta.agent&&sessionMeta.agent.client_tools)||[]).map(t=>t.name));
    const d=await api("GET","/v1/sessions/"+id+"/events?limit=1000");
    d.data.forEach(e=>{renderEvent(tl,e);noteEvent(e)});
    scrollTl();
    if(!keepTail||!live)startTail(id,lastSeq);
  }catch(e){tl.append(el("div","", String(e.message||e)));setComposerEnabled(false)}
}

async function sendMessage(){
  const text=$("#msgbox").value.trim();
  if(!sel||!text)return;
  $("#btnSend").disabled=true;
  try{
    await api("POST","/v1/sessions/"+sel+"/events",{events:[{type:"user.message",content:[{type:"text",text}]}]});
    $("#msgbox").value="";
    if(!live)startTail(sel,lastSeq);
  }catch(e){toast(String(e.message||e))}
  finally{$("#btnSend").disabled=false}
}

async function interrupt(){
  if(!sel)return;
  try{await api("POST","/v1/sessions/"+sel+"/events",{events:[{type:"user.interrupt"}]});toast("Interrupt sent")}
  catch(e){toast(String(e.message||e))}
}

async function fillAgentSelect(){
  const d=await api("GET","/v1/agents");
  const selA=$("#selAgent");selA.innerHTML="";
  if(!d.data.length){selA.append(new Option("(none — create one)",""));return}
  d.data.forEach(a=>selA.append(new Option(a.name+" · "+a.id,a.id)));
}
async function fillEnvSelect(){
  const d=await api("GET","/v1/environments");
  const selE=$("#selEnv");selE.innerHTML="";
  if(!d.data.length){selE.append(new Option("(none — create one)",""));return}
  d.data.forEach(e=>selE.append(new Option(e.name+" · "+e.provider+" · "+e.id,e.id)));
}
async function fillModels(){
  const d=await api("GET","/v1/models");
  const s=$("#selModel");s.innerHTML="";
  if(!d.data.length){s.append(new Option("qoder/auto","qoder/auto"));return}
  d.data.forEach(m=>s.append(new Option(m.provider+"/"+m.id,m.provider+"/"+m.id)));
}

$("#btnKey").onclick=()=>{
  const cur=token();
  const v=prompt("API key (Bearer). Leave empty to clear and use local principal.",cur||"");
  if(v===null)return;
  setToken(v.trim());refreshAuthHint();loadSessions();
  if(sel)openSession(sel);
};
$("#btnRefresh").onclick=()=>loadSessions();
$("#btnNew").onclick=async()=>{
  try{await fillAgentSelect();await fillEnvSelect();$("#firstMsg").value="";$("#dlgNew").showModal()}
  catch(e){toast(String(e.message||e))}
};
$("#btnCreateAgent").onclick=async()=>{
  try{await fillModels();$("#agentName").value="coder";$("#dlgAgent").showModal()}
  catch(e){toast(String(e.message||e))}
};
$("#btnCreateEnv").onclick=()=>{$("#envName").value="local";$("#envProvider").value="local";$("#dlgEnv").showModal()};

$("#dlgNew").addEventListener("close",async()=>{
  if($("#dlgNew").returnValue!=="ok")return;
  const agent=$("#selAgent").value, envId=$("#selEnv").value;
  if(!agent||!envId){toast("Pick an agent and environment");return}
  const first=$("#firstMsg").value.trim();
  const body={agent,environment_id:envId};
  if(first)body.initial_events=[{type:"user.message",content:[{type:"text",text:first}]}];
  try{
    const s=await api("POST","/v1/sessions",body);
    toast("Session "+s.id);
    await openSession(s.id);
  }catch(e){toast(String(e.message||e))}
});
// method=dialog sets dialog.returnValue from the clicked submit button; block Start if incomplete
$("#formNew").addEventListener("submit",(ev)=>{
  const submitter=ev.submitter;
  if(submitter&&submitter.value==="ok"){
    if(!$("#selAgent").value||!$("#selEnv").value){ev.preventDefault();toast("Pick an agent and environment")}
  }
});

$("#dlgAgent").addEventListener("close",async()=>{
  if($("#dlgAgent").returnValue!=="ok")return;
  const name=$("#agentName").value.trim();
  if(!name){toast("Agent name required");return}
  const mid=$("#selModel").value||"qoder/auto";
  const [provider,...rest]=mid.split("/");
  const id=rest.join("/")||"auto";
  const tools=$("#agentTools").value.split(",").map(s=>s.trim()).filter(Boolean);
  try{
    const a=await api("POST","/v1/agents",{name,model:{provider,id},tools});
    toast("Agent "+a.id);
    await fillAgentSelect();$("#selAgent").value=a.id;
  }catch(e){toast(String(e.message||e))}
});
$("#dlgEnv").addEventListener("close",async()=>{
  if($("#dlgEnv").returnValue!=="ok")return;
  const name=$("#envName").value.trim();
  if(!name){toast("Environment name required");return}
  const provider=$("#envProvider").value;
  try{
    const e=await api("POST","/v1/environments",{name,provider,workspace:{kind:"empty"}});
    toast("Env "+e.id);
    await fillEnvSelect();$("#selEnv").value=e.id;
  }catch(err){toast(String(err.message||err))}
});

$("#btnSend").onclick=sendMessage;
$("#btnInterrupt").onclick=interrupt;
$("#msgbox").addEventListener("keydown",(e)=>{if(e.key==="Enter"&&(e.metaKey||e.ctrlKey)){e.preventDefault();sendMessage()}});

document.getElementById("toggleRail").onclick=()=>document.getElementById("rail").classList.toggle("collapsed");

refreshAuthHint();
loadSessions();
setInterval(()=>{if(!live)loadSessions()},5000);
</script></body></html>`;

export { derivePendingActions } from "./ui-pending.ts";

export const ui = new Hono().get("/", (c) => c.html(PAGE));
