import type { AssistantMessage, ImageContent, SessionEntry, TextContent, ToolResultMessage } from "@oh-my-pi/pi-wire";
import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ActiveTool, ConnectionPhase } from "../../lib/client";
import { fmtTokens } from "../../lib/format";
import type { ToolRenderHost } from "../../tool-render";
import { ActivityGroup } from "./ActivityGroup";
import { appendLive, flattenEntries } from "./items";
import { Markdown, StreamingMarkdown } from "./Markdown";
import { followTranscriptTail, updateTranscriptTailLock } from "./tail-lock";
import "./transcript.css";

export interface TranscriptProps {
	entries: readonly SessionEntry[];
	stream: AssistantMessage | null;
	streamDone: boolean;
	activeTools: ReadonlyMap<string, ActiveTool>;
	working: boolean;
	compact?: boolean; // dense variant for the agent drawer
	/** Sub-session drill-down capabilities forwarded to tool renderers. */
	host?: ToolRenderHost;
	/** Main connection phase; absent for the agent drawer's compact transcript. */
	phase?: ConnectionPhase;
}

function Row({
	kind,
	gutter,
	title,
	children,
}: {
	kind: "user" | "assistant" | "custom" | "marker";
	gutter: ReactNode;
	title?: string;
	children: ReactNode;
}): ReactNode {
	return (
		<div className={`tr-row tr-row--${kind}`}>
			<div className="tr-gutter" title={title}>
				{gutter}
			</div>
			<div className="tr-body">{children}</div>
		</div>
	);
}

/** Markdown + image thumbnails for user / custom message content. */
function MsgContent({ content }: { content: string | readonly (TextContent | ImageContent)[] }): ReactNode {
	if (typeof content === "string") return <Markdown text={content} />;
	return (
		<>
			{content.map((block, i) => {
				switch (block.type) {
					case "text":
						return <Markdown key={i} text={block.text} />;
					case "image":
						return (
							<img
								key={i}
								className="tr-msg-img"
								src={`data:${block.mimeType};base64,${block.data}`}
								alt="attachment"
							/>
						);
					default:
						return null;
				}
			})}
		</>
	);
}

/** Local HH:MM of an ISO timestamp or epoch ms; undefined when unparseable. */
function clockTime(at: string | number): string | undefined {
	const date = new Date(at);
	if (Number.isNaN(date.getTime())) return undefined;
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** A prompt turn: raised, accent-barred card with a sender · time meta line. */
function PromptRow({
	sender,
	timestamp,
	content,
}: {
	sender: string;
	timestamp: string;
	content: string | readonly (TextContent | ImageContent)[];
}): ReactNode {
	const time = clockTime(timestamp);
	return (
		<Row kind="user" gutter={<ChevronRight size={13} aria-hidden="true" />} title={timestamp}>
			<div className="tr-meta">
				<span className="tr-meta-who">{sender}</span>
				{time !== undefined && <span className="tr-meta-time">{time}</span>}
			</div>
			<MsgContent content={content} />
		</Row>
	);
}

/** Non-agent entries: prompts, displayed custom messages, dividers and markers. */
const EntryItem = memo(function EntryItem({ entry }: { entry: SessionEntry }): ReactNode {
	switch (entry.type) {
		case "message":
			return entry.message.role === "user" ? (
				<PromptRow sender="host" timestamp={entry.timestamp} content={entry.message.content} />
			) : null;
		case "custom_message": {
			if (entry.customType === "collab-prompt") {
				const details = entry.details;
				const from =
					details !== null &&
					typeof details === "object" &&
					typeof (details as Record<string, unknown>).from === "string"
						? ((details as Record<string, unknown>).from as string)
						: "guest";
				return <PromptRow sender={from} timestamp={entry.timestamp} content={entry.content} />;
			}
			return (
				<Row kind="custom" gutter="" title={entry.timestamp}>
					<div className="tr-custom">
						<span className="tr-chip">{entry.customType}</span>
						<MsgContent content={entry.content} />
					</div>
				</Row>
			);
		}
		case "compaction":
			return (
				<div className="tr-divider" title={entry.shortSummary ?? entry.summary}>
					<span>context compacted · {fmtTokens(entry.tokensBefore)} tokens</span>
				</div>
			);
		case "branch_summary":
			return (
				<div className="tr-divider" title={entry.summary}>
					<span>branch summary</span>
				</div>
			);
		case "model_change":
			return (
				<Row kind="marker" gutter="" title={entry.timestamp}>
					<span className="tr-marker">model → {entry.model}</span>
				</Row>
			);
		case "thinking_level_change":
			return (
				<Row kind="marker" gutter="" title={entry.timestamp}>
					<span className="tr-marker">thinking → {entry.thinkingLevel ?? "off"}</span>
				</Row>
			);
		default:
			return null;
	}
});

/** One agent text block as a prose item, under the same meta line as prompts. */
const AgentText = memo(function AgentText({
	text,
	streaming,
	gutter,
	time,
	title,
}: {
	text: string;
	streaming: boolean;
	gutter: boolean;
	time: number;
	title?: string;
}): ReactNode {
	const clock = clockTime(time);
	return (
		<Row kind="assistant" gutter={gutter ? "agent" : ""} title={title}>
			<div className="tr-say">
				{clock !== undefined && (
					<div className="tr-meta">
						<span className="tr-meta-who tr-meta-who--agent">agent</span>
						<span className="tr-meta-time">{clock}</span>
					</div>
				)}
				{streaming ? <StreamingMarkdown text={text} /> : <Markdown text={text} />}
			</div>
		</Row>
	);
});

/** Error/aborted chip after a finished assistant message's blocks. */
const StopChip = memo(function StopChip({
	message,
	gutter,
	title,
}: {
	message: AssistantMessage;
	gutter: boolean;
	title?: string;
}): ReactNode {
	const stop = message.stopReason;
	return (
		<Row kind="assistant" gutter={gutter ? "agent" : ""} title={title}>
			<div className="tr-stop">
				<span className={`tr-chip ${stop === "error" ? "tr-chip--err" : "tr-chip--warn"}`}>{stop}</span>
				{message.errorMessage !== undefined && message.errorMessage.length > 0 && (
					<span className="tr-stop-msg">{message.errorMessage}</span>
				)}
			</div>
		</Row>
	);
});

/**
 * Rows mounted at the tail. Large sessions carry thousands of entries; mounting
 * all of them makes every streamed token re-reconcile and re-lay-out the whole
 * transcript. Older rows mount a window at a time from the top.
 */
const WINDOW = 100;
/** Distance from the top (px) at which scrolling up mounts the previous window. */
const EARLIER_TRIGGER_PX = 200;

export function Transcript(props: TranscriptProps): ReactNode {
	const { entries, stream, streamDone, activeTools, working, compact, host, phase } = props;

	// null follows the tail. A number pins the first mounted entry while the
	// reader is scrolled away from the bottom, so appended entries never
	// unmount rows above the reader and shift the page under them.
	const [pinnedStart, setPinnedStart] = useState<number | null>(null);
	const tailStart = Math.max(0, entries.length - WINDOW);
	const start = pinnedStart === null ? tailStart : Math.min(pinnedStart, tailStart);
	const visible = useMemo(() => entries.slice(start), [entries, start]);

	// A tool result always follows its call, so visible rows only pair with visible results.
	const results = useMemo(() => {
		const map = new Map<string, ToolResultMessage>();
		for (const entry of visible) {
			if (entry.type === "message" && entry.message.role === "toolResult") {
				map.set(entry.message.toolCallId, entry.message);
			}
		}
		return map;
	}, [visible]);

	const rootRef = useRef<HTMLDivElement | null>(null);
	const lockRef = useRef(true);
	/**
	 * First visible row and its offset from the viewport top, captured before
	 * mounting earlier rows. Restoring against the row, not the total height
	 * delta, stays exact when the same commit also appends live entries.
	 */
	const prependRef = useRef<{ anchor: Element; offset: number } | null>(null);

	// Follow the tail while bottom-locked; releasing/re-arming happens in onScroll.
	useEffect(() => {
		const el = rootRef.current;
		if (el !== null) followTranscriptTail(el, lockRef);
	}, [entries, stream, activeTools, working]);

	// A `live` transition (initial connect or reconnect) jumps to the latest message
	// regardless of the prior scroll position. Absent for the agent drawer's compact transcript.
	useEffect(() => {
		const el = rootRef.current;
		if (phase !== "live" || el === null) return;
		setPinnedStart(null);
		followTranscriptTail(el, lockRef, true);
	}, [phase]);

	// Keep the reader's content in place when earlier rows mount above it.
	useLayoutEffect(() => {
		const el = rootRef.current;
		const before = prependRef.current;
		if (el === null || before === null) return;
		prependRef.current = null;
		if (!before.anchor.isConnected) return;
		el.scrollTop += before.anchor.getBoundingClientRect().top - el.getBoundingClientRect().top - before.offset;
	}, [start]);

	const showEarlier = (): void => {
		const el = rootRef.current;
		if (el === null || start === 0 || prependRef.current !== null) return;
		const top = el.getBoundingClientRect().top;
		for (const row of el.children) {
			if (row.classList.contains("tr-earlier")) continue;
			const rect = row.getBoundingClientRect();
			if (rect.bottom <= top) continue;
			prependRef.current = { anchor: row, offset: rect.top - top };
			break;
		}
		setPinnedStart(Math.max(0, start - WINDOW));
	};

	// Tool calls committed anywhere in the session: rescanned when entries change,
	// not per streaming token or tool output update.
	const committedToolIds = useMemo(() => {
		const ids = new Set<string>();
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			for (const block of entry.message.content) {
				if (block.type === "toolCall") ids.add(block.id);
			}
		}
		return ids;
	}, [entries]);

	// Active tools not already represented as toolCall blocks in committed rows or the stream ghost.
	const tailTools = useMemo(() => {
		const tail: ActiveTool[] = [];
		for (const tool of activeTools.values()) {
			if (committedToolIds.has(tool.toolCallId)) continue;
			if (stream?.content.some(block => block.type === "toolCall" && block.id === tool.toolCallId)) continue;
			tail.push(tool);
		}
		return tail;
	}, [committedToolIds, stream, activeTools]);

	// Committed items re-flatten only when the window changes; the live tail merges on top per token.
	const committedItems = useMemo(() => flattenEntries(visible), [visible]);
	const items = useMemo(
		() => appendLive(committedItems, { stream, pending: !streamDone, tailTools }).items,
		[committedItems, stream, streamDone, tailTools],
	);
	// Auto mode peeks only at a group nothing visible follows yet (an error/aborted chip doesn't
	// count, so a failed turn keeps its last steps open); agent text, prompts or markers collapse it.
	const trailingGroup = useMemo(() => {
		let i = items.length - 1;
		while (i >= 0 && items[i].kind === "stop") i--;
		return i >= 0 && items[i].kind === "group" ? i : -1;
	}, [items]);

	// While the snapshot downloads the banner reports progress; an empty transcript isn't "no activity".
	const settled = phase === undefined || phase === "live";

	return (
		<div
			ref={rootRef}
			className={`tr-root${compact === true ? " tr-root--compact" : ""}`}
			onScroll={() => {
				const el = rootRef.current;
				if (el === null) return;
				updateTranscriptTailLock(el, lockRef);
				// Back at the bottom: drop the pin so the window trims to the tail again.
				if (lockRef.current) {
					if (pinnedStart !== null) setPinnedStart(null);
				} else if (pinnedStart === null) {
					setPinnedStart(start);
				}
				if (el.scrollTop <= EARLIER_TRIGGER_PX) showEarlier();
			}}
		>
			{settled && entries.length === 0 && stream === null && !working && (
				<div className="tr-empty">no activity yet</div>
			)}
			{start > 0 && (
				<button type="button" className="tr-earlier" onClick={showEarlier}>
					show {start.toLocaleString("en-US")} earlier
				</button>
			)}
			{items.map((item, index) => {
				switch (item.kind) {
					case "entry":
						return <EntryItem key={item.key} entry={item.entry} />;
					case "text":
						return (
							<AgentText
								key={item.key}
								text={item.text}
								streaming={item.streaming}
								gutter={item.gutter}
								time={item.time}
								title={item.title}
							/>
						);
					case "stop":
						return <StopChip key={item.key} message={item.message} gutter={item.gutter} title={item.title} />;
					case "group":
						return (
							<Row key={item.key} kind="assistant" gutter={item.gutter ? "agent" : ""}>
								<ActivityGroup
									members={item.members}
									results={results}
									active={activeTools}
									host={host}
									trailing={index === trailingGroup}
								/>
							</Row>
						);
				}
			})}
			{working && stream === null && activeTools.size === 0 && (
				<Row kind="assistant" gutter="agent">
					<div className="tr-shimmer">thinking…</div>
				</Row>
			)}
		</div>
	);
}
