import { keyedLock } from "@intentic/base/async";
import { errorMessage, exitCodeOf } from "@intentic/base/errors";
import { defaultGit } from "@intentic/base/git";
import { BoundedMap } from "@intentic/base/held";
import type { DeployRecord, DeployTrigger, StackSpec } from "@intentic/sandbox-contract/schemas/deploys";
import type { StackImageDigests } from "@intentic/sandbox-contract/schemas/device-stacks";
import type { Logger } from "pino";
import { exactCommit, repoFolder } from "../hosts/stacks/device-stack-bundle.js";
import { opt } from "../opt.js";
import { manifestAt } from "./deploy-manifests.js";
import type { DeploysEngine } from "./deploys-engine.js";

/* WHAT STARTS A DEPLOY BY ITSELF, FROM CI AND FROM ANOTHER STACK (schemas/deploys.ts DeployTriggerSchema `ci`, `after`):
   no turn and no person in the path, so the time from CI publishing an image to the deploy starting is a fetch and a
   few git reads.

   - `ci`: a job that passed (GitHub `workflow_job`, GitLab Job Hook) deploys every stack whose trigger names that job on
     that branch, the moment the job ends; a trigger naming no job deploys when the whole run passes (ci/events.ts
     dispatchCiRun, which the webhook and the poller share). `workflow` narrows on GitHub's workflow name; GitLab names
     none, so there a trigger is not narrowed by it. Every stack read off the repository's manifest at HEAD, as the board
     lists them; the deploy itself reads the manifest of the commit it deploys.
   - `after`: a stack that deploys successfully (other than a rollback) deploys each stack of its repository that follows
     it, at its commit and with its images pinned to the digests it ran.

   A commit never replaces a newer one: when the stack's last successful deploy, or the one running or waiting, is on
   this commit or one that contains it, the event is skipped with a log line. Each event is handled once (a webhook
   redelivered, a job and its run both passing), and one repository's events one at a time, so that check reads what the
   event before it queued. */

// A CI job or run that passed, as either forge said it.
export interface CiPass {
    readonly host: "github" | "gitlab";
    // The workspace repository (ci/projects.ts CiProject.repo).
    readonly repo: string;
    readonly branch: string;
    readonly sha: string;
    readonly runId: number;
    // GitHub's workflow name; absent on GitLab.
    readonly workflow?: string | undefined;
    // The job that passed; absent when the whole run passed.
    readonly job?: { readonly id: number; readonly name: string } | undefined;
    readonly url?: string | undefined;
}

type CiTrigger = Extract<DeployTrigger, { readonly ci: unknown }>["ci"];

export interface TriggerDeps {
    readonly root: string;
    readonly engine: Pick<DeploysEngine, "enqueue" | "records">;
    // Brings a commit the repository lacks from its remote; answers why it could not, or nothing.
    readonly fetchRemote: (dir: string) => Promise<string | undefined>;
    readonly logger: Pick<Logger, "info" | "warn">;
}

// Whether a stack's `ci` trigger asks for this pass: its branch, its workflow where the forge names one, and its job, or
// the whole run when it names none.
const ciTriggerMatches = (trigger: CiTrigger, pass: CiPass): boolean => {
    if (trigger.branch !== pass.branch) {
        return false;
    }
    if (trigger.workflow !== undefined && pass.workflow !== undefined && trigger.workflow !== pass.workflow) {
        return false;
    }
    return trigger.job === undefined ? pass.job === undefined : pass.job?.name === trigger.job;
};

// One line naming what passed, for the record.
const ciDetail = (pass: CiPass): string => {
    const what = pass.job === undefined ? "the run" : `job "${pass.job.name}"`;
    const where = pass.workflow === undefined ? "" : ` of "${pass.workflow}"`;
    return `${what}${where} passed on ${pass.branch} (run ${pass.runId})`.slice(0, 300);
};

// Whether `descendant` holds `ancestor`. A commit git cannot place (one it lacks) is not known to hold it, so the deploy
// goes ahead and the engine says what is missing.
const holds = async (dir: string, descendant: string, ancestor: string, logger: Pick<Logger, "warn">): Promise<boolean> => {
    if (descendant === ancestor) {
        return true;
    }
    return await defaultGit(dir, ["merge-base", "--is-ancestor", ancestor, descendant]).then(
        () => true,
        (error: Error) => {
            if (exitCodeOf(error) !== 1) {
                logger.warn({ err: error, ancestor, descendant }, "deploys: could not tell whether one commit holds another; deploying");
            }
            return false;
        },
    );
};

// What the stack stands on now: the deploy running or waiting, and its last successful one.
const standingOf = (records: readonly DeployRecord[], repo: string, stack: string): DeployRecord[] => {
    const own = records.filter((record) => record.repo === repo && record.stack === stack);
    const active = own.find((record) => record.outcome === "running") ?? own.find((record) => record.outcome === "queued");
    const current = own.find((record) => record.outcome === "succeeded");
    return [active, current].filter((record): record is DeployRecord => record !== undefined);
};

const sameImages = (left: StackImageDigests | undefined, right: StackImageDigests | undefined): boolean =>
    JSON.stringify(Object.entries(left ?? {}).toSorted()) === JSON.stringify(Object.entries(right ?? {}).toSorted());

// Events heard, by key, so a redelivery is dropped before any git runs.
const HEARD_KEPT = 2000;

export const createDeployTriggers = (deps: TriggerDeps) => {
    const inOrder = keyedLock<string>();
    const heard = new BoundedMap<string, true>(HEARD_KEPT);

    // The standing deploy of the stack that already holds `commit` (with `images`, for a promotion), or undefined.
    const supersedes = async (dir: string, repo: string, stack: string, commit: string, images?: StackImageDigests): Promise<DeployRecord | undefined> => {
        for (const record of standingOf(await deps.engine.records(), repo, stack)) {
            const ranImages = record.digests ?? record.pins;
            if (record.commit === commit ? images === undefined || sameImages(ranImages, images) : await holds(dir, record.commit, commit, deps.logger)) {
                return record;
            }
        }
        return undefined;
    };

    // Each stack the manifest at HEAD declares that `wanted` picks, read in the repository's folder.
    const declared = async (repo: string, wanted: (spec: StackSpec) => boolean): Promise<{ readonly dir: string; readonly stacks: readonly StackSpec[] }> => {
        const dir = await repoFolder(deps.root, repo);
        const read = await manifestAt(dir, "HEAD");
        return { dir, stacks: read.kind === "read" ? read.manifest.stacks.filter(wanted) : [] };
    };

    const enqueueUnlessHeld = async (dir: string, request: Parameters<TriggerDeps["engine"]["enqueue"]>[0] & { readonly commit: string }): Promise<DeployRecord | undefined> => {
        const held = await supersedes(dir, request.repo, request.stack, request.commit, request.pins);
        if (held !== undefined) {
            deps.logger.info(
                { repo: request.repo, stack: request.stack, commit: request.commit, standing: held.id, trigger: request.trigger.kind },
                "deploys: skipped, the stack already runs or waits on this commit or a newer one",
            );
            return undefined;
        }
        return await deps.engine.enqueue(request);
    };

    // A CI job or run passed: each stack it triggers, queued at its commit.
    const ciPassedNow = async (pass: CiPass, key: string): Promise<DeployRecord[]> => {
        if (heard.has(key)) {
            return [];
        }
        heard.set(key, true);
        const { dir, stacks } = await declared(pass.repo, (spec) => spec.triggers.some((trigger) => "ci" in trigger && ciTriggerMatches(trigger.ci, pass)));
        if (stacks.length === 0) {
            return [];
        }
        // Fetched once for every stack it triggers: the ancestry check needs the commit here as much as the deploy does.
        const commit = await exactCommit(dir, pass.repo, pass.sha, () => deps.fetchRemote(dir));
        const queued: DeployRecord[] = [];
        for (const spec of stacks) {
            const trigger = { kind: "ci" as const, detail: ciDetail(pass), ...opt("url", pass.url) };
            try {
                const record = await enqueueUnlessHeld(dir, { repo: pass.repo, stack: spec.name, commit, ref: pass.branch, trigger });
                queued.push(...(record === undefined ? [] : [record]));
            } catch (error) {
                deps.logger.warn({ err: error, repo: pass.repo, stack: spec.name, commit }, `deploys: a passing CI run could not queue its deploy: ${errorMessage(error)}`);
            }
        }
        return queued;
    };

    // A stack came up: each stack of its repository that follows it, at its commit and on its images.
    const followNow = async (record: DeployRecord): Promise<DeployRecord[]> => {
        const { dir, stacks } = await declared(record.repo, (spec) => spec.triggers.some((trigger) => "after" in trigger && trigger.after.stack === record.stack));
        const queued: DeployRecord[] = [];
        for (const spec of stacks) {
            const trigger = { kind: "after" as const, detail: `after ${record.stack} (${record.id})` };
            try {
                const request = { repo: record.repo, stack: spec.name, commit: record.commit, ref: record.ref, pins: record.digests, trigger };
                const queuedOne = await enqueueUnlessHeld(dir, request);
                queued.push(...(queuedOne === undefined ? [] : [queuedOne]));
            } catch (error) {
                deps.logger.warn({ err: error, repo: record.repo, stack: spec.name, after: record.id }, `deploys: a promotion could not queue: ${errorMessage(error)}`);
            }
        }
        return queued;
    };

    return {
        // What it queued; a failure is logged, never thrown: nobody waits on a webhook's afterthought.
        ciPassed: (pass: CiPass): Promise<DeployRecord[]> => {
            const key = `${pass.host}:${pass.repo}:${pass.runId}:${pass.job === undefined ? "run" : `job:${pass.job.id}`}`;
            return inOrder(pass.repo, () => ciPassedNow(pass, key)).catch((error: Error) => {
                // Not heard after all: a redelivery may find the remote or the repository readable again.
                heard.delete(key);
                deps.logger.warn({ err: error, repo: pass.repo, sha: pass.sha }, `deploys: a passing CI run was not read for deploys: ${errorMessage(error)}`);
                return [];
            });
        },
        // Every record as the engine writes it (onDeployRecord); acts on each successful one once.
        recorded: (record: DeployRecord): Promise<DeployRecord[]> => {
            if (record.outcome !== "succeeded" || record.trigger.kind === "rollback" || heard.has(`after:${record.id}`)) {
                return Promise.resolve([]);
            }
            heard.set(`after:${record.id}`, true);
            return inOrder(record.repo, () => followNow(record)).catch((error: Error) => {
                deps.logger.warn({ err: error, repo: record.repo, after: record.id }, `deploys: the stacks following one were not read: ${errorMessage(error)}`);
                return [];
            });
        },
    };
};
