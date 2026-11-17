import { type AccountReport, AccountReportSchema, ISSUE_PAYLOAD_MAX, type IssueSender, ISSUES_DAILY_MAX_DEFAULT, ISSUES_ESCALATE_AFTER_DEFAULT } from "@intentic/sandbox-contract/schemas/issues";
import { SANDBOX_PASS_HEADER, type SandboxPass, verifySandboxPass } from "@intentic/sandbox-contract/sandbox-pass";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import type { Context } from "hono";
import type { AppEnv } from "../app-env.js";
import type { AutomationRecord } from "../automations/automations-store.js";
import { ISSUES_PROVIDER } from "../automations/catalog.js";
import type { Services } from "../composition.js";
import { readBoundedJson } from "../http/bounded-body.js";
import { defineRawRoutes } from "../http/raw-route-server.js";
import { fingerprintOf } from "./fingerprint.js";
import { startWake, wakeWanted } from "./intake.routes.js";
import type { IssuesStore } from "./issues-store.js";

// ACCOUNT-LEVEL REPORT ROUTING, the receiving door: another sandbox on the owner's account reporting a problem about a
// project this one claims. Admission is a pass the platform signed (sandbox-contract sandbox-pass.ts), addressed to this
// sandbox: the platform read the sender from its connect token and searched only this owner's claims, so who is
// reporting is the platform's word, never the body's. Everything after admission is the intake's own pipeline: grouped
// by fingerprint before anything costs money, woken only when new or escalated, on the conversation the issue owns.
//
// No issues automation here means the report is still recorded, into the inbox under `account`, and wakes nobody: a
// sandbox that claims a project but never set up an intake still collects what its siblings saw.

// The automation id an unrouted report is filed under, when this sandbox runs no issues intake.
export const ACCOUNT_REPORTS_ID = "account";

// How long to wait for the platform's key on a sandbox that has not announced yet, before refusing as "try again".
const KEY_WAIT_MS = 3_000;
// Per sending sandbox: a runaway agent over there buys a minute of writes here, not a disk full of them.
const PER_SENDER_PER_MINUTE = 30;

export interface AccountRouteDeps {
    readonly issues?: IssuesStore;
    readonly now?: () => number;
    // The owner's intake to file under; defaults to the first enabled issues listener.
    readonly intakeOf?: () => Promise<AutomationRecord | undefined>;
}

// The issues listener reports file under: the first enabled one, in the manifest's order.
const firstIntake = async (services: Services): Promise<AutomationRecord | undefined> =>
    (await services.automations.list()).find(
        (automation) => automation.enabled && automation.trigger.kind === "listener" && automation.trigger.provider === ISSUES_PROVIDER,
    );

// A sliding minute per key plus a UTC-day total, in memory: a restart forgets them, which costs at most one more minute.
const limiter = (now: () => number) => {
    const minute = new Map<string, number[]>();
    let utcDay = "";
    let today = 0;
    return {
        limited: (key: string): boolean => {
            const at = now();
            const recent = (minute.get(key) ?? []).filter((stamp) => at - stamp < 60_000);
            if (recent.length >= PER_SENDER_PER_MINUTE) {
                minute.set(key, recent);
                return true;
            }
            recent.push(at);
            minute.set(key, recent);
            return false;
        },
        overDaily: (max: number): boolean => {
            const utcDayNow = new Date(now()).toISOString().slice(0, 10);
            if (utcDayNow !== utcDay) {
                utcDay = utcDayNow;
                today = 0;
            }
            today += 1;
            return today > max;
        },
    };
};

type AccountContext = Context<AppEnv>;
type Admitted = { readonly pass: SandboxPass; readonly body: AccountReport };

// The sender as the pass names it, plus the conversation its daemon says it reported from.
const senderOf = (pass: SandboxPass, conversationId: string | undefined): IssueSender => {
    const sender: IssueSender = { sandboxId: pass.from, sandboxName: pass.fromName, project: pass.project };
    if (conversationId !== undefined) {
        sender.conversationId = conversationId;
    }
    return sender;
};

export const createAccountRoutes = (services: Services, deps: AccountRouteDeps = {}) => {
    const issues = deps.issues ?? services.issues;
    const now = deps.now ?? Date.now;
    const intakeOf = deps.intakeOf ?? (() => firstIntake(services));
    const limits = limiter(now);
    const self = sandboxIdFromToken(services.config.connectToken);

    // The pass, then the sender's minute, then the body: a refusal costs as little as the earliest gate that can say no.
    const admit = async (c: AccountContext): Promise<Admitted | Response> => {
        const key = await services.platformIdentityKey.settled(KEY_WAIT_MS);
        if (key === undefined || self === undefined) {
            return c.json({ error: "this sandbox has not heard from the platform yet, so it cannot check a pass: try again shortly" }, 503);
        }
        const pass = verifySandboxPass(key, c.req.header(SANDBOX_PASS_HEADER) ?? "", now());
        if (pass?.to !== self) {
            return c.json({ error: "this pass is not one the platform signed for this sandbox, or it has expired: resolve the project again" }, 401);
        }
        if (limits.limited(pass.from)) {
            return c.json({ error: "rate limited: too many reports from your sandbox this minute" }, 429);
        }
        const read = await readBoundedJson(c.req.raw, ISSUE_PAYLOAD_MAX);
        if (read.kind === "tooLarge") {
            return c.json({ error: "payload too large" }, 413);
        }
        const parsed = read.kind === "ok" ? AccountReportSchema.safeParse(read.value) : undefined;
        if (parsed?.success !== true) {
            return c.json({ error: "invalid report body: {report: {kind: crash|detection, message, …}, conversationId?, times?}" }, 400);
        }
        return { pass, body: parsed.data };
    };

    const accept = async (c: AccountContext): Promise<Response> => {
        const admitted = await admit(c);
        if (admitted instanceof Response) {
            return admitted;
        }
        const { pass, body } = admitted;
        const intake = await intakeOf();
        const config = intake?.issues ?? {};
        if (limits.overDaily(config.dailyReportMax ?? ISSUES_DAILY_MAX_DEFAULT)) {
            return c.json({ error: "this sandbox has reached today's limit for reports" }, 429);
        }
        const automationId = intake?.id ?? ACCOUNT_REPORTS_ID;
        // The project is part of the key, so one message about two projects stays two issues.
        const fingerprint = fingerprintOf(`${automationId}\u0000${pass.project}`, body.report, crypto.randomUUID());
        const outcome = await issues.record({
            id: fingerprint,
            automationId,
            report: body.report,
            sender: senderOf(pass, body.conversationId),
            times: body.times ?? 1,
            now: now(),
            escalateAfter: config.escalateAfter ?? ISSUES_ESCALATE_AFTER_DEFAULT,
        });
        if (intake !== undefined && wakeWanted(intake, body.report.kind, undefined) && (outcome.fresh || outcome.escalated)) {
            void startWake(services, issues, intake, outcome.issue, outcome.fresh ? "new" : "recurring").catch((error: Error) =>
                services.logger.error({ err: error, automation: intake.id, issue: fingerprint }, "account report wake failed"),
            );
        }
        return c.json({ ok: true as const, id: fingerprint });
    };

    return { report: accept };
};

export const accountRawRoutes = defineRawRoutes((services: Services) => {
    const routes = createAccountRoutes(services);
    return { "POST /account/report": routes.report };
});
