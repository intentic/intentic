import { stderrOf } from "@intentic/base/errors";
import { defaultGit } from "@intentic/base/git";
import {
    type DeployGrant,
    type DeployRecord,
    STACKS_MANIFEST_PATH,
    type StackHealthState,
    type StackRef,
    type StackSpec,
    stackSecretNames,
} from "@intentic/sandbox-contract/schemas/deploys";
import type { StackImagePins } from "@intentic/sandbox-contract/schemas/device-stacks";
import { ORPCError } from "@orpc/server";
import { opt } from "../opt.js";
import { exactCommit, repoFolder } from "../hosts/stacks/device-stack-bundle.js";
import type { DeployGrantsStore } from "./deploy-grants.js";
import { type BookDeps, createLanes, createRecordBook, lastGood, type RecordBook, recordId } from "./deploy-lanes.js";
import { manifestAt } from "./deploy-manifests.js";
import type { RunDeps } from "./deploy-run.js";
import { isLive, newestFirst, stackKey } from "./deploys-store.js";

/* THE DEPLOYS ENGINE (2026-11-25): the managed environments' one way to change what runs on a server (schemas/deploys.ts).
   Each stack is a lane of its own: at most one deploy RUNNING and one WAITING per stack, and a newer request replaces
   the waiting one, which ends `superseded`. The waiting ones are records (deploys-store.ts), so a restart resumes them,
   and one left `running` by a restart ends `failed`, since what happened on the machine is unknown.

   A deploy reads the manifest of the commit it deploys, renders that stack's secrets under the owner's grant
   (deploy-render.ts, deploy-grants.ts) and runs it on the computer (deploy-run.ts). A deploy the MACHINE says failed,
   of a stack declaring `onFailure: "rollback"`, puts the stack back on its last successful deploy: that commit, with
   its images pinned to the digests it ran, as a record of its own (trigger `rollback`); the failed one then ends
   `rolled-back`, naming the deploy it went back to.

   PUBLIC API, for the routes (deploys.routes.ts) and for what starts deploys by itself (CI, registry polls, promotion,
   the monitor):
   - enqueue({ repo, stack, commit?, ref?, trigger: { kind, detail?, url? }, pins? }): queue a deploy; the commit is
     the repository's committed HEAD when absent, and one the repository lacks is fetched from its remote first. Throws
     (BAD_REQUEST, NOT_FOUND) when there is nothing to queue: no such repository, commit, or stack at that commit.
   - settled(id, signal?): the record once the engine is done with it (a rollback it set off included).
   - environments(): every declared stack with its records, grants, state and problems; manifestErrors per repository.
   - history({ repo, stack }, limit?): the stack's records, newest first.
   - rollback({ repo, stack, to? }) and promote(repo, from, to): enqueue the commit and pins of an earlier deploy.
   - onDeployRecord(listener): every record as it is written (queued, running, ended), for forge reporting and
     `after` triggers; answers the unsubscribe.
   - setStackState(repo, stack, state, since?, ownedElsewhere?): what the monitor last read on the computer.
   - onRendered(listener): each deploy's rendered secret values, by name, the moment they are rendered: what the
     rotation watch (deploy-rotation.ts) keys its marks on. A listener keeps no value.
   - setSecretsChanged(repo, stack, names) and setForgeProblem(repo, problem?): what the watch (deploy-watch.ts) found,
     shown on the board; noteForgeUrl(id, url): where the forge shows a record.
   - grants(), grant(ref, by), grantShown(grant), revoke(ref): the owner's grants (the routes hold them to the owner). */

export interface EnqueueRequest {
    readonly repo: string;
    readonly stack: string;
    readonly commit?: string | undefined;
    readonly ref?: string | undefined;
    readonly trigger: DeployRecord["trigger"];
    readonly pins?: StackImagePins | undefined;
}

export interface StackState {
    readonly state: StackHealthState;
    readonly since?: string | undefined;
    readonly ownedElsewhere: boolean;
}

export interface DeploysEngineDeps extends Omit<RunDeps, "now" | "grants">, Omit<BookDeps, "now"> {
    readonly grantsStore: DeployGrantsStore;
    // Brings a commit the repository lacks from its remote; answers why it could not, or nothing.
    readonly fetchRemote: (dir: string) => Promise<string | undefined>;
    readonly now?: () => number;
}

export interface DeploysEngine {
    readonly start: () => Promise<void>;
    readonly stop: () => void;
    readonly enqueue: (request: EnqueueRequest) => Promise<DeployRecord>;
    readonly settled: (id: string, signal?: AbortSignal) => Promise<DeployRecord>;
    readonly records: () => Promise<readonly DeployRecord[]>;
    readonly history: (ref: StackRef, limit?: number) => Promise<readonly DeployRecord[]>;
    readonly rollback: (ref: StackRef & { readonly to?: string | undefined }, detail?: string) => Promise<DeployRecord>;
    readonly promote: (repo: string, from: string, to: string, detail?: string) => Promise<DeployRecord>;
    readonly stackAtHead: (ref: StackRef) => Promise<StackSpec>;
    readonly grants: () => Promise<readonly DeployGrant[]>;
    readonly grant: (ref: StackRef, by: string | undefined) => Promise<DeployGrant>;
    readonly grantShown: (grant: Omit<DeployGrant, "grantedAt">) => Promise<DeployGrant>;
    readonly revoke: (ref: StackRef) => Promise<boolean>;
    readonly onDeployRecord: (listener: (record: DeployRecord) => void) => () => void;
    readonly setStackState: (repo: string, stack: string, state: StackHealthState, since?: string, ownedElsewhere?: boolean) => void;
    readonly stackState: (repo: string, stack: string) => StackState;
    readonly onRendered: (listener: RenderedListener) => () => void;
    readonly setSecretsChanged: (repo: string, stack: string, names: readonly string[]) => void;
    readonly secretsChanged: (repo: string, stack: string) => readonly string[];
    readonly setForgeProblem: (repo: string, problem: string | undefined) => void;
    readonly forgeProblem: (repo: string) => string | undefined;
    readonly noteForgeUrl: (id: string, url: string) => Promise<void>;
}

// Told a deploy's secret values as they were rendered for it, before anything reaches the machine.
export type RenderedListener = (record: DeployRecord, values: ReadonlyMap<string, string>) => void;

export const RESTARTED = "The daemon restarted during this deploy, so how it ended on the computer is unknown: check the stack there, then deploy again.";

const refused = (message: string): ORPCError<"BAD_REQUEST", unknown> => new ORPCError("BAD_REQUEST", { message });
const missing = (message: string): ORPCError<"NOT_FOUND", unknown> => new ORPCError("NOT_FOUND", { message });

const headCommit = async (dir: string, repo: string): Promise<string> =>
    (
        await defaultGit(dir, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).catch((error: Error) => {
            const said = stderrOf(error)?.trim() ?? "";
            throw refused(said === "" ? `"${repo}" has no commits yet: commit what should run, then deploy` : `could not read "${repo}"'s last commit: ${said}`);
        })
    ).stdout.trim();

// The branch HEAD is on, or undefined when it is detached.
const branchOf = async (dir: string): Promise<string | undefined> =>
    defaultGit(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]).then(
        ({ stdout }) => stdout.trim() || undefined,
        // allow(silent-catch): a detached HEAD is git failing to name a branch, which is the answer: none
        () => undefined,
    );

// The stack as `rev` declares it, or why there is none, thrown.
const declaredStack = async (dir: string, ref: StackRef, rev: string, at: string): Promise<StackSpec> => {
    const read = await manifestAt(dir, rev);
    if (read.kind === "absent") {
        throw missing(`"${ref.repo}" ${at} has no ${STACKS_MANIFEST_PATH}, so it declares no stacks.`);
    }
    if (read.kind === "broken") {
        throw refused(`"${ref.repo}" ${at}: ${read.error}`);
    }
    const spec = read.manifest.stacks.find((stack) => stack.name === ref.stack);
    if (spec === undefined) {
        const names = read.manifest.stacks.map((stack) => stack.name);
        throw missing(`"${ref.repo}" ${at} does not declare "${ref.stack}"${names.length === 0 ? "" : `: it declares ${names.join(", ")}`}.`);
    }
    return spec;
};

// A deploy request as a waiting record of its stack, replacing any record of it that waits already.
const enqueueWith = async (book: RecordBook, deps: DeploysEngineDeps, kick: (key: string) => void, request: EnqueueRequest): Promise<DeployRecord> => {
    const dir = await repoFolder(deps.root, request.repo);
    const commit =
        request.commit === undefined ? await headCommit(dir, request.repo) : await exactCommit(dir, request.repo, request.commit, () => deps.fetchRemote(dir));
    const spec = await declaredStack(dir, request, commit, `at ${commit.slice(0, 12)}`);
    const ref = request.ref ?? (request.commit === undefined ? await branchOf(dir) : undefined);
    const record: DeployRecord = {
        id: recordId(book.now()),
        repo: request.repo,
        stack: spec.name,
        device: spec.device,
        commit,
        ...opt("ref", ref),
        trigger: request.trigger,
        outcome: "queued",
        queuedAt: book.stamp(),
        secretNames: [],
        ...opt("pins", request.pins),
    };
    for (const waiting of await book.store.put(record, book.supersededBy(record))) {
        book.publish(waiting);
        book.settle(waiting);
    }
    book.publish(record);
    kick(stackKey(record.repo, record.stack));
    return record;
};

// The record once the engine is done with it; refused when there is none, and given up (the deploy carries on) when
// the caller stops waiting.
const settledIn = (book: RecordBook, id: string, signal?: AbortSignal): Promise<DeployRecord> =>
    new Promise((resolve, reject) => {
        const done = (record: DeployRecord): void => {
            book.endings.delete(listen);
            signal?.removeEventListener("abort", aborted);
            resolve(record);
        };
        const listen = (record: DeployRecord): void => {
            if (record.id === id) {
                done(record);
            }
        };
        const aborted = (): void => {
            book.endings.delete(listen);
            reject(new ORPCError("CLIENT_CLOSED_REQUEST", { message: "Stopped waiting for the deploy; it carries on." }));
        };
        book.endings.add(listen);
        signal?.addEventListener("abort", aborted, { once: true });
        void book.store.get(id).then((record) => {
            if (record === undefined) {
                book.endings.delete(listen);
                reject(missing(`No deploy is named "${id}".`));
            } else if (!isLive(record) && !book.handling.has(id)) {
                done(record);
            }
        }, reject);
    });

const stackRecords = async (book: RecordBook, ref: StackRef): Promise<DeployRecord[]> =>
    (await book.store.all()).filter((record) => record.repo === ref.repo && record.stack === ref.stack);

// An earlier successful deploy of the stack, as a request: the one named, or the one before the current one.
const rollbackRequest = async (book: RecordBook, ref: StackRef & { readonly to?: string | undefined }, detail?: string): Promise<EnqueueRequest> => {
    const good = (await stackRecords(book, ref)).filter((record) => record.outcome === "succeeded");
    const target = ref.to === undefined ? good[1] : good.find((record) => record.id === ref.to);
    if (target === undefined) {
        throw new ORPCError("CONFLICT", {
            message:
                ref.to === undefined
                    ? `"${ref.stack}" has no earlier successful deploy to go back to.`
                    : `"${ref.to}" is not a successful deploy of "${ref.stack}": \`deploys history ${ref.repo} ${ref.stack}\` lists them.`,
        });
    }
    const trigger = { kind: "rollback" as const, detail: `to ${target.id}${detail === undefined ? "" : `, ${detail}`}` };
    return { repo: ref.repo, stack: ref.stack, commit: target.commit, ref: target.ref, pins: target.digests, trigger };
};

// `to` at what `from` runs: its commit and its images by digest.
const promoteRequest = async (book: RecordBook, repo: string, from: string, to: string, detail?: string): Promise<EnqueueRequest> => {
    const source = await lastGood(book, repo, from);
    if (source === undefined) {
        throw new ORPCError("CONFLICT", { message: `"${from}" has no successful deploy to promote: deploy it first.` });
    }
    const trigger = { kind: "promote" as const, detail: `from ${from} (${source.id})${detail === undefined ? "" : `, ${detail}`}` };
    return { repo, stack: to, commit: source.commit, ref: source.ref, pins: source.digests, trigger };
};

// After a restart: a record left running ended unknown (failed), and the newest waiting record of each stack runs; an
// older one still waiting (a store an older build wrote) is replaced by it.
const recover = async (book: RecordBook, kick: (key: string) => void): Promise<void> => {
    const records = await book.store.all();
    for (const record of records.filter((entry) => entry.outcome === "running")) {
        await book.end(record.id, { outcome: "failed", error: RESTARTED });
    }
    const kept = new Map<string, DeployRecord>();
    for (const record of records.filter((entry) => entry.outcome === "queued")) {
        const key = stackKey(record.repo, record.stack);
        const newer = kept.get(key);
        if (newer === undefined) {
            kept.set(key, record);
            continue;
        }
        const ended = await book.write(record.id, book.supersededBy(newer)(record));
        if (ended !== undefined) {
            book.settle(ended);
        }
    }
    for (const key of kept.keys()) {
        kick(key);
    }
};

export const createDeploysEngine = (deps: DeploysEngineDeps): DeploysEngine => {
    const now = deps.now ?? Date.now;
    const book = createRecordBook({ ...deps, now });
    const renderedListeners = new Set<RenderedListener>();
    const rendered: RenderedListener = (record, values) => {
        for (const listener of renderedListeners) {
            try {
                listener(record, values);
            } catch (error) {
                deps.logger.warn({ err: error, id: record.id }, "deploys: a listener failed on a rendered deploy");
            }
        }
    };
    const run: RunDeps = { ...deps, grants: deps.grantsStore, now, rendered };
    const lanes = createLanes(book, run, deps.logger);
    const states = new Map<string, StackState>();
    const changedSecrets = new Map<string, readonly string[]>();
    const forgeProblems = new Map<string, string>();
    const enqueue = (request: EnqueueRequest): Promise<DeployRecord> => enqueueWith(book, deps, lanes.kick, request);
    const stackAtHead = async (ref: StackRef): Promise<StackSpec> => declaredStack(await repoFolder(deps.root, ref.repo), ref, "HEAD", "at its last commit");
    const grantShown = async (grant: Omit<DeployGrant, "grantedAt">): Promise<DeployGrant> => {
        const kept: DeployGrant = { ...grant, secrets: [...grant.secrets].sort(), grantedAt: book.stamp() };
        await deps.grantsStore.set(kept);
        return kept;
    };
    return {
        start: () => recover(book, lanes.kick),
        stop: lanes.stop,
        enqueue,
        settled: (id, signal) => settledIn(book, id, signal),
        records: () => deps.store.all(),
        history: async (ref, limit = 50) => (await stackRecords(book, ref)).toSorted(newestFirst).slice(0, limit),
        rollback: async (ref, detail) => enqueue(await rollbackRequest(book, ref, detail)),
        promote: async (repo, from, to, detail) => enqueue(await promoteRequest(book, repo, from, to, detail)),
        stackAtHead,
        grants: () => deps.grantsStore.list(),
        grant: async (ref, by) => {
            const spec = await stackAtHead(ref);
            return grantShown({ repo: ref.repo, stack: spec.name, device: spec.device, secrets: stackSecretNames(spec), ...opt("grantedBy", by) });
        },
        grantShown,
        revoke: async (ref) => (await deps.grantsStore.revoke(ref.repo, ref.stack)) > 0,
        onDeployRecord: (listener) => {
            book.listeners.add(listener);
            return () => void book.listeners.delete(listener);
        },
        setStackState: (repo, stack, state, since, ownedElsewhere = false) => {
            states.set(stackKey(repo, stack), { state, ...opt("since", since), ownedElsewhere });
        },
        stackState: (repo, stack) => states.get(stackKey(repo, stack)) ?? { state: "unknown", ownedElsewhere: false },
        onRendered: (listener) => {
            renderedListeners.add(listener);
            return () => void renderedListeners.delete(listener);
        },
        setSecretsChanged: (repo, stack, names) => {
            if (names.length === 0) {
                changedSecrets.delete(stackKey(repo, stack));
            } else {
                changedSecrets.set(stackKey(repo, stack), [...names].sort());
            }
        },
        secretsChanged: (repo, stack) => changedSecrets.get(stackKey(repo, stack)) ?? [],
        setForgeProblem: (repo, problem) => {
            if (problem === undefined) {
                forgeProblems.delete(repo);
            } else {
                forgeProblems.set(repo, problem);
            }
        },
        forgeProblem: (repo) => forgeProblems.get(repo),
        noteForgeUrl: async (id, url) => {
            await book.write(id, { forgeUrl: url });
        },
    };
};
