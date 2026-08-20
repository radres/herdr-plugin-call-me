/**
 * `pane.agent_status_changed` -- the whole reason this plugin exists.
 *
 * herdr already knows when an agent is stuck: it classifies each pane as idle,
 * working, blocked or done, and `blocked` specifically means it recognised a
 * visible approval or question UI. This hook turns that into a phone call, and
 * then turns the answer you speak back into keystrokes in that same pane.
 *
 * The full loop:
 *
 *   agent blocks -> wait out the grace period -> still blocked? -> ring the
 *   phone -> read the question aloud -> human answers by voice -> transcript
 *   comes back -> confirm the agent is STILL blocked -> map the sentence onto
 *   the choice that is actually on screen -> press it -> the agent carries on
 *
 * No keyboard, no tunnel, no VPN, no app open, screen locked, phone in a
 * pocket. That is the part a push notification cannot do.
 *
 * Four gates keep it from being a nuisance, and every one of them was learned
 * the hard way on the Claude Code side of this product:
 *
 *   1. GRACE. Most parked questions are answered by a human sitting right
 *      there, two seconds later. Ringing instantly is how a notifier gets
 *      uninstalled. We wait CALLME_GRACE_S and re-check.
 *   2. COOLDOWN. Status changes are chatty. One call per pane per status per
 *      CALLME_COOLDOWN_S.
 *   3. ONE CALL AT A TIME. Two agents blocking together is one phone. The
 *      second downgrades to a text rather than racing for the line.
 *   4. RE-CHECK BEFORE INJECTING. If the human answered at the keyboard while
 *      the phone was ringing, the transcript is stale and typing it in would be
 *      actively harmful. Confirm `blocked` again first.
 *
 * Exit code is always 0. A notifier that fails loudly inside somebody's agent
 * runtime just looks broken; failures go to stderr, which herdr keeps in
 * `herdr plugin log list`.
 */

import {
  acquireCallLock,
  claimCooldown,
  isEnabled,
  loadDotEnv,
  pairedNumber,
  releaseCallLock,
  settings,
} from "./lib/config.mjs";
import { blockedScript, describe, doneScript, invocation } from "./lib/context.mjs";
import { agentStatus, badge, notify, readPane } from "./lib/herdr.mjs";
import { injectAnswer } from "./lib/inject.mjs";
import { placeCall, sendText } from "./lib/api.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  loadDotEnv();

  if (!isEnabled()) return;

  const config = settings();
  const info = invocation();
  const status = info.status;

  // Only two statuses are worth a human's attention. `working` and `idle` are
  // the normal churn of an agent doing its job.
  const mode =
    status === "blocked" ? config.onBlocked : status === "done" ? config.onDone : "off";
  if (mode === "off") return;

  const { number, source } = pairedNumber();
  if (!number) {
    // Not an error: an installed-but-unpaired plugin is a normal state, and the
    // `pair` pane is how it gets fixed.
    console.error(
      "/call-me: no paired number yet. Open the pair pane " +
        "(herdr plugin pane open --plugin radres.call-me --entrypoint pair) " +
        "or set CALLME_NUMBER in the plugin config .env.",
    );
    return;
  }

  if (!claimCooldown({ paneId: info.paneId, status, cooldownS: config.cooldownS })) return;

  const label = config.label ?? `herdr · ${describe(info)}`;

  if (status === "done") {
    await deliverDone({ info, number, label, mode, config });
    return;
  }

  await deliverBlocked({ info, number, label, mode, config, numberSource: source });
}

/* ------------------------------------------------------------------ done -- */

async function deliverDone({ info, number, label, mode, config }) {
  const body = doneScript(info);
  if (mode === "text") {
    const { delivered } = await sendText({ to: number, body, label });
    if (!delivered) {
      // Stored but never shown: the phone declined notification permission.
      // Rings do not need permission, which is worth telling the user once.
      console.error("/call-me: text stored but not shown -- notifications are off on that phone.");
    }
    if (config.toast) notify("/call-me texted your phone", { body, sound: "done" });
    return;
  }
  // `call` on done is opt-in and deliberately does not inject anything: there is
  // no question to answer, so the transcript is just a note back to the human.
  if (!acquireCallLock()) {
    await sendText({ to: number, body: `${body} (phone was busy)`, label });
    return;
  }
  try {
    const call = await placeCall({ to: number, text: body, label, timeoutS: config.callTimeoutS });
    if (config.toast) notify(`/call-me: call ${call.status}`, { body, sound: "done" });
  } finally {
    releaseCallLock();
  }
}

/* --------------------------------------------------------------- blocked -- */

async function deliverBlocked({ info, number, label, mode, config, numberSource }) {
  const target = info.paneId;

  // Gate 1: grace. Let the human at the keyboard win.
  if (config.graceS > 0) {
    if (config.toast) {
      notify("/call-me: agent blocked", {
        body: `Ringing ${numberSource === "unpaired" ? "your phone" : "in"} ${config.graceS}s unless you answer here.`,
        sound: "request",
      });
    }
    badge(target, "ringing?");
    await sleep(config.graceS * 1000);

    const now = agentStatus(target);
    // `undefined` means herdr could not tell us -- the pane may have closed, or
    // this build has no `agent get --json`. Do not ring on a guess.
    if (now !== "blocked") {
      badge(target, "");
      return;
    }
  }

  const screen = readPane(target, { lines: config.readLines });
  const script = blockedScript(info, screen);

  if (mode === "text") {
    await sendText({ to: number, body: script, label });
    badge(target, "texted");
    return;
  }

  // Gate 3: one call at a time.
  if (!acquireCallLock()) {
    await sendText({ to: number, body: `${script} (another call was in progress)`, label });
    badge(target, "texted");
    return;
  }

  try {
    badge(target, "ringing");
    const call = await placeCall({
      to: number,
      text: script,
      label,
      timeoutS: config.callTimeoutS,
    });

    if (call.status !== "completed" || !call.transcript) {
      // `failed` means the push itself was rejected (a dead install); the rest
      // mean the phone rang and nobody dealt with it. Both leave the agent
      // blocked, which is the correct, safe outcome.
      badge(target, call.status === "failed" ? "unreachable" : call.status);
      if (config.toast) {
        notify(`/call-me: call ${call.status}`, {
          body: "The agent is still waiting for you.",
          sound: "request",
        });
      }
      return;
    }

    if (!config.answerBack) {
      badge(target, "answered");
      notify("/call-me: you said", { body: call.transcript, sound: "done" });
      return;
    }

    // Gate 4: never type a stale answer.
    const stillBlocked = agentStatus(target);
    if (stillBlocked !== "blocked") {
      badge(target, "answered elsewhere");
      notify("/call-me: answer not sent", {
        body: `The agent moved on while the call was live. You said: ${call.transcript}`,
        sound: "request",
      });
      return;
    }

    const sent = await injectAnswer({
      target,
      transcript: call.transcript,
      screen,
      readLines: config.readLines,
    });

    if (!sent.ok) {
      // Either herdr refused the input, or -- more usefully -- the pane is
      // showing a menu this sentence does not map onto. In both cases the agent
      // is left exactly as it was, and the human is told what they said, so the
      // answer is never silently swallowed.
      badge(target, sent.how === "unmapped" ? "unmapped" : "send failed");
      console.error(`/call-me: answer not delivered (${sent.how}): ${sent.detail ?? ""}`);
      await sendText({
        to: number,
        body: `Could not apply "${call.transcript}" -- the agent is showing a choice I would have had to guess at. It is still waiting for you.`,
        label,
      });
      notify("/call-me: could not send your answer", { body: call.transcript, sound: "request" });
      return;
    }

    badge(target, sent.cleared ? "answered" : "answer sent");
    if (config.toast) {
      notify("/call-me: answered by phone", { body: call.transcript, sound: "done" });
    }
  } finally {
    releaseCallLock();
  }
}

main().catch((error) => {
  console.error(`/call-me: ${error?.message ?? error}`);
  releaseCallLock();
});
