import type { IconName } from "@intentic-app/ui";
import type { ToolCallContent } from "@intentic/sandbox-contract";
import type { ChatTool } from "../composables/chat/conversation";
import { diffStat } from "./chatToolDiff";

/* How one tool call renders — the single table the chat's tool cards consult, so per-tool knowledge lives in
 * data rather than in branches scattered through ChatToolCard.vue. A presenter is looked up by the tool's
 * DISPLAY NAME (case-insensitive, the name the daemon already normalized across backends in
 * agent/tool-calls.ts); anything unknown falls back to its ACP category, so an MCP tool or a brand-new
 * provider tool still gets a sane icon and a plain-text body instead of nothing.
 *
 * Deliberately pure and synchronous: `present()` takes a ChatTool and returns everything the card renders, so
 * the whole taxonomy is unit-testable without mounting a component. */

// A tool's textual output, shaped for the renderer that fits it. `text` is the fallback every tool can use;
// `files` turns a path listing into clickable rows; `command` splits a shell invocation from its output.
export type ToolBody =
    | { readonly kind: "text"; readonly text: string }
    | { readonly kind: "files"; readonly entries: readonly ToolFileEntry[]; readonly hidden: number }
    | { readonly kind: "command"; readonly command: string; readonly output: string };

// One row of a `files` body: a workspace path and, when the line carried one, the 1-based line it matched at.
export interface ToolFileEntry {
    readonly path: string;
    readonly line?: number;
}

export interface ToolPresentation {
    readonly icon: IconName;
    // The structured diffs to render above the body (Edit/Write and any ACP agent that sends them ready-made).
    readonly diffs: readonly Extract<ToolCallContent, { type: "diff" }>[];
    // Undefined when the call produced no text at all — the card then shows a header with no fold affordance.
    readonly body: ToolBody | undefined;
    // A short result phrase for the header ("43 matches", "+12 −3", "failed") — visible while collapsed, which
    // is the whole point: a folded card should still say what happened.
    readonly summary: string | undefined;
    // Whether the card starts expanded. A manual toggle overrides it (and sticks) — see ChatToolCard.
    readonly defaultOpen: boolean;
}

// Category → icon. The floor every tool lands on when no per-name presenter claims it.
const CATEGORY_ICONS: Record<ChatTool["category"], IconName> = {
    read: `file`,
    edit: `file-edit`,
    delete: `trash`,
    move: `forward`,
    search: `search`,
    execute: `code`,
    think: `sparkles`,
    fetch: `globe`,
    other: `angle-right`,
};

// Cap on rendered text so a large file read or a chatty command can't bloat the DOM (the box scrolls anyway).
export const TEXT_CAP = 4000;
// Cap on rendered file rows, for the same reason — the count still reports the true total.
const FILE_ROW_CAP = 50;

const countLines = (text: string): number => (text === `` ? 0 : text.split(`\n`).filter((line) => line !== ``).length);

// "1 match" / "2 matches". Sibilant endings take -es; nothing here needs a fuller inflection table.
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? `` : /(?:s|x|z|ch|sh)$/.test(noun) ? `es` : `s`}`;

// A `path`, `path:line` or `path:line:match` line as ripgrep and glob-style tools emit it. Anchored on a
// leading path-shaped segment: no whitespace, at least one `/` or a dot-extension, and no leading dash (so a
// `--flag` echo or a prose line never parses as a file). Returns undefined for anything else.
const parseFileLine = (raw: string): ToolFileEntry | undefined => {
    const line = raw.trim();
    if (line === `` || line.startsWith(`-`)) {
        return undefined;
    }
    const match = /^([^\s:]+(?:\/[^\s:]*)*?)(?::(\d+))?(?::.*)?$/.exec(line);
    const path = match?.[1];
    if (path === undefined || (!path.includes(`/`) && !/\.[A-Za-z0-9]+$/.test(path))) {
        return undefined;
    }
    const lineNumber = match?.[2];
    return lineNumber === undefined ? { path } : { path, line: Number(lineNumber) };
};

// Shape a path listing into clickable rows — but only when it really is one. A search tool's output mode is
// the agent's choice (ripgrep can return counts, or prose "No matches found"), so anything under a clear
// majority of parseable lines degrades to plain text rather than rendering a half-empty, half-wrong list.
const filesBody = (text: string): ToolBody => {
    const lines = text.split(`\n`).filter((line) => line.trim() !== ``);
    const entries = lines.map(parseFileLine).filter((entry) => entry !== undefined);
    if (lines.length === 0 || entries.length * 2 < lines.length) {
        return { kind: `text`, text };
    }
    return { kind: `files`, entries: entries.slice(0, FILE_ROW_CAP), hidden: Math.max(0, entries.length - FILE_ROW_CAP) };
};

// What a presenter may override. Everything is optional — a presenter exists to say the one or two things
// that differ from the category default, never to restate it.
interface Presenter {
    readonly icon?: IconName;
    // Shapes the tool's joined text output. Absent ⇒ the plain text box.
    readonly body?: (text: string, tool: ChatTool) => ToolBody;
    // The header's result phrase, from the joined text and the call itself. Absent ⇒ no summary.
    readonly summary?: (text: string, tool: ChatTool) => string | undefined;
}

// A Bash call's `target` IS the command, so the output box shouldn't repeat it — split them into a `$ cmd`
// line plus the output beneath, the shape a terminal-shaped result actually wants.
const commandBody = (text: string, tool: ChatTool): ToolBody => ({ kind: `command`, command: tool.target ?? ``, output: text });

// Total +/− across a call's structured diffs; undefined when it carries none (so Edit-family tools whose
// backend sent no diff simply have no summary rather than a misleading "+0 −0").
// Signature matches Presenter["summary"] so it can be used as one directly; the joined text is irrelevant here.
const diffSummary = (_text: string, tool: ChatTool): string | undefined => {
    const diffs = (tool.content ?? []).filter((entry) => entry.type === `diff`);
    if (diffs.length === 0) {
        return undefined;
    }
    let additions = 0;
    let deletions = 0;
    for (const diff of diffs) {
        const stat = diffStat(diff.oldText, diff.newText);
        additions += stat.additions;
        deletions += stat.deletions;
    }
    return `+${additions} −${deletions}`;
};

// Per-tool presenters, keyed by lowercased display name. Names are the daemon's normalized display names
// (displayNameOf in agent/tool-calls.ts), so one entry covers every backend that maps onto it.
const PRESENTERS: Record<string, Presenter> = {
    bash: { body: commandBody, summary: (text) => (text === `` ? `no output` : plural(countLines(text), `line`)) },
    bashoutput: { body: commandBody },
    read: { summary: (text) => (text === `` ? undefined : plural(countLines(text), `line`)) },
    grep: { body: filesBody, summary: (text) => (text === `` ? `no matches` : plural(countLines(text), `match`)) },
    glob: { body: filesBody, summary: (text) => (text === `` ? `no matches` : plural(countLines(text), `file`)) },
    edit: { summary: diffSummary },
    write: { summary: diffSummary },
    multiedit: { summary: diffSummary },
    notebookedit: { summary: diffSummary },
    // A subagent's own transcript renders in the parent turn (frames carry parentToolUseId); the card is just
    // the delegation marker, so it gets a distinct icon and no output shaping.
    task: { icon: `users` },
    websearch: { icon: `search` },
    webfetch: { icon: `globe` },
};

export const present = (tool: ChatTool): ToolPresentation => {
    const presenter = PRESENTERS[tool.name.toLowerCase()] ?? {};
    const content = tool.content ?? [];
    const diffs = content.filter((entry) => entry.type === `diff`);
    const text = content
        .filter((entry) => entry.type === `text`)
        .map((entry) => entry.text)
        .join(``);
    const capped = text.length > TEXT_CAP ? `${text.slice(0, TEXT_CAP)}\n… (truncated)` : text;
    const running = tool.status === `pending` || tool.status === `in_progress`;
    const failed = tool.status === `failed`;

    // A Bash card keeps its body even with no output — the `$ command` line is itself worth showing. Every
    // other tool with nothing to say renders as a bare header.
    const body = presenter.body !== undefined ? presenter.body(capped, tool) : capped === `` ? undefined : { kind: `text` as const, text: capped };
    const shown = body !== undefined && (body.kind !== `command` || body.command !== `` || body.output !== ``) ? body : undefined;

    return {
        icon: presenter.icon ?? CATEGORY_ICONS[tool.category],
        diffs,
        body: diffs.length === 0 && shown === undefined ? undefined : shown,
        // A failed call's own message is the summary the header wants; a successful one asks its presenter.
        summary: failed ? `failed` : presenter.summary?.(text, tool),
        // Expanded while it runs (live output is the point) and when it failed (the error is the point);
        // collapsed once a call settles cleanly, so a long turn stays skimmable.
        defaultOpen: running || failed,
    };
};
