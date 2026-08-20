/**
 * Config, paired number, and the small amount of state this plugin owns.
 *
 * The paired number has ONE home across the whole /call-me family:
 * `~/.aiphone/config.json`. Pair once from the iPhone app, the Claude Code
 * plugin, or this plugin's `pair` pane, and every other entry point sees it.
 * That file is why `.env` does not need to carry a number at all.
 *
 * Resolution order, highest first:
 *   1. CALLME_NUMBER / AIPHONE_USER_NUMBER in the environment
 *   2. CALLME_NUMBER in $HERDR_PLUGIN_CONFIG_DIR/.env  (herdr-managed config)
 *   3. user_number in ~/.aiphone/config.json           (the shared home)
 *
 * This file deliberately does NOT import the Claude Code plugin's
 * lib/callme-config.mjs. That module also owns per-session state files, the
 * answer-waiter window and the Stop-hook stamps, none of which exist here; the
 * only overlap is the number, and duplicating twelve lines beats coupling a
 * herdr plugin to another host's session model.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/* ---------------------------------------------------------------- numbers -- */

export function normalizeNumber(value) {
  return String(value ?? "").replace(/\D/g, "");
}

export function isValidNumber(value) {
  return /^\d{10}$/.test(normalizeNumber(value));
}

/** 469-661-8447 -- the grouping the iPhone app shows, so it reads back the same. */
export function displayNumber(value) {
  const n = normalizeNumber(value);
  return n.length === 10 ? `${n.slice(0, 3)}-${n.slice(3, 6)}-${n.slice(6)}` : n;
}

/** The shared /call-me state dir. AIPHONE_STATE_DIR is a test/dev override. */
export function aiphoneStateDir() {
  return process.env.AIPHONE_STATE_DIR || join(homedir(), ".aiphone");
}

export function aiphoneConfigPath() {
  return join(aiphoneStateDir(), "config.json");
}

function numberFromSharedConfig() {
  try {
    const raw = JSON.parse(readFileSync(aiphoneConfigPath(), "utf8"));
    return isValidNumber(raw?.user_number) ? normalizeNumber(raw.user_number) : undefined;
  } catch {
    return undefined;
  }
}

/** @returns {{number?: string, source: string}} */
export function pairedNumber() {
  for (const name of ["CALLME_NUMBER", "AIPHONE_USER_NUMBER"]) {
    if (isValidNumber(process.env[name])) {
      return { number: normalizeNumber(process.env[name]), source: name };
    }
  }
  const shared = numberFromSharedConfig();
  if (shared) return { number: shared, source: aiphoneConfigPath() };
  return { source: "unpaired" };
}

/**
 * Write the number into the shared home, so pairing here also pairs the iPhone
 * app's other agents. Keeps 0600 on the file and 0700 on the dir -- it is the
 * one thing that can ring a real person's phone.
 */
export function savePairedNumber(value) {
  const number = normalizeNumber(value);
  if (!isValidNumber(number)) throw new Error(`not a 10-digit number: ${value}`);
  const dir = aiphoneStateDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let existing = {};
  try {
    existing = JSON.parse(readFileSync(aiphoneConfigPath(), "utf8")) || {};
  } catch {
    /* first pairing on this machine */
  }
  const next = {
    ...existing,
    version: 1,
    user_number: number,
    source: "herdr-pair",
    updated_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    display: displayNumber(number),
  };
  writeFileSync(aiphoneConfigPath(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return number;
}

/* ------------------------------------------------------------------ .env -- */

/**
 * herdr seeds HERDR_PLUGIN_CONFIG_DIR and never touches its contents, so the
 * `.env` there is the user's file and survives a reinstall (the plugin ROOT
 * does not -- it is a managed git checkout).
 */
export function loadDotEnv() {
  const candidates = [];
  if (process.env.HERDR_PLUGIN_CONFIG_DIR) {
    candidates.push(join(process.env.HERDR_PLUGIN_CONFIG_DIR, ".env"));
  }
  candidates.push(join(pluginRoot, ".env")); // local dev fallback, gitignored
  for (const path of [...new Set(candidates)]) {
    let content;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      // Real environment wins over the file, so a one-off override works.
      if (!key || process.env[key] !== undefined) continue;
      process.env[key] = stripQuotes(line.slice(eq + 1).trim());
    }
  }
}

function stripQuotes(value) {
  const quoted =
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"));
  return quoted ? value.slice(1, -1) : value;
}

/* --------------------------------------------------------------- settings -- */

const OFF = ["0", "false", "no", "off", "disabled"];

export function envFlag(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return !OFF.includes(raw.trim().toLowerCase());
}

export function envInt(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = Number.parseInt(String(process.env[name] ?? "").trim(), 10);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
}

/** `call` | `text` | `off` -- what a given agent status is worth. */
export function envMode(name, fallback) {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (["call", "ring", "phone"].includes(raw)) return "call";
  if (["text", "sms", "message"].includes(raw)) return "text";
  if (OFF.includes(raw)) return "off";
  return fallback;
}

export function settings() {
  return {
    onBlocked: envMode("CALLME_ON_BLOCKED", "call"),
    onDone: envMode("CALLME_ON_DONE", "text"),
    answerBack: envFlag("CALLME_ANSWER_BACK", true),
    graceS: envInt("CALLME_GRACE_S", 20, { min: 0, max: 600 }),
    callTimeoutS: envInt("CALLME_CALL_TIMEOUT_S", 120, { min: 30, max: 300 }),
    cooldownS: envInt("CALLME_COOLDOWN_S", 300, { min: 0, max: 86_400 }),
    readLines: envInt("CALLME_READ_LINES", 40, { min: 5, max: 200 }),
    toast: envFlag("CALLME_TOAST", true),
    label: String(process.env.CALLME_LABEL ?? "").trim() || undefined,
  };
}

/* ------------------------------------------------------------------ state -- */

/** Runtime state. HERDR_PLUGIN_STATE_DIR when herdr runs us; XDG otherwise. */
export function stateDir() {
  if (process.env.HERDR_PLUGIN_STATE_DIR) return process.env.HERDR_PLUGIN_STATE_DIR;
  const home =
    process.env.XDG_STATE_HOME ||
    (process.env.HOME ? join(process.env.HOME, ".local", "state") : pluginRoot);
  return join(home, "herdr-plugin-call-me");
}

function statePath(name) {
  return join(stateDir(), name);
}

function readState(name) {
  try {
    return readFileSync(statePath(name), "utf8");
  } catch {
    return undefined;
  }
}

function writeState(name, content) {
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(statePath(name), content, "utf8");
}

/** The master switch the `toggle` action flips, so a key can silence the phone. */
export function isEnabled() {
  const raw = readState("enabled");
  if (raw === undefined) return envFlag("CALLME_ENABLED", true);
  return !OFF.includes(raw.trim().toLowerCase());
}

export function setEnabled(enabled) {
  writeState("enabled", enabled ? "enabled\n" : "disabled\n");
  return enabled;
}

function safeKey(value) {
  return String(value ?? "unknown").replace(/[^A-Za-z0-9._-]+/g, "-");
}

/**
 * Per-pane, per-status cooldown.
 *
 * `pane.agent_status_changed` is chatty: an agent can bounce working -> idle ->
 * working several times a minute, and every bounce is a fresh event hook
 * process. Without this an afternoon of work is an afternoon of phone calls.
 */
export function claimCooldown({ paneId, status, cooldownS, now = Date.now() }) {
  if (cooldownS <= 0) return true;
  const name = `last-${safeKey(paneId)}-${safeKey(status)}`;
  const previous = Number.parseInt(readState(name) ?? "", 10);
  if (Number.isFinite(previous) && now - previous < cooldownS * 1000) return false;
  writeState(name, String(now));
  return true;
}

/**
 * One call at a time, across every pane.
 *
 * Two agents blocking together used to mean two simultaneous rings to one
 * phone, and the second one always loses (the server holds one live call per
 * number). The loser downgrades to a text instead, which is the honest outcome.
 */
export function acquireCallLock({ holdS = 400, now = Date.now() } = {}) {
  const name = "call-in-flight";
  const previous = Number.parseInt(readState(name) ?? "", 10);
  if (Number.isFinite(previous) && now - previous < holdS * 1000) return false;
  writeState(name, String(now));
  return true;
}

export function releaseCallLock() {
  try {
    writeState("call-in-flight", "0");
  } catch {
    /* a stuck lock expires on its own via holdS */
  }
}

export function stateFileExists(name) {
  return existsSync(statePath(name));
}
