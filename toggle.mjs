/**
 * The `toggle` / `on` / `off` actions.
 *
 * The plugin stays installed and enabled in herdr; this flips a state file the
 * event hook checks first. That distinction matters -- `herdr plugin disable`
 * would also kill the on-demand `ask` action, and "stop ringing me for the next
 * hour" should not mean "give up the ability to ring".
 */

import { isEnabled, loadDotEnv, pairedNumber, setEnabled } from "./lib/config.mjs";
import { displayNumber } from "./lib/config.mjs";
import { notify } from "./lib/herdr.mjs";

loadDotEnv();

const argument = String(process.argv[2] ?? "").trim().toLowerCase();
const next =
  argument === "on"
    ? true
    : argument === "off"
      ? false
      : !isEnabled();

setEnabled(next);

const { number } = pairedNumber();
const where = number ? displayNumber(number) : "no phone paired yet";
const line = next ? `/call-me is on (${where})` : "/call-me is off";

notify(line, {
  body: next
    ? "Blocked agents will ring your phone."
    : "Blocked agents will not ring. The ask action still works.",
  sound: "none",
});
console.log(line);
