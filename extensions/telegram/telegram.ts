/**
 * Minimal Telegram Bot API client.
 *
 * Uses long-polling (getUpdates) so no public URL / webhook is required — works
 * behind NAT and on a laptop. Falls back to node:https if global fetch is absent.
 */

export interface TgUser {
	id: number;
	is_bot?: boolean;
	first_name?: string;
	last_name?: string;
	username?: string;
}

export interface TgChat {
	id: number;
	type: string;
	title?: string;
	username?: string;
	first_name?: string;
	last_name?: string;
}

export interface TgMessage {
	message_id: number;
	chat: TgChat;
	from?: TgUser;
	text?: string;
	date: number;
}

export interface TgUpdate {
	update_id: number;
	message?: TgMessage;
	edited_message?: TgMessage;
}

// Overridable so tests (or a self-hosted local Bot API server) can point elsewhere.
const API = process.env.PI_TELEGRAM_API || "https://api.telegram.org";

/** Call a Telegram Bot API method with JSON params. Throws on API errors. */
export async function tgCall<T = unknown>(
	token: string,
	method: string,
	params: Record<string, unknown> = {},
	timeoutMs = 35_000,
): Promise<T> {
	const url = `${API}/bot${token}/${method}`;
	const body = JSON.stringify(params);

	const res = await httpPost(url, body, timeoutMs);
	let data: { ok?: boolean; result?: T; description?: string; error_code?: number };
	try {
		data = JSON.parse(res);
	} catch {
		throw new Error(`Telegram ${method}: invalid JSON response`);
	}
	if (!data.ok) {
		throw new Error(`Telegram ${method} failed: ${data.description || data.error_code || "unknown"}`);
	}
	return data.result as T;
}

/** Long-poll for new updates. Returns immediately when the timeout elapses. */
export async function getUpdates(
	token: string,
	offset: number,
	timeoutSec = 30,
): Promise<TgUpdate[]> {
	return tgCall<TgUpdate[]>(
		token,
		"getUpdates",
		{
			offset,
			timeout: timeoutSec,
			allowed_updates: ["message", "edited_message"],
		},
		(timeoutSec + 10) * 1000,
	);
}

/** Send a text message, splitting on line boundaries if it exceeds the limit. */
export async function sendMessage(token: string, chatId: number, text: string): Promise<void> {
	const chunks = splitMessage(text || "(empty)", 4000);
	for (const chunk of chunks) {
		await tgCall(token, "sendMessage", {
			chat_id: chatId,
			text: chunk,
			disable_web_page_preview: true,
		});
	}
}

/** Split text into <=limit chunks, preferring newline boundaries. */
export function splitMessage(text: string, limit: number): string[] {
	if (text.length <= limit) return [text];
	const out: string[] = [];
	let remaining = text;
	while (remaining.length > limit) {
		let cut = remaining.lastIndexOf("\n", limit);
		if (cut < limit * 0.5) cut = limit; // no good newline, hard cut
		out.push(remaining.slice(0, cut));
		remaining = remaining.slice(cut);
	}
	if (remaining.trim()) out.push(remaining);
	return out;
}

/** Describe a chat for display. */
export function chatTitle(chat: TgChat): string {
	if (chat.title) return chat.title;
	const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ");
	return name || chat.username || String(chat.id);
}

/** Resolve display name of a message sender. */
export function senderName(msg: TgMessage): string {
	const u = msg.from;
	if (!u) return chatTitle(msg.chat);
	const name = [u.first_name, u.last_name].filter(Boolean).join(" ");
	return name || u.username || String(u.id);
}

async function httpPost(url: string, body: string, timeoutMs: number): Promise<string> {
	if (typeof fetch === "function") {
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(), timeoutMs);
		try {
			const res = await fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body,
				signal: ac.signal,
			});
			return await res.text();
		} finally {
			clearTimeout(timer);
		}
	}
	return httpsPost(url, body, timeoutMs);
}

function httpsPost(url: string, body: string, timeoutMs: number): Promise<string> {
	return (async () => {
		const https = await import("node:https");
		return new Promise<string>((resolve, reject) => {
			const u = new URL(url);
			const req = https.request(
				{
					protocol: u.protocol,
					hostname: u.hostname,
					path: u.pathname + u.search,
					method: "POST",
					headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
					timeout: timeoutMs,
				},
				(res) => {
					let data = "";
					res.on("data", (c: Buffer) => (data += c.toString()));
					res.on("end", () => resolve(data));
				},
			);
			req.on("timeout", () => req.destroy(new Error("Telegram request timed out")));
			req.on("error", reject);
			req.write(body);
			req.end();
		});
	})();
}