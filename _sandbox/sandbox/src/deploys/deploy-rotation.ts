import { createHash } from "node:crypto";
import { serialLock } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import { BoundedMap } from "@intentic/base/held";
import type { ListenerMessage } from "@intentic/sandbox-contract/protocol/doors/listener-protocol";
import type { DeployRecord, StackSpec } from "@intentic/sandbox-contract/schemas/deploys";
import type { Logger } from "pino";
import { secretsChangedMessageOf } from "./deploy-events.js";
import { workspaceManifests } from "./deploy-manifests.js";
import type { SecretMarks, StackMarks } from "./deploy-secret-marks.js";
import type { DeploysEngine } from "./deploys-engine.js";
import { isLive } from "./deploys-store.js";

/* A SECRET ROTATED UNDER A RUNNING STACK (schemas/deploys.ts StackSpecSchema `onSecretChange`): the store says only that
   something changed (secrets-slice.ts onSecretsChanged names nothing), so each stack's last successful deploy leaves a
   mark of every value it received (deploy-secret-marks.ts: an HMAC under this sandbox's own key, taken as the deploy
   rendered them, never the value), and each change in the store, and each boot, marks the store's values again. A name
   whose mark differs (changed, or removed) is on the board as changed (`secretsChanged`) until the stack deploys again,
   and each new change is acted on once, as the manifest at HEAD says: `redeploy` queues the stack again at the commit
   and images it runs (trigger `secret-change`), and `notify` tells the owner's automations (`secrets_changed`).

   A redeploy is left to a deploy already waiting for the stack, which renders the new value anyway; one running now may
   have rendered the old one, so the redeploy waits behind it, at its commit rather than an older one. */

export interface RotationDeps {
    readonly root: string;
    readonly engine: Pick<DeploysEngine, "enqueue" | "records" | "setSecretsChanged">;
    readonly marks: SecretMarks;
    // The sandbox's own store: the only place a deploy renders from (deploy-render.ts).
    readonly secretValue: (name: string) => Promise<string | undefined>;
    readonly dispatch: (message: ListenerMessage) => Promise<void>;
    readonly logger: Pick<Logger, "info" | "warn">;
}

// A change already acted on, by its names and marks: an id for its one event, derived from marks only.
const changeId = (fresh: readonly (readonly [string, string])[]): string =>
    createHash("sha256")
        .update(fresh.map(([name, mark]) => `${name}=${mark}`).join("\n"))
        .digest("hex")
        .slice(0, 16);

// `redeploy`: queued again at what it runs, unless a deploy already waits; whether the change is now acted on.
const redeploy = async (deps: RotationDeps, entry: StackMarks, names: readonly string[]): Promise<boolean> => {
    const own = (await deps.engine.records()).filter((record) => record.repo === entry.repo && record.stack === entry.stack);
    if (own.some((record) => record.outcome === "queued")) {
        return true;
    }
    const target = own.find((record) => record.outcome === "running") ?? own.find((record) => record.outcome === "succeeded");
    if (target === undefined) {
        return true;
    }
    const trigger = { kind: "secret-change" as const, detail: `${names.join(", ")} changed in the secret store`.slice(0, 300) };
    try {
        await deps.engine.enqueue({ repo: entry.repo, stack: entry.stack, commit: target.commit, ref: target.ref, pins: target.pins, trigger });
        return true;
    } catch (error) {
        deps.logger.warn({ err: error, repo: entry.repo, stack: entry.stack }, `deploys: a rotated secret's redeploy could not queue: ${errorMessage(error)}`);
        return false;
    }
};

const notify = async (deps: RotationDeps, entry: StackMarks, spec: StackSpec, fresh: readonly (readonly [string, string])[]): Promise<boolean> => {
    const message = secretsChangedMessageOf({ repo: entry.repo, stack: entry.stack, device: spec.device, names: fresh.map(([name]) => name), mark: changeId(fresh) });
    try {
        await deps.dispatch(message);
        return true;
    } catch (error) {
        deps.logger.warn({ err: error, repo: entry.repo, stack: entry.stack }, "deploys: a rotated secret's event could not be dispatched");
        return false;
    }
};

// The stack's marks against the store's values now: each name changed since its deploy, and those not acted on yet.
const compared = async (deps: Pick<RotationDeps, "secretValue">, entry: StackMarks, mark: (name: string, value: string | undefined) => string) => {
    const changed: string[] = [];
    const fresh: (readonly [string, string])[] = [];
    for (const [name, deployed] of Object.entries(entry.deployed)) {
        const now = mark(name, await deps.secretValue(name));
        if (now !== deployed) {
            changed.push(name);
            fresh.push(...(entry.told[name] === now ? [] : [[name, now] as const]));
        }
    }
    return { changed, fresh };
};

// Deploys of a stack held in memory between their render and their end, at most.
const RENDERED_KEPT = 200;

export const createRotationWatch = (deps: RotationDeps) => {
    // Record id → the marks of what it rendered, until it ends.
    const rendering = new BoundedMap<string, Promise<Readonly<Record<string, string>>>>(RENDERED_KEPT);
    const serially = serialLock();

    // The engine rendered a deploy's values: marked now, the values themselves dropped with this call.
    const rendered = (record: DeployRecord, values: ReadonlyMap<string, string>): void => {
        const marked = deps.marks.marker().then((mark) => Object.fromEntries([...values].map(([name, value]) => [name, mark(name, value)])));
        // allow(silent-catch): a mark that could not be taken is said where it is awaited (`recorded`), not twice
        marked.catch(() => undefined);
        rendering.set(record.id, marked);
    };

    // One check at a time; each acts only on what the one before it did not.
    const check = (): Promise<void> =>
        serially(checkNow).catch((error: Error) => deps.logger.warn({ err: error }, `deploys: the stacks' secrets could not be checked: ${errorMessage(error)}`));

    // A record ended: a successful one's marks become what the stack runs with.
    const recorded = async (record: DeployRecord): Promise<void> => {
        const marked = rendering.get(record.id);
        if (marked === undefined || isLive(record)) {
            return;
        }
        rendering.delete(record.id);
        if (record.outcome !== "succeeded") {
            return;
        }
        try {
            const deployed = await marked;
            await deps.marks.change(record.repo, record.stack, () => ({ repo: record.repo, stack: record.stack, deployed: { ...deployed }, told: {} }));
            // A value changed between the render and now is still a change: read the store again.
            void check();
        } catch (error) {
            deps.logger.warn({ err: error, id: record.id }, `deploys: the secrets a deploy received could not be marked: ${errorMessage(error)}`);
        }
    };


    // A new change, acted on as the stack's manifest says, and kept as acted on once it was.
    const act = async (entry: StackMarks, spec: StackSpec, fresh: readonly (readonly [string, string])[]): Promise<void> => {
        const names = fresh.map(([name]) => name);
        const acted = spec.onSecretChange === "redeploy" ? await redeploy(deps, entry, names) : await notify(deps, entry, spec, fresh);
        if (acted) {
            deps.logger.info({ repo: entry.repo, stack: entry.stack, secrets: names, policy: spec.onSecretChange }, "deploys: a secret a stack runs with changed");
            await deps.marks.change(entry.repo, entry.stack, (current) => ({ ...current, told: { ...current.told, ...Object.fromEntries(fresh) } }));
        }
    };

    // Every stack's marks against the store's values now: the board's `secretsChanged`, and each new change acted on.
    const checkNow = async (): Promise<void> => {
        const [mark, all, manifests] = await Promise.all([deps.marks.marker(), deps.marks.all(), workspaceManifests(deps.root)]);
        for (const entry of all) {
            const { changed, fresh } = await compared(deps, entry, mark);
            deps.engine.setSecretsChanged(entry.repo, entry.stack, changed);
            const spec = manifests.stacks.find((declared) => declared.repo === entry.repo && declared.spec.name === entry.stack)?.spec;
            if (fresh.length > 0 && spec !== undefined) {
                await act(entry, spec, fresh);
            }
        }
    };

    return { rendered, recorded, check };
};
