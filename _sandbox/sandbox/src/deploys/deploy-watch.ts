import { serialLock } from "@intentic/base/async";
import type { ListenerMessage } from "@intentic/sandbox-contract/protocol/doors/listener-protocol";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import type { DeployRecord } from "@intentic/sandbox-contract/schemas/deploys";
import type { Logger } from "pino";
import type { CiProject } from "../ci/projects.js";
import type { FetchFn } from "../ci/providers.js";
import type { StackServices } from "../hosts/stacks/device-stacks.js";
import { createForgeReports } from "./deploy-forge.js";
import { createMonitor } from "./deploy-monitor.js";
import { createRegistryChecks } from "./deploy-registry.js";
import { createRotationWatch } from "./deploy-rotation.js";
import type { SecretMarks } from "./deploy-secret-marks.js";
import { type CiPass, createDeployTriggers } from "./deploy-triggers.js";
import type { DeployWatchStore } from "./deploy-watch-store.js";
import type { DeploysEngine } from "./deploys-engine.js";

/* THE DEPLOYS WATCH (2026-11-25): everything that moves a managed environment, or tells the owner about one, with
   nobody asking and no turn in the path; the engine (deploys-engine.ts) does each deploy.
   - deploy-triggers.ts: a passing CI job or run, and a stack another one follows, queue deploys.
   - deploy-registry.ts: newer images behind a stack's tags, pulled on its interval, recorded as a deploy.
   - deploy-monitor.ts: each stack's state on its computer every minute, and its server's disks and memory every five,
     told to the owner's automations when it breaks, recovers or runs low.
   - deploy-rotation.ts: a secret a stack runs with changed in the store: redeployed or told, as its manifest says.
   - deploy-forge.ts: each deploy reported to its repository's GitHub (Deployments) or GitLab (commit statuses).
   The record listeners are subscribed when this is built, so the deploys a restart ends (deploys-engine.ts recover)
   reach the forge too; the loops and the secrets subscription start with `start`, from the boot (boot-schedulers.ts). */

export interface DeployWatchDeps {
    readonly root: string;
    readonly engine: DeploysEngine;
    readonly device: StackServices;
    readonly deviceCards: () => Promise<readonly Capability[]>;
    readonly store: DeployWatchStore;
    readonly marks: SecretMarks;
    readonly secretValue: (name: string) => Promise<string | undefined>;
    readonly onSecretsChanged: (listener: () => void) => () => void;
    readonly projectOf: (repo: string) => Promise<CiProject | undefined>;
    readonly fetch: FetchFn;
    readonly publicUrl: string | undefined;
    readonly fetchRemote: (dir: string) => Promise<string | undefined>;
    readonly dispatch: (message: ListenerMessage) => Promise<void>;
    readonly logger: Pick<Logger, "info" | "warn">;
    readonly now?: () => number;
}

export interface DeployWatch {
    // A CI job or run passed (ci/webhook.routes.ts, ci/events.ts): the deploys it queued. Never rejects.
    readonly ciPassed: (pass: CiPass) => Promise<readonly DeployRecord[]>;
    readonly start: () => Promise<void>;
    readonly stop: () => void;
}

// The monitor reads stacks and pulls due registries every minute, and servers' fill every five.
const STACKS_EVERY_MS = 60_000;
const HOSTS_EVERY_MS = 5 * 60_000;

export const createDeployWatch = (deps: DeployWatchDeps): DeployWatch => {
    const now = deps.now ?? Date.now;
    const triggers = createDeployTriggers(deps);
    const forge = createForgeReports(deps);
    const rotation = createRotationWatch(deps);
    const monitor = createMonitor({ ...deps, now });
    const registry = createRegistryChecks({ ...deps, now });
    const stops: (() => void)[] = [
        deps.engine.onDeployRecord((record) => {
            void triggers.recorded(record);
            void forge.recorded(record);
            void rotation.recorded(record);
        }),
        deps.engine.onRendered(rotation.rendered),
    ];
    // A pass still running when the next is due is waited for, never overlapped.
    const loop = (name: string, everyMs: number, pass: () => Promise<void>): void => {
        const serially = serialLock();
        const run = (): void => void serially(pass).catch((error: Error) => deps.logger.warn({ err: error }, `deploys: the ${name} pass stopped on an error`));
        run();
        const timer = setInterval(run, everyMs);
        timer.unref();
        stops.push(() => clearInterval(timer));
    };
    return {
        ciPassed: triggers.ciPassed,
        start: async () => {
            await monitor.restore();
            stops.push(deps.onSecretsChanged(() => void rotation.check()));
            void rotation.check();
            loop("monitor", STACKS_EVERY_MS, monitor.readStacks);
            loop("registry", STACKS_EVERY_MS, async () => {
                await registry.check();
            });
            loop("servers", HOSTS_EVERY_MS, monitor.readHosts);
        },
        stop: () => {
            for (const stop of stops.splice(0)) {
                stop();
            }
        },
    };
};
