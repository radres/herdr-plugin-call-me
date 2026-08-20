/**
 * Turning herdr's invocation context into something a phone can say.
 *
 * Two inputs, both JSON in the environment:
 *   HERDR_PLUGIN_EVENT_JSON   -- set for event hooks; carries the status change
 *   HERDR_PLUGIN_CONTEXT_JSON -- workspace / tab / focused pane / agent
 *
 * Field spellings are read defensively across several shapes. The official
 * example plugin does the same, and for the same reason: these payloads grow
 * new keys between herdr releases, and a notifier that throws on an unexpected
 * shape is worse than one that degrades to "agent".
 */

import { parseOptions } from "./answer.mjs";

export function readJsonEnv(name) {
  const raw = process.env[name];
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * @returns {{status?: string, paneId?: string, workspaceId?: string,
 *            agent?: string, workspace?: string, tab?: string}}
 */
export function invocation() {
  const event = readJsonEnv("HERDR_PLUGIN_EVENT_JSON");
  const context = readJsonEnv("HERDR_PLUGIN_CONTEXT_JSON");
  const data = event?.data ?? event ?? {};

  const status = firstString(
    data.agent_status,
    data.status,
    data.pane?.agent_status,
    data.pane?.agent?.status,
    context.focused_pane_status,
    context.agent_status,
    context.status,
  );

  const paneId = firstString(
    data.pane_id,
    data.pane?.pane_id,
    data.pane?.id,
    process.env.HERDR_PANE_ID,
    context.focused_pane_id,
    context.pane_id,
    context.pane?.pane_id,
  );

  return {
    status: status?.toLowerCase(),
    paneId,
    workspaceId: firstString(
      data.workspace_id,
      data.pane?.workspace_id,
      process.env.HERDR_WORKSPACE_ID,
      context.workspace_id,
    ),
    agent: firstString(
      data.display_agent,
      data.agent,
      data.pane?.display_agent,
      data.pane?.agent,
      context.focused_pane_agent,
      context.agent,
    ),
    workspace: firstString(context.workspace_label, context.workspace?.label),
    tab: namedTab(firstString(context.tab_label, context.tab?.label)),
  };
}

/** herdr numbers unnamed tabs; "3" tells a human on the phone nothing. */
function namedTab(label) {
  if (!label || /^\d+$/.test(label)) return undefined;
  return label;
}

/** "Claude on call-me / review" -- who is calling, in the phone's thread list. */
export function describe(info) {
  const who = titleCase(info.agent ?? "agent");
  const where = info.workspace ?? info.workspaceId;
  const parts = [who];
  if (where) parts.push(where);
  if (info.tab) parts.push(info.tab);
  return parts.join(" · ");
}

function titleCase(value) {
  const text = String(value ?? "").trim();
  if (!text) return "Agent";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/* ------------------------------------------------------ screen -> speech -- */

/** CSI sequences. We ask for --format text, but a stray one must not be spoken. */
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

/** Braille/block spinner frames and bullet glyphs agents animate with. */
const SPINNER = /[⠀-⣿▖-▟●○◐-◓]/gu;

/** Box drawing, blocks, geometric shapes, and the usual TUI furniture. */
const DECORATION =
  /^[\s─-╿▀-▟■-◿•*_=~+<>|.'"`·—–-]+$/u;

/** Border/prompt glyphs wrapping a line that does carry text. */
const LEADING_BORDER = /^[\s─-╿▀-▟|>*•-]+/u;
const TRAILING_BORDER = /[\s─-╿▀-▟|]+$/u;

/**
 * Condense a terminal snapshot into a sentence worth speaking.
 *
 * The snapshot is the bottom of an agent's TUI: a question, usually an approval
 * menu, wrapped in borders and progress spinners. Read verbatim by a
 * text-to-speech voice that is unlistenable, so:
 *
 *   - drop lines that are pure decoration or only a spinner
 *   - strip leading border glyphs from the lines that survive
 *   - keep the TAIL, because the prompt is always at the bottom
 *   - collapse runs of whitespace, which a border layout is full of
 *
 * Numbered menu items are kept deliberately: "1. Yes  2. Yes, and don't ask
 * again  3. No" is the single most useful thing to hear, and it tells the human
 * exactly what to say back.
 */
export function condense(screen, { maxLines = 14, maxChars = 460 } = {}) {
  const lines = String(screen ?? "")
    .replace(ANSI, "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(SPINNER, " ").replace(/\s+/g, " ").trim())
    .map((line) => line.replace(LEADING_BORDER, "").replace(TRAILING_BORDER, "").trim())
    .filter((line) => line && !DECORATION.test(line));

  const deduped = [];
  for (const line of lines) {
    if (deduped[deduped.length - 1] !== line) deduped.push(line);
  }

  const tail = deduped.slice(-maxLines).join(" ");
  return tail.length > maxChars ? `${tail.slice(0, maxChars - 1).trimEnd()}…` : tail;
}

/**
 * Trim a snapshot down to the prompt that is actually live.
 *
 * A pane keeps its scrollback, so a naive tail can mix the current question with
 * whatever scrolled past a minute ago -- and the phone then reads out a jumble.
 * When there IS a menu on screen we start from the last option 1, keeping a few
 * lines above it for the command and the question they belong to.
 */
export function focusOnPrompt(screen, { lead = 10 } = {}) {
  const text = String(screen ?? "");
  if (!parseOptions(text).length) return text;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/(?:^|[\s│┃|>])\s*1\s*[.):-]\s+\S/.test(lines[i].replace(ANSI, ""))) {
      return lines.slice(Math.max(0, i - lead)).join("\n");
    }
  }
  return text;
}

/** What the phone says when an agent is waiting on a decision. */
export function blockedScript(info, screen) {
  const who = describe(info);
  const question = condense(focusOnPrompt(screen));
  if (!question) {
    return `${who} is waiting for a decision, but I could not read the question off the screen. What should it do?`;
  }
  return `${who} is waiting for you. It says: ${question}`;
}

/** What the phone says, or texts, when an agent has finished. */
export function doneScript(info) {
  return `${describe(info)} finished and is waiting for review.`;
}
