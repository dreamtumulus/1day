// Mock upstream for local E2E tests (docs/v3-design.md §7). Speaks:
//   Anthropic  POST /v1/messages                (x-api-key or Bearer)
//   OpenAI     POST /v1/chat/completions, /v1/responses (also without /v1)
// Streaming SSE supported. Usage is only sent in chat streams when the
// request sets stream_options.include_usage (like the real API).
//
// Failure injection: the upstream API key selects behaviour —
//   mock-429 -> 429 (retry-after: 30)   mock-401 -> 401   mock-500 -> 500
//   mock-400 -> 400 invalid_request     anything else -> success
//   mock-stream-error -> 200 stream that ends in an upstream `error` event / {error} chunk (no usage)
//   mock-body-cut     -> 200 non-stream whose body is cut mid-way (socket destroyed)
//
// Cloud session (CCR, docs/ccr-supply.md §3–§5, §7) — PROVISIONAL outbound
// event shape (Claude Code SDK stream-json family) until Appendix A lands:
//   POST /v1/environment_providers/cloud/create -> {environment_id:"env_mock"}
//   POST /v1/code/sessions                      -> {session:{id}}  (environment_id must be env_mock)
//   POST /v1/code/sessions/:id/events           -> {ok}; a `user` event schedules
//        stream_event partials -> assistant message -> result (over ~60ms)
//   GET  /v1/code/sessions/:id/events?sort_order=asc -> {data:[{event_id, event_type, ..., payload}]}
//   GET  /api/oauth/usage  -> window snapshot; Bearer `mock-window-full` reports 100% used
// If the folded prompt carries the tool_call protocol, the worker "calls" the first tool.
//
//   node scripts/mock-upstream.mjs     # MOCK_PORT (default 19001), loopback only
import http from "node:http";
import crypto from "node:crypto";

const PORT = Number(process.env.MOCK_PORT ?? 19001);
const HOST = process.env.MOCK_HOST ?? "127.0.0.1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

function json(res, status, obj, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(obj));
}

function sse(res) {
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
}

function keyOf(req) {
  const x = req.headers["x-api-key"];
  if (typeof x === "string") return x;
  const a = req.headers.authorization ?? "";
  return a.startsWith("Bearer ") ? a.slice(7) : "";
}

function wantsTool(body) {
  return Array.isArray(body.tools) && body.tools.length > 0;
}

const TEXT = ["Hello from ", "mock upstream."];

// Subscription (Bearer) callers get Anthropic's unified rate-limit headers, like the real API.
function unifiedHeaders(req) {
  if (!(req.headers.authorization ?? "").startsWith("Bearer ")) return {};
  const s = Math.floor(Date.now() / 1000);
  return {
    "anthropic-ratelimit-unified-5h-utilization": "0.42",
    "anthropic-ratelimit-unified-5h-reset": String(s + 3 * 3600),
    "anthropic-ratelimit-unified-5h-status": "allowed",
    "anthropic-ratelimit-unified-7d-utilization": "0.1",
    "anthropic-ratelimit-unified-7d-reset": String(s + 5 * 86400),
    "anthropic-ratelimit-unified-7d-status": "allowed",
    "anthropic-ratelimit-unified-status": "allowed",
  };
}

async function anthropic(res, body, req) {
  const model = body.model ?? "claude-mock";
  const usage = { input_tokens: 10, output_tokens: 6, cache_read_input_tokens: 4, cache_creation_input_tokens: 0 };
  const tool = wantsTool(body) ? body.tools[0] : null;
  const extra = unifiedHeaders(req);
  const key = keyOf(req);
  if (key === "mock-body-cut") {
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"id":"msg_mock","type":"message","content":[{"type":"text","text":"Hel');
    await sleep(20);
    res.destroy();
    return;
  }
  if (key === "mock-stream-error" && body.stream) {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", ...extra });
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev("message_start", { message: { id: "msg_mock", type: "message", role: "assistant", model, content: [], usage: { input_tokens: 10, output_tokens: 1 } } });
    await sleep(5);
    ev("error", { error: { type: "overloaded_error", message: "mock: overloaded mid-stream" } });
    res.end();
    return;
  }
  if (!body.stream) {
    const content = tool
      ? [{ type: "tool_use", id: "toolu_mock1", name: tool.name, input: { city: "Paris" } }]
      : [{ type: "text", text: TEXT.join("") }];
    return json(res, 200, {
      id: "msg_mock", type: "message", role: "assistant", model, content,
      stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null, usage,
    }, extra);
  }
  res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", ...extra });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev("message_start", { message: { id: "msg_mock", type: "message", role: "assistant", model, content: [], usage: { ...usage, output_tokens: 1 } } });
  if (tool) {
    ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_mock1", name: tool.name, input: {} } });
    ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"city":' } });
    ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '"Paris"}' } });
  } else {
    ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    for (const t of TEXT) {
      await sleep(5);
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: t } });
    }
  }
  ev("content_block_stop", { index: 0 });
  ev("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: usage.output_tokens } });
  ev("message_stop", {});
  res.end();
}

async function chat(res, body, req) {
  const model = body.model ?? "gpt-mock";
  const usage = { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19, prompt_tokens_details: { cached_tokens: 2 } };
  const tool = wantsTool(body) ? body.tools[0].function : null;
  if (keyOf(req) === "mock-stream-error" && body.stream) {
    sse(res);
    res.write(`data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })}\n\n`);
    await sleep(5);
    res.write(`data: ${JSON.stringify({ error: { message: "mock: upstream failed mid-stream", type: "server_error", code: null } })}\n\n`);
    res.end();
    return;
  }
  if (!body.stream) {
    const message = tool
      ? { role: "assistant", content: null, tool_calls: [{ id: "call_mock1", type: "function", function: { name: tool.name, arguments: '{"city":"Paris"}' } }] }
      : { role: "assistant", content: TEXT.join("") };
    return json(res, 200, {
      id: "chatcmpl-mock", object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, message, finish_reason: tool ? "tool_calls" : "stop" }], usage,
    });
  }
  sse(res);
  const chunk = (delta, finish, extra = {}) =>
    res.write(`data: ${JSON.stringify({ id: "chatcmpl-mock", object: "chat.completion.chunk", created: 0, model, choices: delta === null ? [] : [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);
  chunk({ role: "assistant", content: "" }, null);
  if (tool) {
    chunk({ tool_calls: [{ index: 0, id: "call_mock1", type: "function", function: { name: tool.name, arguments: "" } }] }, null);
    chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":"Paris"}' } }] }, null);
  } else {
    for (const t of TEXT) {
      await sleep(5);
      chunk({ content: t }, null);
    }
  }
  chunk({}, tool ? "tool_calls" : "stop");
  if (body.stream_options?.include_usage) chunk(null, null, { usage });
  res.write("data: [DONE]\n\n");
  res.end();
}

async function responses(res, body) {
  const model = body.model ?? "gpt-mock";
  const usage = { input_tokens: 9, output_tokens: 5, total_tokens: 14, input_tokens_details: { cached_tokens: 0 } };
  const response = {
    id: "resp_mock", object: "response", status: "completed", model,
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: TEXT.join("") }] }],
    usage,
  };
  if (!body.stream) return json(res, 200, response);
  sse(res);
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev("response.created", { response: { ...response, status: "in_progress", output: [], usage: null } });
  for (const t of TEXT) {
    await sleep(5);
    ev("response.output_text.delta", { delta: t });
  }
  ev("response.completed", { response });
  res.end();
}

// ---------- cloud sessions (CCR) ----------

const sessions = new Map(); // id -> { model, events: [Appendix A.1 envelope] }
let sessionSeq = 0;

// Appendix A.1 envelope: event_id / event_type / sequence_num / source(client|worker)
// / created_at / received_at / processing_at / processed_at / payload; the
// read-back array lives under the `data` key.
function pushEvent(s, payload, source = "worker") {
  const n = s.events.length + 1;
  const now = new Date().toISOString();
  s.events.push({
    event_id: `evt_${n}_${crypto.randomBytes(3).toString("hex")}`,
    event_type: payload.type,
    sequence_num: String(n),
    source,
    created_at: now,
    received_at: now,
    processing_at: now,
    processed_at: now,
    payload,
  });
}

function usageSnapshot(key) {
  const inOneHour = new Date(Date.now() + 3_600_000).toISOString();
  const inSixDays = new Date(Date.now() + 6 * 86_400_000).toISOString();
  if (key === "mock-window-full") {
    return { five_hour: { utilization: 100, resets_at: inOneHour }, seven_day: { utilization: 40, resets_at: inSixDays } };
  }
  return { five_hour: { utilization: 12.5, resets_at: inOneHour }, seven_day: { utilization: 3, resets_at: inSixDays } };
}

async function runWorker(s, userText) {
  const msgId = `msg_mock_${sessionSeq}`;
  // Appendix A.3: identity-context cache overhead dominates the upstream meter
  // (33725 cache_read on a two-token answer); client-visible usage is logical
  // only (§7.1 双账本). Snake usage rides the assistant event; the result
  // carries modelUsage (camelCase, per model, with costUSD) and NO snake usage.
  const usage = { input_tokens: 10, output_tokens: 6, cache_read_input_tokens: 33725, cache_creation_input_tokens: 1200 };
  const modelUsage = { [s.model]: { inputTokens: 10, outputTokens: 6, cacheReadInputTokens: 33725, cacheCreationInputTokens: 1200, thinkingTokens: 0, costUSD: 0.0042, costBasis: "api", contextWindow: 200000, maxOutputTokens: 64000 } };
  pushEvent(s, { type: "env_manager_log", level: "info", message: "sandbox provisioned" });
  pushEvent(s, { type: "system", subtype: "init", session_id: s.id, model: s.model });
  pushEvent(s, { type: "system", subtype: "hook_started" });
  pushEvent(s, { type: "active_goal", goal: null });
  pushEvent(s, { type: "autocompact_state", enabled: false });
  // Appendix A.1: rate_limit_event carries rate_limit_info.unifiedWindows (seconds resetsAt, ratio utilization).
  const sec = Math.floor(Date.now() / 1000);
  pushEvent(s, {
    type: "rate_limit_event",
    rate_limit_info: {
      status: "allowed",
      overageStatus: "allowed",
      unifiedWindows: {
        five_hour: { utilization: 0.42, resetsAt: sec + 3 * 3600 },
        seven_day: { utilization: 0.1, resetsAt: sec + 5 * 86400 },
      },
    },
  });
  // The folded prompt's [tools] section carries the simulation protocol and the tool schemas.
  const toolMatch = userText.includes("fenced block tagged tool_call") ? /"name":"([^"]+)"/.exec(userText) : null;
  const wantsTool = !!toolMatch;
  const text = wantsTool ? `Calling it.\n\n\`\`\`tool_call\n{"name":"${toolMatch[1]}","input":{"city":"Paris"}}\n\`\`\`` : TEXT.join("");
  const ev = (event) => pushEvent(s, { type: "stream_event", uuid: crypto.randomUUID(), session_id: s.id, event });
  ev({ type: "message_start", message: { id: msgId, type: "message", role: "assistant", model: s.model, content: [], usage: { ...usage, output_tokens: 1 } } });
  ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  if (wantsTool) {
    ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  } else {
    for (const t of TEXT) {
      await sleep(20);
      ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } });
    }
  }
  ev({ type: "content_block_stop", index: 0 });
  ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: usage.output_tokens } });
  await sleep(20);
  pushEvent(s, {
    type: "assistant", uuid: crypto.randomUUID(), session_id: s.id,
    message: { id: msgId, role: "assistant", model: s.model, content: [{ type: "text", text }], stop_reason: "end_turn", usage },
  });
  await sleep(20);
  pushEvent(s, { type: "result", subtype: "success", terminal_reason: "completed", is_error: false, stop_reason: "end_turn", result: text, modelUsage, duration_ms: 80, duration_api_ms: 50, num_turns: 1, session_id: s.id });
}

async function ccr(req, res, path, key, body) {
  if (!(req.headers.authorization ?? "").startsWith("Bearer ")) return json(res, 401, { type: "error", error: { type: "authentication_error", message: "mock: Bearer required" } });
  if (req.method === "GET" && path === "/api/oauth/usage") return json(res, 200, usageSnapshot(key));
  // §5.3: session release. 200 on archive, 409 when already archived.
  const am = /^\/v1\/code\/sessions\/([^/]+)\/archive$/.exec(path);
  if (am && req.method === "POST") {
    const s = sessions.get(am[1]);
    if (!s || s.archived) return json(res, 409, { type: "error", error: { type: "invalid_request_error", message: "mock: session already archived" } });
    s.archived = true;
    return json(res, 200, { archived: true });
  }
  if (req.method === "POST" && path === "/v1/environment_providers/cloud/create") {
    return json(res, 200, { environment_id: "env_mock", state: "active", config: { environment_type: "anthropic", sub_type: "ccr", cwd: "/workspace" } });
  }
  if (req.method === "POST" && path === "/v1/code/sessions") {
    if (body.environment_id !== "env_mock") return json(res, 400, { type: "error", error: { type: "invalid_request_error", message: "mock: unknown environment_id" } });
    const id = `cse_mock_${++sessionSeq}`;
    sessions.set(id, { id, model: body.config?.model ?? "unknown", events: [] });
    return json(res, 200, { session: { id, environment_id: body.environment_id, config: body.config } });
  }
  const m = /^\/v1\/code\/sessions\/([^/]+)\/events$/.exec(path);
  if (m) {
    const s = sessions.get(m[1]);
    if (!s) return json(res, 404, { type: "error", error: { type: "not_found_error", message: "mock: no such session" } });
    if (req.method === "GET") return json(res, 200, { data: s.events, has_more: false });
    if (req.method === "POST") {
      for (const e of Array.isArray(body.events) ? body.events : []) {
        const p = e?.payload ?? {};
        pushEvent(s, p, "client"); // inbound events join the ledger (A.1: source=client)
        if (p.type === "control_request" && p.request?.subtype === "set_model") {
          s.model = p.request.model;
          pushEvent(s, { type: "control_response", response: { subtype: "success", request_id: p.request_id ?? "mock" } }, "client");
        }
        if (p.type === "user") {
          const content = p.message?.content;
          const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((b) => b?.text ?? "").join("") : "";
          setTimeout(() => runWorker(s, text), 10);
        }
      }
      return json(res, 200, { ok: true });
    }
  }
  return null;
}

http
  .createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/health") return json(res, 200, { ok: true });
    // Test-only introspection for the session-pool e2e (§5.3).
    if (req.method === "GET" && path === "/ccr/debug") {
      return json(res, 200, {
        sessions: [...sessions.values()].map((s) => ({
          id: s.id,
          model: s.model,
          archived: s.archived === true,
          userEvents: s.events.filter((e) => e.payload?.type === "user").length,
          setModelEvents: s.events.filter((e) => e.payload?.type === "control_request").length,
        })),
      });
    }
    const key = keyOf(req);
    const body = req.method === "POST" ? await readBody(req) : {};
    if (key === "mock-429") return json(res, 429, { error: { type: "rate_limit_error", message: "mock rate limited" } }, { "retry-after": "30" });
    if (key === "mock-request-429") return json(res, 429, { error: { type: "rate_limit_error", code: "claude_code_version_too_old", message: "Claude Code 2.1.1 does not support this model; a newer client is required" } });
    if (key === "mock-model-429") return json(res, 429, { error: { type: "rate_limit_error", details: { error_code: "credits_required" }, message: "model quota exhausted; credits required" } }, { "retry-after": "45" });
    if (key === "mock-window-429") {
      const s = Math.floor(Date.now() / 1000);
      return json(res, 429, { type: "error", error: { type: "rate_limit_error", message: "mock 5h window exhausted" } }, {
        "anthropic-ratelimit-unified-5h-utilization": "1",
        "anthropic-ratelimit-unified-5h-reset": String(s + 2 * 3600),
        "anthropic-ratelimit-unified-5h-status": "rejected",
        "anthropic-ratelimit-unified-7d-utilization": "0.3",
        "anthropic-ratelimit-unified-7d-reset": String(s + 5 * 86400),
        "anthropic-ratelimit-unified-7d-status": "allowed",
        "anthropic-ratelimit-unified-reset": String(s + 2 * 3600),
      });
    }
    if (key === "mock-401") return json(res, 401, { error: { type: "authentication_error", message: "mock invalid key" } });
    if (key === "mock-500") return json(res, 500, { error: { type: "api_error", message: "mock server error" } });
    if (key === "mock-400") return json(res, 400, { error: { type: "invalid_request_error", message: "mock bad request" } });
    if (path.startsWith("/v1/code/") || path.startsWith("/v1/environment_providers/") || path === "/api/oauth/usage") {
      if (await ccr(req, res, path, key, body) !== null) return;
      return json(res, 404, { error: { message: `unknown path ${path}` } });
    }
    if (req.method !== "POST") return json(res, 404, { error: { message: "not found" } });
    if (path.endsWith("/messages")) return anthropic(res, body, req);
    if (path.endsWith("/chat/completions")) return chat(res, body, req);
    if (path.endsWith("/responses")) return responses(res, body);
    return json(res, 404, { error: { message: `unknown path ${path}` } });
  })
  .listen(PORT, HOST, () => console.log(`[mock-upstream] listening on http://${HOST}:${PORT}`));
