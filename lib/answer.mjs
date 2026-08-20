/**
 * Turning a spoken sentence into the keystrokes a blocked agent will accept.
 *
 * This module exists because of one hard constraint discovered against a live
 * herdr server, and it shapes everything here:
 *
 *   `herdr agent prompt` REFUSES a blocked agent -- it returns `agent_blocked`,
 *   "requires interactive input". `herdr agent send-keys` refuses too, with
 *   `agent_not_ready`. A blocked agent is showing a MENU, and free text is not
 *   what a menu wants.
 *
 * So the answer path is:
 *
 *   blocked  -> `pane send-keys` (pane-level APIs have no agent-ready gate)
 *   unblocked -> `agent prompt` (handles bracketed paste and encoded Enter)
 *
 * And the keystroke is not guessed. We read the numbered options off the pane
 * and match the human's words against the options that are actually on screen,
 * so "yes" picks whatever number "Yes" happens to be in that agent's UI. A
 * hardcoded "Enter means approve" would be a coin flip across twenty agents,
 * and the wrong side of that coin runs `rm -rf` on somebody's repo.
 */

const AFFIRMATIVE = new Set([
  "yes", "yeah", "yep", "yup", "ya", "sure", "ok", "okay", "okey", "affirmative",
  "approve", "approved", "proceed", "go", "allow", "allowed", "accept", "fine",
  "correct", "right", "do", "ship", "send", "continue", "confirm", "confirmed",
]);

const NEGATIVE = new Set([
  "no", "nope", "nah", "negative", "dont", "not", "stop", "cancel", "deny",
  "denied", "reject", "rejected", "abort", "never", "skip", "decline", "wait",
]);

/** Words that carry no intent and should not sway option matching. */
const FILLER = new Set([
  "the", "a", "an", "and", "or", "but", "then", "just", "please", "lets", "let",
  "it", "that", "this", "to", "for", "with", "on", "in", "of", "i", "you", "we",
  "would", "should", "could", "can", "will", "want", "think", "option", "number",
  "choose", "pick", "select", "answer", "say", "um", "uh", "so", "well", "is",
  "its", "im", "thats", "yeah", "okay", "ok",
]);

const SPOKEN_DIGITS = {
  one: "1", two: "2", three: "3", four: "4", five: "5",
  six: "6", seven: "7", eight: "8", nine: "9",
  first: "1", second: "2", third: "3", fourth: "4", fifth: "5",
};

/** Options that open a free-text box once selected, so a follow-up prompt lands. */
const WANTS_TEXT = /\b(tell|explain|instead|differently|feedback|why|describe|edit|other)\b/i;

export function words(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Pull the numbered choices out of a terminal snapshot.
 *
 * Matches `1. Yes`, `2) No`, `3 - Something`, with any leading border or
 * indentation, which covers every approval UI seen so far.
 */
export function parseOptions(screen) {
  const options = [];
  const seen = new Set();
  for (const rawLine of String(screen ?? "").split("\n")) {
    const line = rawLine.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
    const match = line.match(/(?:^|[\s│┃|>])\s*([1-9])\s*[.):-]\s+(\S.*?)\s*[│┃|]?\s*$/);
    if (!match) continue;
    const [, key, text] = match;
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({ key, text: text.trim(), wantsText: WANTS_TEXT.test(text) });
  }
  options.sort((a, b) => a.key.localeCompare(b.key));

  // A menu, not a numbered list in the agent's prose. Real approval menus start
  // at 1 and run consecutively; an ordered list in a plan does not have to. This
  // guard is what stops us typing "3" into an agent that was merely explaining
  // its third step.
  if (options.length < 2) return [];
  const consecutive = options.every((option, index) => option.key === String(index + 1));
  return consecutive ? options : [];
}

/**
 * A bare `(y/n)` prompt, which plenty of tools use instead of a numbered menu.
 * Read off the screen rather than assumed, same principle as the menu.
 */
export function parseYesNo(screen) {
  return /[([]\s*y\s*\/\s*n\s*[)\]]/i.test(String(screen ?? "")) ? { yes: "y", no: "n" } : undefined;
}

/** pos | neg | undefined -- what the human's first few words commit to. */
export function polarity(text) {
  const tokens = words(text);
  for (const token of tokens.slice(0, 4)) {
    if (AFFIRMATIVE.has(token)) return "pos";
    if (NEGATIVE.has(token)) return "neg";
  }
  return undefined;
}

function optionPolarity(text) {
  return polarity(text);
}

/** An explicitly spoken option number, digit or word. */
export function spokenKey(transcript, options) {
  const tokens = words(transcript);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const digit = /^[1-9]$/.test(token) ? token : SPOKEN_DIGITS[token];
    if (!digit) continue;
    // "option two" / "number 3" / "the third one" are unambiguous. A bare
    // leading digit is too. A digit buried mid-sentence ("delete 3 files") is
    // not, so it only counts when a selection word introduces it.
    const introduced = i > 0 && ["option", "number", "choice", "answer"].includes(tokens[i - 1]);
    if (introduced || i === 0 || SPOKEN_DIGITS[token]) {
      if (options.some((option) => option.key === digit)) return digit;
    }
  }
  return undefined;
}

/**
 * Pick the option the human meant, or undefined when it is not clear enough.
 *
 * Undefined is a perfectly good answer here: the caller then rejects the prompt
 * and repeats the sentence to the agent in words, which loses nothing. Guessing
 * a menu item wrong is the only outcome that does damage.
 */
export function chooseOption(transcript, options) {
  if (!options.length) return undefined;

  const explicit = spokenKey(transcript, options);
  if (explicit) return options.find((option) => option.key === explicit);

  const want = polarity(transcript);
  if (!want) return undefined;

  const candidates = options.filter((option) => optionPolarity(option.text) === want);
  if (!candidates.length) return undefined;
  if (candidates.length === 1) return candidates[0];

  // Several options share the polarity -- Claude Code's "Yes" and "Yes, and
  // don't ask again" being the everyday case. Score on the words BEYOND the
  // polarity word, so a bare "yes" scores 0 everywhere and falls through to the
  // narrowest option rather than silently opting into "don't ask again".
  const spoken = new Set(words(transcript).filter((word) => !FILLER.has(word)));
  let best;
  let bestScore = 0;
  for (const option of candidates) {
    const optionWords = words(option.text).filter((word) => !FILLER.has(word));
    const score = optionWords.filter((word) => spoken.has(word) && !isPolarityWord(word)).length;
    if (score > bestScore) {
      best = option;
      bestScore = score;
    }
  }
  if (best) return best;

  // Nothing distinguishing was said. Take the shortest option, which is the
  // plain one ("Yes"), never the one that also disables future prompts.
  return [...candidates].sort(
    (a, b) => words(a.text).length - words(b.text).length || a.key.localeCompare(b.key),
  )[0];
}

function isPolarityWord(word) {
  return AFFIRMATIVE.has(word) || NEGATIVE.has(word);
}

/**
 * What the human said beyond picking an option.
 *
 * "yes, but run the tests first" is an approval AND an instruction. Dropping
 * the instruction would be the most annoying possible bug, so the caller sends
 * the keystroke and then queues this remainder as a normal prompt.
 */
export function residual(transcript, option) {
  const tokens = words(transcript);
  let start = 0;
  while (start < tokens.length) {
    const token = tokens[start];
    const isLead =
      isPolarityWord(token) ||
      FILLER.has(token) ||
      /^[1-9]$/.test(token) ||
      SPOKEN_DIGITS[token] !== undefined;
    if (!isLead) break;
    start += 1;
  }
  const rest = tokens.slice(start).filter((word) => !FILLER.has(word));
  const optionWords = new Set(option ? words(option.text) : []);
  const novel = rest.filter((word) => !optionWords.has(word));
  // Two or more substantive words the option does not already say. One stray
  // word is noise from a voice transcript, not an instruction.
  if (novel.length < 2) return undefined;

  // Return the original sentence, not the tokenised rump: the agent should read
  // what the human actually said.
  return String(transcript).trim();
}
