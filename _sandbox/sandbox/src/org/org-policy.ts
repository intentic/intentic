import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { sleep } from "@intentic/base/async";
import { errorMessage, isMissing } from "@intentic/base/errors";
import { type OrgPolicy, OrgPolicySchema, type OrgPolicyState } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { z } from "zod";
import { writeJsonFile } from "../store/json-file.js";

/* THE ORGANISATION POLICY THIS SANDBOX ENFORCES (docs/architecture/organisations.md). A personal sandbox holds none,
 * and then nothing here changes anything: orgLockRefusal (sandbox-contract policy/org-locks.ts) lets every request
 * through for an undefined policy. A bound sandbox is handed its organisation's policy by the platform it is registered
 * with, over its connect token (the ingress `orgPolicy`), at boot and every few minutes after.
 *
 * Kept on disk beside the sandbox's other trust files (the auth root, outside the workspace the agent edits), so a
 * restart while the platform is unreachable still enforces the last edition: losing the platform must never loosen a
 * bound sandbox. For the same reason only the platform's explicit `null` unbinds; a refusal, an unreadable answer or
 * silence keeps what is held. A newer edition replaces an older one, an older one is ignored, and a policy naming a
 * different organisation replaces it outright, since the platform is the one that moved the sandbox. */

export const ORG_POLICY_FILE = "org-policy.json";
// How often a bound or personal sandbox asks again: a lock an admin sets reaches every sandbox within this.
export const ORG_POLICY_POLL_MS = 5 * 60_000;

const HeldSchema = z.object({ policy: OrgPolicySchema, receivedAt: z.string() });
type Held = z.infer<typeof HeldSchema>;

// The held file as its schema reads it, or undefined for one that is not that.
const heldOf = (text: string): Held | undefined => {
    try {
        const parsed = HeldSchema.safeParse(JSON.parse(text));
        return parsed.success ? parsed.data : undefined;
    } catch {
        // allow(silent-catch): text that is not JSON is a held file that does not read, which the caller logs.
        return undefined;
    }
};

// What the fetch loop calls the platform with; injected, so the loop and the decisions it makes are testable without one.
export type OrgPolicyFetch = (applied: number | undefined, signal: AbortSignal) => Promise<{ readonly policy: OrgPolicy | null } | undefined>;

export interface OrgPolicyHolder {
    // The policy in force, once the file on disk has been read; undefined for a personal sandbox.
    readonly current: () => Promise<OrgPolicy | undefined>;
    readonly state: () => Promise<OrgPolicyState>;
    // Takes the platform's answer: a policy (applied if it is news) or null (unbound).
    readonly accept: (policy: OrgPolicy | null) => Promise<void>;
    // Asks the platform now and takes its answer; a failure keeps what is held.
    readonly refresh: (signal?: AbortSignal) => Promise<void>;
    readonly start: () => void;
    readonly stop: () => void;
}

// Whether `next` should replace `held`: always over nothing or another organisation's, otherwise only a newer edition.
const isNews = (held: OrgPolicy | undefined, next: OrgPolicy): boolean =>
    held === undefined || held.orgId !== next.orgId || next.version > held.version;

export const createOrgPolicyHolder = (deps: {
    readonly authRoot: string;
    readonly logger: Logger;
    readonly fetch?: OrgPolicyFetch | undefined;
    readonly now?: () => Date;
}): OrgPolicyHolder => {
    const path = join(deps.authRoot, ORG_POLICY_FILE);
    const now = deps.now ?? (() => new Date());
    let held: Held | undefined;
    // A file that is there but unreadable is held as what it last was in memory (nothing, at boot) and logged: it is
    // the daemon's own file, so this is a disk fault rather than a policy, and the next fetch rewrites it.
    const loaded = readFile(path, "utf8").then(
        (text) => {
            held = heldOf(text);
            if (held === undefined) {
                deps.logger.warn({ path }, "org policy: the held policy could not be read; waiting for the platform's");
            }
        },
        (error: Error) => {
            if (!isMissing(error)) {
                deps.logger.warn({ err: error, path }, "org policy: the held policy could not be read; waiting for the platform's");
            }
        },
    );

    const accept = async (policy: OrgPolicy | null): Promise<void> => {
        await loaded;
        if (policy === null) {
            if (held !== undefined) {
                deps.logger.info({ org: held.policy.orgId }, "org policy: this sandbox no longer belongs to an organisation");
                held = undefined;
                await rm(path, { force: true });
            }
            return;
        }
        if (!isNews(held?.policy, policy)) {
            return;
        }
        const next = { policy, receivedAt: now().toISOString() };
        await writeJsonFile(path, next, 0o600);
        held = next;
        deps.logger.info({ org: policy.orgId, version: policy.version }, "org policy: applied");
    };

    const refresh = async (signal: AbortSignal = new AbortController().signal): Promise<void> => {
        if (deps.fetch === undefined) {
            return;
        }
        await loaded;
        const answer = await deps.fetch(held?.policy.version, signal).catch((error: Error) => {
            deps.logger.debug({ err: errorMessage(error) }, "org policy: the platform could not be asked; keeping what is held");
            return undefined;
        });
        if (answer !== undefined && !signal.aborted) {
            await accept(answer.policy);
        }
    };

    let running: AbortController | undefined;
    const loop = async (signal: AbortSignal): Promise<void> => {
        while (!signal.aborted) {
            await refresh(signal).catch((error: Error) => deps.logger.warn({ err: error }, "org policy: could not apply the platform's answer"));
            // allow(silent-catch): the wait rejects only when stop() aborts it, which is the loop being told to end.
            await sleep(ORG_POLICY_POLL_MS, { signal }).catch(() => undefined);
        }
    };

    return {
        current: async () => {
            await loaded;
            return held?.policy;
        },
        state: async () => {
            await loaded;
            return held === undefined ? { bound: false } : { bound: true, policy: held.policy, receivedAt: held.receivedAt };
        },
        accept,
        refresh,
        start: () => {
            if (running === undefined) {
                running = new AbortController();
                void loop(running.signal);
            }
        },
        stop: () => {
            running?.abort();
            running = undefined;
        },
    };
};
