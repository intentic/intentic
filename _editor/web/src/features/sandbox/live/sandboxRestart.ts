import { shallowRef } from "vue";
import { removeStoredValue, storedKeys, storedValue, storeValue } from "../../../lib/browserStorage";

// THE RESTART, AS SOMETHING EVERY SURFACE CAN SAY. Four things end by replacing this sandbox's container — a rebuild
// from a checkout, a hosted environment build, a staged update, a recreate on the host — and each of them reported
// only on the card it was started from. By the time the restart lands the reader is somewhere else, and what reaches
// them there is a workspace that stops answering: a silence every surface was left to read as a fault. This ledger
// holds the one fact they were missing — that the silence was asked for, and by what.
//
// It says nothing on its own. A restart is only worth words while the sandbox is actually quiet, so the join is made
// by the reader (the lane, the gate), never here; what this holds is a standing expectation, not a notice.
//
// Mirrored to localStorage because the container serving this page is the thing being replaced: a reader who reloads
// mid-swap needs the answer more than anyone, and their tab's memory went down with the daemon.

/** What the silence means, in the two lines the lane and the gate both draw. */
export interface RestartQuiet {
    /** Names the restart and whose it is. Never a question: nothing here is being asked. */
    readonly title: string;
    /** How long it takes, what survives it, and that it repairs itself. */
    readonly detail: string;
}

/** The four buttons that end in a swapped container; one record each, however many surfaces hold it. */
export type RestartProducer = "dev-rebuild" | "hosted-build" | "update" | "recreate";

export interface RestartWork {
    /** Platform id of the sandbox this restarts: one box's rebuild never explains another's silence. */
    readonly sandbox: string;
    readonly id: RestartProducer;
    /** Present continuous, for the tile that carries it while the work runs: "Rebuilding from your checkout". */
    readonly what: string;
    readonly quiet: RestartQuiet;
    /**
     * Held until the sandbox answers again rather than by a producer that will end it. For a restart somebody else
     * performs — the platform swapping a hosted sandbox onto an image it just built — where nothing in this browser
     * is told it has begun, and the only honest ending is the sandbox itself coming back.
     */
    readonly untilAnswered?: boolean;
    readonly startedAt: number;
}

/**
 * How long a restart this browser asked for is what a silence means. Every other threshold in the app is patience
 * for silence NOBODY can account for; this one is accounted for, by a press the reader made and a container that is
 * provably being replaced, so it outranks them while it lasts. Well past the half minute a swap takes, and short
 * enough that a restart which never came back stops being called a restart and gets the words that come with a door.
 */
export const RESTART_PATIENCE_MS = 2 * 60_000;

const KEY = `intentic.restart.`;
// A tab closed mid-build leaves its key behind; past this, a record describes a restart nobody is waiting for.
const GOOD_FOR_MS = 60 * 60_000;

const keyOf = (work: { readonly sandbox: string; readonly id: string }): string => `${KEY}${work.sandbox}.${work.id}`;

const isQuiet = (value: unknown): value is RestartQuiet => {
    const quiet = value as Partial<RestartQuiet> | undefined;
    return typeof quiet?.title === `string` && typeof quiet.detail === `string`;
};

// Storage is shared with every version of this app that has ever run in this browser, so a record is checked rather
// than trusted: what comes back is whatever the last build wrote, or whatever somebody typed into devtools.
const isWork = (value: unknown): value is RestartWork => {
    if (typeof value !== `object` || value === null) {
        return false;
    }
    const work = value as Partial<RestartWork>;
    return (
        typeof work.sandbox === `string` &&
        typeof work.id === `string` &&
        typeof work.what === `string` &&
        typeof work.startedAt === `number` &&
        isQuiet(work.quiet)
    );
};

const readWork = (key: string): RestartWork | undefined => {
    try {
        const value: unknown = JSON.parse(storedValue(key) ?? ``);
        return isWork(value) && Date.now() - value.startedAt <= GOOD_FOR_MS ? value : undefined;
    } catch {
        // A half-written or hand-edited record is no record at all.
        return undefined;
    }
};

// One producer's work, and one surface's claim on it. Counted rather than replaced: the root follow and the card that
// draws the same build both declare it, and the record has to outlive whichever of them lets go first.
interface Claim {
    readonly token: symbol;
    readonly work: RestartWork;
}

// Records from before this page load, whose producer went down with the tab. They can explain a silence but never
// claim work is running: nothing here is watching them, and a spinner nobody can end is worse than no spinner.
// allow(module-state): the restart ledger, each record naming its sandbox; it outlives the page on purpose
const carried = shallowRef<readonly RestartWork[]>([]);
// allow(module-state): the restart ledger, each record naming its sandbox; it outlives the page on purpose
const claims = shallowRef<readonly Claim[]>([]);

const hydrate = (): void => {
    const found: RestartWork[] = [];
    for (const key of storedKeys(KEY)) {
        const work = readWork(key);
        if (work === undefined) {
            removeStoredValue(key);
            continue;
        }
        found.push(work);
    }
    carried.value = found;
};

hydrate();

const held = (sandbox: string): readonly RestartWork[] => claims.value.filter((claim) => claim.work.sandbox === sandbox).map((claim) => claim.work);

/**
 * Declares that this producer's work ends in a restart of `sandbox`, until the returned end is called. Producers end
 * it when their own run settles — never when their component unmounts, since walking away doesn't stop a container
 * from being replaced. Ending twice ends it once.
 */
export const expectRestart = (work: Omit<RestartWork, "startedAt">): (() => void) => {
    const claim: Claim = { token: Symbol(work.id), work: { ...work, startedAt: Date.now() } };
    const key = keyOf(work);
    claims.value = [...claims.value, claim];
    carried.value = carried.value.filter((record) => keyOf(record) !== key);
    storeValue(key, JSON.stringify(claim.work));
    return (): void => {
        claims.value = claims.value.filter((current) => current.token !== claim.token);
        // The record outlives this claim if another surface still holds the same work.
        if (!claims.value.some((current) => keyOf(current.work) === key)) {
            removeStoredValue(key);
        }
    };
};

/**
 * The daemon answered, so a restart this browser was waiting on has happened. Ends the records nobody here will end
 * otherwise: those carried over from before this page load, and those a producer left to the sandbox's own return. A
 * producer still following its own work keeps its record — a sandbox answers for the whole of a build, too.
 */
export const restartFinished = (sandbox: string | undefined): void => {
    if (sandbox === undefined) {
        return;
    }
    const done = (work: RestartWork): boolean => work.sandbox === sandbox && work.untilAnswered === true;
    for (const work of [...carried.value.filter((record) => record.sandbox === sandbox), ...claims.value.map((claim) => claim.work).filter(done)]) {
        removeStoredValue(keyOf(work));
    }
    carried.value = carried.value.filter((record) => record.sandbox !== sandbox);
    claims.value = claims.value.filter((claim) => !done(claim.work));
};

/** What to say about this sandbox being quiet; the newest record wins. Undefined when nothing here asked for one. */
export const restartExpected = (sandbox: string | undefined): RestartWork | undefined => {
    if (sandbox === undefined) {
        return undefined;
    }
    return [...held(sandbox), ...carried.value.filter((record) => record.sandbox === sandbox)].sort((a, b) => b.startedAt - a.startedAt)[0];
};

/** The sandbox tile's sentence while work that ends in a restart is running here; several are counted, not listed. */
export const restartRunning = (sandbox: string | undefined): string | undefined => {
    const running = sandbox === undefined ? [] : [...new Map(held(sandbox).map((work) => [work.id, work])).values()];
    const first = running[0];
    if (first === undefined) {
        return undefined;
    }
    return running.length === 1 ? first.what : `${running.length} running`;
};

/** Test seam: the ledger is module state, and a leaked expectation would follow one test into the next. */
export const forgetRestarts = (): void => {
    for (const work of [...carried.value, ...claims.value.map((claim) => claim.work)]) {
        removeStoredValue(keyOf(work));
    }
    carried.value = [];
    claims.value = [];
};
