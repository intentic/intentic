import type { IconName } from "@intentic/ui";
import { type CardDocument, documentOf, type ToolCallContent, type TranscriptTool } from "@intentic/sandbox-contract";
import { codeLangForPath } from "@intentic/code-read";
import { diffStat } from "./chatToolDiff";

// Per-tool rendering table for the chat's tool cards: a presenter is looked up by the tool's normalized display name
// (case-insensitive), falling back to its ACP category so an unknown tool still renders sanely. `present()` is a pure
// function of a TranscriptTool, testable without mounting a component.

// Shape of a tool's textual output: `text` is the generic fallback, `files` renders a path listing, `command` splits a
// shell invocation from its output.
export type ToolBody =
    | { readonly kind: "text"; readonly text: string }
    // Gutter stripped; firstLine is the row's true starting number; lang undefined renders plain monospace.
    | { readonly kind: "code"; readonly code: string; readonly lang: string | undefined; readonly firstLine: number }
    | { readonly kind: "files"; readonly entries: readonly ToolFileEntry[]; readonly hidden: number }
    | { readonly kind: "command"; readonly command: string; readonly output: string };

// A workspace path and, when the source line carried one, the 1-based line it matched at.
export interface ToolFileEntry {
    readonly path: string;
    readonly line?: number;
}

export interface ToolPresentation {
    readonly icon: IconName;
    // Document this call wrote, drawn as prose; a whole-file write's diff lives only here, not in `diffs`.
    readonly document: CardDocument | undefined;
    // Structured diffs to render above the body (Edit/Write and any ACP agent that sends them ready-made).
    readonly diffs: readonly Extract<ToolCallContent, { type: "diff" }>[];
    // Images the call produced, as workspace paths the card fetches.
    readonly images: readonly Extract<ToolCallContent, { type: "image" }>[];
    // Undefined when the call produced no text at all; the card then shows a header with no fold affordance.
    readonly body: ToolBody | undefined;
    // Short result phrase for the header ("43 matches", "+12 −3", "failed"), visible while the card is collapsed.
    readonly summary: string | undefined;
    // Whether the card starts expanded; a manual toggle overrides it and sticks (see ChatToolCard).
    readonly defaultOpen: boolean;
}

// Category → icon fallback used when no per-name presenter claims the tool.
const CATEGORY_ICONS: Record<TranscriptTool["category"], IconName> = {
    read: `file`,
    edit: `file-edit`,
    delete: `trash`,
    move: `forward`,
    search: `search`,
    execute: `code`,
    think: `sparkles`,
    fetch: `globe`,
    // Not `angle-right`: it would sit beside the fold chevron and read as a second one.
    other: `cog`,
};

// Cap on rendered text length so a large read or chatty command can't bloat the DOM; the box still scrolls.
export const TEXT_CAP = 4000;
// Cap on rendered file rows for the same reason; the header still reports the true total count.
const FILE_ROW_CAP = 50;

const countLines = (text: string): number => (text === `` ? 0 : text.split(`\n`).filter((line) => line !== ``).length);

// "1 match" / "2 matches"; pluralizes sibilant endings with -es.
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? `` : /(?:s|x|z|ch|sh)$/.test(noun) ? `es` : `s`}`;

// Parses a `path[:line[:match]]` line as ripgrep/glob tools emit it; requires a path-shaped segment (`/` or a
// dot-extension, no leading `-`), else undefined.
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

// Shapes a path listing into clickable rows only when most lines parse as one; a search tool may return prose or counts
// instead of paths.
const filesBody = (text: string): ToolBody => {
    const lines = text.split(`\n`).filter((line) => line.trim() !== ``);
    const entries = lines.map(parseFileLine).filter((entry) => entry !== undefined);
    if (lines.length === 0 || entries.length * 2 < lines.length) {
        return { kind: `text`, text };
    }
    return { kind: `files`, entries: entries.slice(0, FILE_ROW_CAP), hidden: Math.max(0, entries.length - FILE_ROW_CAP) };
};

// What a presenter may override; a presenter states only what differs from the category default.
interface Presenter {
    readonly icon?: IconName;
    // Shapes the joined text output; absent renders the plain text box, undefined return renders no body (bare header).
    readonly body?: (text: string, tool: TranscriptTool) => ToolBody | undefined;
    // Header's result phrase, from the joined text and the call itself; absent means no summary.
    readonly summary?: (text: string, tool: TranscriptTool) => string | undefined;
}

// Splits a Bash call's target (the command itself) from its output, rather than repeating the command inside the box.
const commandBody = (text: string, tool: TranscriptTool): ToolBody => ({ kind: `command`, command: tool.target ?? ``, output: text });

// Total +/− across the call's diffs; undefined when it carries none, so a diffless Edit-family tool shows no summary
// instead of "+0 −0".
const diffSummary = (_text: string, tool: TranscriptTool): string | undefined => {
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

// Strips the SDK's numbered gutter (`<n><arrow-or-tab><content>`) into bare code plus the first line's number;
// undefined unless the numbers form a strict +1 run over most lines.
const NUMBERED_LINE = /^ *(\d+)(?:→|\t)(.*)$/;
export const numberedFileBody = (text: string): { readonly code: string; readonly firstLine: number } | undefined => {
    const lines = text.split(`\n`);
    const code: string[] = [];
    let firstLine: number | undefined;
    let next = 0;
    let matched = 0;
    for (const line of lines) {
        const parsed = NUMBERED_LINE.exec(line);
        if (parsed === null) {
            if (firstLine === undefined) {
                return undefined; // First line isn't numbered: not a file view.
            }
            code.push(line); // Trailing marker or blank line after an established run.
            continue;
        }
        const n = Number(parsed[1]);
        if (firstLine === undefined) {
            firstLine = n;
        } else if (n !== next) {
            return undefined; // Break in the +1 sequence: arbitrary numeric text, not a file view.
        }
        next = n + 1;
        matched += 1;
        code.push(parsed[2] ?? ``);
    }
    // Numbered run must be a clear majority, so a few coincidentally-numbered prose lines don't count as a file.
    if (firstLine === undefined || matched * 2 < lines.length) {
        return undefined;
    }
    return { code: code.join(`\n`), firstLine };
};

// Per-tool presenters keyed by lowercased display name (agent/tool-calls.ts normalizes it across backends).
const PRESENTERS: Record<string, Presenter> = {
    bash: { body: commandBody, summary: (text) => (text === `` ? `no output` : plural(countLines(text), `line`)) },
    bashoutput: { body: commandBody },
    read: {
        // Colors the read via the path's extension; unknown extension or non-file read falls back to plain text.
        body: (text, tool) => {
            if (text === ``) {
                return undefined;
            }
            const parsed = numberedFileBody(text);
            if (parsed === undefined) {
                return { kind: `text`, text };
            }
            const path = tool.locations?.[0]?.path ?? tool.target;
            return { kind: `code`, code: parsed.code, lang: path === undefined ? undefined : codeLangForPath(path), firstLine: parsed.firstLine };
        },
        summary: (text) => (text === `` ? undefined : plural(countLines(text), `line`)),
    },
    grep: { body: filesBody, summary: (text) => (text === `` ? `no matches` : plural(countLines(text), `match`)) },
    glob: { body: filesBody, summary: (text) => (text === `` ? `no matches` : plural(countLines(text), `file`)) },
    edit: { summary: diffSummary },
    write: { summary: diffSummary },
    multiedit: { summary: diffSummary },
    notebookedit: { summary: diffSummary },
    // Covers both names for a subagent call: the Claude SDK's `Agent` and native backends' lowercase `task`.
    agent: { icon: `users` },
    task: { icon: `users` },
    websearch: { icon: `search` },
    webfetch: { icon: `globe` },
    // Asking the user is its own act, not `other`; the category default reads as a second fold chevron.
    askuserquestion: { icon: `question-circle` },
};

// Shared presenter for every `Browser <verb>` tool; a snapshot's body is summarized by line count only.
const BROWSER_PRESENTER: Presenter = {
    icon: `globe`,
    summary: (text, tool) => (tool.name.toLowerCase() === `browser snapshot` && text !== `` ? plural(countLines(text), `line`) : undefined),
};

const presenterFor = (name: string): Presenter => {
    const lower = name.toLowerCase();
    return PRESENTERS[lower] ?? (lower.startsWith(`browser `) ? BROWSER_PRESENTER : {});
};

export const present = (tool: TranscriptTool): ToolPresentation => {
    const presenter = presenterFor(tool.name);
    const content = tool.content ?? [];
    // A failed call has no document: its content is what the agent meant to write, not what happened.
    const document = tool.status === `failed` ? undefined : documentOf(tool.name, content);
    const diffs = content.filter((entry) => entry.type === `diff`).filter((entry) => entry.path !== document?.path);
    const images = content.filter((entry) => entry.type === `image`);
    const text = content
        .filter((entry) => entry.type === `text`)
        .map((entry) => entry.text)
        .join(``);
    const capped = text.length > TEXT_CAP ? `${text.slice(0, TEXT_CAP)}\n… (truncated)` : text;
    const running = tool.status === `pending` || tool.status === `in_progress`;
    const failed = tool.status === `failed`;

    // Bash shows the `$ command` line even with no output; every other tool with nothing to say renders bare.
    const body = presenter.body !== undefined ? presenter.body(capped, tool) : capped === `` ? undefined : { kind: `text` as const, text: capped };
    const shown = body !== undefined && (body.kind !== `command` || body.command !== `` || body.output !== ``) ? body : undefined;

    return {
        // A document wears its own icon: a plan file matches the plan card; other write-ups get the reading icon.
        icon: document === undefined ? (presenter.icon ?? CATEGORY_ICONS[tool.category]) : document.plan === true ? `list-check` : `book`,
        document,
        diffs,
        images,
        body: diffs.length === 0 && images.length === 0 && document === undefined && shown === undefined ? undefined : shown,
        // A failed call's own message is the summary; a successful one asks its presenter.
        summary: failed ? `failed` : presenter.summary?.(text, tool),
        // Collapsed once a call settles cleanly; images and documents stay open regardless.
        defaultOpen: running || failed || images.length > 0 || document !== undefined,
    };
};
