import { join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import type { BrowsingForget, BrowsingHistory } from "@intentic/sandbox-contract/schemas/browsing";
import { z } from "zod";
import { stateRelPath } from "../../state-paths.js";
import { defineDocument } from "../../store/evolution/documents.js";
import { openDirectory } from "../../store/open-document.js";
import type { JsonDir } from "../../store/plain-files/json-dir.js";
import { BrowsingIndex, type IndexFile, SNAPSHOT_LIMIT, type VisitKind } from "./browsing-index.js";
import type { ChromiumHistory } from "./chromium-history.js";

// Each browser profile's history index (browsing-index.ts), one file per profile beside the profiles themselves
// (`.intentic/local/browser/_history/`; the underscore is a name no account's profile takes, as `_own` is). Loaded on
// first use, seeded once from Chromium's own History where the profile has one, and saved a moment after it changes,
// so a page loading in bursts is one write rather than dozens; a forget is saved at once, since it is asked for to be
// gone.
//
// A cache in what it holds, which Chromium's own record can mostly rebuild for a persistent profile; but an agent's
// credential-free browser keeps no profile at all, so this is the only record of where it went, and it is a document.

const RecentVisitSchema = z.object({ at: z.number(), typed: z.boolean().optional() });
const BrowsingFileSchema = z.object({
    // The profile's own key, which the file name only approximates (an account id may hold characters a file id may not).
    profile: z.string(),
    // Whether Chromium's own History was taken in already, so it is read once, not on every start.
    seeded: z.boolean(),
    entries: z.array(
        z.object({
            url: z.string(),
            title: z.string().optional(),
            visits: z.number().int().nonnegative(),
            typed: z.number().int().nonnegative(),
            last: z.number(),
            recent: z.array(RecentVisitSchema),
        }),
    ),
    terms: z.array(z.object({ term: z.string(), count: z.number().int().positive(), last: z.number() })),
});
type BrowsingFile = z.infer<typeof BrowsingFileSchema>;

export const browsingHistoryDocument = defineDocument({
    path: stateRelPath(".intentic/local/browser/", "_history"),
    directory: true,
    schema: BrowsingFileSchema,
});

// A profile key as a file id: what jsonDir takes is narrower than an account id, so anything else is spelled out.
const fileIdOf = (profile: string): string => `p-${profile.replaceAll(/[^a-zA-Z0-9_-]/g, "_")}`.slice(0, 60);

const SAVE_DELAY_MS = 2000;

// What went wrong, for the daemon's log: which profile, and the error in words.
export interface BrowsingProblem {
    readonly profile: string;
    readonly err: string;
}

export interface BrowsingStoreDeps {
    // The workspace root, under which the files live.
    readonly root: string;
    // Chromium's own record of a profile, for the one-time seed; undefined where the profile keeps none.
    readonly chromiumHistory: (profile: string) => Promise<ChromiumHistory | undefined>;
    readonly warn: (problem: BrowsingProblem, message: string) => void;
    readonly now?: () => number;
    readonly saveDelayMs?: number;
}

export interface BrowsingStore {
    readonly read: (profile: string, since: string | undefined, limit?: number) => Promise<BrowsingHistory>;
    readonly forget: (profile: string, what: BrowsingForget) => Promise<number>;
    readonly visit: (profile: string, url: string, kind: VisitKind, title?: string) => void;
    readonly retitle: (profile: string, url: string, title: string) => void;
    // Every pending save, done: for a test, and for a daemon going down.
    readonly flush: () => Promise<void>;
}

interface Saver {
    // Now, after whatever save of the profile is already under way.
    readonly now: (profile: string, index: BrowsingIndex) => Promise<void>;
    // A moment from now, once, however many changes arrive meanwhile.
    readonly soon: (profile: string, index: BrowsingIndex) => void;
    readonly flush: () => Promise<void>;
}

const saver = (files: JsonDir<BrowsingFile>, deps: BrowsingStoreDeps): Saver => {
    const timers = new Map<string, { readonly timer: NodeJS.Timeout; readonly index: BrowsingIndex }>();
    const saving = new Map<string, Promise<void>>();
    const write = async (profile: string, file: BrowsingFile): Promise<void> => {
        try {
            await files.write(fileIdOf(profile), file);
        } catch (err) {
            deps.warn({ profile, err: errorMessage(err) }, "browsing history: could not save");
        }
    };
    const now = (profile: string, index: BrowsingIndex): Promise<void> => {
        const pending = timers.get(profile);
        if (pending !== undefined) {
            clearTimeout(pending.timer);
            timers.delete(profile);
        }
        // Taken now, so what is written is the index as it stands when asked, whatever it becomes meanwhile.
        const file: BrowsingFile = { profile, ...structuredClone(index.toFile()) };
        const next = (saving.get(profile) ?? Promise.resolve()).then(() => write(profile, file));
        saving.set(profile, next);
        return next;
    };
    return {
        now,
        soon: (profile, index) => {
            if (!timers.has(profile)) {
                timers.set(profile, { index, timer: setTimeout(() => void now(profile, index), deps.saveDelayMs ?? SAVE_DELAY_MS) });
            }
        },
        flush: async () => {
            await Promise.all([...timers.entries()].map(([profile, pending]) => now(profile, pending.index)));
            await Promise.all(saving.values());
        },
    };
};

export const browsingStore = (deps: BrowsingStoreDeps): BrowsingStore => {
    const now = deps.now ?? Date.now;
    const files = openDirectory(browsingHistoryDocument, join(deps.root, browsingHistoryDocument.path));
    const save = saver(files, deps);
    const loaded = new Map<string, Promise<BrowsingIndex>>();

    // The seed is best effort: a copy taken while Chromium was mid-write can fail to open, and is tried again on the
    // next start rather than marked done.
    const seed = async (profile: string, index: BrowsingIndex): Promise<void> => {
        try {
            const history = await deps.chromiumHistory(profile);
            index.seed(history?.pages ?? [], history?.terms ?? []);
            await save.now(profile, index);
        } catch (err) {
            deps.warn({ profile, err: errorMessage(err) }, "browsing history: could not read Chromium's own history");
        }
    };

    // Unreadable by this build: set aside where a hand can still recover it, and started over either way.
    const setAside = async (profile: string, why: string): Promise<void> => {
        deps.warn({ profile, err: why }, "browsing history: unreadable, starting over");
        try {
            await files.setAside(fileIdOf(profile));
        } catch (err) {
            deps.warn({ profile, err: errorMessage(err) }, "browsing history: could not set the unreadable file aside");
        }
    };

    const load = async (profile: string): Promise<BrowsingIndex> => {
        let file: IndexFile | undefined;
        try {
            file = await files.read(fileIdOf(profile));
        } catch (err) {
            await setAside(profile, errorMessage(err));
        }
        const index = new BrowsingIndex(file);
        if (!index.seeded) {
            await seed(profile, index);
        }
        return index;
    };

    const open = (profile: string): Promise<BrowsingIndex> => {
        const opening = loaded.get(profile) ?? load(profile);
        loaded.set(profile, opening);
        return opening;
    };

    // Every profile with a file when first asked, and every one opened since: what the history page offers to switch
    // between. Listed once, since a listing reads every file whole.
    let listed: Promise<readonly string[]> | undefined;
    const profiles = async (): Promise<string[]> => {
        listed ??= files.list().then(
            (found) => found.entries.map((entry) => entry.profile),
            () => [],
        );
        return [...new Set([...(await listed), ...loaded.keys()])].toSorted();
    };

    // A change to an index that is still loading lands once it has; a flush waits for it to.
    const landing = new Set<Promise<void>>();
    const change = (profile: string, apply: (index: BrowsingIndex) => boolean): void => {
        const applied = open(profile).then((index) => {
            if (apply(index)) {
                save.soon(profile, index);
            }
        });
        landing.add(applied);
        void applied.finally(() => landing.delete(applied));
    };

    return {
        read: async (profile, since, limit = SNAPSHOT_LIMIT) => {
            const index = await open(profile);
            return { profile, ...index.read(since, now(), limit), profiles: await profiles() };
        },
        forget: async (profile, what) => {
            const index = await open(profile);
            const removed = index.forget(what);
            await save.now(profile, index);
            return removed;
        },
        visit: (profile, url, kind, title) => change(profile, (index) => index.visit(url, kind, now(), title)),
        retitle: (profile, url, title) => change(profile, (index) => index.retitle(url, title)),
        flush: async () => {
            await Promise.all(landing);
            await save.flush();
        },
    };
};
