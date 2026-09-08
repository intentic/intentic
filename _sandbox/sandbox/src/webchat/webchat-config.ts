import type { WebchatConfig, WebchatPublicConfig } from "@intentic/sandbox-contract";
import type { AutomationRecord } from "../automations/automations-store.js";

// Decides what an unset Front Desk setting means, and which settings a stranger's browser may see.
// `publicConfig` names every field it emits, so a secret added to WebchatConfig stays invisible until listed here.
// Defaults resolve daemon-side, so the widget carries no fallback logic of its own.

// Defaults for a Front Desk with nothing configured.
const DEFAULT_TITLE = "Chat";
const DEFAULT_GREETING = "Hi! Ask me anything.";
// Intentic's brand orange (`--color-brand-600` from oklch); a customer who wants their own sets `accent`.
const DEFAULT_ACCENT = "#e47100";
// Top-right collides with fewer cookie banners and support widgets than bottom-right.
const DEFAULT_POSITION = "top-right" as const;

export const publicConfig = (automation: AutomationRecord): WebchatPublicConfig => {
    const config: WebchatConfig = automation.webchat ?? {};
    return {
        automationId: automation.id,
        title: config.title ?? DEFAULT_TITLE,
        greeting: config.greeting ?? DEFAULT_GREETING,
        accent: config.accent ?? DEFAULT_ACCENT,
        position: config.position ?? DEFAULT_POSITION,
        access: config.access ?? "public",
        requireName: config.requireName ?? false,
        // A configured mechanism with a missing key degrades to off, not a gate the visitor can never pass.
        antiBot: usableAntiBot(config),
        ...(config.turnstileSiteKey !== undefined ? { turnstileSiteKey: config.turnstileSiteKey } : {}),
        ...(config.googleClientId !== undefined ? { googleClientId: config.googleClientId } : {}),
    };
};

// Which check the daemon actually enforces; read by both the config route and the message route, so the two can never
// disagree.
export const usableAntiBot = (config: WebchatConfig): WebchatPublicConfig["antiBot"] => {
    if (config.antiBot === "turnstile") {
        return config.turnstileSiteKey !== undefined && config.turnstileSecret !== undefined ? "turnstile" : "off";
    }
    return config.antiBot ?? "off";
};
