/**
 * Build a short Telegram-friendly recap of a settled run.
 *
 * The goal: when the agent stops and pings you, you immediately see what it did
 * (or the question it needs answered) without opening the tmux pane.
 */

// Session entries are loosely typed here to stay robust across pi versions.
type AnyEntry = {
	type?: string;
	timestamp?: string;
	message?: {
		role?: string;
		content?: unknown;
	};
};

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((block: any) => {
				if (typeof block === "string") return block;
				if (block && typeof block === "object") {
					if (block.type === "text" && typeof block.text === "string") return block.text;
					if (typeof block.text === "string") return block.text;
				}
				return "";
			})
			.filter(Boolean)
			.join("\n")
			.trim();
	}
	if (content && typeof content === "object" && typeof (content as any).text === "string") {
		return (content as any).text;
	}
	return "";
}

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return text.slice(0, max - 1).trimEnd() + "…";
}

/** Collect the last assistant + last user message text from the active branch. */
export function buildRecap(branch: AnyEntry[]): { head: string; body: string } {
	let lastAssistant = "";
	let lastUser = "";
	let assistantCount = 0;
	let toolCount = 0;

	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i];
		if (!e || e.type !== "message" || !e.message) continue;
		const role = e.message.role;
		if (role === "assistant") {
			assistantCount++;
			if (!lastAssistant) lastAssistant = textFromContent(e.message.content);
		} else if (role === "user") {
			if (!lastUser) lastUser = textFromContent(e.message.content);
		} else if (role === "toolResult") {
			toolCount++;
		}
		if (lastAssistant && lastUser) break;
	}

	const body = lastAssistant || "(no assistant response captured)";
	const askedBy = lastUser ? `🗂 You asked: ${truncate(lastUser, 400)}\n\n` : "";

	return {
		head: askedBy,
		body: truncate(body, 3200),
	};
}

/**
 * Full Telegram recap message (plain text — no parse_mode). `name` identifies
 * the pi session so you know which tmux pane is pinging you.
 */
export function formatRecap(name: string, branch: AnyEntry[]): string {
	const { head, body } = buildRecap(branch);
	const stamp = new Date().toLocaleTimeString();
	return (
		`🔔 ${name} · waiting for you  ·  ${stamp}\n` +
		`────────────────\n` +
		(head ? `${head}` : "") +
		`${body}\n` +
		`────────────────\n` +
		`Reply here to continue this session.`
	);
}