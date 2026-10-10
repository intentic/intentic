import { formatFixed } from "@intentic/ui/format";
import type { EngineId, EngineMoveEnd, EngineMoveEvent, EngineStatus, MoveTarget } from "../desktop";

// A MOVE BETWEEN ENGINES, READ (src-tauri/src/engine.rs runs it, engine.ts holds it, components/EngineCard.vue draws it):
// what the card offers for the engine this PC runs on, how far a move has got from the steps ic prints, how it ended,
// and the copies moves left behind. Pure, so each case is tested by value (engineMove.test.ts).

/** The engines a card names: a computer that is not a Windows PC has one engine of its own, and no card. */
export type PcEngine = Exclude<EngineId, `native`>;

/** One of the two, from whatever ic or an event said. */
export const pcEngineOf = (value: unknown): PcEngine | undefined => (value === `intentic` || value === `dockerDesktop` ? value : undefined);

/** The engine a move goes to, as ic names it, from the command line's spelling. */
export const engineOf = (target: MoveTarget): PcEngine => (target === `docker-desktop` ? `dockerDesktop` : `intentic`);

/** What the card puts in front of the reader, for where this PC is. */
export type EngineOffer =
    // On Docker Desktop, with the move worth putting in front of the reader: "Not now" beside it.
    | `offer`
    // On Docker Desktop, the move in reach.
    | `optIn`
    // On Docker Desktop, kept there by a sandbox that was handed the GPU.
    | `gpu`
    // On Intentic's engine, with Docker Desktop installed: the way back, quietly.
    | `back`
    // Nothing to move between: the engine named, and nothing else.
    | `none`;

export const offerOf = (status: EngineStatus): EngineOffer => {
    if (status.engine === `dockerDesktop`) {
        if (status.gpu) {
            return `gpu`;
        }
        if (!status.canMove) {
            return `none`;
        }
        return status.offerMove ? `offer` : `optIn`;
    }
    return status.engine === `intentic` && status.canMove ? `back` : `none`;
};

/** Where a move from this PC goes: the other engine, when a move is possible. */
export const moveTargetOf = (status: EngineStatus): MoveTarget | undefined => {
    switch (offerOf(status)) {
        case `offer`:
        case `optIn`:
            return `intentic`;
        case `back`:
            return `docker-desktop`;
        default:
            return undefined;
    }
};

/** A sandbox's step, as ic names them. */
export type MoveStep = `begin` | `stopping` | `image` | `volume` | `starting` | `moved`;
const STEPS: ReadonlySet<string> = new Set<MoveStep>([`begin`, `stopping`, `image`, `volume`, `starting`, `moved`]);

/** Who started a move, which decides what ends it on this window's screen. */
export type MoveSource =
    // This window: its steps and its end reach it as every window's do; its own answer reports it.
    | `ours`
    // Another window of this app: its steps reach this one, and its end does too.
    | `heard`
    // Somewhere this app does not hear (Repair, a terminal): known only from the status, which says when it is over.
    | `status`;

/** How far a move has got. */
export interface MoveProgress {
    readonly source: MoveSource;
    /** Where it goes; unknown only for one seen in a status from an ic that does not say. */
    readonly to?: PcEngine;
    /** Intentic's engine being installed first, before any sandbox moves: ic's sentence and how far, in percent. */
    readonly install?: { readonly sentence: string; readonly percent?: number };
    /** The sandbox moving now, which of how many (from 0), and its step. */
    readonly slug?: string;
    readonly index?: number;
    readonly count?: number;
    readonly step?: MoveStep;
    /** A copy's bytes so far, and of how many: exact for a sandbox's files, ic's estimate for its image. */
    readonly done?: number;
    readonly total?: number;
    /** Sandboxes already on the other engine. */
    readonly moved: number;
}

export const startMove = (to: PcEngine | undefined, source: MoveSource): MoveProgress => (to === undefined ? { source, moved: 0 } : { source, to, moved: 0 });

const textOf = (value: unknown): string | undefined => (typeof value === `string` ? value : undefined);
const amountOf = (value: unknown): number | undefined => (typeof value === `number` && Number.isFinite(value) && value >= 0 ? value : undefined);

// A step with no copy under way, and no install either: what each sandbox's steps start from.
const atStep = (progress: MoveProgress, step: MoveStep): MoveProgress => {
    const { done: _done, total: _total, install: _install, ...rest } = progress;
    return { ...rest, step };
};

// A copy's bytes: the announcement says what it copies (and, for files, how much); every line after it says how far.
const copying = (progress: MoveProgress, step: `image` | `volume`, event: EngineMoveEvent): MoveProgress => {
    const done = amountOf(event[`done`]) ?? 0;
    const total = amountOf(event[`total`]);
    const next = { ...atStep(progress, step), done };
    return total === undefined ? next : { ...next, total };
};

/** One step of a move, folded into how far it has got. `done`, `failed` and `exit` are its ending, read by `endOf`. */
export const foldMove = (progress: MoveProgress, event: EngineMoveEvent): MoveProgress => {
    const to = progress.to ?? pcEngineOf(event.to);
    const known = to === undefined ? progress : { ...progress, to };
    if (event.step === `engine`) {
        const sentence = textOf(event[`sentence`]);
        const percent = amountOf(event[`percent`]);
        if (sentence === undefined) {
            return known;
        }
        return { ...known, install: percent === undefined ? { sentence } : { sentence, percent: Math.min(100, percent) } };
    }
    if (!STEPS.has(event.step)) {
        return known;
    }
    const step = event.step as MoveStep;
    const slug = textOf(event.slug);
    // Another sandbox than the one in hand: from its `begin`, or heard part way through, when which one it is is unknown.
    const sandbox: MoveProgress =
        slug === undefined || slug === `` || slug === known.slug
            ? known
            : (({ index: _index, ...rest }) => ({ ...rest, slug }))(known);
    switch (step) {
        case `begin`: {
            const index = amountOf(event[`index`]);
            const count = amountOf(event[`count`]);
            const begun = atStep(sandbox, `begin`);
            return { ...begun, ...(index === undefined ? {} : { index }), ...(count === undefined ? {} : { count }) };
        }
        case `image`:
        case `volume`:
            return copying(sandbox, step, event);
        case `moved`:
            return { ...atStep(sandbox, `moved`), moved: sandbox.moved + 1 };
        default:
            return atStep(sandbox, step);
    }
};

/** How full the bar is, in percent, for a step that can say: a sandbox's files, the install's own percent. Undefined for
 *  every other step, an image's included, whose total is only ic's estimate: the bar goes on moving instead. */
export const barOf = (progress: MoveProgress): number | undefined => {
    if (progress.step === undefined) {
        return progress.install?.percent;
    }
    if (progress.step === `volume` && progress.total !== undefined && progress.total > 0) {
        return Math.min(100, Math.round((100 * (progress.done ?? 0)) / progress.total));
    }
    return undefined;
};

const OUTCOMES: ReadonlySet<string> = new Set<EngineMoveEnd[`outcome`]>([`moved`, `failed`, `busy`]);

/** A move's end, from the `exit` step every window hears (engine.rs `MoveEnd`); undefined for any other step. */
export const endOf = (event: EngineMoveEvent): EngineMoveEnd | undefined => {
    const outcome = event[`outcome`];
    if (event.step !== `exit` || typeof outcome !== `string` || !OUTCOMES.has(outcome)) {
        return undefined;
    }
    const code = event[`code`];
    return {
        outcome: outcome as EngineMoveEnd[`outcome`],
        code: typeof code === `number` ? code : null,
        putBack: event[`putBack`] === true,
        ran: event[`ran`] !== false,
        engine: pcEngineOf(event[`engine`]) ?? null,
        count: amountOf(event[`count`]) ?? null,
        reason: textOf(event[`reason`]) ?? null,
        log: textOf(event[`log`]) ?? null,
    };
};

/** The copies moves left, by the engine that keeps them, each with the day the last of them is removed. */
export interface KeptCopies {
    readonly on: PcEngine;
    /** Epoch ms. */
    readonly until: number;
    readonly count: number;
}

export const keptCopiesOf = (status: EngineStatus | undefined): KeptCopies[] => {
    const kept = new Map<PcEngine, KeptCopies>();
    for (const copy of status?.moves?.leftBehind ?? []) {
        const on = pcEngineOf(copy.on);
        if (on === undefined) {
            continue;
        }
        const held = kept.get(on);
        kept.set(on, { on, until: Math.max(held?.until ?? 0, copy.removeAfter), count: (held?.count ?? 0) + 1 });
    }
    return [...kept.values()];
};

/** Bytes as ic says them in its own lines: decimal gigabytes, to one place. Under a tenth of one, whole megabytes: a
 *  sandbox's history and Docker volumes are a few megabytes, and "0.0 GB of 0.0 GB" said nothing (omen, 2026-10-10). */
export const gigabytes = (bytes: number): string =>
    bytes < 1e8 ? `${formatFixed(Math.round(bytes / 1e6), 0)} MB` : `${formatFixed(bytes / 1e9, 1)} GB`;
