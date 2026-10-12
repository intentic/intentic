import { join } from "node:path";
import type { PowChallenge } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import { antiBotAccepted, mintChallenge, type AntiBotAnswer } from "../auth/antibot.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import { remoteIpOf } from "../http/remote-ip.js";
import { threadKey } from "../seams/thread-key.js";
import { fileInstallsStore, type InstallsDocument, type InstallsStore } from "../store/installs.js";
import type { AutomationRecord } from "./automations-store.js";
import { doorAdmission } from "./door-admission.js";
import { fireOnThread, type FireOutcome, type ThreadFireOptions } from "./scheduler.js";

// Public door: routes an anonymous browser reaches directly (Visitor chat, bug intake), each a stranger's script tag
// rather than an extension, driving fireAutomation directly. No credential; app.ts's auth skip names exactly these
// paths, gated cheapest-first: allowlist or key, rate window, proof-of-work, then the daily ceiling.

export interface PublicDoorSpec<Config> {
    // The listener provider the door's automations name: which `trigger.provider` resolves here.
    readonly provider: string;
    // The path segment the door is served under (/<slug>/:id/config, …/challenge, …/installs, and its own verb).
    readonly slug: string;
    // The door's stored settings on an automation of its kind; defaults not yet applied.
    readonly configOf: (automation: AutomationRecord) => Config;
    // What the embed is told about itself, fully resolved; a secret added later stays invisible until listed here.
    readonly publicConfig: (automation: AutomationRecord) => unknown;
    // The refusals, in the door's own words: the id names nothing of this kind; the automation is switched off.
    readonly missing: string;
    readonly disabled: string;
    // Whether this caller may reach the automation, or a refusal message; absent means the origin allowlist alone.
    readonly admit?: (automation: AutomationRecord, config: Config, origin: string | undefined, keyed: boolean) => string | undefined;
    // The fixed window per automation+caller: how many arrivals a minute before the door answers 429.
    readonly rateMax: number;
    // The query parameter the challenge route reads the caller's id from, so a solution cannot be moved.
    readonly challengeParam: string;
    // This door's install probes are kept separately per door, so automation ids across doors can't collide.
    // Which caller's install-probe document this door records into.
    readonly installs: InstallsDocument;
    // Prefix of sandbox conversations this door opens, so a thread is recognizable on the board and worktree name.
    readonly conversationPrefix: string;
}

// Automation this request addresses, or the refusal to answer with. A refusal still carries the automation when one was
// found, since the install panel's most useful case is a real door refused by an origin not on its list.
export type Resolved<Config> = { readonly automation: AutomationRecord; readonly config: Config } | { readonly status: 403 | 404 | 409; readonly error: string; readonly automation?: AutomationRecord };

const CONVERSATION_ID_MAX = 60;

export interface PublicDoor<Config> {
    readonly resolve: (id: string, origin: string | undefined, key?: string) => Promise<Resolved<Config>>;
    // In-memory per daemon; a restart clears it. Swap for a shared store only if the sandbox runs multi-process.
    readonly rateLimited: (key: string, now: number) => boolean;
    // The per-automation daily ceiling. True ⇒ over, and nothing was spent.
    readonly overDailyCeiling: (automationId: string, max: number, now: number) => boolean;
    // Checks proof of work against the caller's challenge; config carries a Turnstile secret, {} when there's none.
    readonly antiBotPassed: (mode: Parameters<typeof antiBotAccepted>[0], config: Parameters<typeof antiBotAccepted>[1], answer: AntiBotAnswer, callerId: string, c: Context<AppEnv>, now: number) => Promise<boolean>;
    // Thread key and conversation id are derived, not minted; a held wake and a resumed session find the same one.
    readonly thread: (automationId: string, channelId: string) => { readonly key: string; readonly conversationId: string };
    // Fires on a caller's thread: opens/resumes the conversation, runs, and learns the session to resume next time.
    readonly fireOnThread: (
        automation: AutomationRecord,
        thread: { readonly key: string; readonly conversationId: string },
        ttlMs: number,
        options: ThreadFireOptions,
        onOpened?: (conversationId: string) => Promise<void>,
    ) => Promise<FireOutcome>;
    readonly routes: {
        // Embed's own render data, origin-gated; also the install probe, since every page load hits it either way.
        readonly config: (c: Context<AppEnv>) => Promise<Response>;
        // Proof-of-work challenge for one caller; the salt is self-verifying and signed to them, nothing stored here.
        readonly challenge: (c: Context<AppEnv>) => Promise<Response>;
        // Origins that loaded this door's embed, and which were turned away; owner-only, behind the bearer middleware.
        readonly installs: (c: Context<AppEnv>) => Promise<Response>;
    };
}

// The door's own gate, or the default: the trigger's origin allowlist, which only a browser on the page satisfies.
const admission = <Config>(spec: PublicDoorSpec<Config>, automation: AutomationRecord, config: Config, origin: string | undefined, keyed: boolean): string | undefined => {
    if (spec.admit !== undefined) {
        return spec.admit(automation, config, origin, keyed);
    }
    const allowed = automation.trigger.kind === "listener" ? (automation.trigger.allowedOrigins ?? []) : [];
    return origin === undefined || !allowed.includes(origin) ? "origin not allowed" : undefined;
};

export const createPublicDoor = <Config>(
    services: Pick<Services, "agents" | "automations" | "threadSessions" | "workspace" | "doorTokens">,
    spec: PublicDoorSpec<Config>,
    installs: InstallsStore = fileInstallsStore(spec.installs, join(services.workspace.root, spec.installs.path)),
): PublicDoor<Config> => {
    // Called in two halves: the proof-of-work sits between them, cheaper to refuse on than a day's budget to spend.
    const ceilings = doorAdmission();

    const resolve = async (id: string, origin: string | undefined, key?: string): Promise<Resolved<Config>> => {
        const automation = await services.automations.get(id);
        if (automation === undefined || automation.trigger.kind !== "listener" || automation.trigger.provider !== spec.provider) {
            return { status: 404, error: spec.missing };
        }
        const config = spec.configOf(automation);
        // 404 (unknown id) and 403 (wrong origin) stay distinct: the id is public, so both matter to a site owner.
        // Key is checked against the door's store before the spec sees it, only if presented; the allowlist skips it.
        const keyed = key !== undefined && (await services.doorTokens.verify("intake", automation.id, key));
        const refused = admission(spec, automation, config, origin, keyed);
        if (refused !== undefined) {
            return { status: 403, error: refused, automation };
        }
        if (!automation.enabled) {
            return { status: 409, error: spec.disabled, automation };
        }
        return { automation, config };
    };

    // The thread's own conversation, unless it was archived: only a person reopens that one, so the thread starts afresh.
    const mintedOn = (conversationId: string, now: number): string => {
        if (services.agents.entry(conversationId)?.archivedAt === undefined) {
            return conversationId;
        }
        const suffix = now.toString(36);
        return `${conversationId.slice(0, CONVERSATION_ID_MAX - suffix.length - 1)}-${suffix}`;
    };

    const thread = (automationId: string, channelId: string): { key: string; conversationId: string } => ({
        key: threadKey(spec.provider, automationId, channelId),
        conversationId: `${spec.conversationPrefix}-${automationId}-${channelId}`.replaceAll(/[^a-zA-Z0-9_-]/g, "-").slice(0, CONVERSATION_ID_MAX),
    });

    return {
        resolve,
        rateLimited: (key, now) => ceilings.rateLimited(key, spec.rateMax, now),
        overDailyCeiling: ceilings.overDailyCeiling,
        antiBotPassed: (mode, config, answer, callerId, c, now) => antiBotAccepted(mode, config, answer, callerId, remoteIpOf(c), now),
        thread,
        // Same conversation every time, so a chat or a recurring crash stays one card and one worktree.
        fireOnThread: (automation, threadOf, ttlMs, options, onOpened) => {
            const now = Date.now();
            return fireOnThread(
                services as Services,
                automation,
                { key: threadOf.key, ttlMs, mint: () => mintedOn(threadOf.conversationId, now) },
                options,
                onOpened,
            );
        },
        routes: {
            config: async (c) => {
                const origin = c.req.header("origin");
                const resolved = await resolve(c.req.param("id") ?? "", origin);
                if (origin !== undefined && resolved.automation !== undefined) {
                    installs.record(resolved.automation.id, origin, !("status" in resolved), Date.now());
                }
                if ("status" in resolved) {
                    return c.json({ error: resolved.error }, resolved.status);
                }
                return c.json(spec.publicConfig(resolved.automation));
            },
            challenge: async (c) => {
                const resolved = await resolve(c.req.param("id") ?? "", c.req.header("origin"));
                if ("status" in resolved) {
                    return c.json({ error: resolved.error }, resolved.status);
                }
                const caller = c.req.query(spec.challengeParam);
                if (caller === undefined || caller === "") {
                    return c.json({ error: `${spec.challengeParam} required` }, 400);
                }
                const challenge: PowChallenge = mintChallenge(caller, Date.now());
                return c.json(challenge);
            },
            installs: async (c) => c.json({ origins: await installs.list(c.req.param("id") ?? "") }),
        },
    };
};
