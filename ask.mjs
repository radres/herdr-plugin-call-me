/**
 * The `ask` action: ring me about THIS pane, right now.
 *
 * Same machinery as the blocked hook without the waiting. Bind it to a key and
 * it works on any pane, whatever the agent's state -- useful when you are about
 * to walk away from a long run and want the phone to read you the situation, or
 * when herdr has classified a new prompt shape as `idle` instead of `blocked`
 * (which the docs warn happens until a detection manifest learns that screen).
 *
 * Answers still land in the pane when the agent is blocked, and are only
 * reported to you when it is not -- typing into a working agent would interrupt
 * it mid-thought.
 */

import {
  acquireCallLock,
  loadDotEnv,
  pairedNumber,
  releaseCallLock,
  settings,
} from "./lib/config.mjs";
import { blockedScript, condense, describe, invocation } from "./lib/context.mjs";
import { agentStatus, badge, notify, readPane } from "./lib/herdr.mjs";
import { injectAnswer } from "./lib/inject.mjs";
import { placeCall } from "./lib/api.mjs";

async function main() {
  loadDotEnv();
  const config = settings();
  const info = invocation();
  const target = info.paneId;

  const { number } = pairedNumber();
  if (!number) {
    console.error(
      "/call-me: no paired number yet. Run the pair action, or set CALLME_NUMBER " +
        "in the plugin config .env.",
    );
    notify("/call-me: not paired", { body: "Run the /call-me pair action first." });
    process.exitCode = 1;
    return;
  }

  if (!target) {
    console.error("/call-me: no pane in context -- focus an agent pane and try again.");
    process.exitCode = 1;
    return;
  }

  const status = agentStatus(target) ?? info.status;
  const screen = readPane(target, { lines: config.readLines });
  const label = config.label ?? `herdr · ${describe(info)}`;

  const script =
    status === "blocked"
      ? blockedScript(info, screen)
      : `${describe(info)} is ${status ?? "running"}. The screen says: ${
          condense(screen) || "nothing readable."
        } What do you want to do?`;

  if (!acquireCallLock()) {
    notify("/call-me: phone busy", { body: "Another /call-me call is already live." });
    process.exitCode = 1;
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
      badge(target, call.status);
      notify(`/call-me: call ${call.status}`, { sound: "request" });
      return;
    }

    badge(target, "answered");

    // Only inject into an agent that is actually waiting for input. Prompting a
    // working agent would cut across whatever it is doing.
    if (config.answerBack && agentStatus(target) === "blocked") {
      const sent = await injectAnswer({
        target,
        transcript: call.transcript,
        screen,
        readLines: config.readLines,
      });
      if (sent.ok) {
        badge(target, sent.cleared ? "answered" : "answer sent");
        notify("/call-me: answered by phone", { body: call.transcript, sound: "done" });
        return;
      }
      badge(target, sent.how === "unmapped" ? "unmapped" : "send failed");
      console.error(`/call-me: answer not delivered (${sent.how}): ${sent.detail ?? ""}`);
    }

    notify("/call-me: you said", { body: call.transcript, sound: "done" });
    console.log(call.transcript);
  } finally {
    releaseCallLock();
  }
}

main().catch((error) => {
  console.error(`/call-me: ${error?.message ?? error}`);
  releaseCallLock();
  process.exitCode = 1;
});
