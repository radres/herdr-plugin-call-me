/**
 * Putting a spoken answer back into a pane.
 *
 * This is the half of the product nothing else in the herdr marketplace does.
 * Every other notifier stops at "your agent is stuck"; here the human says a
 * sentence into a phone and the agent carries on, with no keyboard involved.
 *
 * The mechanics are dictated by one thing learned against a live server: a
 * BLOCKED agent will not take text.
 *
 *   herdr agent prompt    -> {"code":"agent_blocked","message":"requires interactive input"}
 *   herdr agent send-keys -> {"code":"agent_not_ready","message":"not an active named agent"}
 *
 * Pane-level input has no such gate, so a blocked agent is answered with
 * `pane send-keys` / `pane send-text`, and an unblocked one with `agent prompt`
 * (which handles bracketed paste and the Enter encoding for you).
 *
 * The safety rule, and it outranks the feature: we only press a key we can read
 * off the screen. If the pane is showing a menu we cannot map the sentence onto,
 * we press NOTHING and say so. Pressing Enter on an unrecognised menu would
 * accept whatever happens to be highlighted -- in Claude Code that is "Yes",
 * i.e. approving a command the human never approved. Leaving the agent blocked
 * is always recoverable; approving on a coin flip is not.
 */

import { chooseOption, parseOptions, parseYesNo, polarity, residual } from "./answer.mjs";
import {
  agentStatus,
  paneKeys,
  paneText,
  promptAgent,
  readPane,
  waitUntilUnblocked,
} from "./herdr.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** How long to let a keystroke land before deciding whether it worked. */
const SETTLE_MS = 900;

/**
 * @returns {Promise<{ok: boolean, how: string, cleared: boolean, detail?: string}>}
 *   `ok`      -- we delivered the answer somewhere it could be read
 *   `cleared` -- the agent actually left `blocked` afterwards
 *   `how`     -- for the badge and the log: prompt | keys | keys+text | text | unmapped
 */
export async function injectAnswer({ target, transcript, screen, readLines = 40 }) {
  if (!target) return { ok: false, how: "unmapped", cleared: false, detail: "no pane id" };
  const answer = String(transcript ?? "").trim();
  if (!answer) return { ok: false, how: "unmapped", cleared: false, detail: "empty transcript" };

  // Not blocked: the agent is idle or working, and `agent prompt` is the right
  // door -- it queues the sentence the way the keyboard would.
  if (agentStatus(target) !== "blocked") {
    const sent = promptAgent(target, answer);
    return {
      ok: sent.ok,
      how: "prompt",
      cleared: true,
      detail: sent.ok ? undefined : reason(sent),
    };
  }

  const view = screen && screen.trim() ? screen : readPane(target, { lines: readLines });
  const options = parseOptions(view);

  if (options.length) return await answerMenu({ target, answer, options });

  const yesNo = parseYesNo(view);
  if (yesNo) {
    const want = polarity(answer);
    if (!want) {
      return {
        ok: false,
        how: "unmapped",
        cleared: false,
        detail: "a (y/n) prompt, and the answer was neither",
      };
    }
    return await pressAndSettle({ target, key: want === "pos" ? yesNo.yes : yesNo.no });
  }

  // No menu and no y/n: a plain text prompt (a shell `read`, a commit message, an
  // agent composer). Literal text plus Enter is exactly what a keyboard sends.
  const typed = paneText(target, answer);
  if (!typed.ok) return { ok: false, how: "text", cleared: false, detail: reason(typed) };
  const entered = paneKeys(target, ["enter"]);
  if (!entered.ok) return { ok: false, how: "text", cleared: false, detail: reason(entered) };
  await sleep(SETTLE_MS);
  return { ok: true, how: "text", cleared: agentStatus(target) !== "blocked" };
}

/* ------------------------------------------------------------------ menus -- */

async function answerMenu({ target, answer, options }) {
  const choice = chooseOption(answer, options);
  if (!choice) {
    return {
      ok: false,
      how: "unmapped",
      cleared: false,
      detail: `could not map "${answer}" onto ${options.map((o) => `${o.key}=${o.text}`).join(" / ")}`,
    };
  }

  const pressed = await pressAndSettle({ target, key: choice.key });
  if (!pressed.ok) return pressed;

  const extra = residual(answer, choice);

  // The option opened a free-text box ("No, and tell Claude what to do
  // differently"). Whatever else the human said belongs in it, and if they said
  // nothing else, the sentence itself is the feedback.
  if (choice.wantsText) {
    const body = extra ?? answer;
    const typed = paneText(target, body);
    if (typed.ok) paneKeys(target, ["enter"]);
    await sleep(SETTLE_MS);
    return {
      ok: true,
      how: typed.ok ? "keys+text" : "keys",
      cleared: agentStatus(target) !== "blocked",
      detail: typed.ok ? undefined : reason(typed),
    };
  }

  // "yes, but run the tests first" is an approval AND an instruction. Losing the
  // instruction would be the most irritating possible bug, so it is queued as an
  // ordinary prompt once the agent is taking text again.
  if (extra) {
    const state = await waitUntilUnblocked(target, { timeoutMs: 5000 });
    if (state !== "blocked") promptAgent(target, extra);
  }

  return { ...pressed, how: extra ? "keys+text" : "keys" };
}

async function pressAndSettle({ target, key }) {
  const before = signature(target);
  const first = paneKeys(target, [key]);
  if (!first.ok) return { ok: false, how: "keys", cleared: false, detail: reason(first) };
  await sleep(SETTLE_MS);

  const cleared = agentStatus(target) !== "blocked";
  if (cleared) return { ok: true, how: "keys", cleared: true };

  // Some prompts select on the keypress alone (Claude Code), others highlight a
  // row and wait for Enter. Telling them apart by guessing costs something real:
  // a spare Enter on an agent that already moved on lands in whatever input it
  // opened next. So we only confirm when the screen did NOT react to the key --
  // i.e. when nothing has happened yet and an Enter can only mean "that one".
  if (signature(target) !== before) return { ok: true, how: "keys", cleared: false };

  const confirm = paneKeys(target, ["enter"]);
  if (!confirm.ok) return { ok: true, how: "keys", cleared: false, detail: reason(confirm) };
  await sleep(SETTLE_MS);
  return { ok: true, how: "keys", cleared: agentStatus(target) !== "blocked" };
}

/** A cheap "did the screen react" fingerprint. */
function signature(target) {
  return readPane(target, { lines: 12, source: "visible" })
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function reason(result) {
  const text = `${result.stderr ?? ""} ${result.stdout ?? ""}`.trim();
  return text || `exit ${result.status}`;
}
