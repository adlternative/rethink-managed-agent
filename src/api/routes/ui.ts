import { Hono } from "hono";

/**
 * A tiny, dependency-free read-only dashboard served same-origin by the API at `/`. It lists
 * sessions and renders one session's event log as a timeline (user / assistant / tool calls +
 * results / status / required actions), with an optional live tail over the SSE stream. Same-origin
 * so its /v1 fetches carry the caller's principal (prc_local when AUTH_REQUIRED=false).
 */
const PAGE = /* html */ `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>rethink · sessions</title><style>
:root{color-scheme:light dark;--bg:#f6f7f9;--panel:#fff;--line:#e3e6ea;--dim:#6b7280;--fg:#1c2024;--accent:#2563eb;--tool:#7c3aed;--ok:#16a34a;--err:#dc2626}
@media(prefers-color-scheme:dark){:root{--bg:#16181d;--panel:#1e2127;--line:#2c313a;--dim:#9aa1ac;--fg:#e6e9ee;--accent:#6ea8fe;--tool:#c4a7f7;--ok:#5bd07f;--err:#f28b82}}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 -apple-system,system-ui,sans-serif;background:var(--bg);color:var(--fg);display:flex;height:100vh}
#list{width:300px;min-width:300px;border-right:1px solid var(--line);overflow:auto;background:var(--panel)}
#main{flex:1;overflow:auto;padding:18px 24px}
h1{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--dim);margin:14px 16px 8px}
.s{padding:9px 16px;border-bottom:1px solid var(--line);cursor:pointer}.s:hover{background:var(--bg)}.s.sel{background:var(--bg);border-left:3px solid var(--accent);padding-left:13px}
.s .id{font-family:ui-monospace,monospace;font-size:12px}.s .meta{color:var(--dim);font-size:12px}
.badge{display:inline-block;font-size:11px;padding:1px 7px;border-radius:10px;border:1px solid var(--line)}
.ev{margin:10px 0;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--panel)}
.ev .role{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--dim);margin-bottom:4px}
.user .role{color:var(--accent)}.tool .role{color:var(--tool)}.assistant .role{color:var(--fg)}
.ev pre{white-space:pre-wrap;word-break:break-word;margin:0;font:13px/1.5 ui-monospace,monospace}
.ev.text{white-space:pre-wrap}.mono{font-family:ui-monospace,monospace;font-size:12px;color:var(--dim)}
.status{color:var(--dim);font-size:12px;text-align:center;margin:8px 0}
.ra{border-color:var(--err)}.ra .role{color:var(--err)}
#head{display:flex;align-items:center;gap:12px;margin-bottom:8px}#head .mono{font-size:13px}
button{font:inherit;padding:4px 10px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--fg);cursor:pointer}
</style></head><body>
<div id="list"><h1>Sessions</h1><div id="sessions"></div></div>
<div id="main"><div id="head"></div><div id="timeline" class="mono">Pick a session on the left.</div></div>
<script>
const $=s=>document.querySelector(s), el=(t,c,h)=>{const e=document.createElement(t);if(c)e.className=c;if(h!=null)e.textContent=h;return e};
let sel=null, es=null;
const esc=s=>String(s??"");
async function j(u){const r=await fetch(u,{headers:{accept:"application/json"}});if(!r.ok)throw new Error(u+" "+r.status);return r.json()}
function blocks(cs){return (cs||[]).map(b=>b.type==="text"?b.text:"["+b.type+"]").join("")}
function renderEvent(tl,e){
  const p=e.payload,t=p.type;
  if(t==="user.message"){const d=el("div","ev user");d.append(el("div","role","user"));d.append(Object.assign(el("pre"),{textContent:blocks(p.content)}));tl.append(d)}
  else if(t==="agent.message"){const txt=blocks(p.content);if(!txt.trim())return;const d=el("div","ev assistant");d.append(el("div","role","assistant"));d.append(Object.assign(el("pre"),{textContent:txt}));tl.append(d)}
  else if(t==="agent.tool_use"){const d=el("div","ev tool");d.append(el("div","role","tool call · "+esc(p.name)));d.append(Object.assign(el("pre"),{textContent:JSON.stringify(p.input,null,2)}));tl.append(d)}
  else if(t==="agent.tool_result"){const d=el("div","ev tool");d.append(el("div","role","tool result "+(p.is_error?"· error":"")));d.append(Object.assign(el("pre"),{textContent:blocks(p.content).slice(0,4000)}));tl.append(d)}
  else if(t==="session.status_idle"){tl.append(el("div","status","— turn ended: "+esc(p.stop_reason)+" —"))}
  else if(t==="session.status_running"){tl.append(el("div","status","— running —"))}
  else if(t==="session.error"){const d=el("div","ev ra");d.append(el("div","role","error"));d.append(Object.assign(el("pre"),{textContent:JSON.stringify(p.error)}));tl.append(d)}
}
async function loadSessions(){
  const d=await j("/v1/sessions");const box=$("#sessions");box.innerHTML="";
  d.data.slice().reverse().forEach(s=>{
    const row=el("div","s"+(s.id===sel?" sel":""));
    row.append(Object.assign(el("div","id"),{textContent:s.id}));
    const m=el("div","meta");m.append(el("span","badge",s.status));m.append(document.createTextNode(" "+(s.agent&&s.agent.name||"")));row.append(m);
    row.onclick=()=>openSession(s.id);box.append(row)
  })
}
async function openSession(id){
  sel=id;loadSessions();if(es){es.close();es=null}
  const tl=$("#timeline");tl.innerHTML="";
  const head=$("#head");head.innerHTML="";
  head.append(Object.assign(el("span","mono"),{textContent:id}));
  const live=el("button",null,"● live tail");head.append(live);
  const d=await j("/v1/sessions/"+id+"/events?limit=1000");let last=0;
  d.data.forEach(e=>{renderEvent(tl,e);last=e.seq});
  window.scrollTo(0,document.body.scrollHeight);
  live.onclick=()=>{
    if(es){es.close();es=null;live.textContent="● live tail";return}
    live.textContent="■ stop tail";
    es=new EventSource("/v1/sessions/"+id+"/events/stream?since="+last);
    es.onmessage=ev=>{try{const d=JSON.parse(ev.data);if(d.seq){renderEvent(tl,d);$("#main").scrollTop=$("#main").scrollHeight}}catch(e){}};
    ["agent.message","agent.tool_use","agent.tool_result","session.status_idle","session.status_running","user.message"].forEach(n=>es.addEventListener(n,ev=>{try{const d=JSON.parse(ev.data);renderEvent(tl,d);$("#main").scrollTop=$("#main").scrollHeight}catch(e){}}))
  }
}
loadSessions();setInterval(()=>{if(!es)loadSessions()},4000);
</script></body></html>`;

export const ui = new Hono().get("/", (c) => c.html(PAGE));
