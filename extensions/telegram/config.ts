/**
 * Telegram bridge — per-session configuration store.
 *
 * Each pi session keeps its own config file under ~/.pi/agent/telegram/.
 * One file per session avoids cross-process write races when several pi
 * sessions (tmux panes) run at once.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ChatLink {
	chatId: number;
	/** Telegram chat title or @username, for display. */
	title: string;
	linkedAt: string;
}

export interface TgConfig {
	/** Stable key for this session (derived from the session file). */
	key: string;
	/** Friendly name shown in Telegram so you know which pane is pinging you. */
	name: string;
	/** Telegram bot token (one bot per pi session). */
	botToken?: string;
	/** Master switch. Off by default for a new session. */
	enabled: boolean;
	/** Code a Telegram chat must send to become authorized for this session. */
	pairCode?: string;
	/** Authorized Telegram chats. */
	chats: ChatLink[];
	/** When true, dangerous tool calls ask for approval via Telegram. */
	approvalMode: boolean;
	/** getUpdates offset, persisted so we don't reprocess messages. */
	offset: number;
	createdAt: string;
}

export function configDir(): string {
	return process.env.PI_TELEGRAM_CONFIG_DIR || path.join(os.homedir(), ".pi", "agent", "telegram");
}

export function configPath(key: string): string {
	return path.join(configDir(), `${key}.json`);
}

function ensureDir(): void {
	fs.mkdirSync(configDir(), { recursive: true });
}

/** Derive a stable, filesystem-safe key from a session file path. */
export function keyFromSessionFile(sessionFile: string): string {
	const base = path.basename(sessionFile).replace(/\.jsonl$/i, "");
	return slug(base || sessionFile);
}

function slug(s: string): string {
	return (
		s
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 64) || "session"
	);
}

export function loadConfig(key: string): TgConfig | undefined {
	try {
		const raw = fs.readFileSync(configPath(key), "utf8");
		const parsed = JSON.parse(raw) as TgConfig;
		return normalize(key, parsed);
	} catch {
		return undefined;
	}
}

export function defaultConfig(key: string, name: string): TgConfig {
	return normalize(key, {
		key,
		name,
		enabled: false,
		chats: [],
		approvalMode: false,
		offset: 0,
		createdAt: new Date().toISOString(),
	});
}

function normalize(key: string, cfg: Partial<TgConfig>): TgConfig {
	return {
		key,
		name: cfg.name || key,
		botToken: cfg.botToken,
		enabled: !!cfg.enabled,
		pairCode: cfg.pairCode,
		chats: Array.isArray(cfg.chats) ? cfg.chats : [],
		approvalMode: !!cfg.approvalMode,
		offset: typeof cfg.offset === "number" ? cfg.offset : 0,
		createdAt: cfg.createdAt || new Date().toISOString(),
	} as TgConfig;
}

/** Atomic-ish write: write to a temp file then rename into place. */
export function saveConfig(cfg: TgConfig): void {
	ensureDir();
	const target = configPath(cfg.key);
	const tmp = `${target}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), "utf8");
	fs.renameSync(tmp, target);
}

/** Generate a short human-typable pairing code, e.g. "TG-4K9Q". */
export function newPairCode(): string {
	const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no ambiguous chars
	let s = "";
	for (let i = 0; i < 4; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
	return `TG-${s}`;
}