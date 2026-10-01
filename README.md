# pi-telegram-bridge

> Talk to your **[pi](https://pi.dev)** agent from Telegram — and get a Telegram
> ping whenever it needs you.

Run pi sessions anywhere (tmux panes, a server, your laptop) and stay in the loop
from your phone. When the agent finishes, asks a question, or wants approval for
a risky command, it texts you a recap. Reply in Telegram to keep it going.

- 💬 **Two-way chat** — type in Telegram, it's your message in the pi session; pi
  replies and pings you back.
- 📱 **Chat-ready replies** — once linked, the agent writes for a phone: concise,
  plain text, bullet points, no markdown. Driven by a built-in
  `telegram-messaging` skill that is injected into context and enforced.
- ⚡ **Slash commands work** — send any `/command` from Telegram and it runs in pi:
  extension commands, `/skill:name`, `/compact`, `/session`, and more.
- 🎛️ **Remote pickers** — `/model` and `/thinking` open tappable Telegram inline
  keyboards; tap to switch model or thinking level right from your phone.
- 👥 **Multi-chat** — link several Telegram accounts/devices to one session.
- 🖥️ **Multi-session** — run many pi sessions in tmux, each with its own bot and
  its own pings (labelled so you know which pane needs you).
- 🔒 **Off by default** — a new pi session does nothing until you enable it.
- 🌐 **No server needed** — uses long-polling, so it works behind NAT on a laptop.
- ✅ **Optional approval gate** — approve dangerous commands (`sudo`, `rm -rf`, …)
  straight from Telegram.

---

## Install

One command inside pi's shell (or your terminal):

```bash
pi install git:github.com/NicholasMGreen/pi-telegram-bridge
```

Restart pi (or run `/reload`). That's it — the `/telegram` command is now
available in every pi session. See [pi packages](https://github.com/earendil-works/pi/blob/main/docs/packages.md)
for npm / version-pinned options.

## Setup (5 minutes)

### 1. Create a Telegram bot — one per pi session

In Telegram, open **@BotFather** → send `/newbot` → follow the prompts. Copy the
**token** it gives you, e.g. `123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw`.

> One bot per pi session. To reach 3 pi sessions, make 3 bots.

### 2. Turn it on in your pi session

```
/telegram setup 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaws
```

This validates the token, enables the bridge, and prints a **pairing code** like
`TG-4K9Q`.

### 3. Connect your Telegram

Open your bot in Telegram and send it:

```
/pair TG-4K9Q
```

You'll get `✅ Linked to pi session ...`. Done.

> Shortcut: the **first** chat to send `/start` to a fresh bot links
> automatically — no code needed. The code is only needed to link *more* chats.

### 4. Talk to it

Just type in the Telegram chat. When the agent **stops and needs you**, you get a
ping with a recap of what it did (or the question it's asking). Reply to continue.

### 5. (Optional) Approve risky commands from Telegram

```
/telegram approval on
```

---

## Multiple telegrams → one agent

Everyone who should reach the session sends the same thing to the same bot:

```
/pair TG-4K9Q
```

Your phone, your laptop, a teammate — each linked chat can drive the session and
gets its pings. List them with `/telegram chats`, remove one with
`/telegram unlink <chatId>` (or `/unlink` from that chat).

## Multiple pi sessions in tmux

1. Start each pi session in its own tmux pane / project folder.
2. In each, run `/telegram setup <that-pane's-bot-token>` (use a **different bot**
   per pane).
3. Pair your Telegram to each bot you care about.

Each pane pings you separately. Label them so you know who's who:

```
/telegram name webnovel
```

---

## Commands

### Inside the pi session

| Command | What it does |
|---|---|
| `/telegram setup <token>` | Save bot token, validate, turn on, start listening |
| `/telegram on` / `off` | Enable / disable for this session |
| `/telegram link` | Show the pairing code + how to connect a chat |
| `/telegram status` | Show state (token, listening, linked chats, code) |
| `/telegram name <name>` | Set the label shown in Telegram pings |
| `/telegram chats` | List linked Telegram chats |
| `/telegram unlink [all\|id]` | Remove a linked chat (or all) |
| `/telegram approval on\|off` | Ask on Telegram before dangerous commands |
| `/telegram test` | Send a test ping to linked chats |
| `/telegram token <token>` | Replace the bot token |
| `/telegram reset` | Unlink everyone and turn off |

### In Telegram (once linked)

| You send | What happens |
|---|---|
| any text | Sent to the pi session as your message |
| `/command ...` | Runs the pi slash command (see below) |
| `/pair <code>` | Link another chat to this session |
| `/allow <id>` | Approve a pending dangerous-command request |
| `/deny <id>` | Deny a pending request |
| `/unlink` | Remove this chat from the session |
| `/help` | Bridge help |

## Slash commands from Telegram

Send any `/command` in the Telegram chat and it runs in pi, just like typing it in
the terminal:

- **Extension commands, `/skill:name`, prompt templates** — dispatched and run
  as-is (e.g. `/handoff`, `/skill:pdf-tools`, your custom commands).
- **Safe built-ins** — `/compact [instructions]`, `/name`, `/session`, and `/quit`
  run directly and reply with the result.
- **Remote pickers (tappable buttons)** — `/model` and `/thinking` open an inline
  keyboard in the chat. `/model` pages through the available models (Next/Prev);
  `/thinking` lists the levels. Just tap a button to apply it. You can also set
  them directly: `/model <provider/id>` (or `/model <text>` to filter the list) and
  `/thinking <level>`.
- **Bridge commands** — `/pair`, `/unlink`, `/allow`, `/deny`, `/help` control the
  bridge itself and never reach pi.
- **Terminal-only commands** — a few nested pickers (`/settings`, `/login`,
  `/scoped-models`) and session switches (`/new`, `/resume`, `/fork`) reply with a
  short note that they need the terminal (a switch would also detach Telegram), so
  nothing is ever silently dropped.

---

## How it works

- **One bot per pi session.** Each session long-polls its own Telegram bot so
  messages never collide between sessions. (Telegram gives each bot a single
  message queue — sharing one token across processes would make them steal each
  other's messages.)
- **Notifications** fire on `agent_settled` (the agent stops and won't continue on
  its own): you get a recap — your last request plus the agent's latest
  response/question — in every linked chat.
- **Inbound** messages are injected with `pi.sendUserMessage()`, so they behave
  exactly like you typed them in the editor (queued as a follow-up if the agent is
  mid-run).
- **Off by default:** the per-session `enabled` flag starts `false`;
  `/telegram setup` or `/telegram on` flips it.
- **Messaging style:** as soon as a session is linked, the `telegram-messaging`
  skill is forced into the system prompt so replies stay readable in chat — no
  markdown, lead with the answer, short bullets, one question at a time. It is
  also a normal skill (run `/skill:telegram-messaging` to load it any time).

### Files

Each session keeps its own settings file (so parallel sessions never race):

```
~/.pi/agent/telegram/<session>.json
```

Delete a file to forget a session's bot and links.

### Environment overrides (optional)

| Var | Purpose |
|---|---|
| `PI_TELEGRAM_API` | Point at a different Telegram Bot API server (default `https://api.telegram.org`) |
| `PI_TELEGRAM_CONFIG_DIR` | Change where session configs are stored |

---

## Troubleshooting

- **"Token looks invalid"** — re-copy the full token from BotFather (it includes
  the `:` and a long tail).
- **Bot doesn't reply in Telegram** — check `/telegram status`: is `Listening: yes`?
  If not, run `/telegram on`. Also confirm a chat is linked (`Linked: ...`).
- **Want to start over** — `/telegram reset`, then `/telegram link`.
- **Not getting pings** — the bridge must be `on` with at least one linked chat;
  use `/telegram test` to confirm delivery.
- **Multiple panes sharing one bot** — don't; give each pane its own bot.

---

## Development

```bash
git clone https://github.com/NicholasMGreen/pi-telegram-bridge
cd pi-telegram-bridge
pi install ./          # load it locally while hacking
```

The extension is plain TypeScript under `extensions/telegram/`, loaded directly by
pi (no build step). It has **no runtime dependencies** — it uses only Node
builtins and the global `fetch`. The single `@earendil-works/pi-coding-agent`
import is **type-only** (erased at runtime and supplied by pi), and is declared
as an *optional* peer dependency so installs pull zero packages. Install it
locally (`npm i -D @earendil-works/pi-coding-agent`) only if you want editor
IntelliSense. Contributions welcome.

## License

[MIT](LICENSE)
