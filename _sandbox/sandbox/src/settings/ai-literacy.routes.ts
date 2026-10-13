import { createHash } from "node:crypto";
import { join } from "node:path";
import { AI_LITERACY_TEXT, settingsContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../app-env.js";
import { noteAudit } from "../audit/audit-http.js";
import type { Services } from "../composition.js";
import { fileMemberAiLiteracy, memberAiLiteracyDocument } from "./member-ai-literacy.js";

const memberOf = (context: OrpcContext): string => context.identity?.email.toLowerCase() ?? "";

// Only what the notice reads: its settings, and the history root its confirmations are kept under.
export const createAiLiteracyRoutes = (services: Pick<Services, "config" | "sandboxSettings">) => {
    const i = implement(settingsContract).$context<OrpcContext>();
    let store: ReturnType<typeof fileMemberAiLiteracy> | undefined;
    const confirmations = () => (store ??= fileMemberAiLiteracy(join(services.config.historyRoot, memberAiLiteracyDocument.path)));
    const status = async (member: string, locale: keyof typeof AI_LITERACY_TEXT) => {
        const notice = (await services.sandboxSettings.get()).aiNotice;
        const text = notice.text.trim() || AI_LITERACY_TEXT[locale];
        const version = createHash("sha256").update(text).digest("hex");
        const confirmedAt = notice.show ? await confirmations().confirmedAt(member, version) : undefined;
        return { show: notice.show, text, version, confirmedAt };
    };
    return {
        aiLiteracy: i.aiLiteracy.handler(({ input, context }) => status(memberOf(context), input.locale)),
        confirmAiLiteracy: i.confirmAiLiteracy.handler(async ({ input, context }) => {
            const current = await status(memberOf(context), input.locale);
            if (!current.show || current.version !== input.version) {
                throw new ORPCError("CONFLICT", { message: "The AI notice has changed. Read it again before confirming." });
            }
            const confirmedAt = await confirmations().confirm(memberOf(context), input.version);
            // Recorded on the audit trail by route name (audit/audit-http.ts); the version says which wording was read.
            noteAudit({ details: { version: input.version, locale: input.locale } });
            return { ...current, confirmedAt };
        }),
        aiLiteracyConfirmations: i.aiLiteracyConfirmations.handler(async () => ({ records: await confirmations().list() })),
    };
};
