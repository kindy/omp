import type { AssistantMessage, ToolResultMessage } from "@oh-my-pi/pi-wire";
import { ChevronRight, Eye, FoldVertical, LoaderCircle, TriangleAlert, UnfoldVertical, Wrench } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { fmtDuration } from "../../lib/format";
import type { ActiveTool } from "../../lib/client";
import type { ToolRenderHost } from "../../tool-render";
import type { ActivityMember } from "./items";
import { ToolCard } from "./ToolCard";
import { followTranscriptTail, updateTranscriptTailLock } from "./tail-lock";

type GroupMode = "all" | "cap" | "hide";
/** "auto" follows recency (newest group capped, older ones hidden); the rest are reader pins. */
type GroupPref = "auto" | GroupMode;

/** Icon-only segmented control: fixed button widths so the control never shifts on click; labels live in tooltips and aria-labels. */
const MODES: readonly { mode: GroupMode; label: string; title: string; icon: ReactNode }[] = [
	{ mode: "all", label: "Expand", title: "Expand: show every step", icon: <UnfoldVertical size={12} /> },
	{
		mode: "cap",
		label: "Peek",
		title: "Peek: a short scrolling view that follows the latest step",
		icon: <Eye size={12} />,
	},
	{ mode: "hide", label: "Collapse", title: "Collapse: show only the summary", icon: <FoldVertical size={12} /> },
];

export interface ActivityGroupProps {
	members: readonly ActivityMember[];
	results: ReadonlyMap<string, ToolResultMessage>;
	active: ReadonlyMap<string, ActiveTool>;
	host?: ToolRenderHost;
	/**
	 * Nothing visible follows this group except an error/aborted chip: the agent is still on it
	 * (or the turn ended inside it). In auto it peeks; otherwise it collapses.
	 */
	trailing: boolean;
}

function ThinkingBlock({ text, redacted }: { text: string; redacted?: boolean }): ReactNode {
	const [open, setOpen] = useState(false);
	return (
		<div className="tr-think">
			<button type="button" className="tr-think-head" onClick={() => setOpen(v => !v)}>
				<ChevronRight size={11} className={`tr-chev${open ? " tr-chev--open" : ""}`} />
				thinking{redacted ? " · redacted" : ""}
			</button>
			{open && <div className="tr-think-body">{redacted ? "(redacted by provider)" : text}</div>}
		</div>
	);
}

/**
 * Re-render only when a member block or one of its tool pairings changed.
 * Members are rebuilt whenever committed entries are re-flattened, so compare
 * the blocks they carry, not the member objects.
 */
function activityGroupEqual(prev: ActivityGroupProps, next: ActivityGroupProps): boolean {
	if (prev.host !== next.host || prev.trailing !== next.trailing || prev.members.length !== next.members.length) {
		return false;
	}
	for (let i = 0; i < next.members.length; i++) {
		const a = prev.members[i];
		const b = next.members[i];
		switch (b.kind) {
			case "tool": {
				if (a.kind !== "tool" || a.call !== b.call || a.pending !== b.pending) return false;
				const id = b.call.id;
				if (prev.results.get(id) !== next.results.get(id) || prev.active.get(id) !== next.active.get(id)) {
					return false;
				}
				break;
			}
			case "tail":
				if (a.kind !== "tail" || a.tool !== b.tool) return false;
				break;
			case "thinking":
				// Streamed messages carry fresh block objects per token; the collapsed text is what renders.
				if (a.kind !== "thinking" || a.block.type !== b.block.type) return false;
				if (a.block.type === "thinking" && b.block.type === "thinking" && a.block.thinking !== b.block.thinking) {
					return false;
				}
				break;
		}
	}
	return true;
}

/** A run of consecutive tool calls and thinking blocks, under a summary bar with a height mode. */
export const ActivityGroup = memo(function ActivityGroup({
	members,
	results,
	active,
	host,
	trailing,
}: ActivityGroupProps): ReactNode {
	const [pref, setPref] = useState<GroupPref>("auto");
	const mode: GroupMode = pref === "auto" ? (trailing ? "cap" : "hide") : pref;
	const bodyRef = useRef<HTMLDivElement | null>(null);
	const lockRef = useRef(true);

	/** Explicit choice from the bar; re-arms tail-follow for the (re)opened body. */
	const choose = (next: GroupPref): void => {
		lockRef.current = true;
		setPref(next);
	};

	// Renders happen only when members or their pairings change: follow the newest step while locked.
	useLayoutEffect(() => {
		const el = bodyRef.current;
		if (mode === "cap" && el !== null) followTranscriptTail(el, lockRef);
	});

	// Wall time: first LLM call start → latest known event (message start or tool result).
	// LLM calls: distinct source messages (each assistant message is one call).
	let first = Number.POSITIVE_INFINITY;
	let last = Number.NEGATIVE_INFINITY;
	const calls = new Set<AssistantMessage>();
	const see = (at: number): void => {
		if (!Number.isFinite(at)) return;
		if (at < first) first = at;
		if (at > last) last = at;
	};
	for (const member of members) {
		if (member.kind === "tail") {
			see(member.tool.startedAt);
			continue;
		}
		calls.add(member.message);
		see(member.message.timestamp);
		if (member.kind === "tool") {
			const result = results.get(member.call.id);
			if (result !== undefined) see(result.timestamp);
		}
	}

	let tools = 0;
	let thinking = 0;
	let errors = 0;
	let running = false;
	let runningIntent: string | undefined;
	const body = members.map(member => {
		switch (member.kind) {
			case "thinking":
				thinking++;
				return member.block.type === "thinking" ? (
					<ThinkingBlock key={member.key} text={member.block.thinking} />
				) : (
					<ThinkingBlock key={member.key} text="" redacted />
				);
			case "tail": {
				const tool = member.tool;
				tools++;
				running = true;
				runningIntent = tool.intent;
				return (
					<ToolCard
						key={member.key}
						toolCallId={tool.toolCallId}
						name={tool.toolName}
						intent={tool.intent}
						args={tool.args}
						running
						partialResult={tool.partialResult}
						host={host}
					/>
				);
			}
			case "tool": {
				const call = member.call;
				const act = active.get(call.id);
				const result = results.get(call.id);
				const isRunning = !result && (act !== undefined || member.pending);
				const intent = call.intent ?? act?.intent;
				tools++;
				if (result?.isError === true) errors++;
				if (isRunning) {
					running = true;
					runningIntent = intent;
				}
				return (
					<ToolCard
						key={member.key}
						toolCallId={call.id}
						name={call.name}
						intent={intent}
						args={act?.args ?? call.arguments}
						result={result}
						host={host}
						running={isRunning}
						partialResult={act?.partialResult}
					/>
				);
			}
		}
	});
	// A running group's clock keeps ticking; memo equality alone would freeze it.
	const [now, setNow] = useState(Date.now);
	useEffect(() => {
		if (!running) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [running]);
	const end = running ? Math.max(last, now) : last;
	const elapsed = Number.isFinite(first) && end > first ? end - first : undefined;

	const summary = [
		tools > 0 ? `${tools} ${tools === 1 ? "tool" : "tools"}` : "",
		thinking > 0 ? `${thinking} thinking` : "",
		calls.size > 0 ? `${calls.size} llm` : "",
	]
		.filter(part => part !== "")
		.join(" · ");

	return (
		<div className={`tr-act tr-act--${mode}`}>
			<div className="tr-act-bar">
				<button
					type="button"
					className="tr-act-toggle"
					aria-expanded={mode !== "hide"}
					title={mode === "hide" ? "Show steps" : "Collapse to the summary bar"}
					onClick={() => choose(mode === "hide" ? "cap" : "hide")}
				>
					{elapsed !== undefined && (
						<span className="tr-act-time" title="Wall time from the first LLM call to the latest step">
							{fmtDuration(elapsed)}
						</span>
					)}
					<Wrench size={12} className="tr-act-icon" aria-hidden="true" />
					<span
						className="tr-act-summary"
						title={calls.size > 0 ? `${calls.size} ${calls.size === 1 ? "LLM call" : "LLM calls"}` : undefined}
					>
						{summary}
					</span>
					{running && <LoaderCircle size={12} className="tr-act-spin" aria-hidden="true" />}
					{running && runningIntent !== undefined && <span className="tr-act-now">{runningIntent}</span>}
					{errors > 0 && (
						<span className="tr-act-err" title={`${errors} failed`}>
							<TriangleAlert size={11} aria-hidden="true" />
							{errors}
						</span>
					)}
				</button>
				<div
					className="tr-act-modes"
					role="group"
					aria-label="Step view"
					title="Auto: peek at the newest group, collapse older ones"
				>
					{MODES.map(option => {
						const pressed = mode === option.mode;
						const pinned = pref === option.mode;
						const auto = pressed && pref === "auto";
						return (
							<button
								key={option.mode}
								type="button"
								className={auto ? "tr-act-mode tr-act-mode--auto" : "tr-act-mode"}
								aria-pressed={pressed}
								aria-label={option.label}
								title={
									pinned
										? `${option.title} · click again to go back to auto`
										: auto
											? `${option.title} · auto`
											: option.title
								}
								onClick={() => choose(pinned ? "auto" : option.mode)}
							>
								{option.icon}
							</button>
						);
					})}
				</div>
			</div>
			{mode !== "hide" && (
				<div
					ref={bodyRef}
					className="tr-act-body"
					// Engaging with a step pins the current mode so the group never auto-collapses under
					// the reader: clicking (expanding a card or thinking), or scrolling up off the tail.
					onClick={() => {
						if (pref === "auto") setPref(mode);
					}}
					onScroll={() => {
						const el = bodyRef.current;
						if (el === null || mode !== "cap") return;
						updateTranscriptTailLock(el, lockRef);
						if (!lockRef.current && pref === "auto") setPref("cap");
					}}
				>
					{body}
				</div>
			)}
		</div>
	);
}, activityGroupEqual);
