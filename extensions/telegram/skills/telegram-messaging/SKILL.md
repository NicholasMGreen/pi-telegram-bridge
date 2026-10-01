---
name: telegram-messaging
description: How to write replies to a user over a chat/messaging interface such as Telegram. Applied automatically whenever this session is linked to Telegram so answers stay readable on a phone. Use it whenever your reply is delivered as a plain chat message.
---

Telegram messaging guide

Your reply to the user is delivered as a plain-text chat message and read on a
phone. Telegram shows markdown characters literally, so a nicely formatted
document becomes unreadable. Write every user-facing reply like a clear, kind
text message. (Your reply is also shown in a terminal, where plain text is still
fine, so optimizing for chat costs nothing.)

Do not use markdown

- No **bold**, *italic*, or _underline_.
- No # headings and no > quotes.
- No | tables | - they collapse into jumbled text.
- No ``` code fences and no `backticks` used for emphasis.
- No [text](url) links - paste the raw URL instead.

Write like a text message

- Lead with the outcome. Put the answer, result, or ask first.
- Be concise. One idea per line. Short lines. No walls of text.
- Keep paragraphs to 2-3 lines, then a blank line.
- Cut filler. Do not restate the question.

Use simple structure

- Start each point with a dash and a space: - like this.
- Number steps as 1. 2. 3.
- Put a blank line before and after any list.
- A line of dashes (----) is fine as a section break. No ASCII art.

Report status so it scans in one glance

- Done: what you finished.
- Doing: what is still in progress, if anything.
- Blocked: what stopped you and why.
- Need from you: the exact question or decision.

Ask questions well

- Ask one clear question at a time.
- Put the question on its own line, or start the line with Question:
- For a choice, list 2 to 4 short numbered options.

Code and long output

- Never paste long code or big logs into chat. Write them to a file and give the path.
- Show only the small relevant snippet, indented plainly with no fences.
- Prefer describing a change over dumping a full diff.

Links and paths

- Paste raw URLs; the chat auto-links them.
- Put file paths on their own line so they are easy to copy.

Tone

- Warm, direct, human - like a capable colleague texting.
- Plain everyday words. Skip corporate or academic phrasing.
- A little emoji helps scanning: ✅ done, ⚠️ warning, ❌ problem. Use sparingly.

Example

Do not write like a document with a heading, bold text, and a fenced code block.
Write it like this instead:

  Done: refactored the auth module.

  - Split login and token refresh into separate files.
  - Added tests for both.

  Need from you: should the refresh token TTL be 7 or 30 days?
