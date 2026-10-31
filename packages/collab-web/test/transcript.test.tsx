import { describe, expect, it } from "bun:test";
import type { AssistantMessage, SessionEntry } from "@oh-my-pi/pi-wire";
import { renderToStaticMarkup } from "react-dom/server";
import "./transcript-dom-shim";
import { followTranscriptTail, updateTranscriptTailLock } from "../src/components/transcript/tail-lock";
import { Transcript } from "../src/components/transcript/Transcript";
import type { ActiveTool } from "../src/lib/client";

const TOOL_CALL_ID = "call-running-tool";
const TOOL_NAME = "probe_tool";

const RAW_ASSISTANT_TARGET = "stale-raw-assistant-target";
const ACTIVE_TOOL_TARGET = "effective-active-tool-target";

function assistantUsage(): AssistantMessage["usage"] {
	return { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0 } };
}

function committedAssistantToolCall(): SessionEntry {
	return {
		type: "message",
		id: "assistant-entry-1",
		parentId: null,
		timestamp: "2026-07-09T00:00:00Z",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "I will run the tool." },
				{
					type: "toolCall",
					id: TOOL_CALL_ID,
					name: TOOL_NAME,
					arguments: { target: RAW_ASSISTANT_TARGET },
					intent: "Inspect fixture input",
				},
			],
			model: "test/model",
			usage: assistantUsage(),
			stopReason: "stop",
			timestamp: 1,
		},
	};
}

function activeTool(): ActiveTool {
	return {
		toolCallId: TOOL_CALL_ID,
		toolName: TOOL_NAME,
		args: { target: ACTIVE_TOOL_TARGET },
		intent: "Inspect fixture input",
		startedAt: 1,
	};
}

function renderTranscript(props: {
	entries?: readonly SessionEntry[];
	activeTools?: ReadonlyMap<string, ActiveTool>;
	stream?: AssistantMessage;
	working: boolean;
}): string {
	return renderToStaticMarkup(
		<Transcript
			entries={props.entries ?? []}
			stream={props.stream ?? null}
			streamDone={props.stream === undefined}
			activeTools={props.activeTools ?? new Map()}
			working={props.working}
		/>,
	);
}

function countElements(html: string, selector: string): number {
	let count = 0;
	new HTMLRewriter()
		.on(selector, {
			element() {
				count++;
			},
		})
		.transform(html);
	return count;
}

function countOccurrences(text: string, needle: string): number {
	let count = 0;
	let start = 0;
	while (true) {
		const index = text.indexOf(needle, start);
		if (index === -1) return count;
		count++;
		start = index + needle.length;
	}
}

describe("Transcript live tool rendering", () => {
	it("renders one running card for a committed tool call using active args without the working shimmer", () => {
		const html = renderTranscript({
			entries: [committedAssistantToolCall()],
			activeTools: new Map([[TOOL_CALL_ID, activeTool()]]),
			working: true,
		});

		expect(countElements(html, ".tv-card")).toBe(1);
		expect(countElements(html, '[aria-label="running"]')).toBe(1);
		expect(countOccurrences(html, TOOL_NAME)).toBe(1);
		expect(html).not.toContain("thinking…");
		expect(html).toContain(ACTIVE_TOOL_TARGET);
		expect(html).not.toContain(RAW_ASSISTANT_TARGET);
	});

	it("keeps the working shimmer when no tool is active", () => {
		const html = renderTranscript({ working: true, activeTools: new Map() });

		expect(html).toContain("thinking…");
	});
});

describe("Transcript message Markdown", () => {
	it("renders host strings and guest text blocks as Markdown", () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "host-markdown",
				parentId: null,
				timestamp: "2026-07-15T00:00:00Z",
				message: {
					role: "user",
					content: "Use `381866285601915778`",
					timestamp: 1,
				},
			},
			{
				type: "custom_message",
				id: "guest-markdown",
				parentId: "host-markdown",
				timestamp: "2026-07-15T00:00:01Z",
				customType: "collab-prompt",
				content: [{ type: "text", text: "Guest uses **Markdown**" }],
				details: { from: "guest" },
				display: true,
			},
		];

		const html = renderTranscript({ entries, working: false });

		expect(countElements(html, ".tr-row--user .tr-md code")).toBe(1);
		expect(countElements(html, ".tr-row--user .tr-md strong")).toBe(1);
	});
});

describe("Transcript tail-follow scroll operations", () => {
	it("restores tail-follow when a connection becomes live", () => {
		const element = { scrollTop: 0, scrollHeight: 1_000, clientHeight: 200 };
		const lock = { current: false };

		followTranscriptTail(element, lock, true);
		expect(lock.current).toBe(true);
		expect(element.scrollTop).toBe(1_000);

		element.scrollTop = 600;
		updateTranscriptTailLock(element, lock);
		expect(lock.current).toBe(false);

		element.scrollHeight = 1_200;
		followTranscriptTail(element, lock);
		expect(element.scrollTop).toBe(600);

		followTranscriptTail(element, lock, true);
		expect(lock.current).toBe(true);
		expect(element.scrollTop).toBe(1_200);
	});
});

describe("Transcript windowing", () => {
	it("mounts only the newest 100 entries and offers the rest", () => {
		const entries: SessionEntry[] = Array.from({ length: 250 }, (_, i) => ({
			type: "message",
			id: `m${i}`,
			parentId: i === 0 ? null : `m${i - 1}`,
			timestamp: "2026-07-15T00:00:00Z",
			message: { role: "user", content: `message-${i}-end`, timestamp: i },
		}));

		const html = renderTranscript({ entries, working: false });

		expect(countElements(html, ".tr-row--user")).toBe(100);
		expect(html).toContain("message-249-end");
		expect(html).toContain("message-150-end");
		expect(html).not.toContain("message-149-end");
		expect(html).toContain("show 150 earlier");
	});
});

function assistantMessage(content: AssistantMessage["content"], timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content,
		model: "test/model",
		usage: assistantUsage(),
		stopReason: "toolUse",
		timestamp,
	};
}

function assistantEntry(id: string, content: AssistantMessage["content"], timestamp: number): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-07-20T00:00:00Z",
		message: assistantMessage(content, timestamp),
	};
}

function toolCall(id: string): AssistantMessage["content"][number] {
	return { type: "toolCall", id, name: TOOL_NAME, arguments: { target: id } };
}

function toolResultEntry(callId: string): SessionEntry {
	return {
		type: "message",
		id: `result-${callId}`,
		parentId: null,
		timestamp: "2026-07-20T00:00:00Z",
		message: {
			role: "toolResult",
			toolCallId: callId,
			toolName: TOOL_NAME,
			content: [{ type: "text", text: `output of ${callId}` }],
			isError: false,
			timestamp: 0,
		},
	};
}

describe("Transcript activity groups", () => {
	// Regression: each assistant entry (or the toolResult between them) opening its own tool block.
	it("merges tool-only assistant entries across tool results into one group", () => {
		const entries = [
			assistantEntry("a1", [toolCall("c1")], 1),
			toolResultEntry("c1"),
			assistantEntry("a2", [toolCall("c2")], 2),
			toolResultEntry("c2"),
		];

		const html = renderTranscript({ entries, working: false });

		expect(countElements(html, ".tr-act")).toBe(1);
		expect(countElements(html, ".tr-act .tv-card")).toBe(2);
		expect(countElements(html, ".tv-card")).toBe(2);
	});

	// Regression: agent prose swallowed into an activity group, or tool runs around it merged.
	it("splits tool runs at agent text and renders the text outside any group", () => {
		const entries = [
			assistantEntry("a1", [toolCall("c1")], 1),
			toolResultEntry("c1"),
			assistantEntry("a2", [{ type: "text", text: "Found **it**" }, toolCall("c2")], 2),
			toolResultEntry("c2"),
		];

		const html = renderTranscript({ entries, working: false });

		expect(countElements(html, ".tr-act")).toBe(2);
		// The older group auto-collapses, so only the newest group's card mounts.
		expect(countElements(html, ".tr-act .tv-card")).toBe(1);
		expect(countElements(html, ".tr-say strong")).toBe(1);
		expect(countElements(html, ".tr-act strong")).toBe(0);
	});

	// Regression: older groups staying open (or the newest collapsing) in auto mode.
	it("auto-collapses older groups and keeps the newest group capped", () => {
		const entries = [
			assistantEntry("a1", [toolCall("older-call")], 1),
			toolResultEntry("older-call"),
			assistantEntry("a2", [{ type: "text", text: "Next step" }, toolCall("newest-call")], 2),
			toolResultEntry("newest-call"),
		];

		const html = renderTranscript({ entries, working: false });

		expect(countElements(html, ".tr-act--hide")).toBe(1);
		expect(countElements(html, ".tr-act--hide .tr-act-body")).toBe(0);
		expect(countElements(html, ".tr-act--cap")).toBe(1);
		expect(countElements(html, ".tr-act--cap .tv-card")).toBe(1);
		expect(html.indexOf("tr-act--hide")).toBeLessThan(html.indexOf("tr-act--cap"));
		expect(html).toContain("newest-call");
		expect(html).not.toContain("older-call");
	});

	// Regression: a finished turn's last group staying open above the agent's reply.
	it("collapses the last group once agent text follows it", () => {
		const entries = [
			assistantEntry("a1", [toolCall("done-call")], 1),
			toolResultEntry("done-call"),
			assistantEntry("a2", [{ type: "text", text: "All done" }], 2),
		];

		const html = renderTranscript({ entries, working: false });

		expect(countElements(html, ".tr-act--hide")).toBe(1);
		expect(countElements(html, ".tr-act--cap")).toBe(0);
		expect(html).not.toContain("done-call");
	});

	// Regression: a failed turn hiding the steps that led to the error.
	it("keeps the last group peeking when only an error chip follows it", () => {
		const failed: SessionEntry = {
			type: "message",
			id: "a1",
			parentId: null,
			timestamp: "2026-07-20T00:00:00Z",
			message: { ...assistantMessage([toolCall("failed-call")], 1), stopReason: "error", errorMessage: "boom" },
		};

		const html = renderTranscript({ entries: [failed], working: false });

		expect(countElements(html, ".tr-act--cap .tv-card")).toBe(1);
		expect(countElements(html, ".tr-stop .tr-chip--err")).toBe(1);
	});

	// Regression: live calls opening a second group next to the committed run they continue.
	it("extends the trailing committed group with streaming calls and live tail tools", () => {
		const entries = [assistantEntry("a1", [toolCall("c1")], 1), toolResultEntry("c1")];
		const stream = assistantMessage([toolCall("c2")], 2);

		const streamed = renderTranscript({ entries, stream, working: true });
		expect(countElements(streamed, ".tr-act")).toBe(1);
		expect(countElements(streamed, ".tr-act .tv-card")).toBe(2);

		const tail = renderTranscript({
			entries,
			activeTools: new Map([[TOOL_CALL_ID, activeTool()]]),
			working: true,
		});
		expect(countElements(tail, ".tr-act")).toBe(1);
		expect(countElements(tail, ".tr-act .tv-card")).toBe(2);
	});
});
