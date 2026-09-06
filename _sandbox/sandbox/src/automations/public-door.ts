import type { PowChallenge } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import { antiBotAccepted, mintChallenge, type AntiBotAnswer } from "../auth/antibot.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../context.js";
import { threadKey } from "../sessions/thread-sessions.js";
import { dailyBudget } from "../store/daily-budget.js";
import { rateWindow } from "../store/rate-window.js";
import { fileInstallsStore, type InstallsStore } from "../store/installs.js";
import type { AutomationRecord } from "./automations-store.js";
import { fireAutomation, type FireOptions, type FireOutcome, type WakeFn } from "./scheduler.js";

/* A PUBLIC DOOR: the routes an ANONYMOUS browser may reach on this daemon, written once for the two things that
 * open one. The Front Desk (webchat/) and the bug intake (issues/) are the inbound-HTTP mirror of the
 * gateway-process pattern: no extension holds a connection, because the connection is a `<script>` tag on
 * someone else's page, so these routes ARE the source. They normalize what arrives and drive `fireAutomation`
 * directly, reusing the automation's guard, requireApproval gate, run history and activity log unchanged.
 *
 * Everything a stranger can do is here plus the one route each door adds for what it is FOR (a message that
 * streams a reply, a report that is filed and only sometimes wakes anyone), which is what makes "the embed
 * can't reach the rest of the daemon" a property of the wiring rather than a permission list someone has to
 * maintain: the visitor never holds a credential at all, and app.ts's auth skip names these paths and nothing
 * else. The embeds' side of the same wire is the contract's embed.ts.
 *
 * THE GATES, in the order a request meets them, cheapest first: who this automation is and whether the caller
 * may reach it (the trigger's origin allowlist, or a door's own key), a fixed rate window per caller, the
 * proof-of-work puzzle where one is configured, and the day's ceiling, spent LAST so a request refused for any
 * other reason has not eaten a turn anybody else could have had. */

export interface PublicDoorSpec<Config> {
    // The listener provider the door's automations name: which `trigger.provider` resolves here.
    readonly provider: string;
    // The path segment the door is served under (/<slug>/:id/config, …/challenge, …/installs, and its own verb).
    readonly slug: string;
    // The door's stored settings on an automation of its kind, defaults NOT yet applied.
    readonly configOf: (automation: AutomationRecord) => Config;
    // What the embed is told about itself, fully resolved and naming every field it emits, so a secret added to
    // the config later is invisible to a stranger's browser until somebody deliberately lists it.
    readonly publicConfig: (automation: AutomationRecord) => unknown;
    // The refusals, in the door's own words: the id names nothing of this kind; the automation is switched off.
    readonly missing: string;
    readonly disabled: string;
    /* Whether this caller may reach the automation, or the sentence refusing it. Absent ⇒ the trigger's origin
     * allowlist alone, the good gate: it cannot be lifted out of a bundle and reused. A door with a second
     * kind of caller (a phone with no Origin header presenting a key) supplies its own; `keyed` is whether the
     * key it presented is the one this door was issued (auth/door-tokens.ts), already checked, so the door
     * decides what a valid key buys and never touches the credential itself. */
    readonly admit?: (automation: AutomationRecord, config: Config, origin: string | undefined, keyed: boolean) => string | undefined;
    // The fixed window per automation+caller: how many arrivals a minute before the door answers 429.
    readonly rateMax: number;
    // The query parameter the challenge route reads the caller's id from, so a solution cannot be moved.
    readonly challengeParam: string;
    // Where the install probes are kept. Two doors, two files: the key inside is an automation id, and a Front
    // Desk's id colliding with an intake's would merge two panels' answers.
    // Where this door keeps its install probe, off the workspace root.
    readonly installs: (root: string) => string;
    // The prefix of the sandbox conversations this door opens, so a thread is recognizable on the board and
    // in a worktree name.
    readonly conversationPrefix: string;
}

// The automation this request addresses, or the refusal to answer with. A refusal carries the automation
// whenever one was found, because the install panel's most useful line is built from exactly that case: a real
// door, asked for by an origin that is not on its list. Nothing about the RESPONSE changes, the caller still
// answers with `status` and `error` alone.
export type Resolved<Config> = { readonly automation: AutomationRecord; readonly config: Config } | { readonly status: 403 | 404 | 409; readonly error: string; readonly automation?: AutomationRecord };

const RATE_WINDOW_MS = 60_000;
const CONVERSATION_ID_MAX = 60;

// The client's address, for Turnstile's optional remoteip check. Behind the tunnel the socket is Cloudflare's,
// so the forwarded header is the only thing that carries the visitor's, and it is advisory either way.
export const remoteIpOf = (c: Context<AppEnv>): string | undefined => c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim();

export interface PublicDoor<Config> {
    readonly resolve: (id: string, origin: string | undefined, key?: string) => Promise<Resolved<Config>>;
    // A fixed window per automation+caller. ponytail: in-memory, per daemon, a restart clears it; swap for a
    // shared store only if the sandbox ever runs multi-process.
    readonly rateLimited: (key: string, now: number) => boolean;
    // The per-automation daily ceiling. True ⇒ over, and nothing was spent.
    readonly overDailyCeiling: (automationId: string, max: number, now: number) => boolean;
    // One caller's proof of work, checked against the challenge minted for that caller. `config` is the
    // door's own settings where the check reads a Turnstile secret out of them; `{}` for a door that has none.
    readonly antiBotPassed: (mode: Parameters<typeof antiBotAccepted>[0], config: Parameters<typeof antiBotAccepted>[1], answer: AntiBotAnswer, callerId: string, c: Context<AppEnv>, now: number) => Promise<boolean>;
    // A caller's thread key and the conversation id its thread would own: derived, not minted, so a held wake
    // and a resumed session both find the same one. Bounded and charset-checked like the scheduler's own.
    readonly thread: (automationId: string, channelId: string) => { readonly key: string; readonly conversationId: string };
    /* Fire the automation on a caller's thread: open (or resume) the sandbox conversation the thread owns,
     * run, and learn the provider session so the next arrival continues rather than restates. `onOpened` runs
     * between the open and the fire, for a door with something to stamp at that moment (an issue's run). */
    readonly fireOnThread: (
        automation: AutomationRecord,
        thread: { readonly key: string; readonly conversationId: string },
        ttlMs: number,
        wake: WakeFn,
        options: Omit<FireOptions, "conversationId" | "sessionId">,
        onOpened?: (conversationId: string) => Promise<void>,
    ) => Promise<FireOutcome>;
    readonly routes: {
        /* What the embed renders itself from. Origin-gated like the door's own verb so a door's greeting, accent
         * and sign-in settings aren't readable from anywhere on the internet. This is also the INSTALL PROBE: it
         * is the one request every embed makes on every page load, so recording it, admitted or refused, is
         * what lets the app answer "did the snippet land?" instead of showing the same empty history for a
         * working embed and an unpasted one. */
        readonly config: (c: Context<AppEnv>) => Promise<Response>;
        // A proof-of-work challenge for one caller. The salt is self-verifying and signed against that caller,
        // so nothing is stored here and a solution can't be moved to another thread or reporter.
        readonly challenge: (c: Context<AppEnv>) => Promise<Response>;
        // What the owner's install panel reads: which origins have loaded this door's embed, and which were
        // turned away. OWNER-ONLY, absent from app.ts's public paths, so it goes through the bearer middleware.
        readonly installs: (c: Context<AppEnv>) => Promise<Response>;
    };
}

// The door's own gate, or the default one: the trigger's origin allowlist, which a browser on the page satisfies
// and nothing else can.
const admission = <Config>(spec: PublicDoorSpec<Config>, automation: AutomationRecord, config: Config, origin: string | undefined, keyed: boolean): string | undefined => {
    if (spec.admit !== undefined) {
        return spec.admit(automation, config, origin, keyed);
    }
    const allowed = automation.trigger.kind === "listener" ? (automation.trigger.allowedOrigins ?? []) : [];
    return origin === undefined || !allowed.includes(origin) ? "origin not allowed" : undefined;
};

export const createPublicDoor = <Config>(
    services: Pick<Services, "automations" | "threadSessions" | "workspace" | "doorTokens">,
    spec: PublicDoorSpec<Config>,
    installs: InstallsStore = fileInstallsStore(spec.installs(services.workspace.root)),
): PublicDoor<Config> => {
    const window = rateWindow(RATE_WINDOW_MS);
    const daily = dailyBudget();

    const resolve = async (id: string, origin: string | undefined, key?: string): Promise<Resolved<Config>> => {
        const automation = await services.automations.get(id);
        if (automation === undefined || automation.trigger.kind !== "listener" || automation.trigger.provider !== spec.provider) {
            return { status: 404, error: spec.missing };
        }
        const config = spec.configOf(automation);
        /* The public id is the address; the embed-origin allowlist (plus the rate limit) is the real gate, CORS
         * only keeps browsers from blocking a legit embed. A non-browser client omits Origin and is refused,
         * unless the door has a key for it.
         *
         * These statuses do tell an unknown id (404) from a real one asked for by the wrong origin (403). That
         * is deliberate rather than overlooked: an automation id is PUBLIC by construction, it sits in the
         * snippet on the customer's own page, so there is nothing for a uniform answer to protect, and the two
         * cases are the two different things a site owner has to fix. */
        // The key is checked against the door's own store BEFORE the spec sees it, and only when one was
        // presented: a browser on the allowlist never causes a read of the credential it does not hold.
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

    const thread = (automationId: string, channelId: string): { key: string; conversationId: string } => ({
        key: threadKey(spec.provider, automationId, channelId),
        conversationId: `${spec.conversationPrefix}-${automationId}-${channelId}`.replaceAll(/[^a-zA-Z0-9_-]/g, "-").slice(0, CONVERSATION_ID_MAX),
    });

    return {
        resolve,
        rateLimited: (key, now) => window.limited(key, spec.rateMax, now),
        overDailyCeiling: (automationId, max, now) => daily.spend(automationId, max, now),
        antiBotPassed: (mode, config, answer, callerId, c, now) => antiBotAccepted(mode, config, answer, callerId, remoteIpOf(c), now),
        thread,
        fireOnThread: async (automation, threadOf, ttlMs, wake, options, onOpened) => {
            const now = Date.now();
            const session = await services.threadSessions.open(threadOf.key, () => threadOf.conversationId, ttlMs, now);
            await onOpened?.(session.conversationId);
            const settled = await fireAutomation(services as Services, automation, wake, {
                ...options,
                // The SAME conversation every time, so a five-message chat or a recurring crash is one card and
                // one worktree, and a held wake snapshots the conversation the thread already owns.
                conversationId: session.conversationId,
                ...(session.sessionId !== undefined ? { sessionId: session.sessionId } : {}),
            });
            // Learn the provider session so the next arrival continues this thread rather than restating it.
            await services.threadSessions.settle(threadOf.key, settled.sessionId, Date.now());
            return settled;
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
