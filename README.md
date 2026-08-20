# /call-me for herdr

**Your agent gets stuck. Your phone rings. You say what to do. The agent does it.**

Not a notification. An actual phone call, to an actual phone number, that works
with the screen locked, the laptop shut, no VPN, no tunnel, no app open. You
answer, you speak one sentence, and that sentence becomes the keypress the
waiting agent was asking for.

herdr already knows the moment a human is needed: it watches every pane and
marks an agent `blocked` when it recognises a real approval or question screen.
This plugin turns that moment into a call, reads the question out loud, and puts
your spoken answer back into the pane.

```
claude in w1:p1 blocks on "rm -rf build/  1. Yes  2. Yes, don't ask again  3. No…"
        |
        +-- 20s grace, in case you are at the keyboard
        +-- your phone rings
        +-- "Claude in call-me is waiting for you. It says: rm -rf build. Do you
             want to proceed? One, yes. Two, yes and don't ask again. Three, no."
        +-- you say "yes, but run the tests first"
        +-- pane w1:p1 receives "1", and "run the tests first" follows as a prompt
```

## Install

```bash
herdr plugin install radres/herdr-plugin-call-me
```

No build step, no dependencies, nothing to approve. Then pair your phone:

```bash
herdr plugin pane open --plugin radres.call-me --entrypoint pair
```

That pane links you to the free iPhone app, takes the 10-digit number the app
shows you, and then rings the phone to prove the whole loop works before you
trust it with anything.

<sub>The app is free, has no ads and no subscriptions. Android is in closed
testing.</sub>

## Bind it to a key

Nothing is required — the blocked hook runs on its own. These are for when you
want the phone on demand:

```toml
[[keys.command]]
key = "prefix+c"
type = "plugin_action"
command = "radres.call-me.ask"
description = "call me about this pane"

[[keys.command]]
key = "prefix+t"
type = "plugin_action"
command = "radres.call-me.text"
description = "text me this pane"

[[keys.command]]
key = "prefix+C"
type = "plugin_action"
command = "radres.call-me.toggle"
description = "toggle /call-me auto-ring"
```

| action | what it does |
| --- | --- |
| `ask` | Ring me about the focused pane right now, in any state. Useful before you walk away from a long run, or when herdr has not learned a new prompt shape yet. |
| `text` | One-way: put this pane's state on my phone. No ring, no answer. |
| `toggle` / `on` / `off` | Stop and start the automatic ringing without uninstalling anything. |
| `pair` (pane) | Setup, and a test call. |

## Config

`herdr plugin config-dir radres.call-me` prints the directory; put a `.env`
there. Everything has a working default, so an empty file is a valid config.

| key | default | |
| --- | --- | --- |
| `CALLME_NUMBER` | from `~/.aiphone/config.json` | The phone to ring. The pair pane writes it for you. |
| `CALLME_ON_BLOCKED` | `call` | `call`, `text` or `off` when an agent blocks. |
| `CALLME_ON_DONE` | `text` | Same, for an agent that finished. |
| `CALLME_ANSWER_BACK` | `1` | Put the spoken answer into the pane. `0` = just tell me what I said. |
| `CALLME_GRACE_S` | `20` | Wait this long before ringing, and only ring if it is *still* blocked. |
| `CALLME_CALL_TIMEOUT_S` | `120` | How long the phone rings and stays on the line (30–300). |
| `CALLME_COOLDOWN_S` | `300` | At most one call per pane per state in this window. |
| `CALLME_READ_LINES` | `40` | How much of the pane to read for the question. |
| `CALLME_TOAST` | `1` | Also show a local herdr notification. |
| `CALLME_ENABLED` | `1` | The kill switch the `off` action flips. |
| `CALLME_LABEL` | pane-derived | The thread name on the phone. |

## What it will and will not press

This is the part worth reading, because the plugin types into your terminal.

It only presses a key it can **read off the screen**. It parses the numbered
options in the pane, matches your sentence against those exact options, and
presses the one that matches:

- "yes" picks the plain `Yes`, never `Yes, and don't ask again` — widening
  permissions takes an explicit "and don't ask again".
- "no, use pytest instead" picks the refusing option and then types
  `use pytest instead` into the feedback box it opens.
- "option two" and "the third one" pick by number.
- **If your sentence does not map onto what is on screen, it presses nothing**
  and texts you to say so. Pressing Enter on a menu it did not understand would
  accept whatever happens to be highlighted, which in most agents is "Yes" — so
  it does not. A still-blocked agent is always recoverable.

It also re-checks the agent immediately before typing: if you answered at the
keyboard while the phone was ringing, the transcript is stale and gets reported
to you instead of injected.

A pane that is not showing a menu (a shell `read`, a commit message, an idle
composer) gets the sentence as literal text plus Enter, which is exactly what a
keyboard sends.

## Privacy

The question that gets read to you is the visible portion of the pane, sent to
`/call-me` so it can be spoken. Your answer is transcribed live and is not
stored. Nothing else about your machine, your repos or your other panes leaves
it. Full policy: <https://serdaroztetik.com/aiphone/privacy>

## Development

```bash
node --test test/plugin.test.mjs   # 56 tests, no network, no server, no phone
herdr plugin link .
herdr plugin log list --plugin radres.call-me
```

MIT. Built on <https://serdaroztetik.com/aiphone>.
