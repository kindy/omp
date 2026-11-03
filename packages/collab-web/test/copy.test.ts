import { describe, expect, it } from "bun:test";
import type { AssistantMessage, SessionEntry } from "@oh-my-pi/pi-wire";
import { turnMarkdown } from "../src/components/transcript/copy";
import { buildTranscriptItems } from "../src/components/transcript/items";

let seq = 0;
function prompt(text: string, from?: string): SessionEntry {
	seq++;
	return from === undefined
		? ({
				type: "message",
				id: `u${seq}`,
				timestamp: new Date(seq * 1000).toISOString(),
				message: {
					role: "user",
					content: [
						{ type: "text", text },
						{ type: "image", data: "", mimeType: "image/png" },
					],
				},
			} as unknown as SessionEntry)
		: ({
				type: "custom_message",
				id: `c${seq}`,
				timestamp: new Date(seq * 1000).toISOString(),
				customType: "collab-prompt",
				content: text,
				display: true,
				details: { from },
			} as unknown as SessionEntry);
}
function agent(...content: AssistantMessage["content"]): SessionEntry {
	seq++;
	return {
		type: "message",
		id: `a${seq}`,
		timestamp: new Date(seq * 1000).toISOString(),
		message: { role: "assistant", content, timestamp: seq * 1000, stopReason: "stop" },
	} as unknown as SessionEntry;
}
const text = (t: string) => ({ type: "text", text: t }) as const;
const tool = (id: string) => ({ type: "toolCall", id, name: "read", arguments: {} }) as const;

const entries = [
	agent(text("orphan reply before any prompt")),
	prompt("first question"),
	agent(text("part one"), tool("t1")),
	agent(text("part two")),
	prompt("second question", "alice"),
	agent(text("answer two")),
];
const items = buildTranscriptItems(entries, { stream: null, pending: false, tailTools: [] });
const keyOf = (needle: string) =>
	items.find(
		i => (i.kind === "text" && i.text === needle) || (i.kind === "entry" && JSON.stringify(i.entry).includes(needle)),
	)!.key;

describe("turnMarkdown", () => {
	it("copies the prompt and every agent reply up to the next prompt, skipping tool calls", () => {
		const expected = "**host**\n\nfirst question\n\n[image]\n\n**agent**\n\npart one\n\npart two";
		// Same turn from the prompt and from a later reply in it.
		expect(turnMarkdown(items, keyOf("first question"))).toBe(expected);
		expect(turnMarkdown(items, keyOf("part two"))).toBe(expected);
	});

	it("labels guest prompts with their sender and stops at the transcript end", () => {
		expect(turnMarkdown(items, keyOf("answer two"))).toBe("**alice**\n\nsecond question\n\n**agent**\n\nanswer two");
	});

	it("starts at the first item when the prompt is not mounted", () => {
		expect(turnMarkdown(items, keyOf("orphan reply before any prompt"))).toBe(
			"**agent**\n\norphan reply before any prompt",
		);
	});

	it("returns empty for an unknown key", () => {
		expect(turnMarkdown(items, "missing")).toBe("");
	});
});
