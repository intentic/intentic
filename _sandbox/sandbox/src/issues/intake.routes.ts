import { randomUUID } from "node:crypto";
import {
    ISSUE_PAYLOAD_MAX,
    ISSUES_DAILY_MAX_DEFAULT,
    ISSUES_ESCALATE_AFTER_DEFAULT,
    IssueIngestSchema,
    type IssuePublicConfig,
    type IssuesConfig,
} from "@intentic/sandbox-contract";
import type { Context } from "hono";
import type { z } from "zod";
import { streamAgent } from "../agent/agent.routes.js";
import { antiBotAccepted, mintChallenge } from "../auth/antibot.js";
import { tokenEquals } from "../auth/auth.js";
import type { AutomationRecord } from "../automations/automations-store.js";
import { fireAutomation, type WakeFn } from "../automations/scheduler.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../context.js";
import { threadKey } from "../sessions/thread-sessions.js";
import { dailyBudget } from "../store/daily-budget.js";
import { fileInstallsStore, type InstallsStore } from "../store/installs.js";
import { statePath } from "../workspace/state-paths.js";
import { fingerprintOf } from "./fingerprint.js";
import { ISSUES_PROVIDER } from "./provider.js";
import { wakeBrief } from "./issue-payload.js";
import { fileIssuesStore, type IssuesStore } from "./issues-store.js";

/* THE BUG INTAKE: the daemon's second public door, and the whole of what a stranger's browser can reach on it.
 *
 * The Front Desk's ingest is the model, deliberately, down to the order of the gates, because the caller is the
 * same kind of caller and the mistakes are the same mistakes. What differs is what happens AFTER admission, and
 * the difference is the point of the product:
 *
 *   the Front Desk    every message is an agent turn. Somebody is waiting for an answer, so the reply streams.
 *   this             every report is a FILE WRITE, and only sometimes a turn. Nobody is waiting: the reporter's
 *                    browser is usually mid-crash. So it answers immediately and the dedup decides, on its own
 *                    time, whether anybody needs waking at all.
 *
 * THAT SENTENCE IS THE SAFETY MODEL. A crash loop on one popular page is thousands of reports a minute; with a
 * turn per report it is a bill, and with grouping it is one row whose count goes up. Everything else here (the
 * origin allowlist, the rate limit, the daily ceiling) bounds the file writes. The GROUPING is what bounds the
 * spend, and it happens before any of this can wake anyone.
 *
 * The prefix is `/intake/` rather than `/issues/` on purpose: `/issues` is the owner's inbox, keyed by
 * fingerprint, and these are public, keyed by automation id. Two id spaces with two audiences under one prefix
 * is how a rule gets widened without anybody seeing it. */

// A fixed window per automation+client, the Front Desk's own shape. A crashing page can genuinely fire several
// reports in a second (an error, its rejection, a detection), so this is wider than the chat's, and it is not
// the ceiling that matters anyway.
const RATE_MAX = 60;
const RATE_WINDOW_MS = 60_000;
const hits = new Map<string, number[]>();
const rateLimited = (key: string, now: number): boolean => {
    const recent = (hits.get(key) ?? []).filter((at) => at > now - RATE_WINDOW_MS);
    hits.set(key, recent);
    if (recent.length >= RATE_MAX) {
        return true;
    }
    recent.push(now);
    return false;
};

// The per-automation daily ceiling. In memory, for daily-budget.ts's stated reason.
const daily = dailyBudget();

/* How long one issue keeps talking to the same agent. A crash that comes back inside the week resumes the
 * conversation that already looked at it, which is worth a great deal: the agent that read those frames on
 * Monday still has them on Thursday. Past that the worktree is stale and a fresh conversation is the honest
 * start. */
const ISSUE_THREAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const CONVERSATION_ID_MAX = 60;
// Prefixed so an issue's conversation is recognizable on the board and in a worktree name, the Front Desk's
// `wc-` convention.
const mintConversationId = (automationId: string, fingerprint: string): string =>
    `bug-${automationId}-${fingerprint}`.replaceAll(/[^a-zA-Z0-9_-]/g, "-").slice(0, CONVERSATION_ID_MAX);

type Resolved = { automation: AutomationRecord; config: IssuesConfig } | { status: 403 | 404 | 409; error: string; automation?: AutomationRecord };

/* Is this an intake at all, and is this caller allowed to reach it?
 *
 * TWO DOORS, because there are two kinds of client and only one of them has an Origin header to be judged by:
 *
 *   a browser   proves itself by the site it is on, against the automation's allowlist. This is the good gate,
 *               it cannot be lifted out of a bundle and reused, and it is why `keyFromBrowsers` is off by
 *               default: a key pasted into a public web build is a key anybody has.
 *   an app      a phone, a desktop build, a server. No origin exists to check, so it presents the ingest key.
 *               That key ships inside a binary and is therefore an abuse LABEL rather than a secret; what it
 *               buys is that a leaked one can be rotated in a click while the web stays covered by the
 *               allowlist. The ceilings are what actually bound the damage, which is the honest way round.
 *
 * The refusal carries the automation when one was found, because the install panel's most useful line is built
 * from exactly that case: a real intake, asked for by an origin nobody listed. */
const resolve = async (services: Services, id: string, origin: string | undefined, key: string | undefined): Promise<Resolved> => {
    const automation = await services.automations.get(id);
    if (automation === undefined || automation.trigger.kind !== "listener" || automation.trigger.provider !== ISSUES_PROVIDER) {
        return { status: 404, error: "no bug intake with that id" };
    }
    const config: IssuesConfig = automation.issues ?? {};
    if (!admitted(automation, config, origin, key)) {
        return { status: 403, error: origin === undefined ? "this intake needs a valid key" : "origin not allowed", automation };
    }
    if (!automation.enabled) {
        return { status: 409, error: "intake disabled", automation };
    }
    return { automation, config };
};

const admitted = (automation: AutomationRecord, config: IssuesConfig, origin: string | undefined, key: string | undefined): boolean => {
    const keyed = config.ingestKey !== undefined && key !== undefined && tokenEquals(key, config.ingestKey);
    if (origin === undefined) {
        return keyed;
    }
    const listed = automation.trigger.kind === "listener" && (automation.trigger.allowedOrigins ?? []).includes(origin);
    return listed || (config.keyFromBrowsers === true && keyed);
};

/* Does the trigger want to be woken for THIS one? `eventType` narrows to a kind (wake me for crashes, not for
 * every note somebody writes in), `channelId` to a single site origin (wake me for production, not for the
 * staging build three people are clicking around in). Absent means all, on both.
 *
 * A keyless client has no origin to match, so a trigger narrowed to one site never wakes for a phone. That is
 * the honest reading of "only this site" rather than an oversight: an app is not a site, and an owner who
 * wants both leaves the field empty. */
const wakeWanted = (automation: AutomationRecord, kind: string, origin: string | undefined): boolean => {
    if (automation.trigger.kind !== "listener") {
        return false;
    }
    const { eventType, channelId } = automation.trigger;
    return (eventType === undefined || eventType === kind) && (channelId === undefined || channelId === origin);
};

// Defaults resolved daemon-side so the SDK carries no fallback logic, and named field by field so a secret
// added to IssuesConfig later is invisible to a stranger's browser until somebody lists it here.
const DEFAULT_TITLE = "Report a problem";
const DEFAULT_PROMPT = "What went wrong?";
const DEFAULT_THANKS = "Thanks, we have it. We will look into it.";
// Intentic's brand orange, the Front Desk's own default and for its reason: something embedded with nothing
// configured should look like the product it came from.
const DEFAULT_ACCENT = "#e47100";

export const publicIssuesConfig = (automation: AutomationRecord): IssuePublicConfig => {
    const config: IssuesConfig = automation.issues ?? {};
    return {
        automationId: automation.id,
        title: config.title ?? DEFAULT_TITLE,
        prompt: config.prompt ?? DEFAULT_PROMPT,
        thanks: config.thanks ?? DEFAULT_THANKS,
        askEmail: config.askEmail ?? false,
        accent: config.accent ?? DEFAULT_ACCENT,
        // A site that embedded a crash reporter meant to report crashes.
        captureCrashes: config.captureCrashes ?? true,
        antiBot: config.antiBot ?? "off",
    };
};

const remoteIpOf = (c: Context<AppEnv>): string | undefined =>
    c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0]?.trim();

// What a refused request answers with. One shape for every gate below, so the handler has exactly one way to
// say no and the reasons stay comparable.
type Refusal = { status: 400 | 403 | 404 | 409 | 413 | 429; error: string };

// The body, or the refusal. Size before JSON: reading a hundred-megabyte body to discover it is too big is the
// denial of service the limit exists to prevent.
const parsed = async (c: Context<AppEnv, "/intake/:id/report">): Promise<Refusal | { body: z.infer<typeof IssueIngestSchema> }> => {
    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > ISSUE_PAYLOAD_MAX) {
        return { status: 413, error: "payload too large" };
    }
    try {
        return { body: IssueIngestSchema.parse(await c.req.json()) };
    } catch {
        return { status: 400, error: "invalid report body" };
    }
};

/* Everything between "a well-formed report arrived" and "this may be recorded", cheapest check first: who this
 * intake is and whether the caller may reach it, then the per-client rate window, then the puzzle where one is
 * configured, then the day's ceiling.
 *
 * THE ORDER IS THE DESIGN. The daily budget is spent LAST, so a request refused for any other reason has not
 * eaten a report anybody else could have sent. */
const gated = async (
    services: Services,
    c: Context<AppEnv, "/intake/:id/report">,
    body: z.infer<typeof IssueIngestSchema>,
    now: number,
): Promise<Refusal | { automation: AutomationRecord; config: IssuesConfig; origin: string | undefined }> => {
    const origin = c.req.header("origin");
    const resolved = await resolve(services, c.req.param("id"), origin, body.key);
    if ("status" in resolved) {
        return { status: resolved.status, error: resolved.error };
    }
    const { automation, config } = resolved;
    if (rateLimited(`${automation.id}:${body.clientId}`, now)) {
        return { status: 429, error: "rate limited" };
    }
    /* The puzzle applies to WRITTEN reports only. A crash handler fires on a dying page, where there is no
     * second to spend on a challenge and nobody waiting to watch it happen, so demanding one there would simply
     * mean no crash reports at all. */
    if (body.report.kind === "report" && config.antiBot === "pow") {
        const accepted = await antiBotAccepted("pow", {}, { powNonce: body.powNonce }, body.clientId, remoteIpOf(c), now);
        if (!accepted) {
            return { status: 403, error: "bot check failed" };
        }
    }
    if (daily.spend(automation.id, config.dailyReportMax ?? ISSUES_DAILY_MAX_DEFAULT, now)) {
        return { status: 429, error: "this intake has reached today's limit" };
    }
    return { automation, config, origin };
};

export const createIntakeRoutes = (
    services: Services,
    wake: WakeFn = streamAgent,
    issues: IssuesStore = fileIssuesStore(statePath(services.workspace.root, ".intentic/records/issues/")),
    installs: InstallsStore = fileInstallsStore(statePath(services.workspace.root, ".intentic/records/issue-installs.json")),
) => ({
    /* What the SDK renders itself from, and the INSTALL PROBE: the one request every embed makes on every page
     * load, so recording it (admitted or refused) is what lets the app answer "did the snippet land?" instead
     * of showing the same empty inbox for a working intake and an unpasted one. */
    config: async (c: Context<AppEnv, "/intake/:id/config">): Promise<Response> => {
        const origin = c.req.header("origin");
        const resolved = await resolve(services, c.req.param("id"), origin, undefined);
        if (origin !== undefined && resolved.automation !== undefined) {
            installs.record(resolved.automation.id, origin, !("status" in resolved), Date.now());
        }
        if ("status" in resolved) {
            return c.json({ error: resolved.error }, resolved.status);
        }
        return c.json(publicIssuesConfig(resolved.automation));
    },

    // A proof-of-work challenge for one client, spent on a WRITTEN report. Self-verifying and signed against
    // that client, so nothing is stored here and a solution cannot be moved to another reporter.
    challenge: async (c: Context<AppEnv, "/intake/:id/challenge">): Promise<Response> => {
        const resolved = await resolve(services, c.req.param("id"), c.req.header("origin"), undefined);
        if ("status" in resolved) {
            return c.json({ error: resolved.error }, resolved.status);
        }
        const client = c.req.query("client");
        if (client === undefined || client === "") {
            return c.json({ error: "client required" }, 400);
        }
        return c.json(mintChallenge(client, Date.now()));
    },

    report: async (c: Context<AppEnv, "/intake/:id/report">): Promise<Response> => {
        const now = Date.now();
        const read = await parsed(c);
        if ("error" in read) {
            return c.json({ error: read.error }, read.status);
        }
        const gate = await gated(services, c, read.body, now);
        if ("error" in gate) {
            return c.json({ error: gate.error }, gate.status);
        }
        const { automation, config, origin } = gate;
        const { report } = read.body;

        // The grouping, which happens before anything can cost money. `randomUUID` is what makes a written
        // report its own issue; a crash never reaches it.
        const fingerprint = fingerprintOf(automation.id, report, randomUUID());
        const outcome = await issues.record({
            id: fingerprint,
            automationId: automation.id,
            report,
            ...(origin !== undefined ? { origin } : {}),
            now,
            escalateAfter: config.escalateAfter ?? ISSUES_ESCALATE_AFTER_DEFAULT,
        });

        /* Something brand new always deserves a look; something known deserves one again only once it has grown
         * past its escalation step. Everything else is a count going up, which is exactly what the owner wants
         * to see and exactly what nobody should be woken for.
         *
         * The trigger's own filters land HERE rather than at admission, which is this source's one departure
         * from the others: an intake records everything it admits, and the trigger says what is worth
         * interrupting somebody for. That is what lets an owner wake on production crashes while still reading
         * staging's, from one intake, instead of running two. */
        if (wakeWanted(automation, report.kind, origin) && (outcome.fresh || outcome.escalated)) {
            void startWake(services, wake, issues, automation, outcome.issue, outcome.fresh ? "new" : "recurring").catch((error: unknown) =>
                services.logger.error({ err: error, automation: automation.id, issue: fingerprint }, "issue wake failed"),
            );
        }
        // Answered before any of that: the reporter's page may be seconds from unloading, and there is nothing
        // for it to wait on.
        return c.json({ ok: true as const, id: fingerprint });
    },
});

/* Wake the agent for one issue, on the conversation that issue owns.
 *
 * THE THREAD STORE IS DOING REAL WORK HERE, not bookkeeping. It gives the fire a stable conversation id, which
 * is what (a) makes a recurrence continue with the agent that already read these frames, (b) lets the inbox
 * link to the run, and (c) carries the whole thing through a HOLD: the approvals queue snapshots the
 * conversation and origin, and runHeldWake replays and settles them, so an approval-gated intake needs nothing
 * of its own here.
 *
 * `noteRun` is called BEFORE the fire and regardless of what the fire does with it, which is deliberate: it
 * stamps the count this wake was decided at, and that stamp is the escalation rule's only memory. A held wake
 * that did not stamp would put a fresh approval card in the queue for every single crash. */
export const startWake = async (
    services: Services,
    wake: WakeFn,
    issues: IssuesStore,
    automation: AutomationRecord,
    issue: Parameters<typeof wakeBrief>[0],
    why: "new" | "recurring" | "asked",
): Promise<void> => {
    const now = Date.now();
    const thread = threadKey(ISSUES_PROVIDER, automation.id, issue.id);
    const session = await services.threadSessions.open(thread, () => mintConversationId(automation.id, issue.id), ISSUE_THREAD_TTL_MS, now);
    await issues.noteRun(issue.id, session.conversationId, now);

    void services.activity
        .append({
            provider: ISSUES_PROVIDER,
            direction: "in",
            type: `issue.${why}`,
            channelId: issue.id,
            content: issue.title,
            automationIds: [automation.id],
        })
        .catch((error: unknown) => services.logger.warn({ err: error }, "activity append failed"));

    const brief = wakeBrief(issue, why);
    const settled = await fireAutomation(services, automation, wake, {
        payload: brief.payload,
        // An issue's own turns must not overlap each other, and a second escalation arriving mid-fix is
        // information the running turn would rather have than lose.
        overlap: "queue",
        conversationId: session.conversationId,
        ...(session.sessionId !== undefined ? { sessionId: session.sessionId } : {}),
        origin: { automationId: automation.id, provider: ISSUES_PROVIDER, channelId: issue.id },
        title: brief.title,
        ...(automation.allowedTools !== undefined ? { allowedTools: automation.allowedTools } : {}),
    });
    // Learn the provider session so the next escalation continues this thread rather than restating it.
    await services.threadSessions.settle(thread, settled.sessionId, Date.now());
};
