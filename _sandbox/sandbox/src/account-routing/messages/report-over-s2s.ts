import { keyedLock } from "@intentic/base/async";
import { parseJsonOr } from "@intentic/base/json";
import { rawRouteUrl } from "@intentic/sandbox-contract/protocol/raw/raw-routes";
import { normalizeAddress, type ResolvedAddress, verifyIdentity } from "@intentic/sandbox-contract/s2s";
import { SANDBOX_PASS_HEADER } from "@intentic/sandbox-contract/sandbox-pass";
import type { AccountProblem } from "@intentic/sandbox-contract/schemas/issues";
import { type S2sContactBootstrapAnswer, S2sContactBootstrapAnswerSchema, S2sGrantsSchema, type SandboxIdentity } from "@intentic/sandbox-contract/schemas/s2s";
import type { Logger } from "pino";
import { opt } from "../../opt.js";
import { type ContactRow, vouchedSandboxOf } from "../../s2s/contacts/contacts-store.js";
import { firstSettle, watchSettles } from "../../s2s/messages/first-settle.js";
import type { S2sFetch } from "../../s2s/messages/outbox.js";
import type { S2s } from "../../s2s/s2s-service.js";
import type { ReportEntry } from "../account-outbox.js";
import { fingerprintOf } from "../report-fingerprint.js";
import type { Delivery, RouteTarget } from "../route-client.js";

// A REPORT SENT AS A MESSAGE (docs/architecture/messages.md, "Reports" and "Across versions"): once the platform said
// which sandbox claims the project (the account outbox's route, as before), a target that serves its identity (speaks
// s2s/1) is sent the report as a `report` message over a sandbox-scoped contact holding this sandbox's `report` grant
// there. With no such contact yet, the first report introduces this sandbox (`POST /account/contact-bootstrap` under the
// report pass) and files the contact from the answer. The message goes into the one outbox, and the account outbox lets
// its entry go. A target from before, or one that will not take the introduction, gets the report at its account door,
// as before: `undefined` here says so.
//
// Folding: a repeated report folds into a count while it waits in the account outbox. Once one is a message waiting in
// the messages outbox (the target asleep, its issues inbox off), a repeat of the same problem stays in the account
// outbox, counting, until that one lands, and then goes as one message carrying the count.

// How long a send waits for the message's first attempt, as long as the account door's own try.
const FIRST_TRY_MS = 15_000;
const INTRODUCE_MS = 15_000;

export interface ReportOverS2sDeps {
    readonly s2s: Pick<S2s, "contacts" | "outbox" | "core">;
    // The introduction's one request to the target.
    readonly fetch: S2sFetch;
    readonly logger: Pick<Logger, "info" | "warn">;
    readonly firstTryMs?: number;
}

// The account outbox's report entry, as far as sending it as a message reads it.
type ReportSend = Pick<ReportEntry, "project" | "report" | "times" | "conversationId">;

export type ReportOverS2s = (target: RouteTarget, entry: ReportSend) => Promise<Delivery | undefined>;

/** What makes two reports one problem: the account outbox's own entry id for it. */
const reportFoldKey = (project: string, report: AccountProblem): string => fingerprintOf(`outbox\u0000${project}`, report, "");

// Whether a contact is the target the platform named: the sandbox id someone other than the contact vouched for, or the
// address its key was confirmed at being where the platform says the target is. Never the contact's own word (its
// document's `sandbox`, its name, the grants it says it gives), which any contact may write.
const isTarget = (row: ContactRow, target: RouteTarget, host: string | undefined, zone: string | undefined): boolean =>
    row.scope.kind === "sandbox" && (vouchedSandboxOf(row, zone) === target.sandboxId || (host !== undefined && row.address === host));

type Answered = { readonly ok: true; readonly answer: S2sContactBootstrapAnswer } | { readonly ok: false; readonly why: string };

// POST /account/contact-bootstrap under the report pass, with this sandbox's document.
const askIntroduction = async (deps: ReportOverS2sDeps, target: RouteTarget, document: SandboxIdentity): Promise<Answered> => {
    try {
        const response = await deps.fetch(new URL(rawRouteUrl("POST /account/contact-bootstrap"), target.address).toString(), {
            method: "POST",
            headers: { "content-type": "application/json", [SANDBOX_PASS_HEADER]: target.pass },
            body: JSON.stringify({ document }),
            redirect: "error",
            signal: AbortSignal.timeout(INTRODUCE_MS),
        });
        const body = parseJsonOr(await response.text(), undefined);
        const answer = S2sContactBootstrapAnswerSchema.safeParse(body);
        return response.ok && answer.success ? { ok: true, answer: answer.data } : { ok: false, why: `it answered ${response.status}` };
    } catch {
        // allow(silent-catch): no answer at all is a reason to use the account door this time, said as such.
        return { ok: false, why: "it did not answer" };
    }
};

// The contact the introduction's answer makes, or extends with what it said it grants; a contact here in any other state
// than accepted is left as it is, and the report goes the old way.
const fileIntroduced = async (deps: ReportOverS2sDeps, resolved: Extract<ResolvedAddress, { ok: true }>, answer: S2sContactBootstrapAnswer): Promise<ContactRow | undefined> => {
    const { core } = deps.s2s;
    const held = (await core.deps.store.list()).find(
        (row) => row.scope.kind === "sandbox" && (row.address === resolved.address || row.document.fingerprint === resolved.document.fingerprint),
    );
    // The platform named the target and where it is, and the document served there names it (introduce, below).
    const vouchedSandbox = resolved.document.sandbox;
    if (held === undefined) {
        return core.deps.store.put(
            core.newRow({
                address: resolved.address,
                document: resolved.document,
                scope: { kind: "sandbox" },
                state: "accepted",
                // This side lets it do nothing here: the introduction is for reports going there.
                grants: S2sGrantsSchema.parse({ message: false }),
                theirGrants: answer.grants,
                origin: "report-bootstrap",
                vouchedSandbox,
            }),
        );
    }
    const vouched = held.document.fingerprint === resolved.document.fingerprint ? vouchedSandbox : held.vouchedSandbox;
    return held.state === "accepted" ? core.deps.store.change(held.id, (row) => core.touch(row, { theirGrants: answer.grants, ...opt("vouchedSandbox", vouched) })) : undefined;
};

// The first report to a target with no contact for it: confirmed at its own address, introduced, and filed.
const introduce = async (deps: ReportOverS2sDeps, target: RouteTarget, host: string): Promise<ContactRow | undefined> => {
    const { core } = deps.s2s;
    const resolved = await core.deps.resolve(host);
    // A target from before (no /s2s/identity), or one that does not answer: the account door, as always.
    if (!resolved.ok || resolved.document.sandbox !== target.sandboxId) {
        return undefined;
    }
    const asked = await askIntroduction(deps, target, await core.deps.identity().document());
    if (!asked.ok) {
        deps.logger.info({ to: target.name, why: asked.why }, "report: the introduction was not taken, so it goes to the account door");
        return undefined;
    }
    const { answer } = asked;
    if (answer.document.fingerprint !== resolved.document.fingerprint || !verifyIdentity(answer.document).ok || !answer.grants.report) {
        deps.logger.warn({ to: target.name }, "report: the introduction answered with another key or without the report grant");
        return undefined;
    }
    return fileIntroduced(deps, resolved, answer);
};

// What the message's first attempt came to, as the account outbox reads a try.
const handedOn = async (deps: ReportOverS2sDeps, row: ContactRow, entry: ReportSend): Promise<Delivery | undefined> => {
    const { outbox } = deps.s2s;
    watchSettles(outbox);
    const queued = await outbox.enqueue({
        contact: row,
        payload: { kind: "report", project: entry.project, report: entry.report, times: entry.times, ...opt("conversationId", entry.conversationId) },
    });
    if ("refused" in queued) {
        return { status: 503, error: queued.refused };
    }
    const settled = await firstSettle(outbox, queued.id, deps.firstTryMs ?? FIRST_TRY_MS);
    if (settled?.state === "sent") {
        return { status: 200, id: queued.id };
    }
    // Refused in words (its grant taken back, its key changed): the account door may still take it.
    if (settled?.state === "undelivered") {
        return undefined;
    }
    const why = settled === undefined ? "it has not answered yet" : settled.reason;
    return { status: 200, id: queued.id, handedOn: `sent as a message, which is retried by itself for a week (\`messages outbox\`): ${why}` };
};

export const reportOverS2s = (deps: ReportOverS2sDeps): ReportOverS2s => {
    const serialize = keyedLock<string>();
    return async (target, entry) => {
        const host = normalizeAddress(target.address);
        // One introduction at a time per target, so two reports racing make one contact.
        const row = await serialize(target.sandboxId, async () => {
            const zone = deps.s2s.core.deps.zone;
            const known = (await deps.s2s.contacts.list()).find((each) => each.state === "accepted" && each.theirGrants?.report === true && isTarget(each, target, host, zone));
            return known ?? (host === undefined ? undefined : introduce(deps, target, host));
        });
        if (row === undefined) {
            return undefined;
        }
        const key = reportFoldKey(entry.project, entry.report);
        const earlier = (await deps.s2s.outbox.list()).some(
            (held) => held.state === "waiting" && held.contact === row.id && held.payload.kind === "report" && reportFoldKey(held.payload.project, held.payload.report) === key,
        );
        if (earlier) {
            return { status: 503, error: "an earlier report of this problem still waits in the messages outbox: this one counts beside it until that lands" };
        }
        return handedOn(deps, row, entry);
    };
};
