import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { experimentArm } from "@intentic/agent-context/experiments";
import type { Options } from "./features.js";
import { isMissing } from "./runtime.js";

// Which arm each session drew for each measured mechanism, and what it was sent, written once as the session opens. The
// transcript says what the session then did; this says what it was given, and /intentic:stats joins the two.

// The salts the sandbox draws with (the daemon's decide/experiments.ts), so one id draws the same arm in both.
export const SALTS = { map: "workspace-map", notes: "field-notes", iq: "iq-search" } as const;

export type Mechanism = keyof typeof SALTS;

// True treated, false held out; absent when the mechanism is off or nothing is being measured.
export type Arms = { readonly [K in Mechanism]?: boolean };

export interface SessionRow {
    readonly ts: number;
    readonly session: string;
    readonly project: string;
    readonly transcript?: string;
    readonly arms: Arms;
    // What rode in: characters of the map and notes, whether the iq teaching went, and which notes revision.
    readonly sent: { readonly map?: number; readonly notes?: number; readonly iq?: boolean };
    readonly notesRevision?: string;
}

const MECHANISM_ON: { readonly [K in Mechanism]: (options: Options) => boolean } = {
    map: (options) => options.project_map,
    notes: (options) => options.field_notes,
    iq: (options) => options.iq,
};

// A session is measured only while its mechanism is on and something is held out; otherwise it is simply treated.
export const armsOf = (options: Options, session: string | undefined): Arms => {
    const arms: { -readonly [K in Mechanism]?: boolean } = {};
    for (const mechanism of Object.keys(SALTS) as Mechanism[]) {
        if (MECHANISM_ON[mechanism](options) && options.holdout > 0 && session !== undefined) {
            arms[mechanism] = experimentArm(SALTS[mechanism], session, options.holdout);
        }
    }
    return arms;
};

// Whether a mechanism goes to this session: on, and not drawn into the control.
export const sends = (options: Options, arms: Arms, mechanism: Mechanism): boolean => MECHANISM_ON[mechanism](options) && arms[mechanism] !== false;

// The arms worth recording: only for a mechanism that had something to give this session. With no areas to map, no
// notes written yet, or no iq installed, both arms were sent the same nothing, and counting that session would compare
// it against itself.
export const measuredArms = (arms: Arms, offered: { readonly [K in Mechanism]?: boolean }): Arms =>
    Object.fromEntries(Object.entries(arms).filter(([mechanism]) => offered[mechanism as Mechanism] === true));

export const sessionsFile = (data: string): string => join(data, "sessions.jsonl");

export const recordSession = (data: string, row: SessionRow): void => {
    const file = sessionsFile(data);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(row)}\n`);
};

// Every recorded session, newest record per session id winning; unreadable lines are skipped.
export const readSessions = (data: string): SessionRow[] => {
    let text: string;
    try {
        text = readFileSync(sessionsFile(data), "utf8");
    } catch (error) {
        // Nothing recorded yet is an empty ledger; one that is there and unreadable is not, and the report says so.
        if (isMissing(error)) {
            return [];
        }
        throw error;
    }
    const byId = new Map<string, SessionRow>();
    for (const line of text.split("\n")) {
        if (line.trim() === "") {
            continue;
        }
        try {
            const row = JSON.parse(line) as SessionRow;
            if (typeof row.session === "string" && typeof row.project === "string") {
                byId.set(row.session, row);
            }
        } catch {
            // A torn line from a crashed write is one lost session, not a lost ledger.
            continue;
        }
    }
    return [...byId.values()];
};
