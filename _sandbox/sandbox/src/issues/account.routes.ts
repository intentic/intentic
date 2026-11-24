import { type AccountReport, AccountReportSchema, ISSUE_PAYLOAD_MAX, type IssueSender, ISSUES_DAILY_MAX_DEFAULT, ISSUES_ESCALATE_AFTER_DEFAULT } from "@intentic/sandbox-contract/schemas/issues";
import type { SandboxPass } from "@intentic/sandbox-contract/sandbox-pass";
import type { Context } from "hono";
import { type AdmitRoute, routeAdmissionOf } from "../account-routing/admit-route.js";
import type { AppEnv } from "../app-env.js";
import type { AutomationRecord } from "../automations/automations-store.js";
import { ISSUES_PROVIDER } from "../automations/catalog.js";
import type { Services } from "../composition.js";
import { readBoundedJson } from "../http/bounded-body.js";
import { defineRawRoutes } from "../http/raw-route-server.js";
import { fingerprintOf } from "./fingerprint.js";
import { startWake, wakeWanted } from "./intake.routes.js";
import type { IssuesStore } from "./issues-store.js";

// ACCOUNT-LEVEL REPORT ROUTING, the receiving door: another sandbox on the account reporting a problem about a project
// this one claims. Admission is a report pass the platform signed for this sandbox (account-routing/admit-route.ts): the
// platform read the sender from its connect token, so who is reporting is the platform's word, never the body's. A pass
// naming a person (the one person the reporting conversation acted for, 2026-11-24) is attribution only: kept on the
// issue when this sandbox's roster knows them, dropped otherwise, and never a reason to refuse. Everything after
// admission is the intake's own pipeline: grouped by fingerprint before anything costs money, woken only when new or
// escalated, on the conversation the issue owns.
//
// No issues automation here means the report is still recorded, into the inbox under `account`, and wakes nobody: a
// sandbox that claims a project but never set up an intake still collects what its siblings saw.

// The automation id an unrouted report is filed under, when this sandbox runs no issues intake.
export const ACCOUNT_REPORTS_ID = "account";


export interface AccountRouteDeps {
    readonly issues?: IssuesStore;
    readonly now?: () => number;
    // The owner's intake to file under; defaults to the first enabled issues listener.
    readonly intakeOf?: () => Promise<AutomationRecord | undefined>;
    // The pass-admitted doors' shared admission; defaults to this daemon's.
    readonly admit?: AdmitRoute;
}

// The issues listener reports file under: the first enabled one, in the manifest's order.
const firstIntake = async (services: Services): Promise<AutomationRecord | undefined> =>
    (await services.automations.list()).find(
        (automation) => automation.enabled && automation.trigger.kind === "listener" && automation.trigger.provider === ISSUES_PROVIDER,
    );

// A UTC-day total, in memory: a restart forgets it. Each sender's minute is the admission's (admit-route.ts).
const limiter = (now: () => number) => {
    let utcDay = "";
    let today = 0;
    return {
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
type ReportPass = SandboxPass & { readonly project: string };
type Admitted = { readonly pass: ReportPass; readonly person: string | undefined; readonly body: AccountReport };

// The sender as the pass names it, plus the conversation its daemon says it reported from and the person it acted for.
const senderOf = (pass: ReportPass, person: string | undefined, conversationId: string | undefined): IssueSender => {
    const sender: IssueSender = { sandboxId: pass.from, sandboxName: pass.fromName, project: pass.project };
    if (conversationId !== undefined) {
        sender.conversationId = conversationId;
    }
    if (person !== undefined) {
        sender.person = person;
    }
    if (pass.crossesOrg !== undefined) {
        sender.crossesOrg = pass.crossesOrg;
    }
    return sender;
};

export const createAccountRoutes = (services: Services, deps: AccountRouteDeps = {}) => {
    const issues = deps.issues ?? services.issues;
    const now = deps.now ?? Date.now;
    const intakeOf = deps.intakeOf ?? (() => firstIntake(services));
    const limits = limiter(now);
    const admitRoute = deps.admit ?? routeAdmissionOf(services);

    // The pass and the sender's minute, then the body: a refusal costs as little as the earliest gate that can say no.
    const admit = async (c: AccountContext): Promise<Admitted | Response> => {
        const admitted = await admitRoute(c, "report");
        if (admitted instanceof Response) {
            return admitted;
        }
        const { pass } = admitted;
        // A report pass always names its project (sandbox-pass.ts); one that does not is no report.
        if (pass.project === undefined) {
            return c.json({ error: "this pass names no project: resolve the project again", code: "pass" }, 401);
        }
        const read = await readBoundedJson(c.req.raw, ISSUE_PAYLOAD_MAX);
        if (read.kind === "tooLarge") {
            return c.json({ error: "payload too large" }, 413);
        }
        const parsed = read.kind === "ok" ? AccountReportSchema.safeParse(read.value) : undefined;
        if (parsed?.success !== true) {
            return c.json({ error: "invalid report body: {report: {kind: crash|detection, message, …}, conversationId?, times?}" }, 400);
        }
        return { pass: { ...pass, project: pass.project }, person: admitted.person?.email.toLowerCase(), body: parsed.data };
    };

    const accept = async (c: AccountContext): Promise<Response> => {
        const admitted = await admit(c);
        if (admitted instanceof Response) {
            return admitted;
        }
        const { pass, person, body } = admitted;
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
            sender: senderOf(pass, person, body.conversationId),
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
