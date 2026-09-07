/* WHAT THE PROJECT MAP DID, RECOMPUTED FROM THE TRANSCRIPTS. The measuring behind `bench:map`, kept apart from
 * the printing so it can be imported by a test: a module that scanned a whole corpus on import could not be.
 * map-stats.ts says how to read what this returns.
 *
 * WHY IT EXISTS. The map is a note injected into a conversation's opening message, and until the holdout has
 * run for a fortnight the ledger cannot say anything about it. The transcripts can, today, because the
 * TREATMENT LABELS ITSELF: the note rides the user message, so a session that got one has the map's own header
 * sitting in its first message and a session that did not, does not. That makes every past conversation a
 * sample, and it is the only reading of the map that exists before the arms fill up.
 *
 * IT IS NOT THE HOLDOUT AND MUST NOT BE READ AS ONE. Sessions that carry a map differ from sessions that do not
 * by more than the map: mostly by when they ran, and forks and continuations never carry one. Two populations
 * compared across a change of era is evidence, not a controlled experiment, and the arms (usage/turn-experiments.ts)
 * are what settle it. What this answers that the arms cannot: whether the map's PAYLOAD is worth its lines,
 * which is a question about the note's content rather than about anybody's behaviour.
 *
 * THE PREDICATES ARE THE PRODUCTION ONES, imported rather than reimplemented, so a figure quoted for the map
 * cannot drift away from what the daemon counts. `isRootListing` in particular: this file and the ledger score
 * a directory listing the same way or the two numbers are about different things.
 *
 * SCOPE. Claude Code transcripts only. Codex, Grok, Gemini, Cursor, Pi and ACP turns keep their history
 * elsewhere, so every share here is a share OF THE CLAUDE ARM, even though the map itself reaches all six. */

import { readFileSync } from "node:fs";
import { WORKSPACE_ROOT } from "@intentic/constants";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { displayNameOf, toolCategoryOf, toolLocations, toolTarget } from "../src/agent/tools/tool-calls.js";
import { createTurnMetrics, type TurnMetricsReading } from "../src/agent/run/turn-metrics.js";
import { WORKSPACE_MAP_NOTE_HEADER } from "../src/agent/prompt/workspace-map.js";
import { transcriptFiles } from "./transcripts.js";

/* The workspace root as the AGENT saw it, which is what the paths in these transcripts are written against and
 * what decides which listings were orientation. A corpus captured from another sandbox passes its own. */
export const DEFAULT_AGENT_ROOT = WORKSPACE_ROOT;

/* ---- the note, read back off the message it rode in on --------------------------------------------------- */

export interface MapNoteArea {
    readonly name: string;
    readonly files: number;
    // Whether the row carried a line saying what the area is for. Absent for an area whose own files say nothing.
    readonly purpose: boolean;
    readonly here: boolean;
    // A package inside an expanded area, rather than an area of the project.
    readonly child: boolean;
}

export interface MapNote {
    readonly chars: number;
    /* The project the map described, root-relative, empty when the workspace itself was the project.
     *
     * It is here because an area name is PROJECT-relative while every path in a transcript is
     * WORKSPACE-relative, and the two coincide only when the run started at the workspace root. Without it a
     * conversation opened inside a repo has a map naming `_editor` and a session reading `intentic/_editor/…`,
     * and every one of its files scores as outside the map: on this workspace that was 77 sessions read as
     * misses, against a coverage figure of 39.6%. */
    readonly project: string;
    readonly areas: readonly MapNoteArea[];
    // The area the run was standing in, or undefined when it was standing at the project root.
    readonly here: string | undefined;
    // The note said it was leaving something out: areas past the budget, or a shed the renderer counted.
    readonly truncated: boolean;
}

/* THE NOTE'S STRUCTURE, which is what this anchors on. Its PROSE is not: the head has been three different
 * paragraphs in a month, and a parser that recognised the note by its opening sentence read every older
 * revision as a map with no areas at all and diluted every share below it silently, which is a statistics tool
 * failing in the one way statistics tools fail. The rows below have had the same shape throughout, because the
 * shape is what the renderer computes rather than what anyone writes.
 *
 * `SUMMARY_ROW` takes either separator for the same reason: the wording moved, the reading should not. */
const AREA_ROW = /^ {2,6}(\S+) {2,}(\d+) files?\b(.*)$/;
const PURPOSE_ROW = /^ {8,}\S/;
const SUMMARY_ROW = /^(?:`(.+?)`|the workspace)[,—-] \d+ areas?/;
const STRUCTURAL = [AREA_ROW, PURPOSE_ROW, /^ {2}… and \d+ more$/, /^Also under the workspace root:/];

const structural = (line: string): boolean => STRUCTURAL.some((shape) => shape.test(line));

// One area row, or undefined for a line that is not one. A purpose line is attached to the row above it by the
// caller, which is the only place that knows what "above" was.
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
        // An expanded package is indented four further than an area of the project (workspace-map.ts areaBlock).
        child: line.startsWith("      "),
    };
};

/* The note's own lines: its header, whatever prose that revision opened with, and the rows, ending at the
 * first line after the rows that is neither blank nor one of them. That last line is the user's message.
 *
 * Undefined ⇒ no map here at all, or a header with no rows under it, which is not a note this can read and
 * must not be counted as a map with nothing in it. */
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

// The one frame shape this file rebuilds: a tool call as the daemon's ledger and predicates read it.
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
    // The OPENING turn's behaviour, scored by the daemon's own ledger, since that is the turn the map is sent
    // to and the only one it could have changed. Plus what the turn reached for first, which no ledger keeps.
    readonly opening: TurnMetricsReading & { readonly firstAction: string | undefined };
    // Paths the WHOLE session touched, resolved against the note's areas. Empty for a session that opened none.
    readonly touched: {
        readonly areas: readonly string[];
        readonly outside: number;
        // The first file the session opened, and the listed area holding it. Both undefined for a session that
        // opened none, which is not the same as one whose first file fell outside every area: a coverage share
        // that counted those as misses would be reporting how often sessions read files.
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

/* ONE SESSION, read to the end of its opening turn for behaviour and to the end of the file for coverage.
 *
 * The opening turn ends at the SECOND user message that carries no tool_result, which is the only turn
 * boundary this format has. Everything after it still counts toward which areas the session used, because a
 * map's area line is worth its characters if the session ever goes there, whichever turn it goes there on. */
// The lines worth parsing: a user message, or an assistant line carrying a call. Everything else in a
// transcript is prose, and JSON.parse over 3 GB of it is most of what a run of this costs.
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

// A real prompt, as opposed to a user line carrying tool results, which is the only turn boundary the format
// has. Undefined for anything else.
const promptOf = (event: TranscriptLine): string | undefined => {
    const blocks = event.message?.content;
    const list = Array.isArray(blocks) ? blocks : [];
    return event.type === "user" && !list.some((block) => block["type"] === "tool_result") ? textOf(blocks) : undefined;
};

// One assistant line's calls, as the tool_call frames the daemon's own ledger reads. Building the frame rather
// than a shape of this file's own is what lets the bench count with `createTurnMetrics` instead of a copy of it.
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

/* ONE SESSION, read to the end of its opening turn for behaviour and to the end of the file for coverage.
 *
 * The opening turn ends at the SECOND real prompt. Everything after it still counts toward which areas the
 * session used, because a map's area line is worth its characters if the session ever goes there, whichever
 * turn it goes there on.
 *
 * THE OPENING TURN IS SCORED BY `createTurnMetrics`, the daemon's own ledger, fed frames rebuilt from the
 * transcript. So the corpus and the holdout report the same four numbers computed by the same code, and a
 * change to how a listing is recognised moves both or neither. */
/* WHICH OF THE NOTE'S AREAS THE SESSION ACTUALLY WENT INTO. The deepest listed area that prefixes a path wins,
 * so an expanded package beats the area holding it, and a path under none of them is counted as outside: on
 * this workspace that is `.intentic/`, `refs/` and the dotfiles, which the map hides on purpose. */
const coverageOf = (note: MapNote | undefined, paths: readonly string[], files: readonly string[]): Session["touched"] => {
    // Area names are project-relative and these paths are workspace-relative, so the project prefix goes back
    // on before anything is compared. See MapNote.project.
    const prefix = note === undefined || note.project === "" ? "" : `${note.project}/`;
    const names = (note?.areas ?? []).map((area) => `${prefix}${area.name}`);
    const areaOf = (path: string): string | undefined =>
        names.filter((name) => path === name || path.startsWith(`${name}/`)).toSorted((left, right) => right.length - left.length)[0];
    const inside = [...new Set(paths)].map((path) => areaOf(path));
    return {
        areas: [...new Set(inside.filter((area) => area !== undefined))],
        outside: inside.filter((area) => area === undefined).length,
        /* THE AREA HOLDING THE FIRST FILE THE SESSION OPENED, which is the map's aim: did the note name the
         * place the session went to first.
         *
         * Files rather than every path a call carried, and that distinction cost a reading. A Grep's `path`
         * argument is a place the session LOOKED, not a place it went, and counting those as the first
         * destination read 39.4% over this workspace where the first file opened reads 98.1%: the same map,
         * two questions, and only one of them is about where the session was heading.
         *
         * `entered` is the loose companion, over every path: did the note name anywhere the session ever went. */
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
    // Paths a call OPENED, as opposed to searched under: the destinations, in the order the session reached them.
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
        // A subagent's transcript is not a session: it was never sent a map and never asked to open one.
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
        /* How far the turn walked before touching a file it went on to edit, over the sessions that edited
         * anything: the value reading, and the one that says whether the map bought targeting rather than
         * only compliance. `reached` is how many sessions could answer at all. */
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

// An area as a path from the workspace root, which is the space every reading here is in. See MapNote.project.
const fullName = (note: MapNote | undefined, area: MapNoteArea): string =>
    note === undefined || note.project === "" ? area.name : `${note.project}/${area.name}`;

/* WHETHER THE NOTE'S LINES WERE WORTH THEIR CHARACTERS, which is the reading the holdout cannot produce. An
 * area line is paid for by every session that receives it and used by the ones that go there, so the ratio of
 * the two says where the map is spending and where it is answering. */
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
    // Coverage is asked of the sessions that opened a file, since a session that opened none has no destination
    // for the map to have named, and counting it as a miss would report how often sessions read files.
    const opened = worked.filter((session) => session.touched.firstFile !== undefined);
    const landed = opened.filter((session) => session.touched.firstArea !== undefined);
    return {
        // Two coverage readings, and the gap between them is the finding: whether the note named where the
        // session went FIRST, and whether it named anywhere the session went at all.
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
        // Of the areas sessions actually entered, how many had a line saying what they were for. The healthy
        // shape: a manifest edit that drops a description takes a purpose line away silently, and this sees it.
        purposeOnTheAreaUsed: share(landed.filter((session) => usedArea(session, session.touched.firstArea)?.purpose === true).length, landed.length),
        purposeOnAnyRow: share(rows.filter((area) => area.purpose).length, rows.length),
        // The zoom: how often the run was standing inside an area at all, which is what expands a container.
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
        /* The behaviour comparison, and the figures it stood at when this was written, so drift is visible at a
         * glance. Read `claimed` as a date rather than as a target: nothing fails when it moves, but a number
         * that has moved is an invitation to go and read the mechanism. */
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
