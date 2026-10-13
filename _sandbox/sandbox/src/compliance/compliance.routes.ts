import { complianceContract, type ComplianceDocumentKind, type ComplianceLanguage } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import type { OrpcContext } from "../app-env.js";
import { noteAudit } from "../audit/audit-http.js";
import { actorOf } from "../auth/principal.js";
import type { Services } from "../composition.js";
import { versionedSettingsWrite } from "../seams/settings-versions.js";
import { settingsDocument } from "../settings/settings-store.js";
import { documentFilename, renderDocument } from "./drafts.js";
import { markdownToDocx } from "./docx.js";
import { type FactsServices, gatherFacts } from "./facts.js";
import { applyPreset, presetPreview } from "./preset.js";
import { reportOf } from "./report.js";

// The data protection page's routes (sandbox-contract compliance.contract.ts): the live report, the documents filled in
// from it, and the public-office preset. Reads gather the facts fresh on every call: the page is opened rarely, and a
// stale answer is the one thing a data protection officer cannot use.

export type ComplianceEvent =
    | { readonly kind: "preset.applied"; readonly items: readonly string[] }
    | { readonly kind: "document.downloaded"; readonly document: ComplianceDocumentKind; readonly language: ComplianceLanguage; readonly format: "md" | "docx" };

// The audit trail records both routes by name (audit/audit-http.ts); this adds what only the handler knows, which
// preset items were applied or which document went out, and keeps the line in the daemon's log too.
export const recordComplianceEvent = (services: Pick<Services, "logger">, context: OrpcContext, event: ComplianceEvent): void => {
    noteAudit(
        event.kind === "preset.applied"
            ? { details: { items: [...event.items] } }
            : { target: event.document, details: { language: event.language, format: event.format } },
    );
    services.logger.info({ compliance: event, actor: actorOf(context.identity, context.principal) }, `compliance: ${event.kind}`);
};

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export const createComplianceRoutes = (
    services: FactsServices & Pick<Services, "logger" | "composeEnvironment" | "agentWorktrees" | "git">,
) => {
    const i = implement(complianceContract).$context<OrpcContext>();
    return {
        report: i.report.handler(async () => reportOf(await gatherFacts(services))),
        document: i.document.handler(async ({ input, context }) => {
            const facts = await gatherFacts(services);
            const markdown = renderDocument(facts, reportOf(facts), input.kind, input.language);
            const name = documentFilename(input.kind, input.language);
            recordComplianceEvent(services, context, { kind: "document.downloaded", document: input.kind, language: input.language, format: input.format });
            if (input.format === "docx") {
                return { filename: `${name}.docx`, mediaType: DOCX_TYPE, encoding: "base64" as const, content: markdownToDocx(markdown).toString("base64") };
            }
            return { filename: `${name}.md`, mediaType: "text/markdown; charset=utf-8", encoding: "utf8" as const, content: markdown };
        }),
        preset: i.preset.handler(async () => {
            const facts = await gatherFacts(services);
            return { items: presetPreview({ settings: facts.settings, privacy: facts.privacy, nameModel: facts.readers.model }) };
        }),
        applyPreset: i.applyPreset.handler(async ({ input, context }) => {
            const [settings, status] = await Promise.all([services.sandboxSettings.get(), services.privacyShield.status()]);
            // The route floors at the owner, so whoever reaches here may change the shield.
            const outcome = applyPreset({ settings, privacy: status.policy, nameModel: status.readers.model }, input.items, true);
            if (outcome.settingsChanged) {
                await versionedSettingsWrite(services, [settingsDocument.path], "Settings: public-office preset", () => services.sandboxSettings.set(outcome.settings));
            }
            if (outcome.privacyChanged) {
                await services.privacyShield.setPolicy(outcome.privacy);
                // As the privacy route does: the policy decides whether the readers' pack rides the environment.
                try {
                    await services.composeEnvironment();
                } catch (error) {
                    services.logger.warn({ err: error }, "preset saved the privacy policy, but recomposing the environment failed");
                }
            }
            if (outcome.applied.length > 0) {
                recordComplianceEvent(services, context, { kind: "preset.applied", items: outcome.applied });
            }
            return { applied: outcome.applied, skipped: outcome.skipped };
        }),
    };
};
