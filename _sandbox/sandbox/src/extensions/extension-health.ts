import type { ExtensionHealth } from "@intentic/sandbox-contract/schemas/extension-updates";
import { extensionProcessKey } from "../capabilities/extension-dirs.js";
import { extensionRuntimeAbsent } from "../capabilities/extension-inventory/extension-readiness.js";
import { installedExtensions } from "../capabilities/extension-inventory/installed-extensions.js";
import type { Services } from "../composition.js";
import { processesDesired } from "./extension-processes.js";

// Health: for a minute after a swap, checks that what the new version declared actually came up.
// Two probes (early, then final) give a slow boot a fair chance; autoRevert is the auto rung's failure path.

export const EARLY_PROBE_MS = 15_000;
export const FINAL_PROBE_MS = 60_000;

// What is wrong with the extension's backend half, by the supervisor's last word on it: an activation that threw, or one
// that stands and says it is not serving, which is as much a failed update.
const backendProblem = (services: Services, id: string): string | undefined => {
    const backend = services.extensionBackend.statusOf(id);
    if (backend?.state === "error") {
        return `its backend failed to activate${backend.detail !== undefined ? `: ${backend.detail}` : ""}`;
    }
    const health = backend !== undefined && "health" in backend ? backend.health : undefined;
    if (health?.state === "failed") {
        return `its backend reports it is not serving${health.detail !== undefined ? `: ${health.detail}` : ""}`;
    }
    return undefined;
};

const healthProblem = async (services: Services, id: string): Promise<string | undefined | "stop"> => {
    const extension = (await installedExtensions(services)).find((candidate) => candidate.id === id);
    // Removed or switched off mid-watch: the owner intervened, and the watch has nothing left to judge.
    if (extension === undefined || !extension.enabled) {
        return "stop";
    }
    if (!(await extensionRuntimeAbsent(extension)) && (await processesDesired(services, extension))) {
        for (const process of extension.manifest.contributes?.processes ?? []) {
            if (process.autoStart === true && !services.serviceProcesses.running(extensionProcessKey(id, process.name))) {
                return `its declared process "${process.name}" is not running`;
            }
        }
    }
    return extension.manifest.server === undefined ? undefined : backendProblem(services, id);
};

// A watch carries its original auto-revert decision, rather than borrowing whatever policy is set after a restart.
export interface HealthWatch {
    readonly id: string;
    readonly identity: string;
    readonly fromRef: string | undefined;
    readonly autoRevert: boolean;
}

// The update record's writer and the revert, from extension-updates.ts, which owns both.
export interface HealthVerdicts {
    // Ends the watch on the record: a verdict, or undefined to drop it.
    readonly record: (identity: string, health: ExtensionHealth | undefined) => Promise<void>;
    readonly revert: (services: Services, id: string) => Promise<{ readonly ref: string }>;
}

const healthProbe = (services: Services, verdicts: HealthVerdicts, { id, identity, fromRef, autoRevert }: HealthWatch) => {
    const record = (health: ExtensionHealth | undefined): Promise<void> => verdicts.record(identity, health);
    return async (final: boolean): Promise<boolean> => {
        const problem = await healthProblem(services, id);
        if (problem === "stop") {
            await record(undefined);
            return false;
        }
        if (problem !== undefined) {
            if (autoRevert) {
                try {
                    await verdicts.revert(services, id);
                    await record({ state: "unhealthy", detail: problem, fromRef, at: new Date().toISOString(), autoReverted: true });
                    return false;
                } catch (error) {
                    services.logger.warn({ err: error, extension: id }, "extension update: auto-revert failed");
                }
            }
            await record({ state: "unhealthy", detail: problem, fromRef, at: new Date().toISOString() });
            return false;
        }
        if (final) {
            await record({ state: "healthy", fromRef, at: new Date().toISOString() });
        }
        return !final;
    };
};

/** Arms both probes; each ends the watch on the record with its verdict, the final one with "healthy". */
export const scheduleHealthProbes = (services: Services, verdicts: HealthVerdicts, watch: HealthWatch, earlyMs = EARLY_PROBE_MS, finalMs = FINAL_PROBE_MS): void => {
    const { id } = watch;
    const check = healthProbe(services, verdicts, watch);
    const probe = async (final: boolean): Promise<void> => {
        try {
            if (await check(final)) {
                const timer = setTimeout(() => void probe(true), finalMs - earlyMs);
                timer.unref();
            }
        } catch (error) {
            services.logger.warn({ err: error, extension: id }, "extension update: health watch failed");
        }
    };
    const timer = setTimeout(() => void probe(false), earlyMs);
    timer.unref();
};
