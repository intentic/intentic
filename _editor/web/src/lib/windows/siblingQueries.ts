import { focusManager, hashKey, type QueryClient, type QueryKey } from "@tanstack/vue-query";
import { sleep } from "@intentic/base/async";
import { uuid } from "../uuid";

// ONE FETCH SERVES EVERY EDITOR WINDOW THAT IS SHOWING THE SAME READ. People keep the chat in a window of its own beside
// the main one, and each window kept its own cache: every interval poll ran once per window, and every push from the
// daemon was answered by each window fetching the same read at the same moment. Both windows are visible side by side,
// so vue-query's "don't poll a hidden window" never applied.
//
// No window is elected to poll. Whichever window fetches a read says so (`fetching`); a window showing the same read asks
// for the answer (`want`) and gets it (`answer`), written into its own cache with the moment it was read. vue-query
// restarts a read's interval whenever its data changes, so the window that received the answer waits a full interval
// from then, and the window that fetched polls first next time too: one window ends up polling each shared read, with
// nothing to hand over when it closes. A window about to fetch a read that another window started fetching a moment ago
// waits for that answer instead (bounded, and never across a mutation made here since).
//
// Only reads a sibling is showing travel, and only while it is visible: an answer is a structured clone into every
// window on the channel, too dear to send where nobody draws it.

// How recently another window must have started fetching a read for this window to wait on its answer instead of asking
// the daemon itself: two windows answering one push, or one window's interval a moment behind the other's.
const JOIN_WITHIN_MS = 2_000;
// How long a joined fetch is waited on before this window asks the daemon itself: a read slower than this is worth
// asking twice rather than leaving the view waiting on a window that may have gone.
const JOIN_PATIENCE_MS = 45_000;
// How long a window that has just said it is fetching a read listens before asking the daemon. Two windows answering one
// push from the daemon start the same read in the same moment, before either has heard the other, and stay in step
// from then on (each one's interval restarts as its own read lands): the one whose id sorts first fetches, the other
// waits for its answer. A beat against reads that take from a third of a second to tens of them.
export const CLAIM_BEAT_MS = 20;

export type SiblingNote =
    // A window announcing itself, answered by every other with `here`.
    | { readonly kind: `hello`; readonly from: string }
    | { readonly kind: `here`; readonly from: string; readonly to: string }
    // A window going away (pagehide): its fetches will never answer.
    | { readonly kind: `bye`; readonly from: string }
    | { readonly kind: `fetching`; readonly from: string; readonly hash: string; readonly sandbox: string | undefined; readonly at: number }
    | { readonly kind: `want`; readonly from: string; readonly to: string; readonly hash: string }
    | {
          readonly kind: `answer`;
          readonly from: string;
          readonly hash: string;
          readonly sandbox: string | undefined;
          readonly key: QueryKey;
          readonly data: unknown;
          readonly updatedAt: number;
      }
    | { readonly kind: `failed`; readonly from: string; readonly hash: string };

/** How notes leave and arrive: a BroadcastChannel in the app, a shared bus in tests. */
export interface SiblingChannel {
    readonly post: (note: SiblingNote) => void;
    readonly listen: (heard: (note: SiblingNote) => void) => void;
}

export interface SiblingQueries {
    /** Fetches `key` with `fetch`, or takes the answer another window is already fetching for it. */
    readonly fetchShared: <T>(key: QueryKey, fetch: () => Promise<T>) => Promise<T>;
    /** How many other editor windows have said they are open. */
    readonly siblings: () => number;
    /** Says this window is going; its pending answers become failures in the others. */
    readonly leave: () => void;
    /** Says this window is here again (back from the back-forward cache, which the others heard as leaving). */
    readonly rejoin: () => void;
    /** Handles one incoming note; exported so tests can drive a window directly. */
    readonly receive: (note: SiblingNote) => void;
}

interface SiblingFetch {
    readonly from: string;
    readonly sandbox: string | undefined;
    readonly at: number;
}

type Answer = { readonly data: unknown } | undefined;
type CompletedAnswer = Extract<SiblingNote, { kind: `answer` }>;

interface Waiter {
    readonly from: string;
    readonly settle: (answer: Answer) => void;
}

// One window's side of the exchange.
interface Window {
    readonly client: QueryClient;
    readonly channel: SiblingChannel;
    readonly sandbox: () => string | undefined;
    readonly visible: () => boolean;
    readonly now: () => number;
    readonly id: string;
    readonly others: Set<string>;
    // Fetches other windows said they started and have not answered yet, by query hash.
    readonly theirs: Map<string, SiblingFetch>;
    // This window's own fetches in flight, and which of them another window asked for.
    readonly ours: Set<string>;
    readonly wanted: Set<string>;
    // A want can arrive just after the fetch ends. Keep its answer for the same short window in which it can be joined.
    readonly completed: Map<string, CompletedAnswer>;
    readonly waiters: Map<string, Set<Waiter>>;
    // A read started before a change made here may predate it: never joined across one.
    lastMutationAt: number;
}

// Settles the waits on `hash`: every one, or only those joined to `from`'s fetch.
const settle = (here: Window, hash: string, from: string, answer: Answer): void => {
    const waiting = here.waiters.get(hash);
    if (waiting === undefined) {
        return;
    }
    for (const waiter of waiting) {
        if (waiter.from === from) {
            waiting.delete(waiter);
            waiter.settle(answer);
        }
    }
    if (waiting.size === 0) {
        here.waiters.delete(hash);
    }
};

// Whether this window is drawing the read now: only then is another window's answer worth the clone.
const showing = (here: Window, hash: string): boolean => here.visible() && (here.client.getQueryCache().get(hash)?.getObserversCount() ?? 0) > 0;

// Another window's fetch is over, answered or not: nothing more to join.
const finished = (here: Window, from: string, hash: string): void => {
    if (here.theirs.get(hash)?.from === from) {
        here.theirs.delete(hash);
    }
};

const heardAnswer = (here: Window, note: Extract<SiblingNote, { kind: `answer` }>): void => {
    finished(here, note.from, note.hash);
    if (note.sandbox !== here.sandbox()) {
        return;
    }
    settle(here, note.hash, note.from, { data: note.data });
    const query = here.client.getQueryCache().get(note.hash);
    // A read of its own in flight here lands by itself; one already newer than the answer stays.
    if (query === undefined || query.getObserversCount() === 0 || query.state.fetchStatus !== `idle` || query.state.dataUpdatedAt >= note.updatedAt) {
        return;
    }
    here.client.setQueryData(query.queryKey, note.data, { updatedAt: note.updatedAt });
};

const heardBye = (here: Window, from: string): void => {
    here.others.delete(from);
    for (const [hash, fetch] of here.theirs) {
        if (fetch.from === from) {
            here.theirs.delete(hash);
        }
    }
    for (const hash of here.waiters.keys()) {
        settle(here, hash, from, undefined);
    }
};

const heardFetching = (here: Window, note: Extract<SiblingNote, { kind: `fetching` }>): void => {
    here.theirs.set(note.hash, { from: note.from, sandbox: note.sandbox, at: note.at });
    if (note.sandbox === here.sandbox() && showing(here, note.hash)) {
        here.channel.post({ kind: `want`, from: here.id, to: note.from, hash: note.hash });
    }
};

const heardWant = (here: Window, hash: string): void => {
    if (here.ours.has(hash)) {
        here.wanted.add(hash);
        return;
    }
    const completed = here.completed.get(hash);
    if (completed !== undefined && completed.updatedAt >= here.now() - JOIN_WITHIN_MS) {
        answer(here, completed);
    } else {
        // The fetch failed or its answer expired before this request arrived: let the other window fetch now.
        here.channel.post({ kind: `failed`, from: here.id, hash });
    }
};

const receive = (here: Window, note: SiblingNote): void => {
    if (note.from === here.id || (`to` in note && note.to !== here.id)) {
        return;
    }
    here.others.add(note.from);
    if (note.kind === `hello`) {
        here.channel.post({ kind: `here`, from: here.id, to: note.from });
    } else if (note.kind === `bye`) {
        heardBye(here, note.from);
    } else if (note.kind === `fetching`) {
        heardFetching(here, note);
    } else if (note.kind === `want`) {
        heardWant(here, note.hash);
    } else if (note.kind === `answer`) {
        heardAnswer(here, note);
    } else if (note.kind === `failed`) {
        finished(here, note.from, note.hash);
        settle(here, note.hash, note.from, undefined);
    }
};

/** Waits for another window's answer to a read it is fetching; undefined when it failed, left, or took too long. */
const join = (here: Window, hash: string, from: string): Promise<Answer> =>
    new Promise((resolve) => {
        const timer = setTimeout(() => settle(here, hash, from, undefined), JOIN_PATIENCE_MS);
        const waiter: Waiter = {
            from,
            settle: (answer) => {
                clearTimeout(timer);
                resolve(answer);
            },
        };
        here.waiters.set(hash, (here.waiters.get(hash) ?? new Set()).add(waiter));
        here.channel.post({ kind: `want`, from: here.id, to: from, hash });
    });

// The fetch another window started a moment ago for the same read on the same sandbox, after any change made here.
const joinable = (here: Window, hash: string, on: string | undefined): SiblingFetch | undefined => {
    const theirs = here.theirs.get(hash);
    return theirs !== undefined && theirs.sandbox === on && theirs.at >= Math.max(here.lastMutationAt, here.now() - JOIN_WITHIN_MS) ? theirs : undefined;
};

// Hands this window's answer to the windows that asked for it; one no structured clone carries is a failure there.
const answer = (here: Window, note: CompletedAnswer): void => {
    try {
        here.channel.post(note);
        // allow(silent-catch): the window that asked fetches for itself on hearing the failure.
    } catch {
        here.channel.post({ kind: `failed`, from: here.id, hash: note.hash });
    }
};

// Asks the daemon itself, and hands the answer (or the failure) to the windows that asked for it.
const fetchOwn = async <T>(here: Window, key: QueryKey, hash: string, on: string | undefined, fetch: () => Promise<T>): Promise<T> => {
    for (const [heldHash, completed] of here.completed) {
        if (completed.updatedAt < here.now() - JOIN_WITHIN_MS) {
            here.completed.delete(heldHash);
        }
    }
    here.completed.delete(hash);
    here.ours.add(hash);
    try {
        const data = await fetch();
        const completed: CompletedAnswer = { kind: `answer`, from: here.id, hash, sandbox: on, key, data, updatedAt: here.now() };
        here.completed.set(hash, completed);
        if (here.wanted.has(hash)) {
            answer(here, completed);
        }
        return data;
    } catch (error) {
        if (here.wanted.has(hash)) {
            here.channel.post({ kind: `failed`, from: here.id, hash });
        }
        throw error;
    } finally {
        here.ours.delete(hash);
        here.wanted.delete(hash);
    }
};

const fetchThrough = async <T>(here: Window, key: QueryKey, fetch: () => Promise<T>): Promise<T> => {
    const hash = hashKey(key);
    const on = here.sandbox();
    // Started a moment ago elsewhere: that window's answer. Otherwise said, and listened after: the same read asked
    // elsewhere in the same moment is fetched by the window whose id sorts first.
    let theirs = joinable(here, hash, on);
    if (theirs === undefined && here.others.size > 0) {
        here.channel.post({ kind: `fetching`, from: here.id, hash, sandbox: on, at: here.now() });
        here.ours.add(hash);
        await sleep(CLAIM_BEAT_MS);
        const rival = joinable(here, hash, on);
        if (rival !== undefined && rival.from < here.id) {
            // This window's claim is withdrawn: a window that joined it fetches for itself.
            here.ours.delete(hash);
            here.wanted.delete(hash);
            here.channel.post({ kind: `failed`, from: here.id, hash });
            theirs = rival;
        }
    }
    if (theirs !== undefined) {
        const joined = await join(here, hash, theirs.from);
        if (joined !== undefined) {
            // SAFETY: the answer is what the other window's fetch for this same key returned; a key names one read,
            // whichever window asks it.
            return joined.data as T;
        }
    }
    return fetchOwn(here, key, hash, on, fetch);
};

export const createSiblingQueries = (options: {
    readonly client: QueryClient;
    readonly channel: SiblingChannel;
    // The sandbox this window is on: query keys do not name it, and two windows may be on different ones for a moment.
    readonly sandbox: () => string | undefined;
    // Whether this window draws anything now (vue-query's own focus, which is the document's visibility).
    readonly visible?: () => boolean;
    readonly id?: string;
    readonly now?: () => number;
}): SiblingQueries => {
    const here: Window = {
        client: options.client,
        channel: options.channel,
        sandbox: options.sandbox,
        visible: options.visible ?? ((): boolean => focusManager.isFocused()),
        now: options.now ?? Date.now,
        id: options.id ?? uuid(),
        others: new Set(),
        theirs: new Map(),
        ours: new Set(),
        wanted: new Set(),
        completed: new Map(),
        waiters: new Map(),
        lastMutationAt: Number.NEGATIVE_INFINITY,
    };
    here.client.getMutationCache().subscribe(() => {
        here.lastMutationAt = here.now();
    });
    here.channel.listen((note) => receive(here, note));
    const hello = (): void => here.channel.post({ kind: `hello`, from: here.id });
    hello();
    return {
        fetchShared: (key, fetch) => fetchThrough(here, key, fetch),
        siblings: () => here.others.size,
        leave: () => here.channel.post({ kind: `bye`, from: here.id }),
        rejoin: hello,
        receive: (note) => receive(here, note),
    };
};

// THE APP'S OWN: one per window, on one channel per origin. Until it is installed (a test, a page without the app's
// boot), reads simply fetch.
let shared: SiblingQueries | undefined;

/** Starts sharing this window's reads with the editor's other windows; once, at boot (main.ts). */
export const shareQueriesAcrossWindows = (client: QueryClient, sandbox: () => string | undefined): void => {
    if (shared !== undefined || globalThis.BroadcastChannel === undefined) {
        return;
    }
    const bus = new BroadcastChannel(`intentic.queries`);
    shared = createSiblingQueries({
        client,
        sandbox,
        channel: {
            // oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel has no targetOrigin.
            post: (note) => bus.postMessage(note),
            listen: (heard) => bus.addEventListener(`message`, (event: MessageEvent<SiblingNote>) => heard(event.data)),
        },
    });
    window.addEventListener(`pagehide`, () => shared?.leave());
    window.addEventListener(`pageshow`, (event) => {
        if (event.persisted) {
            shared?.rejoin();
        }
    });
};

/** A read through the sibling windows when sharing is on, straight to the daemon otherwise. */
export const fetchShared = <T>(key: QueryKey, fetch: () => Promise<T>): Promise<T> =>
    shared === undefined ? fetch() : shared.fetchShared(key, fetch);

/** How many other editor windows this one knows of. */
export const siblingWindows = (): number => shared?.siblings() ?? 0;
