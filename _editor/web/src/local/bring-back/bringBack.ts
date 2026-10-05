import { z } from "zod";
import type { SyncDirection } from "../../app/environments/local";

// Bringing an agent's work back from a folder's own sandbox (the desktop app keeps the two in sync, copy-first by
// default): what the app answers each sandbox verb with, read off the `intentic:project` event, and the state the
// window's Bring back section draws. Pure, so the whole exchange is testable without a window or an app.

const Direction = z.enum([`to-sandbox`, `both`]);
const ChangeKind = z.enum([`added`, `modified`, `deleted`]);
// `conflict`: changed in the folder too, so a bring-back keeps the folder's copy. Any other field is dropped unread.
const Change = z.object({ path: z.string().min(1), kind: ChangeKind, size: z.number().optional(), conflict: z.boolean().optional() });
const Failed = z.object({ ok: z.literal(false), error: z.string() });
const Skipped = z.object({ path: z.string(), reason: z.string() });

/** One entry the sandbox changed that the folder has not: what the review lists, each with its A/M/D mark. */
export type SandboxChange = z.infer<typeof Change>;
/** An entry a bring-back left alone, and why (the folder's copy changed too, say). */
export type SkippedEntry = z.infer<typeof Skipped>;

const ProjectAnswer = z.discriminatedUnion(`kind`, [
    z.object({
        kind: z.literal(`changes`),
        result: z.union([
            z.object({
                ok: z.literal(true),
                direction: Direction,
                changes: z.array(Change),
                truncated: z.boolean().optional(),
            }),
            Failed,
        ]),
    }),
    z.object({
        kind: z.literal(`brought-back`),
        result: z.union([
            z.object({
                ok: z.literal(true),
                point: z.string().min(1),
                applied: z.array(z.object({ path: z.string(), kind: ChangeKind })),
                skipped: z.array(Skipped).optional(),
            }),
            Failed,
        ]),
    }),
    z.object({
        kind: z.literal(`restored`),
        // What a restore skipped is only counted here, so its entries are not held to a shape.
        result: z.union([z.object({ ok: z.literal(true), restored: z.number(), skipped: z.array(z.unknown()).optional() }), Failed]),
    }),
    z.object({ kind: z.literal(`direction`), result: z.union([z.object({ ok: z.literal(true), direction: Direction }), Failed]) }),
    // A verb that never reached its sandbox, such as when no machine agent runs on this computer.
    z.object({ kind: z.literal(`error`), verb: z.string(), error: z.string() }),
]);

export type ProjectAnswer = z.infer<typeof ProjectAnswer>;

/** The answer an `intentic:project` event carries, or nothing for a detail of any other shape. */
export const projectAnswer = (event: Event): ProjectAnswer | undefined => {
    if (!(event instanceof CustomEvent)) {
        return undefined;
    }
    const answer = ProjectAnswer.safeParse(event.detail);
    return answer.success ? answer.data : undefined;
};

/** Where the section stands: each asking step waits for the one answer that ends it. */
export type BringBackStep =
    | { readonly at: `idle` }
    | { readonly at: `checking` }
    | { readonly at: `checked`; readonly changes: readonly SandboxChange[]; readonly truncated: boolean }
    | { readonly at: `bringing`; readonly count: number }
    | { readonly at: `brought`; readonly point: string; readonly count: number; readonly skipped: readonly SkippedEntry[] }
    | { readonly at: `restoring` }
    | { readonly at: `restored`; readonly count: number }
    | { readonly at: `failed`; readonly error: string };

export interface BringBackState {
    readonly step: BringBackStep;
    // Which way the folder syncs, once an answer has said; nothing is assumed before.
    readonly direction: SyncDirection | undefined;
    // A switch of direction on its way, and what the last one said when it failed. Apart from `step`, so a failed
    // switch never costs the reader a receipt's Undo.
    readonly switching: boolean;
    readonly switchError: string | undefined;
}

export const IDLE: BringBackState = { step: { at: `idle` }, direction: undefined, switching: false, switchError: undefined };

const failed = (state: BringBackState, error: string): BringBackState => ({ ...state, step: { at: `failed`, error } });

/** The state an answer leaves: each kind settles the step that asked for it. */
export const answered = (state: BringBackState, answer: ProjectAnswer): BringBackState => {
    switch (answer.kind) {
        case `changes`: {
            const { result } = answer;
            return result.ok
                ? { ...state, direction: result.direction, step: { at: `checked`, changes: result.changes, truncated: result.truncated === true } }
                : failed(state, result.error);
        }
        case `brought-back`: {
            const { result } = answer;
            return result.ok
                ? { ...state, step: { at: `brought`, point: result.point, count: result.applied.length, skipped: result.skipped ?? [] } }
                : failed(state, result.error);
        }
        case `restored`: {
            const { result } = answer;
            return result.ok ? { ...state, step: { at: `restored`, count: result.restored } } : failed(state, result.error);
        }
        case `direction`: {
            const { result } = answer;
            return result.ok
                ? { ...state, direction: result.direction, switching: false, switchError: undefined }
                : { ...state, switching: false, switchError: result.error };
        }
        default:
            return answer.verb === `direction` ? { ...state, switching: false, switchError: answer.error } : failed(state, answer.error);
    }
};

/** What the review starts with chosen: every change but those changed on both sides, which a bring-back keeps as yours. */
export const firstChosen = (changes: readonly SandboxChange[]): ReadonlySet<string> =>
    new Set(changes.flatMap((change) => (change.conflict === true ? [] : [change.path])));

// The most changes one bring-back names. The list rides the app's link as JSON, and past this many a reader is better
// served bringing the rest back in another pass than by a link the size of a small file.
export const BRING_BACK_CAP = 2000;

/**
 * What a bring-back sends as its `paths`: the chosen changes, in the review's order, and always by name, even when every
 * one is chosen. Without the list the app takes whatever the sandbox holds when the link lands, which an agent still at
 * work may have added to since the review, deletions included.
 */
export const chosenPaths = (changes: readonly SandboxChange[], chosen: ReadonlySet<string>): readonly string[] =>
    changes.flatMap((change) => (chosen.has(change.path) ? [change.path] : []));
