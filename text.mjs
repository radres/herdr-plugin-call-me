/**
 * The `text` action: send the focused pane's state to the phone, one way.
 *
 * The quiet sibling of `ask`. No ring, no waiting, no answer -- for when you
 * want a record on your phone that a run reached a certain point.
 */

import { loadDotEnv, pairedNumber, settings } from "./lib/config.mjs";
import { condense, describe, invocation } from "./lib/context.mjs";
import { agentStatus, badge, notify, readPane } from "./lib/herdr.mjs";
import { sendText } from "./lib/api.mjs";

async function main() {
  loadDotEnv();
  const config = settings();
  const info = invocation();
  const target = info.paneId;

  const { number } = pairedNumber();
  if (!number) {
    console.error("/call-me: no paired number yet. Run the pair action first.");
    notify("/call-me: not paired", { body: "Run the /call-me pair action first." });
    process.exitCode = 1;
    return;
  }

  const status = (target ? agentStatus(target) : undefined) ?? info.status ?? "running";
  const screen = target ? readPane(target, { lines: config.readLines }) : "";
  const detail = condense(screen, { maxLines: 20, maxChars: 1200 });

  const body = [`${describe(info)} is ${status}.`, detail].filter(Boolean).join("\n\n");
  const { delivered } = await sendText({
    to: number,
    body,
    label: config.label ?? `herdr · ${describe(info)}`,
  });

  badge(target, "texted");
  if (!delivered) {
    console.error("/call-me: stored but not shown -- notifications are off on that phone.");
  }
  if (config.toast) {
    notify(delivered ? "/call-me texted your phone" : "/call-me: notifications are off", {
      body,
      sound: "done",
    });
  }
}

main().catch((error) => {
  console.error(`/call-me: ${error?.message ?? error}`);
  process.exitCode = 1;
});
