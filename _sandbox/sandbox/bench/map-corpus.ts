// Recomputes what the project map did, from transcripts, separate from printing so a test can import it. Not the
// holdout: populations differ by era too, so this is evidence about the map's payload, not a controlled comparison.
// Predicates are the production ones, so figures cannot drift from the daemon's; scope is Claude Code transcripts only.

import { readFileSync } from "node:fs";
import { WORKSPACE_ROOT } from "@intentic/constants";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { displayNameOf, toolCategoryOf, toolLocations, toolTarget } from "../src/agent/tools/tool-calls.js";
import { createTurnMetrics, type TurnMetricsReading } from "../src/agent/run/turn/turn-metrics.js";
import { WORKSPACE_MAP_NOTE_HEADER } from "../src/agent/prompt/workspace-map.js";
import { transcriptFiles } from "./transcripts.js";

// Workspace root as the agent saw it; transcript paths are written against this root.
export const DEFAULT_AGENT_ROOT = WORKSPACE_ROOT;

/* ---- the note, read back off the message it rode in on --------------------------------------------------- */

export interface MapNoteArea {
    readonly name: string;
    readonly files: number;
    // Whether the area's row has a purpose line beneath it.
    readonly purpose: boolean;
    readonly here: boolean;
    // True for a package inside an expanded area, not a top-level area of the project.
    readonly child: boolean;
}

export interface MapNote {
    readonly chars: number;
    // Project name, root-relative; prefix area names with this before matching workspace-relative paths.
    readonly project: string;
    readonly areas: readonly MapNoteArea[];
    // Area the run was standing in; undefined when standing at the project root.
    readonly here: string | undefined;
    // True when the note omitted areas: past budget, or a count the renderer shed.
    readonly truncated: boolean;
}

// Anchors on the rows' structure, not the note's prose, which has changed wording before; SUMMARY_ROW accepts either
// separator for that reason.
const AREA_ROW = /^ {2,6}(\S+) {2,}(\d+) files?\b(.*)$/;
const PURPOSE_ROW = /^ {8,}\S/;
const SUMMARY_ROW = /^(?:`(.+?)`|the workspace)[,—-] \d+ areas?/;
const STRUCTURAL = [AREA_ROW, PURPOSE_ROW, /^ {2}… and \d+ more$/, /^Also under the workspace root:/];

const structural = (line: string): boolean => STRUCTURAL.some((shape) => shape.test(line));

// One area row, or undefined if the line is not one; purpose lines are attached by the caller, not here.
const areaRowOf = (line: string): MapNoteArea | undefined => {
    const row = AREA_ROW.exec(line);
    if (row?.[1] === undefined || row[2] === undefined) {
        return undefined;
    }
    return {
        name: row[1],
        files: Number(row[2]),
        purpose: false,
        here: row[3]?.includes("← you are here") === true,
        // Expanded package rows are indented four spaces more than a top-level area (workspace-map.ts areaBlock).
        child: line.startsWith("      "),
    };
};

// Header, opening prose, and rows, ending just before the first non-blank non-row line (the user's message). Undefined:
// no map, or a header with no rows — not the same as a map listing nothing.
const noteLinesOf = (message: string): string[] | undefined => {
    const start = message.indexOf(WORKSPACE_MAP_NOTE_HEADER);
    if (start === -1) {
        return undefined;
    }
    const lines = message.slice(start).split("\n");
    const firstRow = lines.findIndex((line) => AREA_ROW.test(line));
    if (firstRow === -1) {
        return undefined;
    }
    let end = firstRow;
    for (let index = firstRow; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        if (line !== "" && !structural(line)) {
            break;
        }
        end = line === "" ? end : index;
    }
    return lines.slice(0, end + 1);
};

export const parseMapNote = (message: string): MapNote | undefined => {
    const kept = noteLinesOf(message);
    if (kept === undefined) {
        return undefined;
    }
    const areas: MapNoteArea[] = [];
    for (const line of kept) {
        const row = areaRowOf(line);
        if (row !== undefined) {
            areas.push(row);
            continue;
        }
        const last = areas.at(-1);
        if (last !== undefined && PURPOSE_ROW.test(line)) {
            areas[areas.length - 1] = { ...last, purpose: true };
        }
    }
    return {
        chars: kept.join("\n").length,
        project: kept.flatMap((line) => SUMMARY_ROW.exec(line)?.[1] ?? [])[0] ?? "",
        areas,
        here: areas.find((area) => area.here)?.name,
        truncated: kept.some((line) => line.includes("smaller ones not listed") || / {2}… and \d+ more$/.test(line)),
    };
};

/* ---- the corpus ------------------------------------------------------------------------------------------ */

// Tool-call frame shape rebuilt to match what the daemon's ledger and predicates read.
type CallFrame = Extract<AgentEvent, { kind: "tool_call" }>;

interface TranscriptLine {
    readonly type?: string;
    readonly isSidechain?: boolean;
    readonly timestamp?: string;
    readonly message?: { readonly content?: readonly Record<string, unknown>[] | string };
}

export interface Session {
    readonly day: string;
    readonly note: MapNote | undefined;
    // Opening turn's behaviour, from the daemon's ledger, plus its first action (which no ledger keeps).
    readonly opening: TurnMetricsReading & { readonly firstAction: string | undefined };
    // Paths the whole session touched, resolved against the note's areas; empty if it opened nothing.
    readonly touched: {
        readonly areas: readonly string[];
        readonly outside: number;
        // First file opened, and the area holding it; both undefined only if nothing was opened — distinct from a first
        // file that fell outside every area.
        readonly firstFile: string | undefined;
        readonly firstArea: string | undefined;
        readonly entered: boolean;
    };
}

const textOf = (content: readonly Record<string, unknown>[] | string | undefined): string => {
    if (typeof content === "string") {
        return content;
    }
    return (content ?? [])
        .filter((block) => block["type"] === "text")
        .map((block) => (typeof block["text"] === "string" ? block["text"] : ""))
        .join("\n");
};

// Parses only lines that could hold a user message or a tool_use call; skipping the rest avoids JSON.parse over most of
// a transcript.
const eventOf = (line: string): TranscriptLine | undefined => {
    if (!line.includes(`"tool_use"`) && !line.includes(`"type":"user"`)) {
        return undefined;
    }
    try {
        return JSON.parse(line) as TranscriptLine;
    } catch {
        return undefined;
    }
};

// A real prompt, not a user line carrying tool results — the only turn boundary this format has.
const promptOf = (event: TranscriptLine): string | undefined => {
    const blocks = event.message?.content;
    const list = Array.isArray(blocks) ? blocks : [];
    return event.type === "user" && !list.some((block) => block["type"] === "tool_result") ? textOf(blocks) : undefined;
};

// Rebuilds one assistant line's calls as tool_call frames, so createTurnMetrics can score them directly, without a
// duplicate implementation.
const callsOf = (event: TranscriptLine, agentRoot: string): CallFrame[] => {
    const blocks = event.message?.content;
    if (event.type !== "assistant" || !Array.isArray(blocks)) {
        return [];
    }
    return blocks.flatMap((block, index) => {
        const raw = block["name"];
        if (block["type"] !== "tool_use" || typeof raw !== "string") {
            return [];
        }
        const name = displayNameOf(raw);
        const target = toolTarget(block["input"]);
        const locations = toolLocations(block["input"], agentRoot);
        return [
            {
                kind: "tool_call",
                id: String(block["id"] ?? index),
                name,
                category: toolCategoryOf(name),
                status: "completed",
                ...(target !== undefined ? { target } : {}),
                ...(locations !== undefined ? { locations } : {}),
            } satisfies CallFrame,
        ];
    });
};

const firstActionOf = (call: CallFrame): string =>
    call.name === "Bash" && call.target !== undefined ? `bash:${(call.target.trim().split(/\s+/)[0] ?? "").split("/").pop()}` : call.name;

// Opening turn (behaviour) ends at the second real prompt; coverage reads to end of file. Scored by createTurnMetrics,
// the daemon's own ledger, so corpus and holdout agree on the same numbers.
// Deepest listed area whose prefix matches wins, so a nested package beats the area holding it; no match counts as
// outside.
const coverageOf = (note: MapNote | undefined, paths: readonly string[], files: readonly string[]): Session["touched"] => {
    // Re-adds the project prefix so area names (project-relative) match paths (workspace-relative).
    const prefix = note === undefined || note.project === "" ? "" : `${note.project}/`;
    const names = (note?.areas ?? []).map((area) => `${prefix}${area.name}`);
    const areaOf = (path: string): string | undefined =>
        names.filter((name) => path === name || path.startsWith(`${name}/`)).toSorted((left, right) => right.length - left.length)[0];
    const inside = [...new Set(paths)].map((path) => areaOf(path));
    return {
        areas: [...new Set(inside.filter((area) => area !== undefined))],
        outside: inside.filter((area) => area === undefined).length,
        // firstArea: area holding the first file opened (read/edit), not the first path any call carried — a Grep's
        // `path` is looked at, not visited. `entered` is the loose version, over every path touched.
        firstFile: files[0],
        firstArea: files.length === 0 ? undefined : areaOf(files[0] ?? ""),
        entered: inside.some((area) => area !== undefined),
    };
};

export const readSession = (file: string, agentRoot: string): Session | undefined => {
    const metrics = createTurnMetrics(agentRoot);
    let note: MapNote | undefined;
    let day: string | undefined;
    let prompts = 0;
    let firstAction: string | undefined;
    const edited: string[] = [];
    const paths: string[] = [];
    // Paths a call opened, not searched under; the destinations, in the order reached.
    const files: string[] = [];
    // The opening turn's calls go to the ledger; every turn's paths go to the coverage reading.
    const noteCall = (call: CallFrame): void => {
        const touched = (call.locations ?? []).map((location) => location.path);
        paths.push(...touched);
        files.push(...(call.category === "read" || call.category === "edit" ? touched : []));
        if (prompts !== 1) {
            return;
        }
        firstAction ??= firstActionOf(call);
        edited.push(...(call.category === "edit" ? touched : []));
        metrics.note(call);
    };
    for (const line of readFileSync(file, "utf8").split("\n")) {
        // A subagent's transcript is not a session: never sent a map.
        if (line.includes(`"isSidechain":true`)) {
            return undefined;
        }
        const event = eventOf(line);
        if (event === undefined) {
            continue;
        }
        const prompt = promptOf(event);
        if (prompt !== undefined) {
            prompts += 1;
            day ??= (event.timestamp ?? "").slice(0, 10);
            note ??= parseMapNote(prompt);
            continue;
        }
        for (const call of callsOf(event, agentRoot)) {
            noteCall(call);
        }
    }
    if (day === undefined) {
        return undefined;
    }
    return { day, note, opening: { ...metrics.reading(edited), firstAction }, touched: coverageOf(note, paths, files) };
};

/* ---- the readings ---------------------------------------------------------------------------------------- */

const median = (values: readonly number[]): number => {
    const sorted = values.toSorted((left, right) => left - right);
    return sorted.length === 0 ? 0 : (sorted[Math.floor(sorted.length / 2)] ?? 0);
};
const mean = (values: readonly number[]): number => (values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length);
const share = (part: number, whole: number): string => (whole === 0 ? "0%" : `${((part / whole) * 100).toFixed(1)}%`);
const round1 = (value: number): number => Math.round(value * 10) / 10;

const openingOf = (sessions: readonly Session[]) => {
    const actions: Record<string, number> = {};
    for (const session of sessions) {
        const action = session.opening.firstAction ?? "none";
        actions[action] = (actions[action] ?? 0) + 1;
    }
    return {
        sessions: sessions.length,
        openedWithListing: share(sessions.filter((session) => session.opening.openingListings > 0).length, sessions.length),
        searchesBeforeFirstFile: round1(mean(sessions.map((session) => session.opening.openingSearches))),
        searchesPerOpeningTurn: round1(mean(sessions.map((session) => session.opening.searchCalls))),
        // Calls before touching a file later edited, over sessions that edited anything — whether the map bought
        // targeting, not just compliance. `reached` counts how many sessions could answer at all.
        callsBeforeTarget: round1(mean(sessions.flatMap((session) => session.opening.callsBeforeTarget ?? []))),
        reached: sessions.filter((session) => session.opening.callsBeforeTarget !== undefined).length,
        firstActions: Object.fromEntries(
            Object.entries(actions)
                .toSorted((left, right) => right[1] - left[1])
                .slice(0, 5)
                .map(([name, count]) => [name, share(count, sessions.length)]),
        ),
    };
};

// Area name as a path from the workspace root, the space every reading here uses.
const fullName = (note: MapNote | undefined, area: MapNoteArea): string =>
    note === undefined || note.project === "" ? area.name : `${note.project}/${area.name}`;

// Whether the note's lines earned their characters: an area line is paid for by every session that gets it, used by the
// ones that go there.
const payloadOf = (sessions: readonly Session[]) => {
    const withNote = sessions.filter((session) => session.note !== undefined);
    const worked = withNote.filter((session) => session.touched.areas.length + session.touched.outside > 0);
    const rows = withNote.flatMap((session) => session.note?.areas ?? []);
    const listed = new Map<string, number>();
    const used = new Map<string, number>();
    for (const session of worked) {
        for (const area of session.note?.areas ?? []) {
            const name = fullName(session.note, area);
            listed.set(name, (listed.get(name) ?? 0) + 1);
        }
        for (const name of session.touched.areas) {
            used.set(name, (used.get(name) ?? 0) + 1);
        }
    }
    const usedArea = (session: Session, name: string | undefined): MapNoteArea | undefined =>
        session.note?.areas.find((area) => fullName(session.note, area) === name);
    // Coverage counts only sessions that opened a file; one that opened none has no destination to have named.
    const opened = worked.filter((session) => session.touched.firstFile !== undefined);
    const landed = opened.filter((session) => session.touched.firstArea !== undefined);
    return {
        // Two readings: named the session's first destination, vs named anywhere it went at all.
        everEnteredAListedArea: share(worked.filter((session) => session.touched.entered).length, worked.length),
        openedAFile: opened.length,
        worked: worked.length,
        sessions: withNote.length,
        areasListed: median(withNote.map((session) => session.note?.areas.length ?? 0)),
        areasUsed: median(worked.map((session) => session.touched.areas.length)),
        linesUsed: share(
            worked.reduce((sum, session) => sum + session.touched.areas.length, 0),
            worked.reduce((sum, session) => sum + (session.note?.areas.length ?? 0), 0),
        ),
        firstFileInsideAListedArea: share(landed.length, worked.length),
        // Share of entered areas that had a purpose line; a dropped manifest description shows up here.
        purposeOnTheAreaUsed: share(landed.filter((session) => usedArea(session, session.touched.firstArea)?.purpose === true).length, landed.length),
        purposeOnAnyRow: share(rows.filter((area) => area.purpose).length, rows.length),
        // How often the run stood inside an area, which is what expands a container in the note.
        standingInAnArea: share(withNote.filter((session) => session.note?.here !== undefined).length, withNote.length),
        expandedRows: share(rows.filter((area) => area.child).length, rows.length),
        omittedSomething: share(withNote.filter((session) => session.note?.truncated === true).length, withNote.length),
        chars: {
            median: median(withNote.map((session) => session.note?.chars ?? 0)),
            max: Math.max(0, ...withNote.map((session) => session.note?.chars ?? 0)),
        },
        perArea: [...listed.entries()]
            .toSorted((left, right) => right[1] - left[1])
            .slice(0, 12)
            .map(([name, count]) => ({ area: name, listed: count, used: used.get(name) ?? 0, share: share(used.get(name) ?? 0, count) })),
    };
};

export interface MapStatsOptions {
    readonly agentRoot?: string;
}

export const mapStats = (root: string, options: MapStatsOptions = {}) => {
    const agentRoot = options.agentRoot ?? DEFAULT_AGENT_ROOT;
    const sessions = transcriptFiles(root).flatMap((file) => {
        const session = readSession(file, agentRoot);
        return session === undefined ? [] : [session];
    });
    const days = sessions.map((session) => session.day).toSorted();
    const mapped = sessions.filter((session) => session.note !== undefined);
    const unmapped = sessions.filter((session) => session.note === undefined);
    return {
        root,
        corpus: { sessions: sessions.length, mapped: mapped.length, from: days[0] ?? "", to: days.at(-1) ?? "" },
        // Snapshot from when this was written; read as a date, not a target, so a moved number isn't a failure.
        opening: {
            claimed: "2026-09-05: mapped 28.3% opened with a listing, unmapped 44.7%, and searches did not move (1.5 either way)",
            mapped: openingOf(mapped),
            unmapped: openingOf(unmapped),
        },
        payload: {
            claimed: "2026-09-05: 5 areas listed, 1 used, 21.7% of lines used, 59.4% of first files inside one, zoom never fired",
            ...payloadOf(sessions),
        },
    };
};
