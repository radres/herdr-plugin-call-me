/**
 * Calling back into herdr.
 *
 * There is no plugin SDK -- the herdr CLI *is* the plugin API. We always go
 * through HERDR_BIN_PATH rather than the raw socket, because the socket
 * transport differs by OS (Unix socket vs Windows named pipe) and the CLI
 * hides that. Falls back to `herdr` on PATH when the env var is missing, which
 * is what happens when you run these scripts by hand while developing.
 */

import { spawnSync } from "node:child_process";

function herdrBin() {
  return process.env.HERDR_BIN_PATH || "herdr";
}

/** @returns {{ok: boolean, status: number|null, stdout: string, stderr: string}} */
export function herdr(args, { timeoutMs = 15_000 } = {}) {
  const result = spawnSync(herdrBin(), args, {
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    return { ok: false, status: null, stdout: "", stderr: String(result.error.message) };
  }
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

/**
 * Every herdr CLI response is an envelope: `{"id":"cli:...","result":{...}}`.
 * We hand back the unwrapped `result`, because that is the only part any caller
 * here cares about.
 *
 * Note there is no `--json` flag to pass: these commands emit JSON already, and
 * adding one is a usage error, which is a silent `undefined` if you do not check.
 */
export function herdrJson(args, options) {
  const result = herdr(args, options);
  if (!result.ok) return { ...result, json: undefined };
  try {
    const parsed = JSON.parse(result.stdout);
    return { ...result, json: parsed?.result ?? parsed };
  } catch {
    return { ...result, json: undefined };
  }
}

/**
 * The live status of one agent, or undefined when herdr cannot say.
 *
 * Used twice in the blocked flow: once after the grace delay to confirm the
 * agent is STILL blocked before ringing, and once after the call before
 * injecting the answer. Both checks exist because a human at the keyboard is
 * faster than a phone call, and typing an answer into an agent that already
 * moved on is the one genuinely destructive thing this plugin could do.
 */
export function agentStatus(target) {
  if (!target) return undefined;
  const { json } = herdrJson(["agent", "get", target]);
  const raw =
    json?.agent?.agent_status ??
    json?.agent?.status ??
    json?.agent_status ??
    json?.status;
  return typeof raw === "string" ? raw.toLowerCase() : undefined;
}

/**
 * Read the bottom of a pane. `detection` is the same snapshot herdr's own
 * screen-manifest detection classifies, i.e. exactly the region that made it
 * say `blocked` -- so it is the region holding the question.
 */
export function readPane(target, { lines = 40, source = "detection" } = {}) {
  if (!target) return "";
  // `agent read --source detection` first: it is the exact region herdr's own
  // classifier looked at to decide `blocked`, so it is where the question is.
  // Then the wider sources, then `pane read` -- which needs no detected agent at
  // all, and is what makes the `text` action work on an ordinary pane.
  const attempts = [
    ["agent", "read", target, "--source", source],
    ["agent", "read", target, "--source", "visible"],
    ["pane", "read", target, "--source", "visible"],
    ["pane", "read", target, "--source", "recent-unwrapped"],
  ];
  for (const base of attempts) {
    const result = herdr([...base, "--lines", String(lines), "--format", "text"]);
    const text = extractPaneText(result.stdout);
    if (result.ok && text.trim()) return text;
  }
  return "";
}

/**
 * `agent read` may hand back raw text or a JSON envelope depending on version.
 * Accept both rather than pinning a shape we cannot test across releases.
 */
export function extractPaneText(stdout) {
  const raw = String(stdout ?? "");
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return raw;
  try {
    const json = JSON.parse(trimmed);
    for (const key of ["text", "output", "content", "lines", "data"]) {
      const value = json?.[key] ?? json?.result?.[key];
      if (typeof value === "string") return value;
      if (Array.isArray(value)) return value.join("\n");
    }
    return raw;
  } catch {
    return raw;
  }
}

/**
 * Type text into an agent and press Enter.
 *
 * Only works when the agent is NOT blocked -- a blocked one returns
 * `agent_blocked`, "requires interactive input". That is why the blocked path
 * goes through `paneKeys` instead. No `--wait`: once the answer is in, the hook
 * is done, and blocking here would hold the phone lock while the agent thinks.
 */
export function promptAgent(target, text) {
  return herdr(["agent", "prompt", target, text], { timeoutMs: 20_000 });
}

/**
 * Send logical keys at the PANE level, not the agent level.
 *
 * `agent send-keys` refuses anything that is not "an active named agent", and a
 * blocked agent showing an approval menu is exactly when we need to press a key.
 * Pane-level input has no such gate, and herdr validates every key name before
 * writing a byte either way.
 */
export function paneKeys(target, keys) {
  if (!target) return { ok: false, status: null, stdout: "", stderr: "no pane" };
  return herdr(["pane", "send-keys", target, ...keys]);
}

/** Wait for an agent to leave `blocked`, so a text prompt will be accepted. */
export async function waitUntilUnblocked(target, { timeoutMs = 6000, stepMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = agentStatus(target);
    if (status !== "blocked") return status ?? "unknown";
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return "blocked";
}

/** A local toast, so there is a trace on screen even when the phone is ignored. */
export function notify(title, { body, sound = "request" } = {}) {
  const args = ["notification", "show", title, "--sound", sound];
  if (body) args.push("--body", body);
  return herdr(args, { timeoutMs: 8_000 });
}

/**
 * A display-only badge on the pane, so the sidebar shows the phone state.
 * `--token` is display metadata and never touches semantic agent state, which
 * is what waits, rollups and notifications key off.
 */
export function badge(paneId, value, { ttlMs = 600_000 } = {}) {
  if (!paneId) return { ok: false, status: null, stdout: "", stderr: "no pane" };
  const args = ["pane", "report-metadata", paneId, "--source", "callme", "--ttl-ms", String(ttlMs)];
  args.push("--token", value ? `callme=${value}` : "callme=");
  return herdr(args, { timeoutMs: 8_000 });
}

/** Literal text into a pane, no Enter. Pairs with `paneKeys(target, ["enter"])`. */
export function paneText(target, text) {
  if (!target) return { ok: false, status: null, stdout: "", stderr: "no pane" };
  return herdr(["pane", "send-text", target, text]);
}
