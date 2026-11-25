import { errorMessage } from "@intentic/base/errors";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import { type DeployRecord, deployIntervalMs, type StackSpec } from "@intentic/sandbox-contract/schemas/deploys";
import type { Logger } from "pino";
import { deviceStackOp, type StackServices } from "../hosts/stacks/device-stacks.js";
import { workspaceManifests } from "./deploy-manifests.js";
import { resolveDevice } from "./deploy-run.js";
import type { RegistryCheck,DeployWatchStore } from "./deploy-watch-store.js";
import type { DeploysEngine } from "./deploys-engine.js";

/* NEWER IMAGES BEHIND THE SAME TAGS (schemas/deploys.ts DeployTriggerSchema `registry`), in place of Komodo's daily
   "Global Auto Update": every `every` after the stack's last check (or its last successful deploy, whichever is later),
   the computer is asked to `pull` the stack (stack_action: pull, then `up -d` with the logins and pins its last deploy
   left), and only when compose recreated a container for it, a newer image arrived and a deploy is RECORDED: queued at the
   commit the stack runs, trigger `registry`. That deploy finds the images already there, waits for the stack's health,
   answers the digests it runs and, under `onFailure: rollback`, puts the stack back on the digests it ran before. A pull
   that brought nothing records nothing. `list_stacks` names each service's image by its tag, never its digest, so what
   changed is read off compose's own words and the digests off the recording deploy.

   A stack is left alone while a deploy of it runs or waits, until a deploy from here has succeeded, while its computer
   is not connected, and when another sandbox owns it there. A stack whose last deploy pinned its images (a rollback, a
   promotion) pulls those pins, so it stays where it was put until a deploy without them. */

export interface RegistryDeps {
    readonly root: string;
    readonly engine: Pick<DeploysEngine, "enqueue" | "records" | "stackState">;
    readonly device: StackServices;
    readonly deviceCards: () => Promise<readonly Capability[]>;
    readonly store: DeployWatchStore;
    readonly logger: Pick<Logger, "info" | "warn">;
    readonly now: () => number;
}

// Whether compose recreated or created a container applying the pull: a newer image behind a tag (or a service it had
// not run). An unchanged stack prints `Container <name>  Running` for each.
export const imagesMoved = (output: string): boolean => /\bContainer\s+\S+\s+(?:Recreated?|Created)\b/.test(output);

interface Watched {
    readonly repo: string;
    readonly spec: StackSpec;
    readonly every: string;
    readonly everyMs: number;
}

// When the stack's images were last known fresh: its last check, or its last successful deploy when that is later.
const freshAt = (check: RegistryCheck | undefined, current: DeployRecord): number =>
    Math.max(check === undefined ? 0 : Date.parse(check.checkedAt), Date.parse(current.endedAt ?? current.queuedAt));

export const createRegistryChecks = (deps: RegistryDeps) => {
    // Whether the stack may be pulled now, and the deploy it would stand on; a reason it may not is logged by nobody: it is
    // the ordinary case (deploying, never deployed, asleep), looked at again next pass.
    const pullable = (watched: Watched, records: readonly DeployRecord[], cards: readonly Capability[]): { id: string; current: DeployRecord } | undefined => {
        const own = records.filter((record) => record.repo === watched.repo && record.stack === watched.spec.name);
        const current = own.find((record) => record.outcome === "succeeded");
        const id = resolveDevice(watched.spec.device, cards);
        const busy = own.some((record) => record.outcome === "queued" || record.outcome === "running");
        if (current === undefined || id === undefined || busy || !deps.device.hostHub.online(id) || deps.engine.stackState(watched.repo, watched.spec.name).ownedElsewhere) {
            return undefined;
        }
        return { id, current };
    };

    const pullOne = async (watched: Watched, id: string, current: DeployRecord): Promise<DeployRecord | undefined> => {
        const { repo, spec } = watched;
        let output: string;
        try {
            output = (await deviceStackOp(deps.device, { id, name: spec.name, op: "pull" })).output;
        } catch (error) {
            deps.logger.warn({ err: error, repo, stack: spec.name, device: id }, `deploys: the registry check could not pull: ${errorMessage(error)}`);
            return undefined;
        }
        if (!imagesMoved(output)) {
            return undefined;
        }
        const trigger = { kind: "registry" as const, detail: `newer images behind its tags (pulled every ${watched.every})` };
        try {
            return await deps.engine.enqueue({ repo, stack: spec.name, commit: current.commit, ref: current.ref, trigger });
        } catch (error) {
            deps.logger.warn({ err: error, repo, stack: spec.name }, `deploys: newer images were pulled but their deploy could not queue: ${errorMessage(error)}`);
            return undefined;
        }
    };

    // One pass: each stack with a registry trigger that is due, pulled; what it queued.
    const check = async (): Promise<DeployRecord[]> => {
        const watched: Watched[] = (await workspaceManifests(deps.root)).stacks.flatMap(({ repo, spec }) =>
            spec.triggers.flatMap((trigger) => ("registry" in trigger ? [{ repo, spec, every: trigger.registry.every, everyMs: deployIntervalMs(trigger.registry.every) }] : [])).slice(0, 1),
        );
        if (watched.length === 0) {
            return [];
        }
        const [file, records, cards] = await Promise.all([deps.store.read(), deps.engine.records(), deps.deviceCards()]);
        const queued: DeployRecord[] = [];
        const checked: RegistryCheck[] = [];
        for (const one of watched) {
            const held = file.registry.find((entry) => entry.repo === one.repo && entry.stack === one.spec.name);
            const ready = pullable(one, records, cards);
            if (ready === undefined || deps.now() - freshAt(held, ready.current) < one.everyMs) {
                checked.push(...(held === undefined ? [] : [held]));
                continue;
            }
            checked.push({ repo: one.repo, stack: one.spec.name, checkedAt: new Date(deps.now()).toISOString() });
            const record = await pullOne(one, ready.id, ready.current);
            queued.push(...(record === undefined ? [] : [record]));
        }
        await deps.store.update((current) => ({ ...current, registry: checked }));
        return queued;
    };
    return { check };
};
