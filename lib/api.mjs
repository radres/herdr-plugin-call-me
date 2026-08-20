/**
 * The /call-me HTTP client.
 *
 * Dependency-free on purpose. A plugin that runs inside somebody else's agent
 * runtime should not drag a request library into their machine, and a herdr
 * plugin with no build step installs from GitHub without a build confirmation.
 *
 * Two things here are load-bearing:
 *
 *   - `/ring` and `/text` need no token. The server derives a sender identity
 *     from (recipient, label, caller IP) and hands the derived `session_token`
 *     back, so the first send is also what opens the conversation thread on the
 *     phone. That is why this plugin has no login step.
 *   - The server's limits are enforced HERE too (600 chars spoken, 2000 texted,
 *     30-300s call wait). A 422 inside an event hook reads to the user as "the
 *     plugin is broken", and they never see the response body.
 */

/** The hosted service. There is no self-hosted deployment. */
const DEFAULT_API = "https://serdaroztetik.com/aiphone";

export const MAX_QUESTION_CHARS = 600;
export const MAX_MESSAGE_CHARS = 2000;
export const MIN_CALL_WAIT_S = 30;
export const MAX_CALL_WAIT_S = 300;

export class CallMeError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "CallMeError";
    this.status = status;
  }
}

/** Internal dev plumbing (e2e rigs point at a local server); not a user setting. */
function apiBase() {
  return String(process.env.AIPHONE_API || DEFAULT_API).replace(/\/+$/, "");
}

async function requestJson(path, { method = "GET", body, timeoutMs = 30_000 } = {}) {
  const response = await fetch(`${apiBase()}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new CallMeError(
      `${method} ${path} returned ${response.status}: ${text.slice(0, 300)}`,
      response.status,
    );
  }
  return text ? JSON.parse(text) : {};
}

/** Trim to a ceiling on a word boundary when there is one, so a cut sentence still reads. */
export function clamp(value, max) {
  const text = String(value ?? "").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}…`;
}

/**
 * Ring the phone, say `text`, block until the human hangs up or it times out.
 *
 * `status` is completed | missed | declined | timeout | failed. Only `completed`
 * carries a transcript. `failed` means the push was REJECTED (a dead install),
 * not that nobody picked up -- worth distinguishing in a log.
 */
export async function placeCall({ to, text, label, timeoutS }) {
  const wait = Math.min(
    MAX_CALL_WAIT_S,
    Math.max(MIN_CALL_WAIT_S, Math.round(timeoutS || 120)),
  );
  const result = await requestJson("/ring", {
    method: "POST",
    body: { to, text: clamp(text, MAX_QUESTION_CHARS), from: label, timeout_s: wait },
    // The server holds the request open for the whole call; leave headroom for
    // the ring itself so we never abandon a call that IS happening.
    timeoutMs: (wait + 45) * 1000,
  });
  return {
    status: String(result.status || "unknown"),
    transcript: String(result.transcript || "").trim(),
    sessionToken: result.session_token,
    from: result.from,
  };
}

/**
 * Text the phone. One-way and fast.
 *
 * `delivered:false` is the interesting case: stored, but the phone never showed
 * it (notifications declined). Older servers omit the field, so an absent value
 * counts as delivered instead of crying wolf on every send.
 */
export async function sendText({ to, body, label }) {
  const result = await requestJson("/text", {
    method: "POST",
    body: { to, body: clamp(body, MAX_MESSAGE_CHARS), from: label },
  });
  return {
    delivered: result.delivered !== false,
    messageId: result.message_id,
    from: result.from,
  };
}
