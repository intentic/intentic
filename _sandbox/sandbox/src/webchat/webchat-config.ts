import type { WebchatConfig, WebchatPublicConfig } from "@intentic/sandbox-contract";
import type { AutomationRecord } from "../automations/automations-store.js";

/* The one place that decides what an unset Front Desk setting MEANS, and the one place that decides which
 * settings a stranger's browser may see.
 *
 * Both halves are here on purpose. `publicConfig` names every field it emits — so a secret added to
 * WebchatConfig is invisible to the widget until someone deliberately lists it here, rather than leaking the
 * moment a future author forgets to strip it. And resolving the defaults daemon-side means the widget carries
 * no fallback logic: "what does an unset accent look like" has exactly one answer, on this side of the wire. */

// A Front Desk with nothing configured still has to look like something. These are that something.
const DEFAULT_TITLE = "Chat";
const DEFAULT_GREETING = "Hi! Ask me anything.";
/* Intentic's brand orange (the app's `--color-brand-600`, converted from oklch for a browser that may not speak
 * it). A Front Desk with nothing configured should look like the product it came from rather than like the
 * interchangeable indigo every chat widget ships with — and a customer who wants their own brand sets `accent`. */
const DEFAULT_ACCENT = "#e47100";
// Top-right, because a launcher there collides with fewer cookie banners and support widgets than bottom-right.
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
        // A configured mechanism whose key is missing degrades to "off" rather than to a gate the visitor can
        // never pass: a half-configured bot check must not be an outage. The Automations UI is where the
        // missing key gets pointed out.
        antiBot: usableAntiBot(config),
        ...(config.turnstileSiteKey !== undefined ? { turnstileSiteKey: config.turnstileSiteKey } : {}),
        ...(config.googleClientId !== undefined ? { googleClientId: config.googleClientId } : {}),
    };
};

// Which check the daemon will actually ENFORCE — read by both the config route (so the widget solves the same
// one) and the message route (so the two can never disagree about whether a gate exists).
export const usableAntiBot = (config: WebchatConfig): WebchatPublicConfig["antiBot"] => {
    if (config.antiBot === "turnstile") {
        return config.turnstileSiteKey !== undefined && config.turnstileSecret !== undefined ? "turnstile" : "off";
    }
    return config.antiBot ?? "off";
};
