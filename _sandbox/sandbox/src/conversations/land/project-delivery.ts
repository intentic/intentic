import { lstat, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { errorMessage, undefinedIfMissing } from "@intentic/base/errors";
import {
    DEVICE_FEATURE_PROJECT_DELIVERY,
    type DeliveredFile,
    type DeliveryConflictReason,
    type DeviceFacts,
    type DevicePairing,
    type DeviceReport,
    deviceSupports,
    environmentOf,
    isProjectDirName,
    type LandingDelivery,
    PROJECT_DELIVERY_MAX_BYTES,
    type ProjectDelivery,
    type ProjectDeliveryResult,
    projectRemoteDir,
    sandboxIdFromUrl,
    type WorkspaceEvent,
} from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner, gitBytes } from "@intentic/base/git";
import { z } from "zod";
import type { Services } from "../../composition.js";
import { readObject } from "../../git/changes/blob-reader.js";
import { opt } from "../../opt.js";
import { defineDocument } from "../../store/evolution/documents.js";
import { openDocument } from "../../store/open-document.js";
import { worktreeOf } from "../registry/agents-store.js";

// LANDED WORK DELIVERED TO THE OWNER'S FOLDER. A folder on the owner's computer attached to that computer's own sandbox
// is copied one way into `/work/<name>`. When a conversation's work lands there, the same change goes to the machine
// agent holding the folder (`deliverProject`, schemas/project-delivery.ts), which takes a restore point, writes each file
// whose copy the owner left alone, merges the ones they edited too where git can, and leaves the rest untouched and
// named. What it merged comes back and is written into `/work/<name>` as well, so both copies hold the same bytes.
//
// A subscriber on `agent.landed`, so both doors a land goes through (a turn's own land, and a press of Land) are
// covered by one reaction, and a land into a parent's checkout, which announces nothing, is never delivered. The
// computer may be asleep: then the land waits in /history/project-deliveries.json and goes when it next connects.

// How often waiting lands are tried again whatever happened, and how often the connected machines are looked at for one
// that just arrived: a connection is the moment a waiting land can go, and reading the hub costs nothing.
const RETRY_EVERY_MS = 5 * 60_000;
const ARRIVALS_EVERY_MS = 15_000;

// The machine writes under a restore point and may merge many files; this bounds only a socket gone quiet.
const DELIVERY_TIMEOUT_MS = 120_000;

// Git's tree modes: a link and a submodule are carried by nothing here (the owner's folder decides what stands on such a
// path), an absent side is an addition or a deletion, and an executable file is the one mode the folder is told about.
const LINK_MODES: ReadonlySet<string> = new Set(["120000", "160000"]);
const ABSENT_MODE = "000000";
const EXECUTABLE_MODE = "100755";

// One land still owed to the folder: where the earliest undelivered land of this conversation into this project
// started, and the tip its newest one landed, so a later land carries an earlier one that never went.
const OwedDeliverySchema = z.object({
    agentId: z.string(),
    project: z.string(),
    from: z.string(),
    tip: z.string(),
    title: z.string().optional(),
    queuedAt: z.number(),
});
export type OwedDelivery = z.infer<typeof OwedDeliverySchema>;

// Which computer last said it holds a project folder, and where: how a land made while that computer is away (and this
// daemon has restarted since it last heard from it) still knows to wait for it rather than going nowhere.
const AttachedProjectSchema = z.object({
    project: z.string(),
    host: z.string(),
    folder: z.string().optional(),
});
type AttachedProject = z.infer<typeof AttachedProjectSchema>;

const ProjectDeliveriesSchema = z.object({
    queue: z.array(OwedDeliverySchema),
    attached: z.array(AttachedProjectSchema),
});
type ProjectDeliveries = z.infer<typeof ProjectDeliveriesSchema>;

export const projectDeliveriesDocument = defineDocument({ root: "history", path: "project-deliveries.json", schema: ProjectDeliveriesSchema });

// What delivery reads off the daemon, narrowed so a test hands it a hub, a registry and a repository of its own. Built
// in the boot wiring (bootstrap/boot-schedulers.ts), which sits above hosts/ and this subsystem both.
export interface ProjectDeliveryDeps {
    readonly agents: Pick<Services["agents"], "entry" | "recordDelivery">;
    readonly agentWorktrees: Pick<Services["agentWorktrees"], "mainDir" | "withRepoLock">;
    readonly events: Pick<Services["events"], "publish" | "subscribe">;
    readonly hostHub: Pick<Services["hostHub"], "known" | "connected" | "online"> & {
        readonly state: (id: string) => { readonly facts?: DeviceFacts | undefined };
        readonly client: (id: string) => DeliveryClient | undefined;
    };
    readonly logger: Pick<Services["logger"], "info" | "warn">;
    // The reports machines volunteer over desktop sync, each filed under a token this sandbox minted, so every pairing
    // in one is this sandbox's.
    readonly syncFleet: () => Promise<{ readonly reports: readonly { readonly report: DeviceReport }[] }>;
    readonly historyRoot: string;
    // The names a machine pairs this sandbox under come from its public address and its platform id.
    readonly publicUrl: string;
    readonly platformId: string | undefined;
    // What one machine reports of its folders (device-reports.ts reportedPairings).
    readonly pairingsOf: (host: string) => Promise<readonly DevicePairing[] | undefined>;
}

export interface DeliveryClient {
    readonly deliverProject: (input: ProjectDelivery, options: { readonly signal?: AbortSignal }) => Promise<ProjectDeliveryResult>;
}

/* ---- which pairings are this sandbox's ---- */

const sanitized = (raw: string): string => raw.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");

const hostOf = (url: string): string | undefined => {
    if (url === "") {
        return undefined;
    }
    try {
        return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`).host;
    } catch {
        // allow(silent-catch): an address that does not parse names nothing, and the other names still stand
        return undefined;
    }
};

// What this sandbox goes by on a machine that pairs with it. A machine names a pairing by the sanitized host of the URL
// it was set up with (`sanitizeId` in the machine's sync/ssh.ts), and every folder attached to that sandbox reports the
// same id; the platform's short id and the pairings a volunteered report carries name it too.
export const ownNames = (publicUrl: string, platformId: string | undefined, volunteered: readonly string[]): readonly string[] => {
    const host = hostOf(publicUrl);
    const names = [host === undefined ? undefined : sanitized(host), sandboxIdFromUrl(publicUrl), platformId, ...volunteered];
    return [...new Set(names.filter((name): name is string => name !== undefined && name !== ""))];
};

// Whether a pairing a machine reports is one of this sandbox's. A machine's report names every sandbox it pairs, so a
// folder attached to another sandbox of the same name is not ours. A folder set to deliver by itself is attached to the
// machine's own sandbox, whose folderless `projectsHost` pairing names it: when that one is ours, so is the folder. A
// sandbox that knows no name of its own (no public address yet) takes the machine's word, which checks the folder
// against the link the call arrives on anyway.
export const pairingIsOurs = (pairing: DevicePairing, siblings: readonly DevicePairing[], names: readonly string[]): boolean => {
    if (names.length === 0 || names.includes(pairing.sandboxId)) {
        return true;
    }
    return pairing.deliver === "auto" && siblings.some((sibling) => sibling.projectsHost === true && names.includes(sibling.sandboxId));
};

const deliversHere = (pairing: DevicePairing, remoteDir: string): boolean => pairing.remoteDir === remoteDir && pairing.deliver === "auto";

/* ---- what a land changed, file by file ---- */

type Kept = { readonly path: string; readonly reason: DeliveryConflictReason };

// What one land carries to the folder, read off git: every changed file whole on both sides, binary-safe.
export interface DeliveryBuild {
    readonly files: readonly DeliveredFile[];
    // Paths nothing is sent for: a link or a submodule on either side (`link`), or a name the folder could not hold as
    // git does (`outside`). Reported with the machine's own conflicts.
    readonly kept: readonly Kept[];
    // Past PROJECT_DELIVERY_MAX_BYTES on both sides together: nothing is sent, and Bring back reaches every file.
    readonly tooLarge: boolean;
}

interface RawChange {
    readonly srcMode: string;
    readonly dstMode: string;
    readonly srcSha: string;
    readonly dstSha: string;
    readonly path: string;
}

// `git diff --raw -z --no-renames`: a `:<mode> <mode> <sha> <sha> <status>` header, then the path, NUL after each.
const parseRawZ = (stdout: string): RawChange[] => {
    const parts = stdout.split("\0");
    const changes: RawChange[] = [];
    for (let at = 0; at + 1 < parts.length; at += 2) {
        const header = parts[at] ?? "";
        const path = parts[at + 1] ?? "";
        if (!header.startsWith(":") || path === "") {
            break;
        }
        const [srcMode = "", dstMode = "", srcSha = "", dstSha = ""] = header.slice(1).split(" ");
        changes.push({ srcMode, dstMode, srcSha, dstSha, path });
    }
    return changes;
};

// Why nothing is sent for a path, or undefined when it goes: a name the folder can hold as git names it is one the
// contract's machine side accepts (no backslash, no drive).
const keptReason = (change: RawChange): DeliveryConflictReason | undefined => {
    if (LINK_MODES.has(change.srcMode) || LINK_MODES.has(change.dstMode)) {
        return "link";
    }
    return change.path.includes("\\") || /^[A-Za-z]:/.test(change.path) ? "outside" : undefined;
};

const TOO_LARGE = Symbol("too large");

// One blob, read through the repository's long-lived reader and refused past what the delivery has left to spend. An
// object the reader would not hand over is either past that or missing, and only its size can say which.
const blobWithin = async (dir: string, sha: string, budget: number): Promise<Buffer | typeof TOO_LARGE> => {
    const bytes = await readObject(dir, sha, budget);
    if (bytes !== undefined) {
        return bytes;
    }
    const size = Number((await gitBytes(dir, ["cat-file", "-s", sha], 64)).toString("utf8").trim());
    if (Number.isFinite(size) && size > budget) {
        return TOO_LARGE;
    }
    throw new Error(`git could not read the object ${sha.slice(0, 7)} in ${dir}`);
};

// One side of a change as the contract carries it: null where the file did not exist, else its bytes in base64.
const sideOf = async (
    dir: string,
    mode: string,
    sha: string,
    budget: number,
): Promise<{ readonly text: string | null; readonly bytes: number } | typeof TOO_LARGE> => {
    if (mode === ABSENT_MODE) {
        return { text: null, bytes: 0 };
    }
    const read = await blobWithin(dir, sha, budget);
    return read === TOO_LARGE ? TOO_LARGE : { text: read.toString("base64"), bytes: read.length };
};

const kindOf = (change: RawChange): DeliveredFile["kind"] =>
    change.srcMode === ABSENT_MODE ? "added" : change.dstMode === ABSENT_MODE ? "deleted" : "modified";

export const deliveryOf = async (
    dir: string,
    from: string,
    tip: string,
    git: GitRunner = defaultGit,
    maxBytes: number = PROJECT_DELIVERY_MAX_BYTES,
): Promise<DeliveryBuild> => {
    const { stdout } = await git(dir, ["diff", "--raw", "-z", "--no-renames", "--no-abbrev", from, tip]);
    const files: DeliveredFile[] = [];
    const kept: Kept[] = [];
    let budget = maxBytes;
    // Sequential on purpose: one reader per repository answers one object at a time, and the budget is spent in order.
    for (const change of parseRawZ(stdout)) {
        const reason = keptReason(change);
        if (reason !== undefined) {
            kept.push({ path: change.path, reason });
            continue;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- each read spends the budget the next one is held to
        const base = await sideOf(dir, change.srcMode, change.srcSha, budget);
        // oxlint-disable-next-line eslint/no-await-in-loop -- see above
        const next = base === TOO_LARGE ? TOO_LARGE : await sideOf(dir, change.dstMode, change.dstSha, budget - base.bytes);
        if (base === TOO_LARGE || next === TOO_LARGE) {
            return { files: [], kept: [], tooLarge: true };
        }
        budget -= base.bytes + next.bytes;
        const file: DeliveredFile = { path: change.path, kind: kindOf(change), base: base.text, next: next.text };
        if (change.dstMode === EXECUTABLE_MODE) {
            file.executable = true;
        }
        files.push(file);
    }
    return { files, kept, tooLarge: false };
};

/* ---- the merged copies written back into /work/<name> ---- */

// A path the machine says it merged, as one this daemon will write: relative, `/`-separated, inside the folder, and
// never into a `.git`. The machine is trusted to answer about the files it was sent, not to choose where this writes.
export const writablePath = (path: string): boolean => {
    if (path === "" || path.startsWith("/") || path.includes("\\") || path.includes("\0") || /^[A-Za-z]:/.test(path)) {
        return false;
    }
    return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".." && segment !== ".git");
};

const within = (root: string, path: string): boolean => {
    const rel = relative(root, path);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
};

// Whether a merged path may be written under `root` (already resolved): a plain relative path, whose directory resolves
// inside the folder through any link, and on which no link or directory stands.
const safeTarget = async (realRoot: string, root: string, path: string): Promise<string | undefined> => {
    if (!writablePath(path)) {
        return undefined;
    }
    const target = join(root, ...path.split("/"));
    const parent = await realpath(dirname(target)).catch(undefinedIfMissing);
    if (parent === undefined || !within(realRoot, parent)) {
        return undefined;
    }
    const standing = await lstat(target).catch(undefinedIfMissing);
    return standing === undefined || standing.isFile() ? target : undefined;
};

interface Landed {
    readonly agentId: string;
    readonly project: string;
    readonly from: string;
    readonly tip: string;
    readonly title?: string | undefined;
}

// What the machine merged, written into /work/<name> as the folder now holds it, under the repository's lock like the
// land's own writes. A path that is not a plain file inside the folder is left alone and said in the log. Answers how
// many were written.
const writeMerged = async (deps: ProjectDeliveryDeps, owed: Landed, merged: ProjectDeliveryResult["merged"]): Promise<number> => {
    if (merged.length === 0) {
        return 0;
    }
    const root = deps.agentWorktrees.mainDir(owed.project);
    return await deps.agentWorktrees.withRepoLock(owed.project, async () => {
        const realRoot = await realpath(root);
        let written = 0;
        // One file at a time under the lock, like the land's own writes.
        for (const { path, content } of merged) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- see above
            const target = await safeTarget(realRoot, root, path);
            if (target === undefined) {
                deps.logger.warn(
                    { agentId: owed.agentId, project: owed.project, path },
                    "project delivery: a merged file was not written into the sandbox's copy",
                );
                continue;
            }
            // oxlint-disable-next-line eslint/no-await-in-loop -- see above
            await writeFile(target, Buffer.from(content, "base64"));
            written += 1;
        }
        return written;
    });
};

/* ---- the queue and what it remembers ---- */

const sameLand =
    (owed: { readonly agentId: string; readonly project: string }) =>
    (entry: OwedDelivery): boolean =>
        entry.agentId === owed.agentId && entry.project === owed.project;

// The /history file, as the reaction uses it: lands owed to a folder whose computer is away, and which computer last
// held each project. `waiting` is the queue's length as the last read or write left it, so the arrivals check reads no
// file while nothing waits.
const deliveryBook = (historyRoot: string) => {
    const file = openDocument(projectDeliveriesDocument, join(historyRoot, projectDeliveriesDocument.path), {
        fallback: (): ProjectDeliveries => ({ queue: [], attached: [] }),
    });
    let waiting = 0;
    const counted = (written: ProjectDeliveries): ProjectDeliveries => {
        waiting = written.queue.length;
        return written;
    };
    const withoutLand = (current: ProjectDeliveries, owed: Landed): ProjectDeliveries =>
        current.queue.some(sameLand(owed)) ? { ...current, queue: current.queue.filter((entry) => !sameLand(owed)(entry)) } : current;
    return {
        waiting: (): number => waiting,
        read: async (): Promise<ProjectDeliveries> => counted(await file.read()),
        owed: async (landed: Landed): Promise<OwedDelivery | undefined> => counted(await file.read()).queue.find(sameLand(landed)),
        // Takes this conversation's waiting land of this project out, for the land that carries it now.
        take: async (landed: Landed): Promise<OwedDelivery | undefined> => {
            let taken: OwedDelivery | undefined;
            counted(
                await file.update((current) => {
                    taken = current.queue.find(sameLand(landed));
                    return withoutLand(current, landed);
                }),
            );
            return taken;
        },
        enqueue: async (owed: OwedDelivery): Promise<void> => {
            counted(await file.update((current) => ({ ...current, queue: [...withoutLand(current, owed).queue, owed] })));
        },
        dequeue: async (owed: Landed): Promise<void> => {
            counted(await file.update((current) => withoutLand(current, owed)));
        },
        remembered: async (project: string): Promise<AttachedProject | undefined> =>
            (await file.read()).attached.find((entry) => entry.project === project),
        remember: async (attached: AttachedProject): Promise<void> => {
            await file.update((current) => {
                const held = current.attached.find((entry) => entry.project === attached.project);
                return held?.host === attached.host && held.folder === attached.folder
                    ? current
                    : { ...current, attached: [...current.attached.filter((entry) => entry.project !== attached.project), attached] };
            });
        },
        forget: async (project: string): Promise<void> => {
            await file.update((current) =>
                current.attached.some((entry) => entry.project === project)
                    ? { ...current, attached: current.attached.filter((entry) => entry.project !== project) }
                    : current,
            );
        },
    };
};
type DeliveryBook = ReturnType<typeof deliveryBook>;

/* ---- where the folder is ---- */

type Whereabouts =
    | { readonly kind: "none" }
    | { readonly kind: "ready"; readonly host: string; readonly folder: string | undefined; readonly client: DeliveryClient }
    | { readonly kind: "waiting"; readonly host: string; readonly folder: string | undefined; readonly reason: string };

const factsOf = (deps: ProjectDeliveryDeps, host: string): DeviceFacts | undefined => deps.hostHub.state(host).facts;

// The connection that can be asked now, when it answers `deliverProject`.
const deliveringClient = (deps: ProjectDeliveryDeps, host: string): DeliveryClient | undefined =>
    deviceSupports(factsOf(deps, host), DEVICE_FEATURE_PROJECT_DELIVERY) ? deps.hostHub.client(host) : undefined;

const waitReason = (deps: ProjectDeliveryDeps, host: string): string =>
    deps.hostHub.online(host)
        ? `The agent on ${host} is too old to deliver landed work by itself. Update it (\`intentic-machine upgrade\`) and the work is delivered then.`
        : `${host} is not connected. The work is delivered when it next is.`;

// The connections a volunteered report speaks for: the same computer and the same install on it, as each said.
const hostsOfReport = (deps: ProjectDeliveryDeps, report: DeviceReport): string[] =>
    report.machineId === undefined
        ? []
        : deps.hostHub
              .known()
              .filter(
                  (host) =>
                      factsOf(deps, host)?.machineId === report.machineId &&
                      environmentOf(factsOf(deps, host), undefined) === environmentOf(undefined, report),
              );

interface Holders {
    // Each machine holding the folder for this sandbox, with the folder as it names it.
    readonly holders: ReadonlyMap<string, string | undefined>;
    // The connected machines whose folders were read at all: one of these not listing the folder is the evidence it
    // was detached.
    readonly read: ReadonlySet<string>;
}

const holdersOf = async (deps: ProjectDeliveryDeps, project: string): Promise<Holders> => {
    const remoteDir = projectRemoteDir(project);
    const fleet = await deps.syncFleet();
    const names = ownNames(
        deps.publicUrl,
        deps.platformId,
        fleet.reports.flatMap(({ report }) => report.pairings.map((pairing) => pairing.sandboxId)),
    );
    const holders = new Map<string, string | undefined>();
    const read = new Set<string>();
    const readings = await Promise.all(deps.hostHub.known().map(async (host) => ({ host, pairings: await deps.pairingsOf(host) })));
    for (const { host, pairings = [] } of readings.filter((reading) => reading.pairings !== undefined)) {
        if (deps.hostHub.online(host)) {
            read.add(host);
        }
        const held = pairings.find((pairing) => deliversHere(pairing, remoteDir) && pairingIsOurs(pairing, pairings, names));
        if (held !== undefined) {
            holders.set(host, held.localDir);
        }
    }
    for (const { report } of fleet.reports) {
        const held = report.pairings.find((pairing) => deliversHere(pairing, remoteDir));
        for (const host of held === undefined ? [] : hostsOfReport(deps, report).filter((known) => !holders.has(known))) {
            holders.set(host, held?.localDir);
        }
    }
    return { holders, read };
};

// Where the project's folder is and whether it can be reached now. A machine that holds it and answers `deliverProject`
// wins over one that holds it and cannot; a folder no machine mentions is either detached (its own computer, read just
// now, no longer lists it) or held by a computer that is away (remembered from before).
const locate = async (deps: ProjectDeliveryDeps, book: DeliveryBook, project: string): Promise<Whereabouts> => {
    const { holders, read } = await holdersOf(deps, project);
    if (holders.size === 0) {
        const remembered = await book.remembered(project);
        if (remembered !== undefined && read.has(remembered.host)) {
            await book.forget(project);
        }
        return remembered === undefined || read.has(remembered.host)
            ? { kind: "none" }
            : { kind: "waiting", host: remembered.host, folder: remembered.folder, reason: waitReason(deps, remembered.host) };
    }
    const ready = [...holders].flatMap(([host, folder]) => {
        const client = deliveringClient(deps, host);
        return client === undefined ? [] : [{ host, folder, client }];
    })[0];
    const [host, folder] = ready === undefined ? ([...holders][0] ?? ["", undefined]) : [ready.host, ready.folder];
    await book.remember({ project, host, ...opt("folder", folder) });
    return ready === undefined ? { kind: "waiting", host, folder, reason: waitReason(deps, host) } : { kind: "ready", ...ready };
};

/* ---- the reaction ---- */

const NOT_ATTACHED = "The folder is no longer attached to this sandbox, so nothing was delivered.";

type Verdict = Omit<LandingDelivery, "at" | "project">;

// The machine's answer as the card keeps it: what it wrote (merged ones included), and every path it or the build kept
// out of the folder.
const answeredVerdict = (built: DeliveryBuild, result: ProjectDeliveryResult | undefined, folder: string | undefined): Verdict => {
    const conflicts = [...built.kept, ...(result?.conflicts ?? [])];
    return {
        state: conflicts.length > 0 ? "partial" : "delivered",
        ...opt("folder", result?.folder ?? folder),
        applied: (result?.applied.length ?? 0) + (result?.merged.length ?? 0),
        conflicts,
        ...opt("point", result?.point),
    };
};

export interface ProjectDeliverer {
    // Starts listening for lands and trying waiting ones again; the stop undoes both.
    readonly start: () => () => void;
    // One announcement, as the subscription hands it over: returns at once, the delivery runs behind it.
    readonly landed: (event: WorkspaceEvent) => void;
    // Every waiting land tried again now, in the order they were queued.
    readonly retry: () => Promise<void>;
    // Resolves once every delivery under way has finished (tests, and a stop that wants its writes done).
    readonly settled: () => Promise<void>;
}

// `now` and `maxBytes` are the clock and the ceiling, injectable so a test needs neither a wait nor 32 MB of files.
export const createProjectDelivery = (
    deps: ProjectDeliveryDeps,
    { now = Date.now, maxBytes = PROJECT_DELIVERY_MAX_BYTES }: { readonly now?: () => number; readonly maxBytes?: number } = {},
): ProjectDeliverer => {
    const book = deliveryBook(deps.historyRoot);

    // One delivery per project folder at a time: two into the same folder would race the machine's restore point and
    // each other's merges.
    const chains = new Map<string, Promise<unknown>>();
    const inOrder = <T>(project: string, task: () => Promise<T>): Promise<T> => {
        const next = (chains.get(project) ?? Promise.resolve()).then(task, task);
        // allow(silent-catch): the caller holds `next` and hears its rejection; the chain only orders what comes after
        const tail = next.catch(() => undefined);
        chains.set(project, tail);
        void tail.then(() => chains.get(project) === tail && chains.delete(project));
        return next;
    };

    const record = async (owed: Landed, verdict: Verdict): Promise<void> => {
        const delivery: LandingDelivery = { ...verdict, at: now(), project: owed.project };
        await deps.agents.recordDelivery(owed.agentId, delivery);
        deps.logger.info(
            { agentId: owed.agentId, project: owed.project, state: delivery.state, applied: delivery.applied, conflicts: delivery.conflicts.length },
            "project delivery: landed work and the owner's folder",
        );
    };

    // Settles a land that is not going to wait: out of the queue, and the card told.
    const settle = async (owed: Landed, verdict: Verdict): Promise<void> => {
        await book.dequeue(owed);
        await record(owed, verdict);
    };

    // What is owed for this land: a fresh one carries this conversation's land of the project still waiting, from where
    // that one started; a retry is the waiting entry itself, unless a later land already carried it.
    const owedFor = async (
        landed: Landed,
        origin: "land" | "retry",
    ): Promise<{ readonly owed: OwedDelivery; readonly carried: boolean } | undefined> => {
        if (origin === "retry") {
            const current = await book.owed(landed);
            return current === undefined ? undefined : { owed: current, carried: true };
        }
        const earlier = await book.take(landed);
        return { owed: { ...landed, from: earlier?.from ?? landed.from, queuedAt: earlier?.queuedAt ?? now() }, carried: earlier !== undefined };
    };

    // The machine asked (unless the land changed nothing it could be sent), and its answer carried into the sandbox's
    // copy and onto the card.
    const send = async (owed: OwedDelivery, built: DeliveryBuild, folder: string | undefined, client: DeliveryClient | undefined): Promise<void> => {
        let result: ProjectDeliveryResult | undefined;
        try {
            result =
                built.files.length === 0 || client === undefined
                    ? undefined
                    : await client.deliverProject(
                          {
                              remoteDir: projectRemoteDir(owed.project),
                              files: [...built.files],
                              landing: { agentId: owed.agentId, ...opt("title", owed.title) },
                          },
                          { signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS) },
                      );
        } catch (cause: unknown) {
            // Refused or broken: Bring back in the folder's window still reaches every file, so it does not wait.
            await settle(owed, { state: "failed", ...opt("folder", folder), applied: 0, conflicts: [...built.kept], reason: errorMessage(cause) });
            return;
        }
        await book.dequeue(owed);
        // The folder already holds them: a copy here that could not be written is said in the log, and the card still
        // says what the folder did.
        const written = await writeMerged(deps, owed, result?.merged ?? []).catch((cause: unknown) => {
            deps.logger.warn(
                { err: cause, agentId: owed.agentId, project: owed.project },
                "project delivery: the merged files were not written into the sandbox's copy",
            );
            return 0;
        });
        if (written > 0) {
            // The main tree changed again, as a land changes it: history files a checkpoint under these words.
            deps.events.publish("tree.changed", { label: `Merged with your own edits in ${result?.folder ?? owed.project}` });
        }
        await record(owed, answeredVerdict(built, result, folder));
    };

    // What a land carries, read off git; a read that broke or ran past the ceiling settles it here.
    const build = async (owed: OwedDelivery, folder: string | undefined): Promise<DeliveryBuild | undefined> => {
        const built = await deliveryOf(deps.agentWorktrees.mainDir(owed.project), owed.from, owed.tip, defaultGit, maxBytes).catch(
            async (cause: unknown) => {
                await settle(owed, {
                    state: "failed",
                    ...opt("folder", folder),
                    applied: 0,
                    conflicts: [],
                    reason: `Its changes could not be read: ${errorMessage(cause)}`,
                });
                return undefined;
            },
        );
        if (built?.tooLarge === true) {
            await settle(owed, { state: "too-large", ...opt("folder", folder), applied: 0, conflicts: [] });
            return undefined;
        }
        if (built !== undefined && built.files.length === 0 && built.kept.length === 0) {
            await book.dequeue(owed);
            return undefined;
        }
        return built;
    };

    // One land (or a waiting one again), whole: where it goes, what it carries, the machine's answer, and the card.
    const attempt = async (landed: Landed, origin: "land" | "retry"): Promise<void> => {
        if (origin === "retry" && (await book.owed(landed)) === undefined) {
            return;
        }
        const where = await locate(deps, book, landed.project);
        const owing = await owedFor(landed, origin);
        if (owing === undefined) {
            return;
        }
        const { owed, carried } = owing;
        if (where.kind === "none") {
            // Detached while it waited: said, rather than waiting for good. A fresh land into a folder attached nowhere
            // is simply not a delivery.
            if (carried) {
                await settle(owed, { state: "failed", applied: 0, conflicts: [], reason: NOT_ATTACHED });
            }
            return;
        }
        const built = await build(owed, where.folder);
        if (built === undefined) {
            return;
        }
        if (where.kind === "ready" || built.files.length === 0) {
            await send(owed, built, where.folder, where.kind === "ready" ? where.client : undefined);
            return;
        }
        // Waiting: said once, at the land, and not again on every try while the computer stays away.
        if (origin === "land") {
            await book.enqueue(owed);
            await record(owed, { state: "waiting", ...opt("folder", where.folder), applied: 0, conflicts: [], reason: where.reason });
        }
    };

    const landed = (event: WorkspaceEvent): void => {
        if (event.event !== "agent.landed" || event.outcome !== "landed") {
            return;
        }
        // Read now, while the land that announced itself is what the record holds.
        const repos = worktreeOf(deps.agents.entry(event.agentId))?.repos ?? [];
        for (const { repo, from } of event.repos) {
            const tip = repos.find((recorded) => recorded.repo === repo)?.landedTip;
            // `/work` itself and any repository that could not be a project folder are never attached anywhere.
            if (!isProjectDirName(repo) || tip === undefined || tip === from) {
                continue;
            }
            const job: Landed = { agentId: event.agentId, project: repo, from, tip, ...opt("title", event.title) };
            void inOrder(repo, async () => await attempt(job, "land")).catch((cause: unknown) =>
                deps.logger.warn({ err: cause, agentId: event.agentId, project: repo }, "project delivery: a land could not be delivered"),
            );
        }
    };

    const retry = async (): Promise<void> => {
        const { queue } = await book.read();
        await Promise.all(
            queue.map(async (owed) =>
                inOrder(owed.project, async () => await attempt(owed, "retry")).catch((cause: unknown) =>
                    deps.logger.warn(
                        { err: cause, agentId: owed.agentId, project: owed.project },
                        "project delivery: a waiting land could not be delivered",
                    ),
                ),
            ),
        );
    };

    // Waiting lands go when a machine that can take them connects, and every few minutes regardless (a machine that
    // was connected all along may have just had the folder attached, or its agent updated).
    let seen: ReadonlySet<string> = new Set();
    let retriedAt = 0;
    let checking = false;
    const check = async (): Promise<void> => {
        const ready = new Set(deps.hostHub.connected().filter((host) => deliveringClient(deps, host) !== undefined));
        const arrived = [...ready].some((host) => !seen.has(host));
        seen = ready;
        if (checking || book.waiting() === 0 || (!arrived && now() - retriedAt < RETRY_EVERY_MS)) {
            return;
        }
        checking = true;
        retriedAt = now();
        await retry().finally(() => {
            checking = false;
        });
    };

    return {
        start: () => {
            const unsubscribe = deps.events.subscribe("workspace", landed);
            void book.read().catch((cause: unknown) => deps.logger.warn({ err: cause }, "project delivery: the waiting lands could not be read"));
            const timer = setInterval(() => {
                void check().catch((cause: unknown) => deps.logger.warn({ err: cause }, "project delivery: waiting lands were not tried again"));
            }, ARRIVALS_EVERY_MS);
            timer.unref();
            return () => {
                unsubscribe();
                clearInterval(timer);
            };
        },
        landed,
        retry,
        settled: async () => {
            await Promise.all(chains.values());
        },
    };
};
