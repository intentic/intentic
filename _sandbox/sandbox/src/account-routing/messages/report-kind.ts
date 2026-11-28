import type { IssueSender } from "@intentic/sandbox-contract/schemas/issues";
import type { S2sPayloadOf } from "@intentic/sandbox-contract/schemas/s2s";
import type { Logger } from "pino";
import { opt } from "../../opt.js";
import type { ContactRow } from "../../s2s/contacts/contacts-store.js";
import type { S2sKindOutcome, S2sReceived } from "../../s2s/messages/kinds.js";
import type { S2s } from "../../s2s/s2s-service.js";
import { titleOf } from "../report-fingerprint.js";
import { OVER_DAILY, type ReportIntake } from "./report-intake.js";

// A REPORT AS A MESSAGE, received (docs/architecture/messages.md, "Reports"): a contact holding the `report` grant
// (admission checked it, and for a person-scoped contact that person on the roster at the report floor) reports a problem
// about a project. It goes where `POST /account/report` sends one (report-intake.ts): the issues extension's
// `account-report` fire, under the same day's ceiling, with the contact as the sender. Nothing is kept here: while no
// extension keeps the inbox the kind answers 503 `unready`, and the sender's outbox keeps the report and tries again.
// Once taken it is heard by automations (the `s2s` source's `report` event).

// The sender as the contact says it: its sandbox and name, its address, and the person a person-scoped contact routes as.
// Whether the two sandboxes are in one organisation is the platform's word, which a contact does not carry.
const senderOf = (row: ContactRow, payload: S2sPayloadOf<"report">): IssueSender => ({
    sandboxId: row.document.sandbox.slice(0, 40),
    sandboxName: (row.name ?? row.document.name).slice(0, 120),
    address: row.address,
    project: payload.project,
    ...opt("conversationId", payload.conversationId),
    ...opt("person", row.scope.kind === "person" ? row.scope.person : undefined),
});

export interface ReportKindDeps {
    readonly intake: ReportIntake;
    readonly logger: Pick<Logger, "warn">;
}

const received = async (s2s: Pick<S2s, "hear">, deps: ReportKindDeps, row: ContactRow, report: S2sReceived<"report">): Promise<S2sKindOutcome> => {
    const { header, payload } = report;
    const filing = await deps.intake({ report: payload.report, times: payload.times ?? 1, sender: senderOf(row, payload) });
    if (filing.kind === "over-daily") {
        return { refused: "rate", error: OVER_DAILY };
    }
    if (filing.kind === "later") {
        deps.logger.warn({ contact: row.id, project: payload.project, why: filing.why }, "s2s report not filed: the sender keeps it");
        return { refused: "unready", error: filing.why };
    }
    const event = { event: "report", contact: row, envelope: header.id, project: payload.project, title: titleOf(payload.report), at: report.receivedAt } as const;
    return { stored: true, after: async () => s2s.hear(event) };
};

/** Registers the `report` kind with the inbox; answers its removal. */
export const registerReportKind = (s2s: Pick<S2s, "kinds" | "hear">, deps: ReportKindDeps): (() => void) =>
    s2s.kinds.register("report", async (report) =>
        report.contact === undefined ? { refused: "not_contact", error: "only a contact sends reports" } : received(s2s, deps, report.contact, report),
    );
