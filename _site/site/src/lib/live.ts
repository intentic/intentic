import { PLATFORM_WEB_ORIGIN } from "@intentic/constants";

// Live content that must change without a deploy (an incident notice, download/workspace kill switches), sourced from
// `_site/site/content/live.json`. Baked into every page at build by `LiveNotice.astro`; `worker.ts` fetches it at
// request time and only overrides, never supplies, so any failure leaves the last built state.

/** Where the worker reads the live document from. Public repo, so no credential is involved. */
export const LIVE_CONTENT_URL = "https://raw.githubusercontent.com/intentic/intentic/HEAD/_site/site/content/live.json";

// Overrides GitHub max-age=300; GitHub purges its own CDN on push, so this is the real cache floor.
export const LIVE_CACHE_SECONDS = 30;

export type NoticeTone = "info" | "warn" | "down";

const TONES: readonly NoticeTone[] = ["info", "warn", "down"];

export interface LiveNoticeContent {
    /** False ⇒ the strip is not rendered at all. The message is kept so the last one can be put back. */
    active: boolean;
    tone: NoticeTone;
    /** One sentence. Long enough to say what is wrong and short enough to read in a strip. */
    message: string;
    /** Optional destination for "Details". Internal path, or https on a host we own. */
    href: string;
    linkLabel: string;
}

export interface LiveSwitch {
    enabled: boolean;
    /** Why it is off. Shown on the disabled control as its title; say it out loud in the notice too. */
    reason: string;
}

export interface LiveContent {
    notice: LiveNoticeContent;
    switches: { download: LiveSwitch; workspace: LiveSwitch };
}

/** What the site behaves as when there is no usable document at all: nothing announced, nothing blocked. */
export const DEFAULT_LIVE_CONTENT: LiveContent = {
    notice: { active: false, tone: "info", message: "", href: "", linkLabel: "" },
    switches: { download: { enabled: true, reason: "" }, workspace: { enabled: true, reason: "" } },
};

// Allowlist, not a URL check, for a notice href: an injected redirect would be attacker-controlled.
const ALLOWED_LINK_HOSTS = new Set(["intentic.dev", "www.intentic.dev", "status.intentic.dev", new URL(PLATFORM_WEB_ORIGIN).hostname, "github.com", "discord.gg"]);

// Caps a strip to about three lines at 390px, matching `--notice-height`; longer belongs behind `href`.
const MAX_MESSAGE = 120;
const MAX_REASON = 140;
const MAX_LABEL = 40;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A string, trimmed and length-capped, or "" for anything that is not one. Never throws, never returns null. */
const text = (value: unknown, max: number): string => (typeof value === "string" ? value.trim().slice(0, max) : "");

/**
 * Booleans only; a missing or non-boolean flag takes the fallback instead of being coerced (a "false" string is
 * truthy).
 */
const flag = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);

const link = (value: unknown): string => {
    const raw = text(value, 300);
    if (raw === "") {
        return "";
    }
    // Internal, and only ever a path: "//evil.example" is a protocol-relative URL, not a path.
    if (raw.startsWith("/") && !raw.startsWith("//")) {
        return raw;
    }
    try {
        const url = new URL(raw);
        return url.protocol === "https:" && ALLOWED_LINK_HOSTS.has(url.hostname) ? url.href : "";
    } catch {
        return "";
    }
};

const parseSwitch = (value: unknown): LiveSwitch => {
    const source = isRecord(value) ? value : {};
    return { enabled: flag(source.enabled, true), reason: text(source.reason, MAX_REASON) };
};

// Never rejects a document for being partly wrong; only a non-object document returns undefined. An empty message
// forces `active` false regardless of the file, since a blank strip is worse than none.
export const parseLiveContent = (value: unknown): LiveContent | undefined => {
    if (!isRecord(value)) {
        return undefined;
    }
    const notice = isRecord(value.notice) ? value.notice : {};
    const switches = isRecord(value.switches) ? value.switches : {};
    const message = text(notice.message, MAX_MESSAGE);
    const tone = notice.tone;
    return {
        notice: {
            active: flag(notice.active, false) && message !== "",
            tone: typeof tone === "string" && (TONES as readonly string[]).includes(tone) ? (tone as NoticeTone) : "info",
            message,
            href: link(notice.href),
            linkLabel: text(notice.linkLabel, MAX_LABEL) || "Details",
        },
        switches: { download: parseSwitch(switches.download), workspace: parseSwitch(switches.workspace) },
    };
};
