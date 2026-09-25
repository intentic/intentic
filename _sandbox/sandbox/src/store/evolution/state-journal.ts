import { copyFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { z } from "zod";
import { stateRelPath } from "../../state-paths.js";
import type { DocumentRoot } from "./documents.js";
import { asideOf, writeJsonFile } from "../json-file.js";

// The write-ahead journal of one conversion episode: before the boot step changes a file it copies the file aside
// (its pre-image), and the episode stays open until the new version has booted all the way. A build that finds an
// open episode opened by any other conversion set (its digest) restores the pre-images before it opens a single store,
// which is how a rollback lands on the files the previous version left rather than the ones the new version had
// started converting.
// Committed episodes keep their pre-images for a grace window, a hand-restorable record of what each update changed.
// Every build reads the journal every other build wrote, a rolled-back one included, so it is read one episode at a
// time: an episode this build cannot read (a newer build's shape) is logged and kept as written, never dropped by a
// rewrite, and the rest still restore.

// How long committed pre-images, and earlier document addresses left beside their current one, are kept.
export const GRACE_MS = 7 * 24 * 60 * 60 * 1000;

// Loose, like every object below: a key a newer build adds survives this build's rewrite of the journal.
const EntrySchema = z.looseObject({
    path: z.string(),
    // Where the file's bytes were copied before the episode changed it; null when it did not exist yet.
    preImage: z.string().nullable(),
    // Set when the episode renamed a tree here from this path: a rollback renames it back instead of deleting it.
    movedFrom: z.string().optional(),
});

const EpisodeSchema = z.looseObject({
    id: z.string(),
    // The conversion count builds before the digest identify an episode by; still written for them.
    engine: z.number(),
    // Which conversion set opened it (documents.ts, conversionDigest): only a build with the same one resumes it.
    // Absent from an episode a build before the digest opened, which every later build puts back.
    digest: z.string().optional(),
    version: z.string(),
    state: z.enum(["open", "committed"]),
    startedAt: z.number(),
    committedAt: z.number().optional(),
    entries: z.array(EntrySchema),
});
export type Episode = z.infer<typeof EpisodeSchema>;

export interface Journal {
    readonly episodes: readonly Episode[];
    // An earlier document address still present beside its current one, and when it was first seen so.
    readonly moved: Readonly<Record<string, number>>;
    // What this build read but could not use, written back as it stands: episodes it cannot read, and the keys it
    // does not know (a daemon before 2026-09-25 kept its rename windows under `renames`).
    readonly kept: { readonly episodes: readonly unknown[]; readonly keys: Readonly<Record<string, unknown>> };
    // The file was there and not a journal at all (not JSON, or not an object): the next write sets it aside first.
    readonly damaged?: true;
}

export const emptyJournal = (): Journal => ({ episodes: [], moved: {}, kept: { episodes: [], keys: {} } });

export const journalPath = (historyRoot: string): string => join(historyRoot, "state-journal.json");

// What reading the journal needs of a logger; a pino logger is one.
export interface JournalLogger {
    readonly warn: (fields: object, message: string) => void;
}

const MovedSchema = z.record(z.string(), z.number());

// One episode at a time: a reject costs that episode (kept, logged), never the rest. An unreadable `moved` reads as
// nothing seen yet, which only delays removing an earlier address by one grace window.
export const readJournal = async (historyRoot: string, logger?: JournalLogger): Promise<Journal> => {
    const path = journalPath(historyRoot);
    const text = await readFile(path, "utf8").catch(undefinedIfMissing);
    if (text === undefined) {
        return emptyJournal();
    }
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        // silent-catch: not JSON is reported just below, with a file that is JSON but not a journal
        raw = undefined;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        logger?.warn({ path }, "state: the conversion journal is not one this build can read; it is set aside on the next write, its pre-images left where they are");
        return { ...emptyJournal(), damaged: true };
    }
    const { episodes: rawEpisodes, moved: rawMoved, ...keys } = raw as Record<string, unknown>;
    const episodes: Episode[] = [];
    const unread: unknown[] = [];
    for (const [index, candidate] of (Array.isArray(rawEpisodes) ? rawEpisodes : []).entries()) {
        const parsed = EpisodeSchema.safeParse(candidate);
        if (parsed.success) {
            episodes.push(parsed.data);
            continue;
        }
        unread.push(candidate);
        logger?.warn(
            { path, index, id: (candidate as { id?: unknown } | null)?.id, issue: parsed.error.issues[0]?.message },
            "state: a conversion episode is not one this build can read (a newer build's, or damaged); it is kept as written and not restored",
        );
    }
    if (rawEpisodes !== undefined && !Array.isArray(rawEpisodes)) {
        logger?.warn({ path }, "state: the conversion journal's episodes are not a list; kept as written");
        keys["episodes"] = rawEpisodes;
    }
    const moved = MovedSchema.safeParse(rawMoved ?? {});
    if (!moved.success) {
        logger?.warn({ path }, "state: the conversion journal's earlier addresses are not readable; treated as first seen now");
    }
    return { episodes, moved: moved.data ?? {}, kept: { episodes: unread, keys } };
};

const isJournalObject = async (path: string): Promise<boolean> => {
    const text = await readFile(path, "utf8").catch(undefinedIfMissing);
    if (text === undefined) {
        return true;
    }
    try {
        const raw: unknown = JSON.parse(text);
        return typeof raw === "object" && raw !== null && !Array.isArray(raw);
    } catch {
        // silent-catch: not JSON is exactly the damaged file this asks about; the answer is the report
        return false;
    }
};

export const writeJournal = async (historyRoot: string, journal: Journal): Promise<void> => {
    const path = journalPath(historyRoot);
    // Only while the file is still what could not be read: a journal already written over it is this build's own.
    if (journal.damaged === true && !(await isJournalObject(path))) {
        await rename(path, await asideOf(path)).catch(undefinedIfMissing);
    }
    const { episodes, moved, kept } = journal;
    await writeJsonFile(path, { ...kept.keys, episodes: [...episodes, ...kept.episodes], moved });
};

// Where each volume keeps pre-images: in its own secret class, so a copy of a vault never lands anywhere backed up.
const preImageRoot = (roots: Readonly<Record<DocumentRoot, string>>, root: DocumentRoot, episode: string): string => {
    switch (root) {
        case "workspace":
            return join(roots.workspace, stateRelPath(".intentic/secrets/converting/"), episode);
        case "history": {
            const historyRoot = roots.history;
            return join(historyRoot, "converting", episode);
        }
        case "auth":
            return join(roots.auth, "converting", episode);
    }
};

// The volume a path lives on: the longest root containing it, since the auth root usually sits inside the workspace.
export const rootOf = (roots: Readonly<Record<DocumentRoot, string>>, path: string): DocumentRoot | undefined =>
    (Object.entries(roots) as [DocumentRoot, string][])
        .filter(([, root]) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`))
        .toSorted(([, a], [, b]) => b.length - a.length)[0]?.[0];

// Copies a file into place atomically: a sibling temp copy renamed over the target.
const copyInto = async (from: string, to: string): Promise<void> => {
    await mkdir(dirname(to), { recursive: true });
    const temp = join(dirname(to), `.converting.${process.pid}.tmp`);
    await copyFile(from, temp);
    await rename(temp, to);
};

// What an episode is about to do, in the order it does it: renames, then copies, then writes (which may land inside a
// renamed or copied tree, so a write's pre-image is read from where its bytes are before any of it: `sourceOf`).
export interface EpisodeWork {
    readonly renames: ReadonlyMap<string, string>;
    readonly copies: readonly string[];
    readonly writes: readonly string[];
    readonly sourceOf: (path: string) => string;
}

// Copies each target aside and records the episode open, before a single target is written. A resumed episode (a
// crash mid-apply of a build with this same conversion digest) keeps the pre-images it already took: those are the true
// originals. Entries are recorded in the order the work applies, and a rollback undoes them newest first.
export const openEpisode = async (
    roots: Readonly<Record<DocumentRoot, string>>,
    journal: Journal,
    work: EpisodeWork,
    identity: { readonly engine: number; readonly digest: string; readonly version: string; readonly now: number },
): Promise<Journal> => {
    const resumed = journal.episodes.find((episode) => episode.state === "open" && episode.digest === identity.digest);
    const episode: Episode = resumed ?? { id: `${identity.now}-${process.pid}`, ...identity, state: "open", startedAt: identity.now, entries: [] };
    const recorded = new Set(episode.entries.map((entry) => entry.path));
    const entries = [...episode.entries];
    for (const [from, to] of work.renames) {
        if (!recorded.has(to)) {
            entries.push({ path: to, preImage: null, movedFrom: from });
            recorded.add(to);
        }
    }
    for (const to of work.copies.filter((candidate) => !recorded.has(candidate))) {
        entries.push({ path: to, preImage: null });
        recorded.add(to);
    }
    for (const target of work.writes.filter((candidate) => !recorded.has(candidate))) {
        const root = rootOf(roots, target);
        if (root === undefined) {
            throw new Error(`${target} is outside every volume this sandbox converts`);
        }
        const preImage = join(preImageRoot(roots, root, episode.id), relative(roots[root], target));
        const copied = await copyInto(work.sourceOf(target), preImage).then(
            () => true,
            (error: unknown) => {
                if (undefinedIfMissing(error) === undefined) {
                    return false;
                }
                throw error;
            },
        );
        entries.push({ path: target, preImage: copied ? preImage : null });
        recorded.add(target);
    }
    const opened: Journal = {
        ...journal,
        episodes: [...journal.episodes.filter((candidate) => candidate.id !== episode.id), { ...episode, entries }],
    };
    await writeJournal(roots.history, opened);
    return opened;
};

// Puts every file an episode touched back as it was, then forgets the episode.
export const restoreEpisode = async (roots: Readonly<Record<DocumentRoot, string>>, journal: Journal, episode: Episode): Promise<Journal> => {
    // Newest first, so a tree renamed and then written into is emptied before it is renamed back.
    for (const entry of episode.entries.toReversed()) {
        if (entry.movedFrom !== undefined) {
            await moveBack(entry.path, entry.movedFrom);
        } else if (entry.preImage === null) {
            await rm(entry.path, { recursive: true, force: true });
        } else {
            await copyInto(entry.preImage, entry.path);
        }
    }
    await dropPreImages(roots, episode);
    const restored: Journal = { ...journal, episodes: journal.episodes.filter((candidate) => candidate.id !== episode.id) };
    await writeJournal(roots.history, restored);
    return restored;
};

// A renamed tree goes back where it came from, unless something took that address in the meantime.
const moveBack = async (path: string, from: string): Promise<void> => {
    const occupied = await stat(from).then(
        () => true,
        () => false,
    );
    if (occupied) {
        return;
    }
    await mkdir(dirname(from), { recursive: true });
    await rename(path, from).catch(undefinedIfMissing);
};

const dropPreImages = async (roots: Readonly<Record<DocumentRoot, string>>, episode: Episode): Promise<void> => {
    for (const root of Object.keys(roots) as DocumentRoot[]) {
        await rm(preImageRoot(roots, root, episode.id), { recursive: true, force: true });
    }
};

// Marks the open episode committed; the version that converted the files has booted, so there is nothing to undo.
export const commitEpisodes = (journal: Journal, now: number): Journal => ({
    ...journal,
    episodes: journal.episodes.map((episode) => (episode.state === "open" ? { ...episode, state: "committed", committedAt: now } : episode)),
});

// Drops committed episodes past the grace window, pre-images and all.
export const pruneEpisodes = async (roots: Readonly<Record<DocumentRoot, string>>, journal: Journal, now: number): Promise<Journal> => {
    const expired = journal.episodes.filter((episode) => episode.state === "committed" && now - (episode.committedAt ?? episode.startedAt) > GRACE_MS);
    for (const episode of expired) {
        await dropPreImages(roots, episode);
    }
    return expired.length === 0 ? journal : { ...journal, episodes: journal.episodes.filter((episode) => !expired.includes(episode)) };
};
