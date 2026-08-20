/**
 * Offline tests. No herdr server, no network, no phone.
 *
 * Run: node --test test/plugin.test.mjs
 *
 * Everything here runs against a throwaway AIPHONE_STATE_DIR and
 * HERDR_PLUGIN_STATE_DIR, because the alternative is a test suite that reads
 * (or worse, rewrites) the developer's real paired number.
 */

import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "callme-herdr-"));
const aiphoneDir = join(sandbox, "aiphone");
const stateDir = join(sandbox, "state");
const configDir = join(sandbox, "config");

const OWNED_ENV = [
  "CALLME_NUMBER",
  "AIPHONE_USER_NUMBER",
  "CALLME_ON_BLOCKED",
  "CALLME_ON_DONE",
  "CALLME_ANSWER_BACK",
  "CALLME_GRACE_S",
  "CALLME_CALL_TIMEOUT_S",
  "CALLME_COOLDOWN_S",
  "CALLME_ENABLED",
  "CALLME_TOAST",
  "CALLME_LABEL",
  "HERDR_PLUGIN_EVENT_JSON",
  "HERDR_PLUGIN_CONTEXT_JSON",
  "HERDR_PANE_ID",
  "HERDR_WORKSPACE_ID",
];

before(() => {
  mkdirSync(aiphoneDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  process.env.AIPHONE_STATE_DIR = aiphoneDir;
  process.env.HERDR_PLUGIN_STATE_DIR = stateDir;
  process.env.HERDR_PLUGIN_CONFIG_DIR = configDir;
});

after(() => rmSync(sandbox, { recursive: true, force: true }));

beforeEach(() => {
  for (const name of OWNED_ENV) delete process.env[name];
});

const config = await import("../lib/config.mjs");
const context = await import("../lib/context.mjs");
const api = await import("../lib/api.mjs");
const herdr = await import("../lib/herdr.mjs");
const answer = await import("../lib/answer.mjs");

/* --------------------------------------------------------------- numbers -- */

describe("paired number", () => {
  it("accepts 10 digits in any punctuation", () => {
    assert.equal(config.normalizeNumber("(469) 661-8447"), "4696618447");
    assert.ok(config.isValidNumber("469-661-8447"));
    assert.ok(!config.isValidNumber("46966184"));
    assert.ok(!config.isValidNumber("469661844777"));
  });

  it("formats the way the iPhone app shows it, so it reads back the same", () => {
    assert.equal(config.displayNumber("4696618447"), "469-661-8447");
  });

  it("prefers the environment over the shared config file", () => {
    writeFileSync(join(aiphoneDir, "config.json"), JSON.stringify({ user_number: "1111111111" }));
    process.env.CALLME_NUMBER = "2222222222";
    const resolved = config.pairedNumber();
    assert.equal(resolved.number, "2222222222");
    assert.equal(resolved.source, "CALLME_NUMBER");
  });

  it("falls back to ~/.aiphone/config.json, the one home every integration reads", () => {
    writeFileSync(join(aiphoneDir, "config.json"), JSON.stringify({ user_number: "3333333333" }));
    assert.equal(config.pairedNumber().number, "3333333333");
  });

  it("reports unpaired rather than throwing when nothing is set", () => {
    writeFileSync(join(aiphoneDir, "config.json"), "{ this is not json");
    const resolved = config.pairedNumber();
    assert.equal(resolved.number, undefined);
    assert.equal(resolved.source, "unpaired");
  });

  it("round-trips through savePairedNumber and keeps unrelated keys", () => {
    writeFileSync(
      join(aiphoneDir, "config.json"),
      JSON.stringify({ user_number: "1111111111", always_remind: true }),
    );
    config.savePairedNumber("(469) 661-8447");
    assert.equal(config.pairedNumber().number, "4696618447");
    const raw = JSON.parse(readFileSync(join(aiphoneDir, "config.json"), "utf8"));
    assert.equal(raw.always_remind, true, "must not clobber other integrations' settings");
    assert.equal(raw.display, "469-661-8447");
  });

  it("refuses a number that is not 10 digits", () => {
    assert.throws(() => config.savePairedNumber("123"), /10-digit/);
  });
});

/* ---------------------------------------------------------------- .env ---- */

describe("settings", () => {
  it("reads .env from the herdr-managed config dir", () => {
    writeFileSync(join(configDir, ".env"), "CALLME_ON_BLOCKED=text\nCALLME_GRACE_S=5\n");
    config.loadDotEnv();
    assert.equal(config.settings().onBlocked, "text");
    assert.equal(config.settings().graceS, 5);
  });

  it("lets a real environment variable beat the .env file", () => {
    writeFileSync(join(configDir, ".env"), "CALLME_ON_BLOCKED=text\n");
    process.env.CALLME_ON_BLOCKED = "off";
    config.loadDotEnv();
    assert.equal(config.settings().onBlocked, "off");
  });

  it("accepts the obvious synonyms for each mode", () => {
    for (const [raw, want] of [
      ["call", "call"], ["ring", "call"], ["phone", "call"],
      ["text", "text"], ["sms", "text"],
      ["off", "off"], ["0", "off"], ["no", "off"],
    ]) {
      process.env.CALLME_ON_BLOCKED = raw;
      assert.equal(config.settings().onBlocked, want, `${raw} -> ${want}`);
    }
  });

  it("falls back on nonsense instead of disabling itself silently", () => {
    process.env.CALLME_ON_BLOCKED = "banana";
    process.env.CALLME_GRACE_S = "not-a-number";
    assert.equal(config.settings().onBlocked, "call");
    assert.equal(config.settings().graceS, 20);
  });

  it("clamps the call timeout to what the server will accept", () => {
    process.env.CALLME_CALL_TIMEOUT_S = "9999";
    assert.equal(config.settings().callTimeoutS, 300);
    process.env.CALLME_CALL_TIMEOUT_S = "1";
    assert.equal(config.settings().callTimeoutS, 30);
  });
});

/* ----------------------------------------------------------------- state -- */

describe("enable switch", () => {
  it("defaults on, and the state file overrides the env default", () => {
    assert.ok(config.isEnabled());
    config.setEnabled(false);
    assert.ok(!config.isEnabled());
    process.env.CALLME_ENABLED = "1";
    assert.ok(!config.isEnabled(), "the toggle action must win over .env");
    config.setEnabled(true);
    assert.ok(config.isEnabled());
  });
});

describe("cooldown", () => {
  it("allows the first alert and suppresses a repeat for the same pane+status", () => {
    const now = 1_000_000;
    assert.ok(config.claimCooldown({ paneId: "w1:p1", status: "blocked", cooldownS: 300, now }));
    assert.ok(!config.claimCooldown({ paneId: "w1:p1", status: "blocked", cooldownS: 300, now: now + 1000 }));
  });

  it("does not let one pane silence another", () => {
    const now = 2_000_000;
    assert.ok(config.claimCooldown({ paneId: "w1:p1", status: "blocked", cooldownS: 300, now }));
    assert.ok(config.claimCooldown({ paneId: "w1:p2", status: "blocked", cooldownS: 300, now }));
  });

  it("does not let done silence blocked on the same pane", () => {
    const now = 3_000_000;
    assert.ok(config.claimCooldown({ paneId: "w9:p9", status: "done", cooldownS: 300, now }));
    assert.ok(config.claimCooldown({ paneId: "w9:p9", status: "blocked", cooldownS: 300, now }));
  });

  it("expires", () => {
    const now = 4_000_000;
    assert.ok(config.claimCooldown({ paneId: "w2:p1", status: "blocked", cooldownS: 60, now }));
    assert.ok(config.claimCooldown({ paneId: "w2:p1", status: "blocked", cooldownS: 60, now: now + 61_000 }));
  });

  it("is a no-op when disabled", () => {
    const now = 5_000_000;
    assert.ok(config.claimCooldown({ paneId: "w3:p1", status: "blocked", cooldownS: 0, now }));
    assert.ok(config.claimCooldown({ paneId: "w3:p1", status: "blocked", cooldownS: 0, now }));
  });
});

describe("call lock", () => {
  it("only lets one call hold the line, and frees it on release", () => {
    const now = 6_000_000;
    assert.ok(config.acquireCallLock({ now }));
    assert.ok(!config.acquireCallLock({ now: now + 5000 }), "second agent must downgrade to a text");
    config.releaseCallLock();
    assert.ok(config.acquireCallLock({ now: now + 6000 }));
  });

  it("expires a lock left behind by a killed process", () => {
    config.releaseCallLock();
    const now = 7_000_000;
    assert.ok(config.acquireCallLock({ holdS: 10, now }));
    assert.ok(config.acquireCallLock({ holdS: 10, now: now + 11_000 }));
  });
});

/* --------------------------------------------------------------- context -- */

describe("invocation context", () => {
  it("reads status and pane out of the event payload", () => {
    process.env.HERDR_PLUGIN_EVENT_JSON = JSON.stringify({
      event: "pane.agent_status_changed",
      data: { agent_status: "Blocked", pane_id: "w1:p3", display_agent: "claude", workspace_id: "w1" },
    });
    const info = context.invocation();
    assert.equal(info.status, "blocked");
    assert.equal(info.paneId, "w1:p3");
    assert.equal(info.agent, "claude");
  });

  it("falls back to the focused pane when there is no event (an action, not a hook)", () => {
    process.env.HERDR_PLUGIN_CONTEXT_JSON = JSON.stringify({
      focused_pane_id: "w2:p7",
      focused_pane_agent: "codex",
      workspace_label: "call-me",
      tab_label: "review",
    });
    const info = context.invocation();
    assert.equal(info.paneId, "w2:p7");
    assert.equal(info.agent, "codex");
    assert.equal(context.describe(info), "Codex · call-me · review");
  });

  it("drops a numeric tab label, which tells a human on the phone nothing", () => {
    process.env.HERDR_PLUGIN_CONTEXT_JSON = JSON.stringify({
      workspace_label: "call-me",
      tab_label: "3",
    });
    assert.equal(context.invocation().tab, undefined);
  });

  it("survives malformed JSON instead of crashing the hook", () => {
    process.env.HERDR_PLUGIN_EVENT_JSON = "{{{not json";
    const info = context.invocation();
    assert.equal(info.status, undefined);
    assert.equal(context.describe(info), "Agent");
  });
});

/* -------------------------------------------------- screen -> speech ----- */

describe("condense", () => {
  const claudePrompt = [
    "╭──────────────╮",
    "│  ⣹ Working...  │",
    "╰──────────────╯",
    "",
    "  Bash command",
    "  rm -rf build/",
    "",
    "  Do you want to proceed?",
    "  1. Yes",
    "  2. Yes, and don't ask again",
    "  3. No, and tell Claude what to do differently",
    "────────────────",
  ].join("\n");

  it("keeps the question and the numbered options, which is what you need to hear", () => {
    const text = context.condense(claudePrompt);
    assert.match(text, /Do you want to proceed\?/);
    assert.match(text, /1\. Yes/);
    assert.match(text, /3\. No/);
  });

  it("drops pure box-drawing lines", () => {
    const text = context.condense(claudePrompt);
    assert.ok(!/─{3}/.test(text), `border leaked: ${text}`);
    assert.ok(!text.includes("│"), `vertical bar leaked: ${text}`);
  });

  it("strips ANSI so a colour code is never read aloud", () => {
    const text = context.condense("\u001b[31mDelete the database?\u001b[0m");
    assert.equal(text, "Delete the database?");
  });

  it("strips spinner frames", () => {
    assert.equal(context.condense("⣹ ⣻ thinking"), "thinking");
  });

  it("collapses repeated identical lines from a redrawn TUI", () => {
    const text = context.condense(["ready", "ready", "ready", "go?"].join("\n"));
    assert.equal(text, "ready go?");
  });

  it("keeps the tail, because the prompt is always at the bottom", () => {
    const many = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
    const text = context.condense(many, { maxLines: 3 });
    assert.equal(text, "line 57 line 58 line 59");
  });

  it("clamps long output with an ellipsis", () => {
    const text = context.condense("x ".repeat(2000), { maxChars: 50 });
    assert.ok(text.length <= 50, `got ${text.length}`);
    assert.ok(text.endsWith("…"));
  });

  it("returns empty for a screen that is only decoration", () => {
    assert.equal(context.condense("───\n   \n││"), "");
  });

  it("still produces a usable script when the screen is unreadable", () => {
    const script = context.blockedScript({ agent: "claude" }, "───");
    assert.match(script, /waiting for a decision/);
    assert.match(script, /What should it do/);
  });

  it("fits a spoken question inside the server's 600-char ceiling", () => {
    const script = context.blockedScript({ agent: "claude", workspace: "call-me" }, claudePrompt);
    assert.ok(
      api.clamp(script, api.MAX_QUESTION_CHARS).length <= api.MAX_QUESTION_CHARS,
      "a 422 inside an event hook reads as a broken plugin",
    );
  });
});

/* ------------------------------------------------------------------ api --- */

describe("api limits", () => {
  it("never exceeds the ceiling", () => {
    for (const max of [8, 12, 20, 40]) {
      assert.ok(api.clamp("the quick brown fox jumps over the lazy dog", max).length <= max);
    }
  });

  it("cuts on a word boundary when the boundary is late enough to keep meaning", () => {
    // Space at index 20 of a 24-char budget: worth backing up to.
    assert.equal(api.clamp("deploy to production now please", 24), "deploy to production…");
  });

  it("keeps a partial word rather than throwing most of the text away", () => {
    // Space at index 5 of a 12-char budget: backing up would lose half the text.
    assert.equal(api.clamp("hello world again", 12), "hello world…");
  });

  it("leaves short text alone", () => {
    assert.equal(api.clamp("  ship it  ", 100), "ship it");
  });

  it("mirrors the server's own ceilings", () => {
    assert.equal(api.MAX_QUESTION_CHARS, 600);
    assert.equal(api.MAX_MESSAGE_CHARS, 2000);
    assert.equal(api.MIN_CALL_WAIT_S, 30);
    assert.equal(api.MAX_CALL_WAIT_S, 300);
  });
});

/* ---------------------------------------------------------------- herdr --- */

describe("pane text extraction", () => {
  it("passes plain text through untouched", () => {
    assert.equal(herdr.extractPaneText("Do you want to proceed?"), "Do you want to proceed?");
  });

  it("unwraps a JSON envelope, because the shape varies across releases", () => {
    assert.equal(herdr.extractPaneText('{"text":"proceed?"}'), "proceed?");
    assert.equal(herdr.extractPaneText('{"lines":["a","b"]}'), "a\nb");
    assert.equal(herdr.extractPaneText('{"result":{"output":"deep"}}'), "deep");
  });

  it("returns the raw string when it cannot find a known key", () => {
    assert.equal(herdr.extractPaneText('{"surprise":1}'), '{"surprise":1}');
  });
});

/* --------------------------------------------------------------- answer --- */

// A realistic Claude Code approval screen, borders and all. Everything about the
// answer mapping is judged against text like this rather than a tidy fixture,
// because the real input is a terminal snapshot.
const CLAUDE_MENU = [
  "╭──────────────────────────────────────────────╮",
  "│ Bash command                                 │",
  "│                                              │",
  "│   rm -rf build/                              │",
  "│   Remove the build directory                 │",
  "│                                              │",
  "│ Do you want to proceed?                      │",
  "│ ❯ 1. Yes                                     │",
  "│   2. Yes, and dont ask again for rm commands │",
  "│   3. No, and tell Claude what to do differently │",
  "╰──────────────────────────────────────────────╯",
].join("\n");

describe("reading options off the screen", () => {
  it("finds a numbered menu behind box borders", () => {
    const options = answer.parseOptions(CLAUDE_MENU);
    assert.deepEqual(
      options.map((o) => o.key),
      ["1", "2", "3"],
    );
    assert.equal(options[0].text, "Yes");
    assert.match(options[2].text, /^No, and tell Claude/);
  });

  it("marks the option that opens a text box", () => {
    const options = answer.parseOptions(CLAUDE_MENU);
    assert.equal(options[0].wantsText, false);
    assert.equal(options[2].wantsText, true);
  });

  // The guard that matters most: an agent describing step 3 of its plan is not
  // offering you a menu, and pressing "3" at it would be a keystroke nobody asked
  // for.
  it("refuses prose that merely happens to be numbered", () => {
    const prose = [
      "Here is the plan:",
      "  2. run the migration",
      "  3. deploy",
    ].join("\n");
    assert.deepEqual(answer.parseOptions(prose), []);
  });

  it("refuses a single numbered line", () => {
    assert.deepEqual(answer.parseOptions("1. Yes"), []);
  });

  it("spots a bare (y/n) prompt", () => {
    assert.deepEqual(answer.parseYesNo("Overwrite config.json? (y/n)"), { yes: "y", no: "n" });
    assert.deepEqual(answer.parseYesNo("Continue? [Y/n]"), { yes: "y", no: "n" });
    assert.equal(answer.parseYesNo(CLAUDE_MENU), undefined);
  });
});

describe("mapping a spoken sentence onto a menu", () => {
  const options = answer.parseOptions(CLAUDE_MENU);
  const pick = (said) => answer.chooseOption(said, options)?.key;

  it("takes a plain yes to the plain Yes, never to 'dont ask again'", () => {
    assert.equal(pick("yes"), "1");
    assert.equal(pick("yeah go ahead"), "1");
    assert.equal(pick("sure, ship it"), "1");
  });

  it("takes the wider option only when the human asked for it", () => {
    assert.equal(pick("yes and dont ask again"), "2");
  });

  it("routes a refusal to the refusing option", () => {
    assert.equal(pick("no"), "3");
    assert.equal(pick("no, use pytest instead"), "3");
  });

  it("honours an explicitly spoken number", () => {
    assert.equal(pick("option two"), "2");
    assert.equal(pick("the third one"), "3");
  });

  // The important negative: a sentence with no discernible intent must map to
  // nothing, so the caller reports back instead of guessing.
  it("gives up rather than guessing", () => {
    assert.equal(answer.chooseOption("call me back in ten minutes", options), undefined);
    assert.equal(answer.chooseOption("yes", []), undefined);
  });

  it("does not read a digit out of the middle of a sentence", () => {
    // "delete 3 files" is not "option 3"; polarity decides it instead.
    assert.equal(pick("delete 3 files"), undefined);
  });
});

describe("the instruction attached to an answer", () => {
  const options = answer.parseOptions(CLAUDE_MENU);
  const yes = options[0];

  it("keeps whatever was said beyond the approval", () => {
    assert.equal(
      answer.residual("yes but run the tests first", yes),
      "yes but run the tests first",
    );
  });

  it("returns nothing for a bare answer", () => {
    assert.equal(answer.residual("yes", yes), undefined);
    assert.equal(answer.residual("yeah sure", yes), undefined);
  });

  it("ignores a single stray word, which is transcript noise not an order", () => {
    assert.equal(answer.residual("yes ok", yes), undefined);
  });
});
