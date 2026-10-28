import { readFileSync } from "node:fs";
const KEY = readFileSync(process.argv[2], "utf8").split("\n").find((l) => l.startsWith("consumer API key")).split(":")[1].trim();
const G = `http://127.0.0.1:${process.env.E2E_GATEWAY_PORT ?? 18400}`;
const H = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };
let fails = 0;
const check = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"} ${name} ${cond ? "" : extra}`); if (!cond) fails++; };
const post = async (path, body, headers = H) => {
  const r = await fetch(G + path, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: r.status, text: await r.text() };
};
const tools = [{ type: "function", function: { name: "get_weather", description: "w", parameters: { type: "object", properties: { city: { type: "string" } } } } }];
const msgs = [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }];

let r = await post("/v1/chat/completions", { model: "claude-sonnet-5", messages: msgs });
let j = JSON.parse(r.text);
check("chat->anthropic nonstream", r.status === 200 && j.choices[0].message.content === "Hello from mock upstream." && j.usage.prompt_tokens === 14, r.text);

r = await post("/v1/chat/completions", { model: "claude-sonnet-5", messages: msgs, tools });
j = JSON.parse(r.text);
check("chat->anthropic tools", j.choices?.[0]?.finish_reason === "tool_calls" && JSON.parse(j.choices[0].message.tool_calls[0].function.arguments).city === "Paris", r.text);

r = await post("/v1/chat/completions", { model: "claude-sonnet-5", messages: msgs, stream: true });
check("chat->anthropic stream", r.status === 200 && r.text.includes('"content":"Hello from "') && r.text.trim().endsWith("data: [DONE]") && !r.text.includes('"usage"'), r.text);

r = await post("/v1/chat/completions", { model: "claude-sonnet-5", messages: msgs, stream: true, stream_options: { include_usage: true } });
check("chat->anthropic stream include_usage", r.text.includes('"prompt_tokens":14'), r.text);

r = await post("/v1/chat/completions", { model: "claude-sonnet-5", messages: msgs, tools, stream: true });
check("chat->anthropic stream tools", r.text.includes('"name":"get_weather"') && r.text.includes('Paris') && r.text.includes('"finish_reason":"tool_calls"'), r.text);

r = await post("/v1/chat/completions", { model: "gpt-5.5", messages: msgs });
j = JSON.parse(r.text);
check("chat passthrough", r.status === 200 && j.choices[0].message.content === "Hello from mock upstream.", r.text);

r = await post("/v1/chat/completions", { model: "gpt-5.5", messages: msgs, stream: true });
check("chat passthrough stream hides injected usage", r.status === 200 && r.text.includes("[DONE]") && !r.text.includes('"usage"'), r.text);

r = await post("/v1/messages", { model: "claude-sonnet-5", max_tokens: 50, messages: [{ role: "user", content: "hi" }] });
j = JSON.parse(r.text);
check("messages passthrough", r.status === 200 && j.content[0].text === "Hello from mock upstream.", r.text);

r = await post("/v1/messages", { model: "claude-sonnet-5", max_tokens: 50, stream: true, messages: [{ role: "user", content: "hi" }] });
check("messages passthrough stream", r.text.includes("event: message_stop"), r.text);

r = await post("/v1/messages", { model: "gpt-5.5", max_tokens: 50, system: "s", messages: [{ role: "user", content: "hi" }] });
j = JSON.parse(r.text);
check("messages->openai nonstream", r.status === 200 && j.type === "message" && j.content[0].text === "Hello from mock upstream." && j.usage.input_tokens === 10, r.text);

r = await post("/v1/messages", { model: "gpt-5.5", max_tokens: 50, stream: true, messages: [{ role: "user", content: "hi" }],
  tools: [{ name: "get_weather", input_schema: { type: "object" } }] });
check("messages->openai stream tools", r.text.includes("event: message_start") && r.text.includes('"type":"tool_use"') && r.text.includes("input_json_delta") && r.text.includes('"stop_reason":"tool_use"') && r.text.includes("message_stop"), r.text);

r = await post("/v1/responses", { model: "gpt-5.5", input: "hi", stream: true });
check("responses stream", r.status === 200 && r.text.includes("response.completed"), r.text);

r = await post("/v1/responses", { model: "claude-sonnet-5", input: "hi" });
check("responses on anthropic-only -> 400", r.status === 400 && r.text.includes("unsupported_endpoint"), r.text);

r = await post("/v1/chat/completions", { model: "no-such-model", messages: msgs });
check("unknown model 404", r.status === 404 && r.text.includes("model_not_found"), r.text);

r = await post("/v1/messages", { model: "claude-sonnet-5", messages: [] });
check("messages missing max_tokens", r.status === 400 && r.text.includes('"type":"error"'), r.text);

r = await post("/v1/chat/completions", { model: "gpt-5.5", messages: msgs }, { ...H, authorization: "Bearer sk-1d-bogus" });
check("invalid key 401", r.status === 401, r.text);

const m = await fetch(G + "/v1/models", { headers: H }).then((x) => x.json());
check("models list", Array.isArray(m.data) && ["claude-sonnet-5", "gpt-5.5"].every((id) => m.data.some((entry) => entry.id === id)), JSON.stringify(m).slice(0, 200));

console.log(fails ? `${fails} FAILED` : "ALL PASS");
process.exit(fails ? 1 : 0);
