import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { sleep } from "@intentic/base/async";
import { errorMessage, isMissing } from "@intentic/base/errors";
import { ORG_SECTIONS, type OrgPolicy, OrgPolicySchema, type OrgPolicyState, orgUnknownPins } from "@intentic/sandbox-contract/schemas/organisation";
import type { Logger } from "pino";
import { z } from "zod";
import { writeJsonFile } from "../store/json-file.js";
import { parseJsonWith } from "@intentic/base/json";

/* THE ORGANISATION POLICY THIS SANDBOX ENFORCES (docs/architecture/organisations.md). A personal sandbox holds none,
 * and then nothing here changes anything: orgLockRefusal (sandbox-contract policy/org-locks.ts) lets every request
 * through for an undefined policy. A bound sandbox is handed its organisation's policy by the platform it is registered
 * with, over its connect token (the ingress `orgPolicy`), at boot and every few minutes after.
 *
 * Kept on disk beside the sandbox's other trust files (the auth root, outside the workspace the agent edits), so a
 * restart while the platform is unreachable still enforces the last edition: losing the platform must never loosen a
 * bound sandbox. For the same reason only the platform's explicit `null` unbinds; a refusal, an unreadable answer or
 * silence keeps what is held.
 *
 * The platform's answer is the policy, whatever is held: it replaces the held one whenever the two differ, an edition
 * numbered BELOW the held one included. Taking only a newer edition (as phase 1 did) let a held file edited to a huge
 * `version` outlive every later answer, and a platform restored from a backup never reach its sandboxes again.
 * Refreshes run one at a time, so an older answer can never land after a newer one.
 *
 * The file is read once, at construction; the policy in force is the one in memory, which nothing in the workspace or
 * the auth root can reach while the daemon runs. A held file that exists but does not read is a bound sandbox whose
 * record broke, so it is enforced as PROVISIONAL until the platform answers: every section held read-only, never open.
 * A held file that is gone cannot be told from a personal sandbox: the first change a covered route is asked for waits
 * a bounded moment for the platform's first answer (`settled`), so a deleted file opens nothing while the platform is
 * reachable. With the platform unreachable too it does open, which is the limit of anything kept inside a container
 * whose agents run as root (docs/architecture/organisations.md, "What the protection does not cover"). */

export const ORG_POLICY_FILE = "org-policy.json";
// How often a bound or personal sandbox asks again: a lock an admin sets reaches every sandbox within this.
export const ORG_POLICY_POLL_MS = 5 * 60_000;
// How long a covered change waits for the platform's first answer when nothing is held. One round trip when the
// platform is up; when it is down, the delay a personal sandbox pays once per boot before its first such change.
export const ORG_POLICY_FIRST_ANSWER_MS = 5_000;

const HeldSchema = z.object({ policy: OrgPolicySchema, receivedAt: z.string() });
type Held = z.infer<typeof HeldSchema> & { readonly provisional?: true };

// The held file as its schema reads it, or undefined for one that is not that.
const heldOf = (text: string): z.infer<typeof HeldSchema> | undefined => {
    // Text that is not JSON is a held file that does not read, which the caller handles.
    return parseJsonWith(text, HeldSchema);
};

// The organisation's name out of a file that does not otherwise read, for the refusal's wording only.
const NamedSchema = z.object({ policy: z.object({ orgName: z.string().min(1).max(120) }) });
const nameIn = (text: string): string | undefined => {
    try {
        return NamedSchema.safeParse(JSON.parse(text)).data?.policy.orgName;
    } catch {
        // allow(silent-catch): no name to read is the answer; the refusal then says "your organisation".
        return undefined;
    }
};

// What a bound sandbox whose held record broke enforces until the platform answers: every section read-only. No pins
// and no roster fence: those change files and rosters, and a guess must never write anything down.
export const provisionalPolicy = (orgName: string | undefined): OrgPolicy => ({
    orgId: "provisional",
    orgName: orgName ?? "Your organisation",
    version: 1,
    sections: Object.fromEntries(ORG_SECTIONS.map((section) => [section, "locked"])),
});

// Whether two policies say the same thing, field by field rather than by their JSON, whose key order is the writer's.
const sameList = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean =>
    (a ?? []).length === (b ?? []).length && (a ?? []).every((item, index) => item === (b ?? [])[index]);
export const samePolicy = (a: OrgPolicy, b: OrgPolicy): boolean =>
    a.orgId === b.orgId &&
    a.orgName === b.orgName &&
    a.version === b.version &&
    ORG_SECTIONS.every((section) => a.sections[section] === b.sections[section]) &&
    sameList(a.preset, b.preset) &&
    (a.membersOnly ?? false) === (b.membersOnly ?? false) &&
    sameList(a.people, b.people);

// What the fetch loop calls the platform with; injected, so the loop and the decisions it makes are testable without one.
export type OrgPolicyFetch = (applied: number | undefined, signal: AbortSignal) => Promise<{ readonly policy: OrgPolicy | null } | undefined>;

export interface OrgPolicyHolder {
    // The policy in force, once the file on disk has been read; undefined for a personal sandbox.
    readonly current: () => Promise<OrgPolicy | undefined>;
    readonly state: () => Promise<OrgPolicyState>;
    // Takes the platform's answer: a policy (in force from now if it differs from what is held) or null (unbound).
    readonly accept: (policy: OrgPolicy | null) => Promise<void>;
    // Asks the platform now and takes its answer; a failure keeps what is held.
    readonly refresh: (signal?: AbortSignal) => Promise<void>;
    // Whether the loop's first ask is still out: until it is answered, nothing held may only mean nothing heard yet.
    readonly waiting: () => boolean;
    // Resolves once the loop's first ask has been answered or failed, or after `waitMs`; at once when no ask is out.
    readonly settled: (waitMs: number) => Promise<void>;
    // Calls `listener` with the policy in force once the held file has been read, then after every change to it
    // (undefined: none). A listener's failure is logged, never the holder's.
    readonly onChange: (listener: (policy: OrgPolicy | undefined) => Promise<void> | void) => () => void;
    readonly start: () => void;
    readonly stop: () => void;
}

export const createOrgPolicyHolder = (deps: {
    readonly authRoot: string;
    readonly logger: Logger;
    readonly fetch?: OrgPolicyFetch | undefined;
    readonly now?: () => Date;
}): OrgPolicyHolder => {
    const path = join(deps.authRoot, ORG_POLICY_FILE);
    const now = deps.now ?? (() => new Date());
    let held: Held | undefined;
    type Listener = (policy: OrgPolicy | undefined) => Promise<void> | void;
    const listeners = new Set<Listener>();
    const tell = (listener: Listener): Promise<void> =>
        Promise.resolve()
            .then(() => listener(held?.policy))
            .catch((error: Error) => deps.logger.warn({ err: error }, "org policy: a listener failed on the policy now in force"));
    const changed = async (): Promise<void> => {
        for (const listener of listeners) {
            // in order, each after the last: a roster reconcile and a drift check must not race
            await tell(listener);
        }
    };

    const loaded = readFile(path, "utf8").then(
        (text) => {
            const read = heldOf(text);
            if (read !== undefined) {
                held = read;
                return;
            }
            held = { policy: provisionalPolicy(nameIn(text)), receivedAt: now().toISOString(), provisional: true };
            deps.logger.warn({ path }, "org policy: the held policy does not read; every section is held read-only until the platform answers");
        },
        (error: Error) => {
            if (isMissing(error)) {
                return;
            }
            held = { policy: provisionalPolicy(undefined), receivedAt: now().toISOString(), provisional: true };
            deps.logger.warn({ err: error, path }, "org policy: the held policy cannot be read; every section is held read-only until the platform answers");
        },
    );

    const accept = async (policy: OrgPolicy | null): Promise<void> => {
        await loaded;
        if (policy === null) {
            if (held !== undefined) {
                deps.logger.info({ org: held.policy.orgId }, "org policy: this sandbox no longer belongs to an organisation");
                held = undefined;
                await rm(path, { force: true });
                await changed();
            }
            return;
        }
        if (held !== undefined && held.provisional !== true && samePolicy(held.policy, policy)) {
            return;
        }
        if (held !== undefined && held.provisional !== true && held.policy.orgId === policy.orgId && policy.version < held.policy.version) {
            // The platform is the policy; a held edition ahead of it was edited or restored from somewhere else.
            deps.logger.warn(
                { org: policy.orgId, held: held.policy.version, platform: policy.version },
                "org policy: the held edition was ahead of the platform's; taking the platform's",
            );
        }
        const next = { policy, receivedAt: now().toISOString() };
        await writeJsonFile(path, next, 0o600);
        held = next;
        deps.logger.info({ org: policy.orgId, version: policy.version, unenforced: orgUnknownPins(policy) }, "org policy: applied");
        await changed();
    };

    // One refresh at a time, in the order they were asked for.
    let queue: Promise<void> = Promise.resolve();
    const refreshOnce = async (signal: AbortSignal): Promise<void> => {
        if (deps.fetch === undefined) {
            return;
        }
        await loaded;
        // A provisional hold is not an edition this sandbox was given, so it is not reported as one.
        const applied = held?.provisional === true ? undefined : held?.policy.version;
        const answer = await deps.fetch(applied, signal).catch((error: Error) => {
            deps.logger.debug({ err: errorMessage(error) }, "org policy: the platform could not be asked; keeping what is held");
            return undefined;
        });
        if (answer !== undefined && !signal.aborted) {
            await accept(answer.policy);
        }
    };
    const refresh = (signal: AbortSignal = new AbortController().signal): Promise<void> => {
        const run = queue.then(() => refreshOnce(signal));
        // allow(silent-catch): the caller is handed `run` and sees its failure; the queue only needs to move on.
        queue = run.catch(() => undefined);
        return run;
    };

    let running: AbortController | undefined;
    let first: Promise<void> | undefined;
    let firstDone = false;
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
            if (held === undefined) {
                return { bound: false };
            }
            const state: OrgPolicyState = { bound: true, policy: held.policy, receivedAt: held.receivedAt };
            if (held.provisional === true) {
                state.provisional = true;
            }
            const unknown = orgUnknownPins(held.policy);
            if (unknown.length > 0) {
                state.unenforced = unknown;
            }
            return state;
        },
        accept,
        refresh,
        waiting: () => first !== undefined && !firstDone,
        settled: async (waitMs) => {
            if (first === undefined || firstDone) {
                return;
            }
            let timer: NodeJS.Timeout | undefined;
            await Promise.race([first, new Promise<void>((resolve) => (timer = setTimeout(resolve, waitMs)))]);
            clearTimeout(timer);
        },
        onChange: (listener) => {
            listeners.add(listener);
            void loaded.then(() => tell(listener));
            return () => listeners.delete(listener);
        },
        start: () => {
            if (running === undefined) {
                running = new AbortController();
                // The loop's first refresh is the first answer `settled` waits for; the loop then owns the rest.
                const signal = running.signal;
                first = refresh(signal)
                    .catch((error: Error) => deps.logger.warn({ err: error }, "org policy: could not apply the platform's first answer"))
                    .finally(() => {
                        firstDone = true;
                    });
                void first.then(() => loop(signal));
            }
        },
        stop: () => {
            running?.abort();
            running = undefined;
        },
    };
};
