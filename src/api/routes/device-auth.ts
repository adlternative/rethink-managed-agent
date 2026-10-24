import { Hono } from "hono";
import { approveDeviceCode, createDeviceCode, exchangeDeviceToken, lookupUserCode } from "../device-auth.ts";
import { ApiError, invalid, readJson } from "../errors.ts";
import { loadResolver } from "../principal-resolver.ts";

/**
 * Public device-authorization endpoints (auth middleware skips `/v1/auth/device/*`).
 * Used by `pma login` and the `/login/device` browser page.
 */
export const deviceAuthRoute = new Hono()
  .post("/device/code", async (c) => {
    const issued = await createDeviceCode(c.req.url);
    return c.json(issued, 200);
  })
  .get("/device/code", async (c) => {
    const userCode = c.req.query("user_code");
    if (!userCode) throw invalid("user_code query parameter is required");
    const row = lookupUserCode(userCode);
    if (!row) return c.json({ type: "error", error: { type: "not_found_error", message: "unknown user code" } }, 404);
    return c.json(row);
  })
  .post("/device/approve", async (c) => {
    const body = await readJson<{ user_code?: string; display_name?: string; api_key?: string }>(c);
    if (!body.user_code || typeof body.user_code !== "string") throw invalid("user_code is required");

    let actorId: string | undefined;
    // Prefer an explicit api_key in the body (paste from the browser form), then Authorization.
    const pasted = typeof body.api_key === "string" && body.api_key.trim() ? body.api_key.trim() : undefined;
    if (pasted || c.req.header("authorization")) {
      const resolver = await loadResolver();
      const identity = await resolver.resolve({
        header: (n) => (n.toLowerCase() === "authorization" && pasted ? `Bearer ${pasted}` : c.req.header(n)),
        method: c.req.method,
        path: c.req.path,
      });
      if (!identity) throw new ApiError(401, "authentication_error", "invalid API key");
      actorId = identity.actor.id;
    }

    const result = await approveDeviceCode({
      userCode: body.user_code,
      actorId,
      displayName: body.display_name,
    });
    return c.json({ ok: true, ...result });
  })
  .post("/device/token", async (c) => {
    const body = await readJson<{ device_code?: string; grant_type?: string }>(c);
    if (body.grant_type && body.grant_type !== "urn:ietf:params:oauth:grant-type:device_code") {
      throw invalid("grant_type must be urn:ietf:params:oauth:grant-type:device_code");
    }
    if (!body.device_code) throw invalid("device_code is required");
    const result = await exchangeDeviceToken(body.device_code);
    if (result.status === "pending") {
      return c.json({ error: "authorization_pending", error_description: "waiting for user to authorize" }, 400);
    }
    if (result.status === "expired") {
      return c.json({ error: "expired_token", error_description: "device code expired" }, 400);
    }
    if (result.status === "denied") {
      return c.json({ error: "access_denied", error_description: "authorization denied" }, 400);
    }
    return c.json({
      access_token: result.access_token,
      token_type: result.token_type,
      principal_id: result.principal_id,
    });
  });

/** Same-origin HTML page the CLI opens in the browser. */
const DEVICE_PAGE = /* html */ `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize pma CLI</title>
<style>
:root{color-scheme:light dark;--bg:#f4f5f7;--panel:#fff;--fg:#1a1d21;--dim:#6b7280;--line:#e5e7eb;--accent:#2563eb;--ok:#15803d;--err:#b91c1c}
@media(prefers-color-scheme:dark){:root{--bg:#12141a;--panel:#1c1f26;--fg:#e8eaed;--dim:#9aa3b2;--line:#2a303a;--accent:#6ea8fe;--ok:#4ade80;--err:#f87171}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;font:15px/1.5 ui-sans-serif,system-ui,sans-serif;background:radial-gradient(1200px 600px at 10% -10%,#dbeafe55,transparent),var(--bg);color:var(--fg);padding:24px}
main{width:min(420px,100%);background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:28px 26px;box-shadow:0 10px 40px #0000000d}
h1{font-size:1.25rem;margin:0 0 6px;letter-spacing:-.02em}p{margin:0 0 16px;color:var(--dim)}
label{display:block;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--dim);margin:14px 0 6px}
input{width:100%;font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--fg)}
button{margin-top:18px;width:100%;font:inherit;font-weight:600;padding:11px 14px;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer}
button:disabled{opacity:.55;cursor:default}
.msg{margin-top:14px;font-size:14px}.ok{color:var(--ok)}.err{color:var(--err)}
.hint{font-size:12px;color:var(--dim);margin-top:10px}
code{font-family:ui-monospace,monospace;font-size:12px}
</style></head><body>
<main>
  <h1>Authorize CLI</h1>
  <p>Confirm this device so <code>pma login</code> can store an API token.</p>
  <label for="code">User code</label>
  <input id="code" autocomplete="off" spellcheck="false" placeholder="ABCD-EFGH">
  <label for="name">Display name <span style="text-transform:none;letter-spacing:0">(optional, new accounts)</span></label>
  <input id="name" placeholder="Your name">
  <label for="key">Existing API key <span style="text-transform:none;letter-spacing:0">(optional)</span></label>
  <input id="key" type="password" autocomplete="off" placeholder="pma_…">
  <button id="go" type="button">Authorize</button>
  <div id="msg" class="msg" hidden></div>
  <p class="hint">With <code>AUTH_REQUIRED=true</code>, leave the key empty to create a new principal (when signup is enabled), or paste a key to mint another token for that principal.</p>
</main>
<script>
const q=new URLSearchParams(location.search);
const codeEl=document.getElementById('code');
const nameEl=document.getElementById('name');
const keyEl=document.getElementById('key');
const msg=document.getElementById('msg');
const go=document.getElementById('go');
if(q.get('user_code')) codeEl.value=q.get('user_code');
function show(t,ok){msg.hidden=false;msg.className='msg '+(ok?'ok':'err');msg.textContent=t}
go.onclick=async()=>{
  go.disabled=true; show('Authorizing…', true);
  try{
    const body={user_code:codeEl.value.trim()};
    if(nameEl.value.trim()) body.display_name=nameEl.value.trim();
    if(keyEl.value.trim()) body.api_key=keyEl.value.trim();
    const r=await fetch('/v1/auth/device/approve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    const j=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(j?.error?.message||j?.error_description||('HTTP '+r.status));
    show('Authorized. You can close this tab and return to the terminal.', true);
  }catch(e){ show(String(e.message||e), false); go.disabled=false }
};
</script>
</body></html>`;

export const deviceLoginUi = new Hono().get("/login/device", (c) => c.html(DEVICE_PAGE));
