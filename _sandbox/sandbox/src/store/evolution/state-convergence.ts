import { cp, lstat, mkdir, readdir, readFile, rename, rm, rmdir, stat } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { errorMessage, undefinedIfMissing } from "@intentic/base/errors";
import { writeFileAtomic } from "@intentic/base/fs";
import type { Logger } from "pino";
import { z } from "zod";
import { stateRelPath } from "../../state-paths.js";
import { convertDocument } from "./conversions.js";
import { conversionDigest, defineDocument, type DocumentRoot, type DocumentSpec, engineEpoch } from "./documents.js";
import { jsonEntries } from "../json-file.js";
import { isDowngrade, newestRunVersion, recordNewestRun } from "../newest-run.js";
import { commitEpisodes, type Episode, GRACE_MS, type Journal, openEpisode, pruneEpisodes, readJournal, restoreEpisode, writeJournal } from "./state-journal.js";
import type { StructuralStep } from "./state-steps.js";
import { version as buildVersion } from "../../version.js";

// The boot step that brings this workspace's stored files to this build's shapes before any store opens: moves
// documents that changed address, runs structural steps, and writes back every document whose conversions change it,
// all under a journal (state-journal.ts) that keeps the pre-images until the build has booted all the way. Planning is
// separate from applying and reads only, so the pre-flight (state-plan.ts) runs the very same plan inside the target
// image over read-only mounts before an update touches anything. Both take every document and step from their caller,
// which reads them from state-registry.ts: nothing here depends on which modules a process loaded.

export type StateRoots = Readonly<Record<DocumentRoot, string>>;

export interface PlanStep {
    readonly document: string;
    readonly change: string;
    // What was particular about this one: a conflict's losing value, a retired entry, a mapped value.
    readonly detail?: string;
}

export interface PlanFailure {
    readonly document: string;
    readonly detail: string;
}

export interface StatePlan {
    // The conversion count builds before the digest compared (documents.ts, engineEpoch); reported, never decided by.
    readonly engine: number;
    // What identifies this build's conversion episode (documents.ts, conversionDigest).
    readonly digest: string;
    // A newer release than this build ran here (a rollback): its files may hold what this build cannot read.
    readonly downgrade: boolean;
    readonly steps: readonly PlanStep[];
    readonly failures: readonly PlanFailure[];
    // Every file the plan writes, to its new text (undefined deletes it), in the order they apply.
    readonly writes: ReadonlyMap<string, string | undefined>;
    // Trees copied and renamed, source to destination; applied before the writes, which may land inside them.
    readonly copies: ReadonlyMap<string, string>;
    readonly renames: ReadonlyMap<string, string>;
    readonly touches: readonly string[];
    readonly effects: readonly (() => Promise<void>)[];
    // Earlier addresses seen beside their current one for the first time; the journal starts their grace window.
    readonly seen: readonly string[];
    // Where a planned write's current bytes live before the copies and renames (its pre-image's source).
    readonly sourceOf: (path: string) => string;
}

// Past this a document is converted on read only: rewriting a large ledger at boot would cost the boot, not the reader.
const EAGER_LIMIT = 5 * 1024 * 1024;

export const documentPath = (roots: StateRoots, spec: Pick<DocumentSpec, "root" | "path">): string => join(roots[spec.root], spec.path);

// How a plan names a document: the workspace-relative path people see in the tree, or the volume and its path.
const displayOf = (spec: Pick<DocumentSpec, "root" | "path">): string => (spec.root === "workspace" ? spec.path : `${spec.root}:${spec.path}`);

const canonical = (value: unknown): string => `${JSON.stringify(value, undefined, 2)}\n`;

// The volumes as the plan will leave them: reads see the writes, copies and renames planned so far, and nothing
// touches the disk.
interface Overlay {
    readonly writes: Map<string, string | undefined>;
    readonly copies: Map<string, string>;
    readonly renames: Map<string, string>;
    readonly read: (path: string) => Promise<string | undefined>;
    readonly list: (dir: string) => Promise<string[]>;
    // Where a path's bytes are on disk now, before the planned copies and renames move them there.
    readonly sourceOf: (path: string) => string;
    readonly kind: (path: string) => Promise<"file" | "directory" | undefined>;
}

const within = (path: string, root: string): boolean => path === root || path.startsWith(`${root}${sep}`);

const createOverlay = (): Overlay => {
    const writes = new Map<string, string | undefined>();
    const copies = new Map<string, string>();
    const renames = new Map<string, string>();
    const sourceOf = (path: string): string => {
        let current = path;
        // Bounded: each hop moves to a source, and a plan holds finitely many; a cycle would be a planning bug.
        for (let hop = 0; hop <= copies.size + renames.size; hop++) {
            const match = [...copies, ...renames].find(([, to]) => within(current, to));
            if (match === undefined) {
                return current;
            }
            current = `${match[0]}${current.slice(match[1].length)}`;
        }
        return current;
    };
    const movedAway = (path: string): boolean => [...renames.keys()].some((from) => within(path, from));
    const read = async (path: string): Promise<string | undefined> => {
        if (writes.has(path)) {
            return writes.get(path);
        }
        if (movedAway(path)) {
            return undefined;
        }
        return readFile(sourceOf(path), "utf8").catch(undefinedIfMissing);
    };
    const list = async (dir: string): Promise<string[]> => {
        const names = new Set(movedAway(dir) ? [] : ((await readdir(sourceOf(dir)).catch(undefinedIfMissing)) ?? []));
        for (const to of [...copies.values(), ...renames.values()].filter((destination) => dirname(destination) === dir)) {
            names.add(basename(to));
        }
        for (const from of [...renames.keys()].filter((source) => dirname(source) === dir)) {
            names.delete(basename(from));
        }
        for (const [path, content] of writes) {
            if (dirname(path) !== dir) {
                continue;
            }
            if (content === undefined) {
                names.delete(basename(path));
            } else {
                names.add(basename(path));
            }
        }
        return [...names].toSorted();
    };
    const kind = async (path: string): Promise<"file" | "directory" | undefined> => {
        if (writes.has(path)) {
            return writes.get(path) === undefined ? undefined : "file";
        }
        if (movedAway(path)) {
            return undefined;
        }
        const found = await lstat(sourceOf(path)).catch(undefinedIfMissing);
        return found === undefined ? undefined : found.isDirectory() ? "directory" : found.isFile() ? "file" : undefined;
    };
    return { writes, copies, renames, read, list, sourceOf, kind };
};

interface PlanDraft {
    readonly overlay: Overlay;
    readonly steps: PlanStep[];
    readonly failures: PlanFailure[];
    readonly touches: string[];
    readonly effects: (() => Promise<void>)[];
    readonly seen: string[];
}

// One file per entry for a directory document; only its `.json` files are entries.
const entryFiles = async (overlay: Overlay, dir: string): Promise<string[]> =>
    (await overlay.list(dir)).filter((name) => name.endsWith(".json")).map((name) => join(dir, name));

const present = async (overlay: Overlay, spec: DocumentSpec, path: string): Promise<boolean> =>
    spec.directory ? (await entryFiles(overlay, path)).length > 0 : (await overlay.read(path)) !== undefined;

// Copies the newest earlier address that exists into place when the current one is absent. The earlier copy stays for
// the grace window, so a rollback to a build that still reads it finds it; after that it is removed, journaled.
const planMove = async (spec: DocumentSpec, roots: StateRoots, journal: Journal, now: number, draft: PlanDraft): Promise<void> => {
    const { overlay } = draft;
    const current = documentPath(roots, spec);
    const earlier = spec.movedFrom.map((path) => ({ path, absolute: join(roots[spec.root], path) }));
    if (!(await present(overlay, spec, current))) {
        for (const source of earlier.toReversed()) {
            if (await present(overlay, spec, source.absolute)) {
                await copyDocument(overlay, spec, source.absolute, current);
                draft.steps.push({ document: displayOf(spec), change: `moves it from ${source.path}` });
                break;
            }
        }
    }
    for (const old of earlier) {
        if (!(await present(overlay, spec, old.absolute))) {
            continue;
        }
        const firstSeen = journal.moved[old.absolute];
        if (firstSeen === undefined) {
            draft.seen.push(old.absolute);
        } else if (now - firstSeen > GRACE_MS) {
            for (const file of spec.directory ? await entryFiles(overlay, old.absolute) : [old.absolute]) {
                overlay.writes.set(file, undefined);
            }
            draft.steps.push({ document: displayOf(spec), change: `removes the copy left at ${old.path}` });
        }
    }
};

const copyDocument = async (overlay: Overlay, spec: DocumentSpec, from: string, to: string): Promise<void> => {
    const pairs = spec.directory ? (await entryFiles(overlay, from)).map((file) => [file, join(to, basename(file))] as const) : [[from, to] as const];
    for (const [source, target] of pairs) {
        overlay.writes.set(target, await overlay.read(source));
    }
};

// Writes back one file whose conversions change it; a file that is not JSON, or too large to rewrite at boot, is left to
// the store, which converts on read and reports what it cannot.
const planConversion = async (spec: DocumentSpec, path: string, draft: PlanDraft): Promise<void> => {
    const text = await draft.overlay.read(path);
    if (text === undefined || text.length > EAGER_LIMIT) {
        return;
    }
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        // allow(silent-catch): the store reports a file that is not JSON on its first read; there is nothing to convert
        return;
    }
    try {
        const converted = convertDocument(spec.history, spec.directory ? "object" : spec.granularity, raw);
        if (converted.changes.length === 0) {
            return;
        }
        draft.overlay.writes.set(path, canonical(converted.value));
        const document = spec.directory ? `${displayOf(spec)}/${basename(path)}` : displayOf(spec);
        // One step per conversion that plainly applied, and one per change with something particular to say.
        const plain = new Set(converted.changes.filter((one) => one.detail === undefined).map((one) => one.conversion));
        for (const change of plain) {
            draft.steps.push({ document, change });
        }
        for (const one of converted.changes.filter((candidate) => candidate.detail !== undefined)) {
            draft.steps.push({ document, change: one.conversion, ...(one.detail === undefined ? {} : { detail: one.detail }) });
        }
    } catch (error) {
        draft.failures.push({ document: displayOf(spec), detail: errorMessage(error) });
    }
};

const planStep = async (step: StructuralStep, roots: StateRoots, draft: PlanDraft): Promise<void> => {
    try {
        const planned = await step.plan({ roots, read: draft.overlay.read, list: draft.overlay.list, kind: draft.overlay.kind });
        if (planned === undefined) {
            return;
        }
        for (const [from, to] of planned.copies ?? []) {
            draft.overlay.copies.set(from, to);
        }
        for (const [from, to] of planned.renames ?? []) {
            draft.overlay.renames.set(from, to);
        }
        for (const [path, content] of planned.writes) {
            draft.overlay.writes.set(path, content);
        }
        draft.touches.push(...(planned.touches ?? []));
        if (planned.effect !== undefined) {
            draft.effects.push(planned.effect);
        }
        draft.steps.push(...planned.changes.map((change) => ({ document: step.id, change })));
    } catch (error) {
        draft.failures.push({ document: step.id, detail: errorMessage(error) });
    }
};

export interface PlanOptions {
    readonly roots: StateRoots;
    // Every document and step this build knows: state-registry.ts, or a test's own.
    readonly documents: readonly DocumentSpec[];
    readonly steps: readonly StructuralStep[];
    // The release this plan is for, which a stamp naming a newer one makes a downgrade; the running build's by default.
    readonly version?: string;
    readonly journal?: Journal;
    readonly now?: number;
}

// What converging would do, computed without writing anything: layout steps, then document moves, then content steps,
// then per-document conversions, each reading what the ones before it planned.
export const planState = async ({ roots, documents, steps, version = buildVersion, journal, now = Date.now() }: PlanOptions): Promise<StatePlan> => {
    const standing = journal ?? (await readJournal(roots.history));
    const onDisk = documents.filter((spec) => spec.boot);
    const draft: PlanDraft = { overlay: createOverlay(), steps: [], failures: [], touches: [], effects: [], seen: [] };
    for (const step of steps.filter((candidate) => candidate.phase === "layout")) {
        await planStep(step, roots, draft);
    }
    for (const spec of onDisk.filter((candidate) => candidate.movedFrom.length > 0)) {
        await planMove(spec, roots, standing, now, draft);
    }
    for (const step of steps.filter((candidate) => candidate.phase !== "layout")) {
        await planStep(step, roots, draft);
    }
    for (const spec of onDisk.filter((candidate) => candidate.history.length > 0)) {
        const path = documentPath(roots, spec);
        for (const file of spec.directory ? await entryFiles(draft.overlay, path) : [path]) {
            await planConversion(spec, file, draft);
        }
    }
    return {
        engine: engineEpoch(documents, steps),
        digest: conversionDigest(documents, steps),
        downgrade: isDowngrade(version),
        steps: draft.steps,
        failures: draft.failures,
        writes: draft.overlay.writes,
        copies: draft.overlay.copies,
        renames: draft.overlay.renames,
        touches: draft.touches,
        effects: draft.effects,
        seen: draft.seen,
        sourceOf: draft.overlay.sourceOf,
    };
};

// Keeps a file's mode (a vault is 0600) when its content is replaced.
const applyWrite = async (path: string, content: string | undefined): Promise<void> => {
    if (content === undefined) {
        await rm(path, { force: true });
        return;
    }
    const mode = (await stat(path).catch(undefinedIfMissing))?.mode;
    await writeFileAtomic(path, content, mode === undefined ? undefined : mode & 0o777);
};

// A directory emptied by removing an earlier address goes too; one still holding anything stays.
const pruneEmptied = async (deleted: readonly string[]): Promise<void> => {
    for (const dir of new Set(deleted.map((path) => dirname(path)))) {
        // allow(silent-catch): a directory still holding something (or already gone) is exactly the one to leave alone
        await rmdir(dir).catch(() => undefined);
    }
};

// What each update converted, newest last; a record for the owner, never read back to decide anything.
const LedgerEntrySchema = z.object({
    at: z.number(),
    version: z.string(),
    engine: z.number(),
    digest: z.string().optional(),
    steps: z.array(z.object({ document: z.string(), change: z.string(), detail: z.string().optional() })),
});
export const conversionsDocument = defineDocument({ path: stateRelPath(".intentic/records/conversions.json"), schema: LedgerEntrySchema, granularity: "entries" });
const LEDGER_KEPT = 50;

const appendLedger = async (workspaceRoot: string, entry: z.infer<typeof LedgerEntrySchema>): Promise<void> => {
    const ledger = jsonEntries(join(workspaceRoot, conversionsDocument.path), {
        entry: (raw) => LedgerEntrySchema.safeParse(raw).data,
        document: conversionsDocument,
    });
    await ledger.update((entries) => [...entries, entry].slice(-LEDGER_KEPT));
};

// Module state the /health route reads: whether a conversion episode is open, and this build's conversion count.
let journalOpen = false;
let runningEngine = 0;

export const stateStatus = (): { readonly journal: "open" | "none"; readonly engine: number } => ({
    journal: journalOpen ? "open" : "none",
    engine: runningEngine,
});

export interface ConvergeOptions extends Omit<PlanOptions, "journal" | "now"> {
    readonly version: string;
    readonly logger: Logger;
    // Only the daemon that owns these volumes converts them; a guest learns the stamp and converts on read like anyone.
    readonly mayWrite: boolean;
    readonly now?: () => number;
}

export interface ConvergeOutcome {
    readonly plan: StatePlan | undefined;
    // Files put back from a newer build's open episode.
    readonly restored: number;
}

const withSeen = (journal: Journal, seen: readonly string[], now: number): Journal =>
    seen.length === 0 ? journal : { ...journal, moved: { ...journal.moved, ...Object.fromEntries(seen.map((path) => [path, now])) } };

// A newer build's open episode is undone before anything else: those files are the previous version's to read. An
// older one's is undone too, since this build plans from the files as they were before it began. Only an interrupted
// episode of this same conversion set is resumed, its pre-images being the true originals; one opened before the digest
// existed names none, and is undone.
const recoverEpisodes = async (roots: StateRoots, journal: Journal, digest: string, logger: Logger): Promise<{ journal: Journal; restored: number }> => {
    let current = journal;
    let restored = 0;
    for (const episode of journal.episodes.filter((candidate) => candidate.state === "open" && candidate.digest !== digest)) {
        current = await restoreEpisode(roots, current, episode);
        restored += episode.entries.length;
        logger.warn(
            { episode: episode.id, from: episode.version, files: episode.entries.length },
            "state: put back the files an update had started converting and never committed",
        );
    }
    return { journal: current, restored };
};

export const convergeState = async (options: ConvergeOptions): Promise<ConvergeOutcome> => {
    const { roots, version, logger, mayWrite } = options;
    const now = options.now ?? Date.now;
    const { documents, steps } = options;
    const digest = conversionDigest(documents, steps);
    runningEngine = engineEpoch(documents, steps);
    await recordNewestRun(roots.workspace, version, { engine: runningEngine, digest, write: mayWrite });
    if (!mayWrite) {
        return { plan: undefined, restored: 0 };
    }
    const recovered = await recoverEpisodes(roots, await readJournal(roots.history, logger), digest, logger);
    let journal = await pruneEpisodes(roots, recovered.journal, now());
    journalOpen = journal.episodes.some((episode) => episode.state === "open");
    const plan = await planState({ roots, documents, steps, version, journal, now: now() });
    for (const failure of plan.failures) {
        logger.warn(failure, "state: a conversion failed; the store reads that file as it stands and reports it");
    }
    if (plan.downgrade) {
        logger.warn({ version, newest: newestRunVersion() }, "state: a newer build converted these files; this one keeps its hands off what it cannot read");
    }
    if (plan.writes.size > 0 || plan.effects.length > 0 || plan.copies.size > 0 || plan.renames.size > 0) {
        journal = await openEpisode(
            roots,
            journal,
            { writes: [...plan.writes.keys(), ...plan.touches], copies: [...plan.copies.values()], renames: plan.renames, sourceOf: plan.sourceOf },
            { engine: plan.engine, digest, version, now: now() },
        );
        journalOpen = true;
        for (const [from, to] of plan.copies) {
            await mkdir(dirname(to), { recursive: true });
            await cp(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
        }
        for (const [from, to] of plan.renames) {
            await mkdir(dirname(to), { recursive: true });
            await rename(from, to);
        }
        for (const [path, content] of plan.writes) {
            await applyWrite(path, content);
        }
        await pruneEmptied([...plan.writes].filter(([, content]) => content === undefined).map(([path]) => path));
        for (const effect of plan.effects) {
            await effect();
        }
        await appendLedger(roots.workspace, { at: now(), version, engine: plan.engine, digest, steps: [...plan.steps] });
        logger.info({ files: plan.writes.size, steps: plan.steps.length }, "state: converted this workspace's files; the journal stays open until boot finishes");
    }
    const settled = withSeen(journal, plan.seen, now());
    if (JSON.stringify(settled) !== JSON.stringify(recovered.journal)) {
        await writeJournal(roots.history, settled);
    }
    return { plan, restored: recovered.restored };
};

// Called once the build has booted all the way: nothing it converted needs undoing any more.
// The reported status flips first: a daemon this far along is healthy, and a journal write that fails leaves the episode
// open on disk for the next boot of this same build to resume, never a reason to roll this one back.
export const commitState = async (roots: StateRoots, now: number = Date.now()): Promise<Episode | undefined> => {
    journalOpen = false;
    const journal = await readJournal(roots.history);
    const open = journal.episodes.find((episode) => episode.state === "open");
    if (open !== undefined) {
        await writeJournal(roots.history, commitEpisodes(journal, now));
    }
    return open;
};

// Test seam: the module state the /health route and the stores read.
export const resetStateStatus = (): void => {
    journalOpen = false;
    runningEngine = 0;
};
