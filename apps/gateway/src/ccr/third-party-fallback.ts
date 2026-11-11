import { sha256Hex } from "@1dayapi/core";
import { classifyCcRequestError } from "./model-unavailable.js";
import { callerSystemText } from "./translate.js";

export const THIRD_PARTY_FALLBACK_TTL_MS = 12 * 60 * 60 * 1000;
export const THIRD_PARTY_KEY_CHARS = 2048;

type Json = Record<string, any>;

/** The agent's own prefix, not its changing date / cwd / project instructions. */
export function thirdPartyPromptKey(body: Json): string {
  const system = callerSystemText(body).trim();
  return system ? sha256Hex(system.slice(0, THIRD_PARTY_KEY_CHARS)) : "";
}

function unansweredThirdPartyRefusal(text: string): boolean {
  return classifyCcRequestError(text)?.code === "third_party_extra_usage" && !/\(after partial output\)/i.test(text);
}

function errorOnlySse(text: string): boolean {
  const frames = text.split(/\r?\n\r?\n/).map((s) => s.trim()).filter(Boolean);
  return frames.length > 0 && frames.every((s) => s.startsWith("event: error\n")) && unansweredThirdPartyRefusal(text);
}

function withBody(res: Response, body: string | ReadableStream<Uint8Array> | null): Response {
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

export interface ThirdPartyInspection {
  response: Response | null;
  refused: boolean;
}

/** Inspect before the downstream sees anything. A started answer is never replayed. */
export async function inspectThirdPartyResponse(res: Response, stream: boolean): Promise<ThirdPartyInspection> {
  if (!stream) {
    if (res.status !== 502) return { response: res, refused: false };
    const text = await res.text();
    if (unansweredThirdPartyRefusal(text)) return { response: null, refused: true };
    return { response: withBody(res, text), refused: false };
  }
  if (!res.body) return { response: res, refused: false };
  const reader = res.body.getReader();
  const first = await reader.read();
  if (first.done) return { response: withBody(res, null), refused: false };
  if (errorOnlySse(new TextDecoder().decode(first.value))) {
    await reader.cancel().catch(() => {});
    return { response: null, refused: true };
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first.value);
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { response: withBody(res, body), refused: false };
}
