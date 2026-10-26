// A PROCESS UNDER WAY ON THIS COMPUTER OR FOR IT, as both of the desktop app's faces draw it (2026-10-26). The reader is
// never moved out of the view they are in: a sign-in, this PC's own setup, a sandbox's setup, a folder's, a Docker start,
// a recreate, a fix, a sync, a repair each runs where the reader is, a tile in that view's rail and a page in its place
// (shell/rail/processes/). The app keeps one list of them (desktop-app's processes.rs) and tells both faces: the
// workspace by the `intentic-processes` event below, a local window by its host (localHost.ts `processes`). The
// workspace tells the app about the runs only it holds (a machine of ours, a connected machine) by `intentic://process`,
// and answers what a run asks by `intentic://process-act`, so a question is answered on the page it is drawn on.
//
// A report crosses a process boundary, so nothing in it is taken on trust: a field out of shape is dropped, a report out
// of shape is nothing, a list keeps the reports it can read. The words on screen are the page's own, from `kind`,
// `state`, `waitingFor` and the action ids; the only text a report carries is the owner's (a name the reader typed, a
// requirement's label, the app's own "Step 4 of 10"), shown as it came.

import { z } from "zod";

/** The event the app dispatches on the workspace's window with the whole list (desktop-app's processes.rs `announce`). */
export const DESKTOP_PROCESSES_EVENT = `intentic-processes`;

/** The event the app dispatches on the workspace's window with an answer This computer gave to a run the workspace holds
 * (`origin: "workspace"`), detail `{ id, act, need? }`: the page that runs it acts on it as on its own press. */
export const DESKTOP_PROCESS_ACT_EVENT = `intentic-process-act`;

export const PROCESS_KINDS = [
    `sandbox-setup`,
    `pc-setup`,
    `docker`,
    `folder-setup`,
    `sign-in`,
    `recreate`,
    `fix`,
    `sync`,
    `repair`,
    `engine-move`,
    `first-task`,
] as const;
export type ProcessKind = (typeof PROCESS_KINDS)[number];

/** `done` stays on the rail until it is seen; `stopped` is the reader's own Stop, `failed` anything else that ended it. */
export const PROCESS_STATES = [`running`, `waiting`, `failed`, `stopped`, `done`] as const;
export type ProcessState = (typeof PROCESS_STATES)[number];

/** What a `waiting` run waits for: the reader's go-ahead, Windows ending the session, this PC's own setup (which needs
 * nothing of the reader), the browser a sign-in went to, or an answer to one of its `needs`. */
export const PROCESS_WAITS = [`consent`, `restart`, `signOut`, `pcSetup`, `browser`, `answer`] as const;
export type ProcessWait = (typeof PROCESS_WAITS)[number];

/**
 * What the reader can do about a run, named here and worded by the page (shell/rail/processes/processWords.ts). `open`
 * opens what the run made (a sandbox: on Home in place; elsewhere it is the press that goes there); `use-hosted` takes
 * the sandbox to a machine of ours instead; `fresh-code` runs a setup again on a code minted now; `allow` and `deny`
 * answer one need.
 */
export const PROCESS_ACTIONS = [
    `consent`,
    `stop`,
    `retry`,
    `dismiss`,
    `restart-now`,
    `restart-in-10`,
    `restart-later`,
    `sign-out`,
    `use-hosted`,
    `fresh-code`,
    `open`,
    `sign-in-again`,
    `cancel`,
    `allow`,
    `deny`,
] as const;
export type ProcessAction = (typeof PROCESS_ACTIONS)[number];

/** One thing a run asks of the reader: a requirement to consent to, an approval to give. Its label is the owner's. */
export interface ProcessNeed {
    readonly id: string;
    readonly label: string;
    readonly detail?: string | undefined;
    /** Per-need answers (`allow`, `deny`); a need without them is answered by the run's own actions (`consent`). */
    readonly actions?: readonly ProcessAction[] | undefined;
}

export interface ProcessReport {
    /** Stable for the run's life: `<kind>:<what it is about>` (`sandbox-setup:<sandboxId>`, `folder-setup:<path>`). */
    readonly id: string;
    readonly kind: ProcessKind;
    readonly state: ProcessState;
    /** Who runs it: the app (this computer) or a workspace page (a machine of ours, a connected machine). */
    readonly origin: `app` | `workspace`;
    /** What it is about, as the reader named it: the sandbox's or the folder's name. */
    readonly subject?: string | undefined;
    readonly sandboxId?: string | undefined;
    /** A folder of this computer, for a folder's own sandbox. */
    readonly folder?: string | undefined;
    /** 0–100, where the run measures itself. */
    readonly percent?: number | undefined;
    /** The owner's own words for where it is ("Step 4 of 10") and how long is left ("about 3 min left"). */
    readonly position?: string | undefined;
    readonly remaining?: string | undefined;
    /** The running step's id, for the page's own words where it has them and for analytics. */
    readonly step?: string | undefined;
    /** The owner's one line about the running step, shown as it came. */
    readonly line?: string | undefined;
    readonly waitingFor?: ProcessWait | undefined;
    /** Why a `failed` run stopped, in the owner's words. */
    readonly failure?: string | undefined;
    readonly needs?: readonly ProcessNeed[] | undefined;
    /** What can be done about it now, in the order the page offers it; the first is the main press. */
    readonly actions?: readonly ProcessAction[] | undefined;
    /** When it started and when this report was made, ms since the epoch. */
    readonly startedAt?: number | undefined;
    readonly at?: number | undefined;
}

/** Whether a run asks something of the reader now: the mark its tile wears, and what a notification is put up for. */
export const processAsks = (report: ProcessReport): boolean =>
    report.state === `failed` ||
    (report.state === `waiting` && report.waitingFor !== `pcSetup` && report.waitingFor !== `browser`) ||
    (report.needs ?? []).length > 0;

/** Whether it still works or waits, rather than having ended one way or another. */
export const processLive = (report: ProcessReport): boolean => report.state === `running` || report.state === `waiting`;

const ID = /^[a-z][a-z-]*:\S{1,400}$/;
const ACTION_ID = /^[\w.:-]{1,80}$/;
const text = (max: number) =>
    z
        .string()
        .transform((value) => value.trim())
        .pipe(z.string().min(1).max(max))
        .optional()
        .catch(undefined);
// A list keeps what it can read: one value out of shape is dropped, never the list.
const kept = <T extends z.ZodTypeAny>(item: T) =>
    z
        .array(z.unknown())
        .transform((list) => list.flatMap((value): z.output<T>[] => {
            const read = item.safeParse(value);
            return read.success ? [read.data] : [];
        }));
const actions = kept(z.enum(PROCESS_ACTIONS)).optional().catch(undefined);
const clock = z.number().finite().nonnegative().optional().catch(undefined);

const NeedSchema = z.object({
    id: z.string().regex(ACTION_ID),
    label: z.string().trim().min(1).max(200),
    detail: text(600),
    actions,
});

const ProcessReportSchema = z.object({
    id: z.string().regex(ID),
    kind: z.enum(PROCESS_KINDS),
    state: z.enum(PROCESS_STATES),
    origin: z.enum([`app`, `workspace`]).catch(`app`),
    subject: text(120),
    sandboxId: text(80),
    folder: text(1000),
    percent: z
        .number()
        .finite()
        .transform((value) => Math.min(100, Math.max(0, value)))
        .optional()
        .catch(undefined),
    position: text(80),
    remaining: text(80),
    step: text(80),
    line: text(300),
    waitingFor: z.enum(PROCESS_WAITS).optional().catch(undefined),
    failure: text(600),
    needs: kept(NeedSchema).optional().catch(undefined),
    actions,
    startedAt: clock,
    at: clock,
});

/** A list as it crosses the boundary: the reports it can read, one per id (the last wins), in the order they came. Bare,
 * or as `{ processes }`, the event's own shape. */
export const ProcessListSchema = z
    .union([z.object({ processes: z.array(z.unknown()) }).transform((wrapped) => wrapped.processes), z.array(z.unknown())])
    .catch([])
    .pipe(kept(ProcessReportSchema))
    .transform((reports) => {
        const byId = new Map<string, ProcessReport>();
        for (const report of reports) {
            byId.delete(report.id);
            byId.set(report.id, report);
        }
        return [...byId.values()];
    });

/** The list an `intentic-processes` event carries; nothing for a detail of any other shape. */
export const processesOf = (event: Event): readonly ProcessReport[] | undefined =>
    event instanceof CustomEvent ? ProcessListSchema.parse(event.detail) : undefined;

const ActDetail = z.object({ id: z.string().regex(ID), act: z.enum(PROCESS_ACTIONS), need: z.string().regex(ACTION_ID).optional().catch(undefined) });

/** An answer an `intentic-process-act` carries; nothing for a detail of any other shape. */
export const processActOf = (event: Event): { readonly id: string; readonly act: ProcessAction; readonly need?: string } | undefined => {
    if (!(event instanceof CustomEvent)) {
        return undefined;
    }
    const read = ActDetail.safeParse(event.detail);
    if (!read.success) {
        return undefined;
    }
    const { id, act, need } = read.data;
    return need === undefined ? { id, act } : { id, act, need };
};

/* THE WORKSPACE'S SIDE OF THE CHANNEL: links, since the hosted page has no IPC (desktop.ts says why). */

/** A run only this page holds, told to the app so This computer draws it too; `clear` once it is gone from here. */
export const desktopProcessLink = (report: ProcessReport): string => `intentic://process?${new URLSearchParams({ report: JSON.stringify(report) }).toString()}`;
export const desktopProcessClearLink = (id: string): string => `intentic://process?${new URLSearchParams({ clear: id }).toString()}`;
/** Sent as the page starts listening: the app answers with the whole list at once rather than at its next change. */
export const DESKTOP_PROCESS_HELLO_LINK = `intentic://process?hello=1`;

/** An answer to a run the app holds: an action on the run, or on one of its needs. */
export const desktopProcessActLink = (id: string, act: ProcessAction, need?: string): string => {
    const params = new URLSearchParams({ id, act });
    if (need !== undefined) {
        params.set(`need`, need);
    }
    return `intentic://process-act?${params.toString()}`;
};
