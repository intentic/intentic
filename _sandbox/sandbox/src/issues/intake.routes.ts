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
import type { AutomationRecord } from "../automations/automations-store.js";
import { createPublicDoor, type PublicDoor, type PublicDoorSpec } from "../automations/public-door.js";
import type { WakeFn } from "../automations/scheduler.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../context.js";
import type { InstallsStore } from "../store/installs.js";
import { statePath } from "../workspace/state-paths.js";
import { fingerprintOf } from "./fingerprint.js";
import { ISSUES_PROVIDER } from "./provider.js";
import { wakeBrief } from "./issue-payload.js";
import { fileIssuesStore, type IssuesStore } from "./issues-store.js";

/* THE BUG INTAKE: the daemon's second public door (automations/public-door.ts), whose own verb is `report`.
 * What differs from the Front Desk is what happens AFTER admission, and the difference is the point of the
 * product:
 *
 *   the Front Desk    every message is an agent turn. Somebody is waiting for an answer, so the reply streams.
 *   this             every report is a FILE WRITE, and only sometimes a turn. Nobody is waiting: the reporter's
 *                    browser is usually mid-crash. So it answers immediately and the dedup decides, on its own
 *                    time, whether anybody needs waking at all.
 *
 * THAT SENTENCE IS THE SAFETY MODEL. A crash loop on one popular page is thousands of reports a minute; with a
 * turn per report it is a bill, and with grouping it is one row whose count goes up. Everything else (the
 * origin allowlist, the rate limit, the daily ceiling) bounds the file writes. The GROUPING is what bounds the
 * spend, and it happens before any of this can wake anyone.
 *
 * The prefix is `/intake/` rather than `/issues/` on purpose: `/issues` is the owner's inbox, keyed by
 * fingerprint, and these are public, keyed by automation id. Two id spaces with two audiences under one prefix
 * is how a rule gets widened without anybody seeing it. */

/* How long one issue keeps talking to the same agent. A crash that comes back inside the week resumes the
 * conversation that already looked at it, which is worth a great deal: the agent that read those frames on
 * Monday still has them on Thursday. Past that the worktree is stale and a fresh conversation is the honest
 * start. */
const ISSUE_THREAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

export const INTAKE_DOOR: PublicDoorSpec<IssuesConfig> = {
    provider: ISSUES_PROVIDER,
    slug: "intake",
    configOf: (automation) => automation.issues ?? {},
    publicConfig: publicIssuesConfig,
    missing: "no bug intake with that id",
    disabled: "intake disabled",
    /* TWO DOORS, because there are two kinds of client and only one of them has an Origin header to be judged
     * by:
     *
     *   a browser   proves itself by the site it is on, against the automation's allowlist. This is the good
     *               gate, it cannot be lifted out of a bundle and reused, and it is why `keyFromBrowsers` is
     *               off by default: a key pasted into a public web build is a key anybody has.
     *   an app      a phone, a desktop build, a server. No origin exists to check, so it presents the ingest
     *               key. That key ships inside a binary and is therefore an abuse LABEL rather than a secret;
     *               what it buys is that a leaked one can be rotated in a click while the web stays covered by
     *               the allowlist. The ceilings are what actually bound the damage, which is the honest way
     *               round. */
    admit: (automation, config, origin, keyed) => {
        if (origin === undefined) {
            return keyed ? undefined : "this intake needs a valid key";
        }
        const listed = automation.trigger.kind === "listener" && (automation.trigger.allowedOrigins ?? []).includes(origin);
        return listed || (config.keyFromBrowsers === true && keyed) ? undefined : "origin not allowed";
    },
    // Wider than the chat's: a crashing page can genuinely fire several reports in a second (an error, its
    // rejection, a detection), and it is not the ceiling that matters anyway.
    rateMax: 60,
    challengeParam: "client",
    installs: (root) => statePath(root, ".intentic/records/issue-installs.json"),
    conversationPrefix: "bug",
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

/* Everything between "a well-formed report arrived" and "this may be recorded", the door's gates in the door's
 * order, with one departure: the puzzle applies to WRITTEN reports only. A crash handler fires on a dying page,
 * where there is no second to spend on a challenge and nobody waiting to watch it happen, so demanding one
 * there would simply mean no crash reports at all. */
const gated = async (
    door: PublicDoor<IssuesConfig>,
    c: Context<AppEnv, "/intake/:id/report">,
    body: z.infer<typeof IssueIngestSchema>,
    now: number,
): Promise<Refusal | { automation: AutomationRecord; config: IssuesConfig; origin: string | undefined }> => {
    const origin = c.req.header("origin");
    const resolved = await door.resolve(c.req.param("id"), origin, body.key);
    if ("status" in resolved) {
        return { status: resolved.status, error: resolved.error };
    }
    const { automation, config } = resolved;
    if (door.rateLimited(`${automation.id}:${body.clientId}`, now)) {
        return { status: 429, error: "rate limited" };
    }
    if (body.report.kind === "report" && config.antiBot === "pow" && !(await door.antiBotPassed("pow", {}, { powNonce: body.powNonce }, body.clientId, c, now))) {
        return { status: 403, error: "bot check failed" };
    }
    if (door.overDailyCeiling(automation.id, config.dailyReportMax ?? ISSUES_DAILY_MAX_DEFAULT, now)) {
        return { status: 429, error: "this intake has reached today's limit" };
    }
    return { automation, config, origin };
};

export const createIntakeRoutes = (
    services: Services,
    wake: WakeFn = streamAgent,
    issues: IssuesStore = fileIssuesStore(statePath(services.workspace.root, ".intentic/records/issues/")),
    installs?: InstallsStore,
) => {
    const door = createPublicDoor(services, INTAKE_DOOR, installs);
    return {
        ...door.routes,
        report: async (c: Context<AppEnv, "/intake/:id/report">): Promise<Response> => {
            const now = Date.now();
            const read = await parsed(c);
            if ("error" in read) {
                return c.json({ error: read.error }, read.status);
            }
            const gate = await gated(door, c, read.body, now);
            if ("error" in gate) {
                return c.json({ error: gate.error }, gate.status);
            }
            const { automation, config, origin } = gate;
            const { report } = read.body;

            // The grouping, which happens before anything can cost money. `randomUUID` is what makes a written
            // report its own issue; a crash never reaches it.
            const fingerprint = fingerprintOf(automation.id, report, crypto.randomUUID());
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
    };
};

/* Wake the agent for one issue, on the conversation that issue owns.
 *
 * THE THREAD IS DOING REAL WORK HERE, not bookkeeping. It gives the fire a stable conversation id, which is
 * what (a) makes a recurrence continue with the agent that already read these frames, (b) lets the inbox link
 * to the run, and (c) carries the whole thing through a HOLD: the approvals queue snapshots the conversation
 * and origin, and runHeldWake replays and settles them, so an approval-gated intake needs nothing of its own
 * here.
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
    const door = createPublicDoor(services, INTAKE_DOOR);
    const thread = door.thread(automation.id, issue.id);
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
    await door.fireOnThread(
        automation,
        thread,
        ISSUE_THREAD_TTL_MS,
        wake,
        {
            payload: brief.payload,
            // An issue's own turns must not overlap each other, and a second escalation arriving mid-fix is
            // information the running turn would rather have than lose.
            overlap: "queue",
            origin: { automationId: automation.id, provider: ISSUES_PROVIDER, channelId: issue.id },
            title: brief.title,
            ...(automation.allowedTools !== undefined ? { allowedTools: automation.allowedTools } : {}),
        },
        (conversationId) => issues.noteRun(issue.id, conversationId, Date.now()),
    );
};
