/**
 * Telegram Bridge for Pi
 * ======================
 *
 * Talk to a pi session from Telegram, and get a Telegram ping whenever the
 * agent needs you (it finished / asked a question / wants approval).
 *
 * Topology: ONE Telegram bot per pi session. Several Telegram chats (phone,
 * laptop, teammates) can be linked to that bot and all reach the same session.
 * Long-polling is used, so no public URL or webhook is required.
 *
 * It is OFF by default for a new session. Turn it on per session with
 * `/telegram setup <bot-token>` (or `/telegram on` once a token is saved).
 *
 * Commands (run inside the pi session):
 *   /telegram setup <token>   Save bot token, enable, start listening
 *   /telegram on | off        Enable / disable for this session
 *   /telegram link            Show the pairing code + how to connect a chat
 *   /telegram status          Show current state
 *   /telegram name <name>     Set the label shown in Telegram pings
 *   /telegram chats           List linked Telegram chats
 *   /telegram unlink [all|id] Remove a linked chat (or all)
 *   /telegram approval on|off Ask on Telegram before dangerous commands
 *   /telegram test            Send a test ping to linked chats
 *   /telegram token <token>   Replace the bot token
 *   /telegram reset           Unlink everyone and turn off
 *
 * In Telegram (once linked):
 *   just type        -> sent to the pi session as your message
 *   /allow <id>      -> approve a pending dangerous-command request
 *   /deny <id>       -> deny a pending request
 *   /unlink          -> remove your chat from this session
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as cfgStore from "./config.ts";
import type { TgConfig } from "./config.ts";
import { getUpdates, sendMessage, tgCall, chatTitle } from "./telegram.ts";
import type { TgUpdate, TgMessage } from "./telegram.ts";
import { formatRecap } from "./recap.ts";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DANGEROUS = [
	/\brm\s+(-[a-z]*r[a-z]*f|--recursive)/i,
	/\bsudo\b/i,
	/\b(chmod|chown)\b.*\s777\b/i,
	/\bmkfs\b/i,
	/\b(shutdown|reboot|halt)\b/i,
	/\bdd\s+if=/i,
	/>\s*\/dev\/(sd|nvme|hd)/i,
	/\bkill\s+-9\b/i,
];

const baseDir = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = join(baseDir, "skills", "telegram-messaging", "SKILL.md");

// Telegram bridge control commands (handled locally, never sent to pi).
const BRIDGE_COMMANDS = new Set(["pair", "start", "link", "allow", "approve", "deny", "reject", "unlink", "help"]);

// pi built-in slash commands (core; not dispatched by sendUserMessage).
const BUILTIN_COMMANDS = new Set([
	"settings", "model", "tree", "thinking", "scoped-models", "export", "import", "share", "bug",
	"copy", "name", "session", "changelog", "hotkeys", "fork", "clone", "trust", "login", "logout",
	"new", "compact", "resume", "reload", "quit",
]);

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

let skillBodyCache: string | undefined;

/** Load the messaging skill body (frontmatter stripped), cached. */
function skillBody(): string {
	if (skillBodyCache === undefined) {
		let raw = "";
		try {
			raw = fs.readFileSync(SKILL_PATH, "utf8");
		} catch {
			raw = "";
		}
		skillBodyCache = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim();
	}
	return skillBodyCache;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

export default function (pi: ExtensionAPI) {
	// ---- process-scoped runtime state (one pi session == one process) ----
	let key: string | undefined;
	let cfg: TgConfig | undefined;
	let sessionCtx: ExtensionContext | undefined;
	let polling = false;
	let stopPolling = false;
	let lastError: string | undefined;
	let approvalSeq = 0;
	const pendingApprovals = new Map<string, { resolve: (allow: boolean) => void }>();

	// ---- config helpers ----
	function defaultName(ctx?: ExtensionContext): string {
		try {
			const named = pi.getSessionName?.();
			if (named) return named;
		} catch {
			/* ignore */
		}
		try {
			const cwd = ctx?.cwd || process.cwd();
			const base = cwd.split("/").filter(Boolean).pop();
			return base || "pi";
		} catch {
			return "pi";
		}
	}

	/** Load (and cache) this session's config. Recomputes on session switch. */
	function ensure(ctx?: ExtensionContext): TgConfig {
		let sf: string | undefined;
		try {
			sf = ctx?.sessionManager?.getSessionFile?.();
		} catch {
			sf = undefined;
		}
		const k = sf ? cfgStore.keyFromSessionFile(sf) : (key ?? cfgStore.keyFromSessionFile(process.cwd()));
		if (k !== key || !cfg) {
			key = k;
			cfg = cfgStore.loadConfig(k) || cfgStore.defaultConfig(k, defaultName(ctx));
			if (!cfg.pairCode) cfg.pairCode = cfgStore.newPairCode();
			if (!cfg.name || cfg.name === k) cfg.name = defaultName(ctx);
		}
		return cfg;
	}

	function save(): void {
		if (cfg) cfgStore.saveConfig(cfg);
	}

	// ---- inbound injection into the pi session ----
	function injectUser(text: string): void {
		try {
			pi.sendUserMessage(text);
		} catch {
			// Busy (streaming): queue as a follow-up instead of interrupting.
			try {
				pi.sendUserMessage(text, { deliverAs: "followUp" });
			} catch {
				/* ignore */
			}
		}
	}

	// Dispatch a slash command through pi. expandPromptTemplates makes pi run
	// extension commands, /skill:name, and /template just as if typed in the editor.
	function injectCommand(text: string): void {
		try {
			pi.sendUserMessage(text, { expandPromptTemplates: true });
		} catch {
			try {
				pi.sendUserMessage(text, { deliverAs: "followUp", expandPromptTemplates: true });
			} catch {
				/* ignore */
			}
		}
	}

	// ---- Telegram long-poll loop ----
	async function startPolling(): Promise<void> {
		const c = ensure(sessionCtx);
		if (polling || !c.enabled || !c.botToken) return;
		polling = true;
		stopPolling = false;
		const token = c.botToken;
		void (async () => {
			while (!stopPolling && cfg && cfg.enabled && cfg.botToken === token) {
				try {
					const updates = await getUpdates(token, cfg.offset, 25);
					for (const u of updates) {
						if (u.update_id >= cfg.offset) cfg.offset = u.update_id + 1;
						await handleUpdate(u);
					}
					if (updates.length) save();
					lastError = undefined;
				} catch (err: any) {
					lastError = String(err?.message || err);
					// Transient network errors are normal during long-poll; back off.
					await sleep(5000);
				}
			}
			polling = false;
		})();
	}

	function stopPoller(): void {
		stopPolling = true;
		polling = false;
	}

	// ---- inbound message handling ----
	async function handleUpdate(u: TgUpdate): Promise<void> {
		const msg: TgMessage | undefined = u.message || u.edited_message;
		if (!msg) return;
		const c = ensure(sessionCtx);
		const token = c.botToken;
		if (!token) return;

		const text = (msg.text || "").trim();
		const chatId = msg.chat.id;
		const linked = c.chats.some((x) => x.chatId === chatId);

		// Approval replies (only from linked chats).
		if (linked) {
			const allowMatch = text.match(/^\/(?:allow|approve)(?:@\w+)?\s+(\S+)/i);
			const denyMatch = text.match(/^\/(?:deny|reject)(?:@\w+)?\s+(\S+)/i);
			if (allowMatch || denyMatch) {
				const id = (allowMatch || denyMatch)![1];
				const pending = pendingApprovals.get(id);
				if (pending) {
					pending.resolve(!!allowMatch);
					await safeSend(token, chatId, allowMatch ? `✅ Approved (${id})` : `❌ Denied (${id})`);
				} else {
					await safeSend(token, chatId, `No pending request ${id}.`);
				}
				return;
			}
		}

		// /unlink removes the chat.
		if (linked && /^\/unlink(?:@\w+)?$/i.test(text)) {
			c.chats = c.chats.filter((x) => x.chatId !== chatId);
			save();
			await safeSend(token, chatId, "👋 Unlinked. This chat no longer controls the session.");
			return;
		}

		// Pairing: /pair <code>, /start <code>, /start, or bare code.
		const pairMatch =
			text.match(/^\/(?:pair|start|link)(?:@\w+)?\s+(\S+)/i) || text.match(/^\/?(TG-[A-Z0-9]{4})$/i);
		const isStart = /^\/start(?:@\w+)?$/i.test(text);

		if (!linked) {
			if (pairMatch) {
				const code = pairMatch[1].toUpperCase();
				const codeOk = code === (c.pairCode || "").toUpperCase();
				const firstLinkOpen = c.chats.length === 0;
				if (codeOk || firstLinkOpen) {
					c.chats.push({ chatId, title: chatTitle(msg.chat), linkedAt: new Date().toISOString() });
					save();
					await safeSend(
						token,
						chatId,
						`✅ Linked to pi session "${c.name}".\n` +
							`Type here to talk to the agent. It will ping you when it needs you.\n` +
							`Commands: /unlink`,
					);
				} else {
					await safeSend(token, chatId, `🔒 Wrong pairing code. Run /telegram link in the pi session to get the code.`);
				}
				return;
			}
			if (isStart) {
				if (c.chats.length === 0) {
					c.chats.push({ chatId, title: chatTitle(msg.chat), linkedAt: new Date().toISOString() });
					save();
					await safeSend(token, chatId, `✅ Linked to pi session "${c.name}". Type here to talk to the agent.`);
				} else {
					await safeSend(token, chatId, `🔒 This bot is private. Send /pair <code> (get the code from the pi session).`);
				}
				return;
			}
			// Unknown / unlinked chat.
			await safeSend(token, chatId, `🔒 This chat isn't linked. Send /pair <code> (run /telegram link in the pi session).`);
			return;
		}

		// Linked chat: slash commands route to pi; plain text becomes your message.
		if (text) {
			if (text.startsWith("/")) {
				await handleSlashCommand(text, chatId, c);
				return;
			}
			injectUser(text);
		}
	}

	async function safeSend(token: string, chatId: number, text: string): Promise<void> {
		try {
			await sendMessage(token, chatId, text);
		} catch (err: any) {
			lastError = String(err?.message || err);
		}
	}

	// ---- slash-command routing (Telegram -> pi) ----
	function bridgeHelp(): string {
		return (
			"Telegram bridge commands:\n" +
			"  /pair <code>   link this chat to the session\n" +
			"  /unlink        remove this chat\n" +
			"  /allow <id>    approve a pending request\n" +
			"  /deny <id>     deny a pending request\n\n" +
			"Any other /command is sent to pi and runs as if you typed it\n" +
			"(e.g. /compact, /session, /skill:name, your extension commands).\n" +
			"Plain text is sent as your message to the agent."
		);
	}

	// pi built-in commands. The safe non-interactive ones run directly; the rest
	// open terminal pickers, so we explain instead of silently dropping them.
	async function handleBuiltin(name: string, args: string): Promise<string> {
		const ctx = sessionCtx;
		try {
			switch (name) {
				case "compact":
					ctx?.compact?.({ customInstructions: args || undefined });
					return args ? `⏳ Compacting with instructions: ${args}` : "⏳ Compacting context…";
				case "name":
					if (args) {
						pi.setSessionName(args);
						return `Session name set to "${args}".`;
					}
					return `Session name: ${pi.getSessionName() || "(not set)"}`;
				case "thinking":
					if (args) {
						const lvl = args.toLowerCase();
						if (!THINKING_LEVELS.includes(lvl)) {
							return `Unknown thinking level "${args}". Use one of: ${THINKING_LEVELS.join(", ")}`;
						}
						pi.setThinkingLevel(lvl as any);
						return `Thinking level set to ${lvl}.`;
					}
					return `Thinking level: ${pi.getThinkingLevel()}`;
				case "session": {
					const usage = ctx?.getContextUsage?.();
					const lines = [
						"Session info",
						`name:    ${pi.getSessionName() || "(not set)"}`,
						`model:   ${ctx?.model?.id || "unknown"}`,
						`cwd:     ${ctx?.cwd || "unknown"}`,
						`status:  ${ctx?.isIdle?.() ? "idle" : "working"}`,
					];
					if (usage) lines.push(`context: ${usage.tokens ?? "?"} tokens (${usage.percent ?? "?"}%)`);
					return lines.join("\n");
				}
				case "quit":
					ctx?.shutdown?.();
					return "Shutting down pi. This Telegram link will stop with it.";
				case "model":
					return args
						? "Setting a model over Telegram isn't supported yet. Run /model in the terminal."
						: "/model opens a model picker in the terminal. Run it there.";
				case "new":
				case "resume":
				case "fork":
				case "clone":
				case "tree":
					return `/${name} switches the pi session. Telegram stays bound to the current session, so the next session won't be linked here. Run it in the terminal.`;
				default:
					return `/${name} is a terminal UI command. Run it in the pi terminal.`;
			}
		} catch (e: any) {
			return `Couldn't run /${name}: ${String(e?.message || e)}`;
		}
	}

	// Route a slash command from a linked chat to pi.
	async function handleSlashCommand(text: string, chatId: number, c: TgConfig): Promise<void> {
		const m = text.match(/^\/([A-Za-z0-9_-]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
		const name = (m?.[1] || "").toLowerCase();
		const args = (m?.[2] || "").trim();
		const token = c.botToken!;

		if (BRIDGE_COMMANDS.has(name)) {
			await safeSend(token, chatId, bridgeHelp());
			return;
		}
		if (BUILTIN_COMMANDS.has(name)) {
			await safeSend(token, chatId, await handleBuiltin(name, args));
			return;
		}

		// Extension / skill / prompt-template command: dispatch it to pi.
		await safeSend(token, chatId, `▶ ${text.split("\n")[0]}`);
		injectCommand(text);
	}

	// ---- optional Telegram approval gate for dangerous commands ----
	function isDangerous(cmd: string): boolean {
		return DANGEROUS.some((r) => r.test(cmd));
	}

	async function requestApproval(c: TgConfig, cmd: string, ctx: ExtensionContext): Promise<boolean> {
		const id = `a${++approvalSeq}`;
		const text =
			`⚠️ Approval needed — ${c.name}\n\nCommand:\n${cmd}\n\n` +
			`Reply:\n/allow ${id}\n/deny ${id}\n(auto-denies in 10 min)`;
		for (const chat of c.chats) await safeSend(c.botToken!, chat.chatId, text);

		return new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => {
				pendingApprovals.delete(id);
				resolve(false);
			}, 10 * 60 * 1000);
			pendingApprovals.set(id, {
				resolve: (v) => {
					clearTimeout(timer);
					pendingApprovals.delete(id);
					resolve(v);
				},
			});
			try {
				ctx?.signal?.addEventListener?.("abort", () => {
					clearTimeout(timer);
					pendingApprovals.delete(id);
					resolve(false);
				}, { once: true });
			} catch {
				/* ignore */
			}
		});
	}

	// ---- lifecycle events ----
	pi.on("session_start", async (_event, ctx) => {
		sessionCtx = ctx;
		const c = ensure(ctx);
		if (c.enabled && c.botToken) await startPolling();
	});

	pi.on("agent_settled", async (_event, ctx) => {
		sessionCtx = ctx;
		const c = ensure(ctx);
		if (!c.enabled || !c.botToken || c.chats.length === 0) return;
		let text: string;
		try {
			text = formatRecap(c.name, ctx.sessionManager.getBranch() as any[]);
		} catch {
			text = `🔔 ${c.name} · waiting for you`;
		}
		for (const chat of c.chats) await safeSend(c.botToken!, chat.chatId, text);
	});

	pi.on("tool_call", async (event, ctx) => {
		sessionCtx = ctx;
		const c = ensure(ctx);
		if (!c.approvalMode || !c.enabled || !c.botToken || c.chats.length === 0) return undefined;
		if (event.toolName !== "bash") return undefined;
		const cmd = String((event.input as any)?.command ?? "");
		if (!cmd || !isDangerous(cmd)) return undefined;
		const allow = await requestApproval(c, cmd, ctx);
		return allow ? undefined : { block: true, reason: "Denied via Telegram approval" };
	});

	// Force the messaging-style guide into the system prompt whenever this
	// session is linked to Telegram, so replies stay readable in chat.
	pi.on("before_agent_start", (event, ctx) => {
		const c = ensure(ctx);
		const opts = (event as any).systemPromptOptions;
		if (!opts) return;
		const sections = opts.sections || (opts.sections = {});
		const linked = !!c.enabled && !!c.botToken && c.chats.length > 0;
		const body = skillBody();
		if (linked && body) {
			sections.telegram_messaging = body;
		} else {
			delete sections.telegram_messaging;
		}
	});

	// Register the messaging guide as a real, loadable skill.
	pi.on("resources_discover", () => ({ skillPaths: [SKILL_PATH] }));

	pi.on("session_shutdown", async () => {
		stopPoller();
		save();
	});

	// ---- /telegram command ----
	pi.registerCommand("telegram", {
		description: "Telegram bridge: setup, on/off, link, status (see /telegram help)",
		handler: async (args, ctx) => {
			sessionCtx = ctx;
			const c = ensure(ctx);
			const [subRaw, ...rest] = args.trim().split(/\s+/);
			const sub = (subRaw || "").toLowerCase();
			const arg = rest.join(" ").trim();

			switch (sub) {
				case "setup": {
					if (!arg) {
						ctx.ui.notify("Usage: /telegram setup <bot-token>  (get it from @BotFather)", "warning");
						return;
					}
					const token = arg.trim();
					// Validate the token early so typos are caught immediately.
					try {
						const me = await tgCall<any>(token, "getMe");
						c.name = c.name && c.name !== c.key ? c.name : (me.username ? `@${me.username}` : defaultName(ctx));
					} catch (err: any) {
						ctx.ui.notify(`Token looks invalid: ${err?.message || err}`, "error");
						return;
					}
					c.botToken = token;
					c.enabled = true;
					if (!c.pairCode) c.pairCode = cfgStore.newPairCode();
					save();
					await startPolling();
					ctx.ui.notify(`Telegram enabled for "${c.name}".`, "info");
					showLinkHelp(ctx, c);
					return;
				}
				case "on": {
					if (!c.botToken) {
						ctx.ui.notify("No bot token yet. Run: /telegram setup <bot-token>", "warning");
						return;
					}
					c.enabled = true;
					save();
					await startPolling();
					ctx.ui.notify(`Telegram ON for "${c.name}".`, "info");
					return;
				}
				case "off": {
					c.enabled = false;
					save();
					stopPoller();
					ctx.ui.notify("Telegram OFF for this session.", "info");
					return;
				}
				case "link":
				case "pair": {
					showLinkHelp(ctx, c);
					return;
				}
				case "name": {
					if (!arg) {
						ctx.ui.notify(`Current name: ${c.name}`, "info");
						return;
					}
					c.name = arg;
					save();
					ctx.ui.notify(`Telegram label set to "${c.name}".`, "info");
					return;
				}
				case "chats": {
					if (c.chats.length === 0) {
						ctx.ui.notify("No linked Telegram chats yet. Run /telegram link", "info");
						return;
					}
					const list = c.chats.map((x) => `• ${x.title} (${x.chatId})`).join("\n");
					ctx.ui.notify(`Linked chats:\n${list}`, "info");
					return;
				}
				case "unlink": {
					if (arg === "all" || arg === "*") {
						c.chats = [];
						save();
						ctx.ui.notify("Unlinked all Telegram chats.", "info");
					} else {
						const id = Number(arg);
						const before = c.chats.length;
						c.chats = c.chats.filter((x) => x.chatId !== id);
						save();
						ctx.ui.notify(
							c.chats.length < before ? `Unlinked chat ${id}.` : `No linked chat ${id}.`,
							"info",
						);
					}
					return;
				}
				case "approval": {
					c.approvalMode = arg === "on" || arg === "true";
					save();
					ctx.ui.notify(`Telegram approval gate ${c.approvalMode ? "ON" : "OFF"}.`, "info");
					return;
				}
				case "test": {
					if (!c.botToken || c.chats.length === 0) {
						ctx.ui.notify("No linked chats to test. Run /telegram link", "warning");
						return;
					}
					for (const chat of c.chats) await safeSend(c.botToken, chat.chatId, `🔔 Test ping from pi session "${c.name}".`);
					ctx.ui.notify("Test ping sent.", "info");
					return;
				}
				case "token": {
					if (!arg) {
						ctx.ui.notify("Usage: /telegram token <bot-token>", "warning");
						return;
					}
					c.botToken = arg.trim();
					c.enabled = true;
					save();
					await startPolling();
					ctx.ui.notify("Bot token saved. Telegram enabled.", "info");
					return;
				}
				case "reset": {
					stopPoller();
					key = undefined;
					cfg = cfgStore.defaultConfig(cfg?.key || "session", defaultName(ctx));
					cfg.pairCode = cfgStore.newPairCode();
					save();
					ctx.ui.notify("Telegram bridge reset (all chats unlinked, turned off).", "info");
					return;
				}
				case "status":
				default: {
					if (sub && sub !== "help" && sub !== "status") {
						ctx.ui.notify(`Unknown subcommand "${sub}". Try /telegram help`, "warning");
						return;
					}
					if (sub === "help") {
						ctx.ui.notify(helpText(), "info");
						return;
					}
					const lines = [
						`Telegram bridge — ${c.name}`,
						`State:      ${c.enabled ? "ON" : "off"}`,
						`Bot token:  ${c.botToken ? "set" : "NOT set"}`,
						`Listening:  ${polling ? "yes" : "no"}${lastError ? `  (last error: ${lastError})` : ""}`,
						`Pair code:  ${c.pairCode}`,
						`Approval:   ${c.approvalMode ? "on" : "off"}`,
						`Linked:     ${c.chats.length ? c.chats.map((x) => x.title).join(", ") : "none"}`,
					];
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}
			}
		},
	});

	function showLinkHelp(ctx: ExtensionContext, c: TgConfig): void {
		const code = c.pairCode || "";
		ctx.ui.notify(
			`Connect a Telegram chat to "${c.name}":\n` +
				`1. Open your bot in Telegram\n` +
				`2. Send it:  /pair ${code}\n` +
				`   (the first chat to send /start is linked automatically)\n` +
				`3. Then just type here to talk to the agent.\n` +
				`Several chats can link to this same session.`,
			"info",
		);
	}

	function helpText(): string {
		return [
			"Telegram bridge commands:",
			"  /telegram setup <token>   save bot token + enable",
			"  /telegram on | off        enable / disable",
			"  /telegram link            show pairing code + steps",
			"  /telegram status          show state",
			"  /telegram name <name>     set the ping label",
			"  /telegram chats           list linked chats",
			"  /telegram unlink [all|id] unlink a chat",
			"  /telegram approval on|off dangerous-command approval via Telegram",
			"  /telegram test            send a test ping",
			"  /telegram token <token>   replace bot token",
			"  /telegram reset           unlink all + turn off",
		].join("\n");
	}
}