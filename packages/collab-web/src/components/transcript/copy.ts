import type { ImageContent, SessionEntry, TextContent } from "@oh-my-pi/pi-wire";
import type { TranscriptItem } from "./items";

type PromptContent = string | readonly (TextContent | ImageContent)[];

/** A prompt turn's sender and content, or null when the entry is not a prompt. */
export function promptOf(entry: SessionEntry): { sender: string; content: PromptContent } | null {
	if (entry.type === "message") {
		return entry.message.role === "user" ? { sender: "host", content: entry.message.content } : null;
	}
	if (entry.type === "custom_message" && entry.customType === "collab-prompt") {
		const details = entry.details;
		const from =
			details !== null &&
			typeof details === "object" &&
			typeof (details as Record<string, unknown>).from === "string"
				? ((details as Record<string, unknown>).from as string)
				: "guest";
		return { sender: from, content: entry.content };
	}
	return null;
}

/** Markdown source of prompt content; images become an `[image]` placeholder. */
export function contentMarkdown(content: PromptContent): string {
	if (typeof content === "string") return content;
	return content
		.map(block => (block.type === "text" ? block.text : block.type === "image" ? "[image]" : ""))
		.filter(part => part !== "")
		.join("\n\n");
}

/**
 * Markdown of the turn holding item `key`: its prompt followed by every agent
 * text block up to the next prompt, each under a bold sender line. Tool calls,
 * thinking and markers are left out. A turn whose prompt lies above the
 * mounted window starts at the first mounted item. Empty when `key` is unknown.
 */
export function turnMarkdown(items: readonly TranscriptItem[], key: string): string {
	const at = items.findIndex(item => item.key === key);
	if (at < 0) return "";
	let start = at;
	for (; start > 0; start--) {
		const item = items[start]!;
		if (item.kind === "entry" && promptOf(item.entry) !== null) break;
	}
	const parts: string[] = [];
	let agentOpen = false;
	for (let i = start; i < items.length; i++) {
		const item = items[i]!;
		if (item.kind === "entry") {
			const prompt = promptOf(item.entry);
			if (prompt === null) continue;
			if (i !== start) break;
			parts.push(`**${prompt.sender}**`, contentMarkdown(prompt.content));
			agentOpen = false;
		} else if (item.kind === "text") {
			if (!agentOpen) parts.push("**agent**");
			agentOpen = true;
			parts.push(item.text);
		}
	}
	return parts.join("\n\n");
}

/** Writes `text` to the clipboard; falls back to `execCommand` outside secure contexts (plain-http LAN hosts). */
export async function copyText(text: string): Promise<void> {
	if (navigator.clipboard !== undefined && window.isSecureContext) {
		await navigator.clipboard.writeText(text);
		return;
	}
	const area = document.createElement("textarea");
	area.value = text;
	area.setAttribute("readonly", "");
	area.style.cssText = "position:fixed;top:0;left:0;opacity:0";
	document.body.appendChild(area);
	area.select();
	try {
		if (!document.execCommand("copy")) throw new Error("copy command rejected");
	} finally {
		area.remove();
	}
}
