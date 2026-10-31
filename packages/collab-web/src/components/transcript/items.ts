import type {
	AssistantMessage,
	RedactedThinkingContent,
	SessionEntry,
	ThinkingContent,
	ToolCallContent,
} from "@oh-my-pi/pi-wire";
import type { ActiveTool } from "../../lib/client";

/** One member of an activity group: a tool call, a live tool not yet in any message, or a thinking block. */
export type ActivityMember =
	| { kind: "tool"; key: string; call: ToolCallContent; /** From the still-streaming message. */ pending: boolean }
	| { kind: "tail"; key: string; tool: ActiveTool }
	| { kind: "thinking"; key: string; block: ThinkingContent | RedactedThinkingContent };

/**
 * A direct child of the transcript root. `gutter` marks the first agent item
 * (text, group, stop) after a non-agent item; later agent items in the same
 * turn leave the gutter empty.
 */
export type TranscriptItem =
	| { kind: "entry"; key: string; entry: SessionEntry }
	| { kind: "text"; key: string; text: string; streaming: boolean; gutter: boolean; title?: string }
	| { kind: "group"; key: string; members: readonly ActivityMember[]; gutter: boolean }
	| { kind: "stop"; key: string; message: AssistantMessage; gutter: boolean; title?: string };

export interface TranscriptItems {
	readonly items: readonly TranscriptItem[];
	/** Every key handed out (item and member keys), so live appends stay unique. */
	readonly keys: ReadonlySet<string>;
}

export interface LiveTail {
	stream: AssistantMessage | null;
	/** Stream still receiving tokens: no stop chip, streaming Markdown, calls count as running. */
	pending: boolean;
	tailTools: readonly ActiveTool[];
}

class ItemBuilder {
	readonly items: TranscriptItem[];
	readonly keys = new Set<string>();
	readonly #baseKeys: ReadonlySet<string>;
	/** Members of the trailing group while it is still extendable and owned by this builder. */
	#open: ActivityMember[] | null = null;

	constructor(base?: TranscriptItems) {
		this.items = base === undefined ? [] : base.items.slice();
		this.#baseKeys = base === undefined ? new Set() : base.keys;
	}

	/** Stable key, suffixed only on a collision (e.g. two messages sharing a timestamp). */
	#key(raw: string): string {
		let key = raw;
		for (let n = 2; this.#baseKeys.has(key) || this.keys.has(key); n++) key = `${raw}#${n}`;
		this.keys.add(key);
		return key;
	}

	#gutter(): boolean {
		const last = this.items.at(-1);
		return last === undefined || last.kind === "entry";
	}

	#member(member: ActivityMember): void {
		if (this.#open !== null) {
			this.#open.push(member);
			return;
		}
		const last = this.items.at(-1);
		if (last?.kind === "group") {
			// Trailing group from the memoized base: extend a copy, never the shared array.
			const members = [...last.members, member];
			this.items[this.items.length - 1] = { ...last, members };
			this.#open = members;
			return;
		}
		const members = [member];
		this.items.push({ kind: "group", key: member.key, members, gutter: this.#gutter() });
		this.#open = members;
	}

	#visible(item: TranscriptItem): void {
		this.#open = null;
		this.items.push(item);
	}

	entry(entry: SessionEntry): void {
		switch (entry.type) {
			case "message": {
				const msg = entry.message;
				if (msg.role === "user") this.#visible({ kind: "entry", key: this.#key(entry.id), entry });
				else if (msg.role === "assistant") this.assistant(msg, false, entry.timestamp);
				// toolResult entries pair with their call; developer & unknown roles render nothing.
				return;
			}
			case "custom_message":
				if (entry.customType === "collab-prompt" || entry.display) {
					this.#visible({ kind: "entry", key: this.#key(entry.id), entry });
				}
				return;
			case "compaction":
			case "branch_summary":
			case "model_change":
			case "thinking_level_change":
				this.#visible({ kind: "entry", key: this.#key(entry.id), entry });
				return;
			default:
				// unknown entry types from newer hosts — skip tolerantly
				return;
		}
	}

	assistant(message: AssistantMessage, pending: boolean, title?: string): void {
		const stamp = message.timestamp;
		message.content.forEach((block, i) => {
			switch (block.type) {
				case "text":
					if (block.text.trim() === "") return;
					this.#visible({
						kind: "text",
						key: this.#key(`${stamp}:${i}`),
						text: block.text,
						streaming: pending,
						gutter: this.#gutter(),
						title,
					});
					return;
				case "toolCall":
					this.#member({ kind: "tool", key: this.#key(block.id), call: block, pending });
					return;
				case "thinking":
				case "redactedThinking":
					this.#member({ kind: "thinking", key: this.#key(`${stamp}:${i}`), block });
					return;
				default:
					return;
			}
		});
		const stop = message.stopReason;
		if (!pending && (stop === "error" || stop === "aborted")) {
			this.#visible({ kind: "stop", key: this.#key(`${stamp}:stop`), message, gutter: this.#gutter(), title });
		}
	}

	tails(tools: readonly ActiveTool[]): void {
		for (const tool of tools) this.#member({ kind: "tail", key: this.#key(tool.toolCallId), tool });
	}
}

/** Flatten committed entries into render items; memoize per visible window. */
export function flattenEntries(entries: readonly SessionEntry[]): TranscriptItems {
	const builder = new ItemBuilder();
	for (const entry of entries) builder.entry(entry);
	return builder;
}

/**
 * Append the streaming message and live tools on top of memoized committed
 * items. Leading non-text blocks extend the trailing committed group.
 */
export function appendLive(base: TranscriptItems, live: LiveTail): TranscriptItems {
	if (live.stream === null && live.tailTools.length === 0) return base;
	const builder = new ItemBuilder(base);
	if (live.stream !== null) builder.assistant(live.stream, live.pending);
	builder.tails(live.tailTools);
	return builder;
}

/** Committed entries plus the live tail, in render order. */
export function buildTranscriptItems(entries: readonly SessionEntry[], live: LiveTail): readonly TranscriptItem[] {
	return appendLive(flattenEntries(entries), live).items;
}
