import type { AutomationSummary } from "@intentic/sandbox-contract/schemas/automations";
import { embedSnippet } from "../useAutomations";
import { t } from "../i18n.js";

export interface VisitorChatSummary {
    readonly origins: readonly string[];
    readonly access: string;
    readonly botCheck: string;
}

// The Visitor chat settings that decide whether the widget works at all: where it may be embedded, who may talk to it,
// and what stops a bot. Undefined for any other automation, and until the sandbox's own origin is known, so Install
// never opens on nothing. Mirrors the daemon's resolution (webchat-config.ts): missing keys report as off, matching
// what is enforced.
export const visitorChatOf = (automation: AutomationSummary): VisitorChatSummary | undefined => {
    const fires = automation.trigger;
    if (fires.kind !== `listener` || fires.provider !== `webchat` || embedSnippet(automation) === undefined) {
        return undefined;
    }
    const config = automation.webchat ?? {};
    const turnstileReady = config.turnstileSiteKey !== undefined && config.turnstileSecret !== undefined;
    return {
        origins: fires.allowedOrigins ?? [],
        access: config.access === `google` ? t(`automationRow.googleSignInRequired`) : t(`automationRow.openToAnyone`),
        botCheck:
            config.antiBot === `turnstile` && turnstileReady
                ? `Turnstile`
                : config.antiBot === `turnstile`
                  ? t(`automationRow.turnstileUnfinished`)
                  : config.antiBot === `pow`
                    ? t(`automationRow.builtInBotCheck`)
                    : t(`automationRow.noBotCheck`),
    };
};
