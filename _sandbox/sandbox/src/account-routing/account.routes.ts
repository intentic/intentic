import { randomUUID } from "node:crypto";
import { extensionIdOf } from "@intentic/extension-manifest";
import {
    type AccountReport,
    type AccountReportFiled,
    AccountReportSchema,
    ISSUE_PAYLOAD_MAX,
    type IssueSender,
    ISSUES_DAILY_MAX_DEFAULT,
} from "@intentic/sandbox-contract/schemas/issues";
import type { SandboxPass } from "@intentic/sandbox-contract/sandbox-pass";
import type { Context } from "hono";
import type { AppEnv } from "../app-env.js";
import { cachedEnabledExtensions } from "../capabilities/contributions.js";
import type { Services } from "../composition.js";
import { type FireDeps, tryFire } from "../extensions/backend/extension-fires.js";
import { listenerOwnership } from "../extensions/listener/listener-state.js";
import { readBoundedJson } from "../http/bounded-body.js";
import { defineRawRoutes } from "../http/raw-route-server.js";
import { type AdmitRoute, routeAdmissionOf } from "./admit-route.js";

// ACCOUNT-LEVEL REPORT ROUTING, the receiving door: another sandbox on the account reporting a problem about a project
// this one claims. Admission is a report pass the platform signed for this sandbox (admit-route.ts): the platform read
// the sender from its connect token, so who is reporting is the platform's word, never the body's. A pass naming a person
// (the one person the reporting conversation acted for, 2026-11-24) is attribution only: kept on the report when this
// sandbox's roster knows them, dropped otherwise, and never a reason to refuse.
//
// (2026-11-26) What happens to an admitted report is the issues inbox's, which left the daemon for the extension that
// owns the `issues` listener (intentic.issues): grouping, escalation and the wake are its policy. The door hands the
// report over through that extension's `account-report` fire handler (the backend host's fires door, which no person's,
// panel's or agent's token reaches), with the sender as the pass named it. Nothing is kept here: a report the inbox
// cannot take now (the extension off or not installed, its backend restarting) is answered 503, and the sending
// sandbox's outbox keeps it and tries again for a week (account-outbox.ts), so installing the extension later still
// delivers what waited.

// The listener provider whose owner keeps the inbox an account report is filed into, and the handler it serves.
export const REPORT_INBOX_PROVIDER = "issues";
export const ACCOUNT_REPORT_HANDLER = "account-report";
// What the hand-off names as its automation: none fired it, and the inbox files it under its own intake.
export const ACCOUNT_REPORTS_ID = "account";

export interface AccountRouteDeps {
    readonly now?: () => number;
    // The pass-admitted doors' shared admission; defaults to this daemon's.
    readonly admit?: AdmitRoute;
    // Hands an admitted report to the inbox; defaults to the owning extension's fire handler.
    readonly file?: (filed: AccountReportFiled) => Promise<Filing>;
}

// What handing a report to the inbox came to: taken, or why not and whether trying again could change that.
export type Filing = { readonly kind: "taken"; readonly id: string } | { readonly kind: "later"; readonly why: string };

// A UTC-day total, in memory: a restart forgets it. Each sender's minute is the admission's (admit-route.ts). The door's
// own ceiling, whatever the inbox does with what it takes.
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

/** Hands an admitted report to the backend of the extension that owns the issues inbox, through its fire handler. */
export const fileWithInbox = async (deps: FireDeps, filed: AccountReportFiled, now: number): Promise<Filing> => {
    const owner = (await listenerOwnership(deps)).owners.get(REPORT_INBOX_PROVIDER);
    const extension = owner === undefined ? undefined : (await cachedEnabledExtensions(deps)).find((each) => each.id === owner);
    if (extension === undefined) {
        return { kind: "later", why: "this sandbox has no issues inbox switched on (the Issues extension)" };
    }
    const id = randomUUID();
    const tried = await tryFire(deps, {
        id,
        extension: extensionIdOf(extension.manifest),
        handler: ACCOUNT_REPORT_HANDLER,
        automationId: ACCOUNT_REPORTS_ID,
        firedAt: now,
        coalesced: 0,
        payload: JSON.stringify(filed),
        prompt: "",
        owedAt: now,
        nextAt: now,
        attempts: 0,
    });
    switch (tried.kind) {
        case "taken":
            return { kind: "taken", id };
        case "threw":
            return { kind: "later", why: `its issues inbox failed to file it: ${tried.error}` };
        case "later":
        case "never":
            return { kind: "later", why: `its issues inbox cannot take it now: ${tried.why}` };
    }
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
    const now = deps.now ?? Date.now;
    const limits = limiter(now);
    const admitRoute = deps.admit ?? routeAdmissionOf(services);
    const file = deps.file ?? ((filed: AccountReportFiled) => fileWithInbox(services, filed, now()));

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
        if (limits.overDaily(ISSUES_DAILY_MAX_DEFAULT)) {
            return c.json({ error: "this sandbox has reached today's limit for reports" }, 429);
        }
        const { pass, person, body } = admitted;
        const filing = await file({ report: body.report, times: body.times ?? 1, sender: senderOf(pass, person, body.conversationId) });
        if (filing.kind === "later") {
            services.logger.warn({ from: pass.from, project: pass.project, why: filing.why }, "account report not filed: the sender keeps it");
            return c.json({ error: filing.why }, 503);
        }
        return c.json({ ok: true as const, id: filing.id });
    };

    return { report: accept };
};

export const accountRawRoutes = defineRawRoutes((services: Services) => {
    const routes = createAccountRoutes(services);
    return { "POST /account/report": routes.report };
});
