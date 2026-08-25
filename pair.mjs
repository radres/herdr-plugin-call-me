/**
 * The `pair` pane: a popup that gets a phone connected, then proves it.
 *
 * Opens as a session-modal popup, so it gets real terminal input without
 * disturbing the tiled layout. It writes the number to `~/.aiphone/config.json`
 * -- the one home the whole /call-me family reads -- so pairing here also pairs
 * the iPhone app's other agents, and vice versa.
 *
 * It ends by ringing the phone. A pairing flow that only writes a config file
 * teaches the user nothing about whether the loop works; one that makes the
 * phone ring in their hand teaches them everything.
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  displayNumber,
  isEnabled,
  isValidNumber,
  loadDotEnv,
  normalizeNumber,
  pairedNumber,
  savePairedNumber,
  settings,
  stateDir,
} from "./lib/config.mjs";
import { placeCall } from "./lib/api.mjs";

/** Countable install link (302 -> App Store), so herdr installs are attributable. */
const APP_LINK = "https://serdaroztetik.com/aiphone/go/herdr";

const BOLD = "\u001b[1m";
const DIM = "\u001b[2m";
const RESET = "\u001b[0m";

function heading(text) {
  stdout.write(`\n${BOLD}${text}${RESET}\n`);
}

function dim(text) {
  stdout.write(`${DIM}${text}${RESET}\n`);
}

async function main() {
  loadDotEnv();
  const config = settings();

  stdout.write(`\n${BOLD}/call-me${RESET} for herdr\n`);
  dim("Your agents ring your actual phone. You answer by voice.");

  const existing = pairedNumber();
  heading("Status");
  stdout.write(
    existing.number
      ? `  paired      ${displayNumber(existing.number)}  ${DIM}(${existing.source})${RESET}\n`
      : `  paired      ${DIM}not yet${RESET}\n`,
  );
  stdout.write(`  auto-ring   ${isEnabled() ? "on" : "off"}  ${DIM}(blocked agents)${RESET}\n`);
  stdout.write(`  on blocked  ${config.onBlocked}\n`);
  stdout.write(`  on done     ${config.onDone}\n`);
  stdout.write(`  answer back ${config.answerBack ? "yes" : "no"}\n`);
  dim(`  config      ${process.env.HERDR_PLUGIN_CONFIG_DIR ?? "(unset)"}/.env`);
  dim(`  state       ${stateDir()}`);

  heading("1. Get the app");
  stdout.write(`  Install /call-me on your iPhone:\n`);
  stdout.write(`  ${APP_LINK}\n`);
  dim("  The app shows you a 10-digit number. That is what you type below.");

  heading("2. Pair this machine");
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const prompt = existing.number
      ? `  Number [${displayNumber(existing.number)}]: `
      : "  Number: ";
    const answer = normalizeNumber(await rl.question(prompt));
    const number = answer || existing.number;

    if (!number) {
      stdout.write("\n  Nothing entered. Nothing changed.\n");
      return;
    }
    if (!isValidNumber(number)) {
      stdout.write(`\n  "${answer}" is not a 10-digit number. Nothing changed.\n`);
      process.exitCode = 1;
      return;
    }

    if (number !== existing.number) {
      savePairedNumber(number);
      stdout.write(`\n  Paired ${displayNumber(number)}.\n`);
    } else {
      stdout.write(`\n  Keeping ${displayNumber(number)}.\n`);
    }

    heading("3. Prove it");
    const go = (await rl.question("  Ring that phone now? [Y/n] ")).trim().toLowerCase();
    if (["n", "no"].includes(go)) {
      dim("  Skipped. Blocked agents will ring it from now on.");
      return;
    }

    stdout.write("\n  Ringing. Answer it and say anything.\n");
    const call = await placeCall({
      to: number,
      text:
        "This is /call-me, wired up to herdr. When one of your agents needs a " +
        "decision, this is how it will reach you. Say anything to finish setting up.",
      label: "herdr · pairing",
      timeoutS: 90,
    });

    if (call.status === "completed") {
      stdout.write(`\n  ${BOLD}Working.${RESET} You said: ${call.transcript || "(nothing)"}\n`);
      dim("  That transcript is what gets typed into a blocked agent for you.");
      return;
    }

    stdout.write(`\n  Call ${call.status}.\n`);
    if (call.status === "failed") {
      dim("  A rejected push usually means the app is not installed on that number,");
      dim("  or it was reinstalled and took a new number. Check the app's My Number tab.");
    } else {
      dim("  The push went out but the call was not answered. Try again when you have");
      dim("  the phone in your hand; iOS Focus and unknown-caller screening can also");
      dim("  silence it (Settings -> Apps -> Phone -> Silence Unknown Callers -> Never).");
    }
  } finally {
    rl.close();
  }
}

main()
  .catch((error) => {
    stdout.write(`\n  Failed: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    // A popup closes the instant its command exits, taking the output with it.
    // Hold the pane open so the result is readable.
    stdout.write("\n  Press Enter to close.\n");
    const rl = createInterface({ input: stdin, output: stdout });
    await rl.question("");
    rl.close();
  });
