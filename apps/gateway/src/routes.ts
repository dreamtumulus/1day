import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { INTERNAL_HEADER, isModelAllowed, listRegistry, publicPricing, verifyInternalToken } from "@1dayapi/core";
import { authenticate } from "./auth.js";
import { sendError } from "./http.js";
import { inFlightSnapshot, proxy } from "./proxy.js";
import { estimateTokens } from "./usage.js";

async function handleModels(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const format = req.headers["anthropic-version"] ? "anthropic" : "openai-chat";
  const caller = authenticate(req, reply, format, false);
  if (!caller) return reply;
  const models = listRegistry().filter((m) => m.enabled && isModelAllowed(caller.allowlist, m.modelId));
  return {
    object: "list",
    data: models.map((m) => ({
      id: m.modelId,
      object: "model",
      type: "model",
      created: 0,
      owned_by: m.platform,
      display_name: m.displayName,
    })),
  };
}

// Claude Code calls this; answer locally with an estimate (no upstream cost).
async function handleCountTokens(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const caller = authenticate(req, reply, "anthropic", false);
  if (!caller) return reply;
  const body = (req.body ?? {}) as Record<string, unknown>;
  return { input_tokens: estimateTokens(JSON.stringify({ s: body.system, m: body.messages, t: body.tools })) };
}

function notImplemented(req: FastifyRequest, reply: FastifyReply): void {
  sendError(reply, "openai-chat", 501, "not_implemented", `${req.url} is not available yet.`, "invalid_request_error");
}

export function registerRoutes(app: FastifyInstance): void {
  app.get("/health", async () => ({ status: "ok", service: "1dayapi-gateway", time: new Date().toISOString() }));

  // Console loopback: live per-account in-flight counts (docs/console-api.md, admin accounts list).
  app.get("/internal/inflight", async (req, reply) => {
    if (!verifyInternalToken(req.headers[INTERNAL_HEADER])) {
      sendError(reply, "openai-chat", 401, "invalid_internal_token", "Internal token required.", "authentication_error");
      return reply;
    }
    return { data: inFlightSnapshot() };
  });

  for (const p of ["", "/v1"]) {
    app.get(`${p}/models`, handleModels);
    app.get(`${p}/models/pricing`, async () => ({ object: "list", data: publicPricing() }));
    app.post(`${p}/chat/completions`, (req, reply) => proxy(req, reply, "openai-chat", "/v1/chat/completions"));
    app.post(`${p}/messages`, (req, reply) => proxy(req, reply, "anthropic", "/v1/messages"));
    app.post(`${p}/messages/count_tokens`, handleCountTokens);
    app.post(`${p}/responses`, (req, reply) => proxy(req, reply, "responses", "/v1/responses"));
    app.post(`${p}/images/generations`, notImplemented);
    app.post(`${p}/videos`, notImplemented);
  }
}
