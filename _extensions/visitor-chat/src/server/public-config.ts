import type { WebchatConfig, WebchatPublicConfig } from "@intentic/sandbox-contract/schemas/automations";
import type { Chat } from "./chats.js";

// What an unset Visitor chat setting means, and which settings a stranger's browser may see (the daemon's
// webchat-config.ts until 2026-11-26). `publicConfigOf` names every field it emits, so a secret added to WebchatConfig
// stays invisible until listed here. Defaults resolve here, so the widget carries no fallback logic of its own.

const DEFAULT_TITLE = `Chat`;
const DEFAULT_GREETING = `Hi! Ask me anything.`;
// Top-right collides with fewer cookie banners and support widgets than bottom-right.
const DEFAULT_POSITION = `top-right` as const;
// Intentic's brand orange, the embeds' own default (the contract's `embed` DEFAULT_ACCENT, which an extension may not
// import); a customer who wants their own sets `accent`.
export const DEFAULT_ACCENT = `#e47100`;

// Which check is actually enforced, read by both the settings route and the message route so the two never disagree:
// a configured Turnstile with a missing key degrades to off, not a gate the visitor can never pass.
export const usableAntiBot = (config: WebchatConfig): WebchatPublicConfig[`antiBot`] => {
    if (config.antiBot === `turnstile`) {
        return config.turnstileSiteKey !== undefined && config.turnstileSecret !== undefined ? `turnstile` : `off`;
    }
    return config.antiBot ?? `off`;
};

export const publicConfigOf = (chat: Chat): WebchatPublicConfig => {
    const { config } = chat;
    const result: WebchatPublicConfig = {
        automationId: chat.id,
        title: config.title ?? DEFAULT_TITLE,
        greeting: config.greeting ?? DEFAULT_GREETING,
        accent: config.accent ?? DEFAULT_ACCENT,
        position: config.position ?? DEFAULT_POSITION,
        access: config.access ?? `public`,
        requireName: config.requireName ?? false,
        aiDisclosure: config.aiDisclosure ?? true,
        antiBot: usableAntiBot(config),
    };
    if (config.turnstileSiteKey !== undefined) {
        result.turnstileSiteKey = config.turnstileSiteKey;
    }
    if (config.googleClientId !== undefined) {
        result.googleClientId = config.googleClientId;
    }
    if (config.aiDisclosureText) {
        result.aiDisclosureText = config.aiDisclosureText;
    }
    return result;
};
