/** Single-file local console, served at GET /. Dark, dependency-free. */
export const CONSOLE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>1DayAPI Provider Node</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;background:#0d1117;color:#c9d1d9;font:14px/1.5 -apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
  header{padding:16px 24px;border-bottom:1px solid #21262d;display:flex;align-items:baseline;gap:12px}
  header h1{font-size:18px;margin:0;color:#f0f6fc}
  header .ver{color:#8b949e;font-size:12px}
  main{max-width:960px;margin:0 auto;padding:20px 24px 60px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:20px}
  .card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px 16px}
  .card .label{color:#8b949e;font-size:12px;text-transform:uppercase;letter-spacing:.05em}
  .card .value{font-size:16px;margin-top:4px;word-break:break-all}
  .ok{color:#3fb950}.bad{color:#f85149}.warn{color:#d29922}
  section{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:16px}
  section h2{margin:0 0 12px;font-size:15px;color:#f0f6fc}
  input,select,textarea{background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;padding:8px 10px;font:inherit;width:100%}
  textarea{min-height:110px;font-family:ui-monospace,monospace;font-size:12px}
  button{background:#238636;border:1px solid #2ea043;color:#fff;border-radius:6px;padding:8px 14px;font:inherit;cursor:pointer}
  button.secondary{background:#21262d;border-color:#30363d;color:#c9d1d9}
  button.danger{background:#8e3231;border-color:#b54a48}
  button:hover{filter:brightness(1.15)}
  .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .row>*{flex:0 1 auto}
  .row input{flex:1 1 260px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #21262d}
  th{color:#8b949e;font-weight:600}
  .muted{color:#8b949e}
  .msg{margin-top:8px;font-size:13px;white-space:pre-wrap}
  code{background:#21262d;padding:1px 5px;border-radius:4px;font-size:12px}
</style>
</head>
<body>
<header><h1>1DayAPI Provider Node</h1><span class="ver" id="ver"></span></header>
<main>
  <div class="grid">
    <div class="card"><div class="label">桥接状态</div><div class="value" id="st-state">…</div></div>
    <div class="card"><div class="label">绑定</div><div class="value" id="st-bound">…</div></div>
    <div class="card"><div class="label">活动隧道</div><div class="value" id="st-sessions">…</div></div>
    <div class="card"><div class="label">平台 WS</div><div class="value" id="st-ws" style="font-size:12px">…</div></div>
  </div>

  <section>
    <h2>节点绑定</h2>
    <div class="muted" style="margin-bottom:8px">Node ID: <code id="st-nodeid">…</code> <span id="st-provider"></span></div>
    <div class="row">
      <input id="bind-code" placeholder="bind_…（控制台生成的绑定码，10 分钟有效）" autocomplete="off">
      <button id="btn-bind">绑定</button>
      <button id="btn-unbind" class="danger">解绑</button>
    </div>
    <div class="msg" id="bind-msg"></div>
  </section>

  <section>
    <h2>凭证 <button class="secondary" id="btn-refresh-creds" style="float:right">刷新</button></h2>
    <table><thead><tr><th>Vendor</th><th>账号</th><th>订阅</th><th>状态</th><th>创建时间</th></tr></thead>
    <tbody id="creds-body"><tr><td colspan="5" class="muted">加载中…</td></tr></tbody></table>
  </section>

  <section>
    <h2>本机凭证探测</h2>
    <div class="row">
      <button class="secondary" id="btn-detect">探测 ~/.claude / ~/.codex</button>
      <button id="btn-import" disabled>导入并上传平台</button>
    </div>
    <table style="margin-top:10px"><thead><tr><th></th><th>Vendor</th><th>来源</th><th>账号</th><th>订阅</th><th>Token</th><th>过期</th></tr></thead>
    <tbody id="detect-body"><tr><td colspan="7" class="muted">尚未探测</td></tr></tbody></table>
    <div class="msg" id="detect-msg"></div>
  </section>

  <section>
    <h2>手动粘贴 Token</h2>
    <div class="row" style="margin-bottom:8px">
      <select id="tok-vendor" style="width:160px">
        <option value="anthropic">anthropic</option>
        <option value="openai">openai</option>
      </select>
    </div>
    <textarea id="tok-json" placeholder='{"accessToken":"…","refreshToken":"…","expiresAt":"…","accountEmail":"…","subscriptionType":"…"}'></textarea>
    <div class="row" style="margin-top:8px"><button id="btn-token">上传凭证</button></div>
    <div class="msg" id="tok-msg"></div>
  </section>
</main>
<script>
let csrf = "";
let detected = [];
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(method !== "GET" && csrf ? { "x-1dayapi-csrf": csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = res.headers.get("x-csrf-token");
  if (t) csrf = t;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message || json?.error?.code || ("HTTP " + res.status));
  return json;
}

function show(id, text, cls) {
  const el = $(id);
  el.textContent = text || "";
  el.className = "msg " + (cls || "");
}

async function refresh() {
  try {
    const s = await api("GET", "/api/status");
    $("ver").textContent = "v" + s.nodeVersion;
    $("st-nodeid").textContent = s.nodeId;
    $("st-provider").textContent = s.providerId ? "| Provider: " + s.providerId : "";
    const st = s.bridge.state;
    const stateEl = $("st-state");
    stateEl.textContent = st + (s.bridge.suppressedReason ? " (" + s.bridge.suppressedReason + ")" : "") + (s.bridge.nextRetryAt ? " · 重试 " + new Date(s.bridge.nextRetryAt).toLocaleTimeString() : "");
    stateEl.className = "value " + (st === "ready" ? "ok" : st === "suppressed" || st === "disabled" ? "bad" : "warn");
    $("st-bound").textContent = s.bound ? "已绑定" : "未绑定";
    $("st-bound").className = "value " + (s.bound ? "ok" : "bad");
    $("st-sessions").textContent = String(s.officialExit.activeSessions);
    $("st-ws").textContent = s.bridge.wsUrl || "—";
    renderCreds(s.credentials || []);
  } catch (e) {
    $("st-state").textContent = "控制台不可达: " + e.message;
  }
}

function renderCreds(creds) {
  const body = $("creds-body");
  if (!creds.length) {
    body.innerHTML = '<tr><td colspan="5" class="muted">暂无凭证（未绑定或平台不可达时可能为空）</td></tr>';
    return;
  }
  body.innerHTML = creds.map((c) =>
    "<tr><td>" + esc(c.vendor) + "</td><td>" + esc(c.accountEmail || "—") + "</td><td>" + esc(c.subscriptionType || "—") + "</td><td>" + esc(({active:"正常",pending:"待审核",rejected:"已驳回",error:"异常",disabled:"已停用"})[c.status] || c.status || "—") + "</td><td>" + esc(c.createdAt || "—") + "</td></tr>"
  ).join("");
}

$("btn-bind").onclick = async () => {
  const code = $("bind-code").value.trim();
  if (!code) return show("bind-msg", "请输入绑定码", "bad");
  try {
    const r = await api("POST", "/api/platform/bind", { bindingCode: code });
    show("bind-msg", "绑定成功: providerId=" + r.providerId, "ok");
    refresh();
  } catch (e) { show("bind-msg", "绑定失败: " + e.message, "bad"); }
};

$("btn-unbind").onclick = async () => {
  if (!confirm("确定解绑该节点？平台侧 secret 将作废。")) return;
  try {
    await api("POST", "/api/platform/unbind");
    show("bind-msg", "已解绑", "ok");
    refresh();
  } catch (e) { show("bind-msg", "解绑失败: " + e.message, "bad"); }
};

$("btn-refresh-creds").onclick = refresh;

$("btn-detect").onclick = async () => {
  show("detect-msg", "探测中…");
  try {
    const r = await api("GET", "/api/oauth/local/detect");
    detected = r.data || [];
    const body = $("detect-body");
    if (!detected.length) {
      body.innerHTML = '<tr><td colspan="7" class="muted">未发现本机凭证</td></tr>';
    } else {
      body.innerHTML = detected.map((c, i) =>
        '<tr><td><input type="checkbox" class="detect-check" data-i="' + i + '" checked style="width:auto"></td><td>' + esc(c.vendor) + "</td><td>" + esc(c.source) + "</td><td>" + esc(c.accountEmail || "—") + "</td><td>" + esc(c.subscriptionType || "—") + "</td><td><code>" + esc(c.accessTokenMasked) + "</code></td><td>" + esc(c.expiresAt || "—") + "</td></tr>"
      ).join("");
    }
    $("btn-import").disabled = !detected.length;
    show("detect-msg", "发现 " + detected.length + " 个凭证", "ok");
  } catch (e) { show("detect-msg", "探测失败: " + e.message, "bad"); }
};

$("btn-import").onclick = async () => {
  const vendors = [...document.querySelectorAll(".detect-check")]
    .filter((c) => c.checked)
    .map((c) => detected[Number(c.dataset.i)]?.vendor)
    .filter(Boolean);
  if (!vendors.length) return show("detect-msg", "未选择凭证", "bad");
  try {
    const r = await api("POST", "/api/platform/credentials/authorize-local", { vendors });
    const errs = (r.errors || []).map((e) => e.vendor + ": " + e.message).join("\\n");
    show("detect-msg", "已上传 " + (r.data || []).length + " 个凭证，等待平台管理员审核后开始接单" + (errs ? "\\n失败:\\n" + errs : ""), errs ? "warn" : "ok");
    refresh();
  } catch (e) { show("detect-msg", "导入失败: " + e.message, "bad"); }
};

$("btn-token").onclick = async () => {
  const vendor = $("tok-vendor").value;
  const tokenJson = $("tok-json").value.trim();
  if (!tokenJson) return show("tok-msg", "请粘贴 token JSON", "bad");
  try {
    const r = await api("POST", "/api/platform/credentials/authorize-token", { vendor, tokenJson });
    show("tok-msg", "上传成功（待平台审核）: credentialBindingId=" + r.credentialBindingId, "ok");
    $("tok-json").value = "";
    refresh();
  } catch (e) { show("tok-msg", "上传失败: " + e.message, "bad"); }
};

refresh();
setInterval(refresh, 5000);
</script>
</body>
</html>
`;
