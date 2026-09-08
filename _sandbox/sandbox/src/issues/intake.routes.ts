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
import { streamAgent } from "../agent/routes/agent.routes.js";
import type { AutomationRecord } from "../automations/automations-store.js";
import { createPublicDoor, type PublicDoor, type PublicDoorSpec } from "../automations/public-door.js";
import type { WakeFn } from "../automations/scheduler.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import type { InstallsStore } from "../store/installs.js";
import { statePath } from "../workspace/layout/state-paths.js";
import { fingerprintOf } from "./fingerprint.js";
import { ISSUES_PROVIDER } from "./provider.js";
import { wakeBrief } from "./issue-payload.js";
import { fileIssuesStore, type IssuesStore } from "./issues-store.js";

// The daemon's second public door (report), differing from the Front Desk after admission: every report is a file
// write, only sometimes a turn, since nobody waits on a crashing page. Grouping happens before anything can wake
// anyone, which is what bounds the spend; everything else (allowlist, rate limit, ceiling) only bounds the writes.
// `/intake/` is a separate id space, keyed by automation id, from the owner's `/issues/` inbox keyed by fingerprint.

// How long a recurrence resumes the same conversation before the worktree is stale and a fresh one starts.
const ISSUE_THREAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Resolved daemon-side, named field by field, so a new IssuesConfig secret stays hidden until listed here.
const DEFAULT_TITLE = "Report a problem";
const DEFAULT_PROMPT = "What went wrong?";
const DEFAULT_THANKS = "Thanks, we have it. We will look into it.";
// Intentic's brand orange, same default as the Front Desk: unconfigured should still look like the product.
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
    // Two admission paths, since only a browser has an Origin header to check:
    // browser: origin checked against the allowlist; unforgeable, why keyFromBrowsers defaults off
    // app (phone, desktop, server): no origin, so it presents the ingest key instead, a rotatable abuse label, not a
    // secret
    admit: (automation, config, origin, keyed) => {
        if (origin === undefined) {
            return keyed ? undefined : "this intake needs a valid key";
        }
        const listed = automation.trigger.kind === "listener" && (automation.trigger.allowedOrigins ?? []).includes(origin);
        return listed || (config.keyFromBrowsers === true && keyed) ? undefined : "origin not allowed";
    },
    // Wider than the chat's: a crashing page can fire several reports a second; the daily ceiling is what matters.
    rateMax: 60,
    challengeParam: "client",
    installs: (root) => statePath(root, ".intentic/records/issue-installs.json"),
    conversationPrefix: "bug",
};

// Whether the trigger wants to be woken for this event: eventType narrows to a kind, channelId to an origin, absent
// meaning all. A keyless client has no origin, so a trigger narrowed to one site never wakes for it, an app is not a
// site.
const wakeWanted = (automation: AutomationRecord, kind: string, origin: string | undefined): boolean => {
    if (automation.trigger.kind !== "listener") {
        return false;
    }
    const { eventType, channelId } = automation.trigger;
    return (eventType === undefined || eventType === kind) && (channelId === undefined || channelId === origin);
};

// One refusal shape for every gate below, so the handler has exactly one way to say no.
type Refusal = { status: 400 | 403 | 404 | 409 | 413 | 429; error: string };

// The parsed body, or a refusal; checks declared size before parsing JSON, so an oversized body is never fully read
// first.
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

// The door's gates, in order, between a well-formed report and one that may be recorded. One departure: the anti-bot
// puzzle applies only to written reports, since a crash fires from a dying page with nobody there to solve one.
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

            // Grouping happens before anything costs money; randomUUID gives a written report its own issue, not a
            // crash.
            const fingerprint = fingerprintOf(automation.id, report, crypto.randomUUID());
            const outcome = await issues.record({
                id: fingerprint,
                automationId: automation.id,
                report,
                ...(origin !== undefined ? { origin } : {}),
                now,
                escalateAfter: config.escalateAfter ?? ISSUES_ESCALATE_AFTER_DEFAULT,
            });

            // New always wakes; known only past its escalation step. Filters apply here, after recording, not
            // admission.
            if (wakeWanted(automation, report.kind, origin) && (outcome.fresh || outcome.escalated)) {
                void startWake(services, wake, issues, automation, outcome.issue, outcome.fresh ? "new" : "recurring").catch((error: unknown) =>
                    services.logger.error({ err: error, automation: automation.id, issue: fingerprint }, "issue wake failed"),
                );
            }
            // Answered before any of that: the reporter's page may be seconds from unloading, with nothing to wait on.
            return c.json({ ok: true as const, id: fingerprint });
        },
    };
};

// Wakes the agent on the conversation the issue owns. A stable conversation id lets a recurrence continue with the same
// agent, lets the inbox link to the run, and carries a hold through the approvals queue untouched. `noteRun` runs
// before the fire regardless of outcome: it stamps the count this wake was decided at, escalation's only memory, or a
// held wake would queue a fresh card for every crash.
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
            // An issue's turns never overlap; a second escalation mid-fix queues rather than being lost.
            overlap: "queue",
            origin: { automationId: automation.id, provider: ISSUES_PROVIDER, channelId: issue.id },
            title: brief.title,
            ...(automation.allowedTools !== undefined ? { allowedTools: automation.allowedTools } : {}),
        },
        (conversationId) => issues.noteRun(issue.id, conversationId, Date.now()),
    );
};
