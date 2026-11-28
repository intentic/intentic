import { randomUUID } from "node:crypto";
import { extensionIdOf } from "@intentic/extension-manifest";
import { type AccountReportFiled, ISSUES_DAILY_MAX_DEFAULT } from "@intentic/sandbox-contract/schemas/issues";
import { cachedEnabledExtensions } from "../../capabilities/contributions.js";
import type { Services } from "../../composition.js";
import { type FireDeps, tryFire } from "../../extensions/backend/extension-fires.js";
import { listenerOwnership } from "../../extensions/listener/listener-state.js";

// WHERE AN ADMITTED REPORT GOES, whichever way it came (docs/architecture/account-routing.md, "The door";
// docs/architecture/messages.md, "Reports"): the pass-admitted door `POST /account/report` and a `report` message from a
// contact both hand it to the extension that owns the `issues` listener (intentic.issues), through its `account-report`
// fire handler, under one UTC-day ceiling. Nothing is kept here: a report the inbox cannot take now (the extension off or
// not installed, its backend restarting) is answered "later", and the sender keeps it and tries again.

// The listener provider whose owner keeps the inbox an account report is filed into, and the handler it serves.
const REPORT_INBOX_PROVIDER = "issues";
const ACCOUNT_REPORT_HANDLER = "account-report";
// What the hand-off names as its automation: none fired it, and the inbox files it under its own intake.
const ACCOUNT_REPORTS_ID = "account";

// What handing a report to the inbox came to: taken, or why not and whether trying again could change that.
export type Filing = { readonly kind: "taken"; readonly id: string } | { readonly kind: "later"; readonly why: string };

// What the intake made of one report: a filing, or past today's ceiling.
export type Intake = Filing | { readonly kind: "over-daily" };

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

// A UTC-day total, in memory: a restart forgets it. Each sender's minute is its door's (admit-route.ts, s2s/admission.ts).
// The intake's own ceiling, whatever the inbox does with what it takes; a report past it counts too.
const dailyLimiter = (now: () => number, max: number) => {
    let utcDay = "";
    let today = 0;
    return (): boolean => {
        const utcDayNow = new Date(now()).toISOString().slice(0, 10);
        if (utcDayNow !== utcDay) {
            utcDay = utcDayNow;
            today = 0;
        }
        today += 1;
        return today > max;
    };
};

export type ReportIntake = (filed: AccountReportFiled) => Promise<Intake>;

/** The day's ceiling in front of a filing. */
export const createReportIntake = (deps: { readonly file: (filed: AccountReportFiled) => Promise<Filing>; readonly now: () => number }): ReportIntake => {
    const overDaily = dailyLimiter(deps.now, ISSUES_DAILY_MAX_DEFAULT);
    return async (filed) => (overDaily() ? { kind: "over-daily" } : deps.file(filed));
};

// One intake per daemon, so the door and the `report` kind spend one day's ceiling.
// allow(module-state): one intake per daemon's services, shared by both ways a report arrives.
const intakes = new WeakMap<Services, ReportIntake>();

/** This daemon's intake: the issues extension's fire handler, under the day's ceiling. */
export const reportIntakeOf = (services: Services): ReportIntake => {
    const known = intakes.get(services);
    if (known !== undefined) {
        return known;
    }
    const intake = createReportIntake({ file: (filed) => fileWithInbox(services, filed, Date.now()), now: Date.now });
    intakes.set(services, intake);
    return intake;
};

export const OVER_DAILY = "this sandbox has reached today's limit for reports";
