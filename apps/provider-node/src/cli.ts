#!/usr/bin/env bun
import { NODE_VERSION } from "./version.js";

const CONSOLE_BASE = (
  process.env.PROVIDER_CONSOLE_URL ?? "http://127.0.0.1:16889"
).replace(/\/+$/, "");

function usage(): void {
  console.log(`1dayapi-node v${NODE_VERSION} — 1DayAPI provider node CLI

Usage: 1dayapi-node <command> [options]

Commands:
  serve                      Start the provider node daemon (console + WS bridge)
  bind --value <bind_...>    Redeem a platform binding code (via local console)
  status                     Show node / bridge status
  list                       List credentials uploaded to the platform
  import [--vendor v]        Detect local CLI credentials and upload them
  install-service            Install + enable the systemd user unit
  uninstall-service          Disable and remove the systemd user unit
  start | stop | restart     Control the systemd user service
  logs                       Follow service logs (journalctl --user-unit)
  doctor                     Check node/paths/systemd/docker/console health
  version                    Print version

Environment:
  PROVIDER_CONSOLE_URL       Local console base URL (default ${CONSOLE_BASE})
  PROVIDER_CONFIG_PATH       Config file path (default ~/.config/1dayapi-provider-node/config.json)
  PROVIDER_PLATFORM_WS_URL   Override platform WS URL
  PROVIDER_SYSTEMD_USER_DIR  Override systemd user unit dir (testing)
  NODE_ALLOW_NODE_RUNTIME=1  Dev-only escape hatch: allow serving under Node.js
                             (production must run under Bun for TLS fingerprint parity)
`);
}

async function fetchCsrf(): Promise<string> {
  const res = await fetch(CONSOLE_BASE + "/api/status");
  const token = res.headers.get("x-csrf-token");
  if (!token) throw new Error(`Local console did not return x-csrf-token (HTTP ${res.status})`);
  return token;
}

async function callConsole(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (method !== "GET") headers["x-1dayapi-csrf"] = await fetchCsrf();
  const res = await fetch(CONSOLE_BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

async function cmdBind(args: string[]): Promise<void> {
  let value: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--value") value = args[++i];
    else if (!args[i].startsWith("-") && !value) value = args[i];
  }
  if (!value) fail("bind requires --value <bind_...>");
  const { status, json } = await callConsole("POST", "/api/platform/bind", { bindingCode: value });
  if (status >= 400) {
    const err = json.error as { code?: string; message?: string } | undefined;
    fail(err?.message ?? `bind failed (HTTP ${status})`);
  }
  console.log(`bound: providerId=${json.providerId} nodeId=${json.nodeId}`);
  console.log(`platform WS: ${json.platformWsUrl}`);
}

async function cmdStatus(): Promise<void> {
  const { status, json } = await callConsole("GET", "/api/status");
  if (status >= 400) fail(`status failed (HTTP ${status}) — is the node running?`);
  console.log(JSON.stringify(json, null, 2));
}

async function cmdList(): Promise<void> {
  const { status, json } = await callConsole("GET", "/api/status");
  if (status >= 400) fail(`list failed (HTTP ${status}) — is the node running?`);
  const creds = (json.credentials as unknown[]) ?? [];
  if (!creds.length) {
    console.log("(no credentials)");
    return;
  }
  console.log(JSON.stringify(creds, null, 2));
}

async function cmdImport(args: string[]): Promise<void> {
  let vendor: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--vendor") vendor = args[++i];
  }
  const detect = await callConsole("GET", "/api/oauth/local/detect");
  if (detect.status >= 400) fail("detect failed — is the node running?");
  const found = (detect.json.data as Array<Record<string, unknown>>) ?? [];
  console.log(`detected ${found.length} local credential(s):`);
  for (const c of found) {
    console.log(
      `  - ${c.vendor} ${c.accountEmail ?? ""} ${c.subscriptionType ?? ""} (${c.source}) token=${c.accessTokenMasked}`,
    );
  }
  const wanted = vendor ? found.filter((c) => c.vendor === vendor) : found;
  if (!wanted.length) fail("nothing to import");
  const { status, json } = await callConsole("POST", "/api/platform/credentials/authorize-local", {
    vendors: wanted.map((c) => c.vendor),
  });
  if (status >= 400) {
    const err = json.error as { message?: string } | undefined;
    fail(err?.message ?? `import failed (HTTP ${status})`);
  }
  console.log(`uploaded: ${JSON.stringify(json.data)}`);
  const errors = (json.errors as Array<Record<string, string>>) ?? [];
  for (const e of errors) console.error(`  failed ${e.vendor}: ${e.message}`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "serve": {
      const mod = await import("./index.js");
      await mod.main();
      break;
    }
    case "bind":
      await cmdBind(args);
      break;
    case "status":
      await cmdStatus();
      break;
    case "list":
      await cmdList();
      break;
    case "import":
      await cmdImport(args);
      break;
    case "install-service": {
      const { cmdInstallService } = await import("./service.js");
      await cmdInstallService();
      break;
    }
    case "uninstall-service": {
      const { cmdUninstallService } = await import("./service.js");
      await cmdUninstallService();
      break;
    }
    case "start":
    case "stop":
    case "restart": {
      const { cmdServiceControl } = await import("./service.js");
      await cmdServiceControl(command);
      break;
    }
    case "logs": {
      const { cmdLogs } = await import("./service.js");
      cmdLogs();
      break;
    }
    case "doctor": {
      const { cmdDoctor } = await import("./service.js");
      await cmdDoctor();
      break;
    }
    case "version":
    case "--version":
    case "-v":
      console.log(NODE_VERSION);
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      usage();
      break;
    default:
      fail(`unknown command: ${command}`);
  }
}

main().catch((err) => {
  console.error(`error: ${(err as Error).message}`);
  process.exit(1);
});
