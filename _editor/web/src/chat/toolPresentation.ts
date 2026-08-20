import type { IconName } from "@intentic/ui";
import type { ToolCallContent } from "@intentic/sandbox-contract";
import type { ChatTool } from "../composables/chat/transcript";
import { codeLangForPath } from "../pages/workspace/fileType";
import { diffStat } from "./chatToolDiff";

/* How one tool call renders, the single table the chat's tool cards consult, so per-tool knowledge lives in
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
    // A file's contents to syntax-highlight, as a Read card shows. `code` has the SDK's line-number gutter
    // stripped (see numberedFileBody); `firstLine` is the original number of its first line (Read honors an
    // offset), which the card restores as a real gutter. `lang` is the Shiki id from the path, or undefined
    // (unknown extension / no grammar), then it renders as plain, still-numbered monospace.
    | { readonly kind: "code"; readonly code: string; readonly lang: string | undefined; readonly firstLine: number }
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
    // Pictures the call produced, today a browser screenshot, carried as a workspace path the card fetches.
    readonly images: readonly Extract<ToolCallContent, { type: "image" }>[];
    // Undefined when the call produced no text at all, the card then shows a header with no fold affordance.
    readonly body: ToolBody | undefined;
    // A short result phrase for the header ("43 matches", "+12 −3", "failed"), visible while collapsed, which
    // is the whole point: a folded card should still say what happened.
    readonly summary: string | undefined;
    // Whether the card starts expanded. A manual toggle overrides it (and sticks), see ChatToolCard.
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
    // Not `angle-right`: a caret sits immediately after the card's fold chevron and reads as a second one.
    other: `cog`,
};

// Cap on rendered text so a large file read or a chatty command can't bloat the DOM (the box scrolls anyway).
export const TEXT_CAP = 4000;
// Cap on rendered file rows, for the same reason, the count still reports the true total.
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

// Shape a path listing into clickable rows, but only when it really is one. A search tool's output mode is
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

// What a presenter may override. Everything is optional, a presenter exists to say the one or two things
// that differ from the category default, never to restate it.
interface Presenter {
    readonly icon?: IconName;
    // Shapes the tool's joined text output. Absent ⇒ the plain text box; returning undefined ⇒ no body at all
    // (a bare header), same as a tool with no presenter and empty output.
    readonly body?: (text: string, tool: ChatTool) => ToolBody | undefined;
    // The header's result phrase, from the joined text and the call itself. Absent ⇒ no summary.
    readonly summary?: (text: string, tool: ChatTool) => string | undefined;
}

// A Bash call's `target` IS the command, so the output box shouldn't repeat it, split them into a `$ cmd`
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

// A `Read` result is the SDK's numbered file view: every line is `<spaces><line no><sep><content>`, the
// separator an arrow (→) or a tab. Strip that gutter so the content can be highlighted (and the numbers shown
// in a real gutter instead), returning the bare code and the first line's number (Read honors an offset, so it
// isn't always 1). Returns undefined unless the body really is that shape, a strictly +1 run over the bulk of
// the lines, so an image/PDF read (`[image]`) or any other non-numbered output falls through to the plain text
// box rather than being mangled. A trailing note (the `… (truncated)` marker present() appends past TEXT_CAP, or
// a final blank line) rides along as content once the run has started.
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
                return undefined; // the very first line isn't numbered — not a file view
            }
            code.push(line); // a trailing marker / blank tail inside an already-established run
            continue;
        }
        const n = Number(parsed[1]);
        if (firstLine === undefined) {
            firstLine = n;
        } else if (n !== next) {
            return undefined; // a break in the +1 sequence — arbitrary numeric text, not a file view
        }
        next = n + 1;
        matched += 1;
        code.push(parsed[2] ?? ``);
    }
    // Require the numbered run to be the clear majority, so a couple of coincidentally-numbered prose lines
    // don't read as a file.
    if (firstLine === undefined || matched * 2 < lines.length) {
        return undefined;
    }
    return { code: code.join(`\n`), firstLine };
};

// Per-tool presenters, keyed by lowercased display name. Names are the daemon's normalized display names
// (displayNameOf in agent/tool-calls.ts), so one entry covers every backend that maps onto it.
const PRESENTERS: Record<string, Presenter> = {
    bash: { body: commandBody, summary: (text) => (text === `` ? `no output` : plural(countLines(text), `line`)) },
    bashoutput: { body: commandBody },
    read: {
        // A Read shows a file: color it from the path's extension (the workspace viewer's own resolution) with
        // the SDK's line-number gutter stripped for clean highlighting. A non-file read (image/PDF ⇒ `[image]`)
        // or an unknown extension degrades to plain, see numberedFileBody / the code body's fallback.
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
    // A subagent's own transcript nests under this card (its child tool calls + streamed thinking, the client
    // groups them by parentToolUseId; see conversation.ts appendTool), so it gets a distinct icon and no output
    // shaping of its own; its result rides the default text body. The Claude SDK names the tool `Agent` (its
    // input is AgentInput/subagent_type) while native backends emit lowercase `task`, both are current, so both
    // resolve here.
    agent: { icon: `users` },
    task: { icon: `users` },
    websearch: { icon: `search` },
    webfetch: { icon: `globe` },
    // Asking the user is its own act, not an "other", and the category default (`angle-right`) read as a second
    // fold chevron sitting right next to the real one.
    askuserquestion: { icon: `question-circle` },
};

/* THE BROWSER FAMILY, PRESENTED AS ONE.
 *
 * Every @playwright/mcp tool arrives named "Browser <verb>" (agent/tool-calls.ts), and there are twenty-odd of
 * them, a table entry each would be twenty rows saying the same thing. They share a face on purpose: the
 * globe marks browser work wherever it appears in a turn, matching the pill the panel gives the session those
 * calls are running in, so "this card" and "that tab" read as the same browser.
 *
 * A snapshot is the one body worth shaping. It is a YAML accessibility tree, sometimes hundreds of lines, and
 * it is written for the model rather than for a person, so the header says how big it was and the box stays
 * folded, instead of burying the turn in it. */
const BROWSER_PRESENTER: Presenter = {
    icon: `globe`,
    summary: (text, tool) => (tool.name.toLowerCase() === `browser snapshot` && text !== `` ? plural(countLines(text), `line`) : undefined),
};

const presenterFor = (name: string): Presenter => {
    const lower = name.toLowerCase();
    return PRESENTERS[lower] ?? (lower.startsWith(`browser `) ? BROWSER_PRESENTER : {});
};

export const present = (tool: ChatTool): ToolPresentation => {
    const presenter = presenterFor(tool.name);
    const content = tool.content ?? [];
    const diffs = content.filter((entry) => entry.type === `diff`);
    const images = content.filter((entry) => entry.type === `image`);
    const text = content
        .filter((entry) => entry.type === `text`)
        .map((entry) => entry.text)
        .join(``);
    const capped = text.length > TEXT_CAP ? `${text.slice(0, TEXT_CAP)}\n… (truncated)` : text;
    const running = tool.status === `pending` || tool.status === `in_progress`;
    const failed = tool.status === `failed`;

    // A Bash card keeps its body even with no output, the `$ command` line is itself worth showing. Every
    // other tool with nothing to say renders as a bare header.
    const body = presenter.body !== undefined ? presenter.body(capped, tool) : capped === `` ? undefined : { kind: `text` as const, text: capped };
    const shown = body !== undefined && (body.kind !== `command` || body.command !== `` || body.output !== ``) ? body : undefined;

    return {
        icon: presenter.icon ?? CATEGORY_ICONS[tool.category],
        diffs,
        images,
        body: diffs.length === 0 && images.length === 0 && shown === undefined ? undefined : shown,
        // A failed call's own message is the summary the header wants; a successful one asks its presenter.
        summary: failed ? `failed` : presenter.summary?.(text, tool),
        // Expanded while it runs (live output is the point) and when it failed (the error is the point);
        // collapsed once a call settles cleanly, so a long turn stays skimmable. EXCEPT when the call came
        // back with a picture, which is the whole reason it was made and worth nothing folded away.
        defaultOpen: running || failed || images.length > 0,
    };
};
