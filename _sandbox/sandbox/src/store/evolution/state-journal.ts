import { copyFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { z } from "zod";
import { stateRelPath } from "../../state-paths.js";
import type { DocumentRoot } from "./documents.js";
import { writeJsonFile } from "../json-file.js";

// The write-ahead journal of one conversion episode: before the boot step changes a file it copies the file aside
// (its pre-image), and the episode stays open until the new version has booted all the way. A build that finds an
// open episode opened by any other conversion set (its digest) restores the pre-images before it opens a single store,
// which is how a rollback lands on the files the previous version left rather than the ones the new version had
// started converting.
// Committed episodes keep their pre-images for a grace window, a hand-restorable record of what each update changed.

// How long committed pre-images, and earlier document addresses left beside their current one, are kept.
export const GRACE_MS = 7 * 24 * 60 * 60 * 1000;

const EntrySchema = z.object({
    path: z.string(),
    // Where the file's bytes were copied before the episode changed it; null when it did not exist yet.
    preImage: z.string().nullable(),
    // Set when the episode renamed a tree here from this path: a rollback renames it back instead of deleting it.
    movedFrom: z.string().optional(),
});

const EpisodeSchema = z.object({
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

const JournalSchema = z.object({
    episodes: z.array(EpisodeSchema).default([]),
    // An earlier document address still present beside its current one, and when it was first seen so.
    moved: z.record(z.string(), z.number()).default({}),
    // Each document's renames in their grace window (rename-compat.ts), and when each window closes.
    renames: z.record(z.string(), z.array(z.object({ from: z.string(), to: z.string(), until: z.number() }))).default({}),
});
export type Journal = z.infer<typeof JournalSchema>;

export const journalPath = (historyRoot: string): string => join(historyRoot, "state-journal.json");

// An unreadable journal reads as empty, the only safe reading: its pre-images stay on disk where a hand can reach them.
export const readJournal = async (historyRoot: string): Promise<Journal> => {
    const text = await readFile(journalPath(historyRoot), "utf8").catch(undefinedIfMissing);
    if (text === undefined) {
        return JournalSchema.parse({});
    }
    try {
        return JournalSchema.safeParse(JSON.parse(text)).data ?? JournalSchema.parse({});
    } catch {
        // silent-catch: not JSON reads as empty, like a schema reject; the pre-image directories are left alone
        return JournalSchema.parse({});
    }
};

export const writeJournal = (historyRoot: string, journal: Journal): Promise<void> => writeJsonFile(journalPath(historyRoot), journal);

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
