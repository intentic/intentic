import { PLATFORM_WEB_ORIGIN } from "@intentic/constants";

/* LIVE CONTENT: the handful of things on this site that must change WITHOUT a deploy.
 *
 * Everything else here is built. Copy is typed TypeScript in `site-content`, pages are `.astro`, and a
 * wording change reaches the web the way every other change does — a commit, a build, a deploy. That is the
 * right trade for anything a search engine reads, because the build is what writes the sitemap entry, the
 * `.md` mirror, the `llms.txt` line and the OpenGraph card. A page fetched at runtime has none of them.
 *
 * Three things do not fit that trade, and they are the whole of this file:
 *
 *   - A NOTICE. "The hosted sandboxes are degraded." Waiting three minutes for a pipeline to say so is
 *     three minutes of people filing the same ticket.
 *   - THE DOWNLOAD SWITCH. A bad installer has to stop being handed out NOW, not after a build.
 *   - THE WORKSPACE SWITCH. Same, for the button that opens the app.
 *
 * ONE FILE IS THE SOURCE: `_site/site/content/live.json`, in git, reviewable in a diff, edited by whoever or
 * whatever is asked to edit it. It is read TWICE:
 *
 *   - AT BUILD, by `LiveNotice.astro` and by nothing else, which BAKES the current state into every page.
 *   - AT REQUEST, by `worker.ts`, which fetches it from raw.githubusercontent and rewrites the baked HTML.
 *
 * That layering is the design, not an optimization. The worker only ever OVERRIDES; it never supplies. A
 * failed fetch, a malformed document, a GitHub outage — every one of them leaves the page exactly as it was
 * built, which is the last state somebody committed. The failure mode of the instant lane is "as fresh as
 * the last deploy", which is the same site everybody had before this file existed.
 *
 * NO ZOD HERE, deliberately. This module is bundled into the worker, which runs on every request to the
 * site; the parser below is thirty lines and costs nothing. It is also STRICT on purpose — the point of a
 * lane that bypasses the build is that nothing else is checking, so a bad `live.json` must degrade to
 * "ignore it" rather than to a blank hero. */

/** Where the worker reads the live document from. Public repo, so no credential is involved. */
export const LIVE_CONTENT_URL = "https://raw.githubusercontent.com/intentic/intentic/HEAD/_site/site/content/live.json";

/* How long the edge may serve a cached copy. raw.githubusercontent answers with `max-age=300`, which is
 * GitHub telling US how long to cache; we override it, because five minutes is a poor kill switch. GitHub
 * purges its own CDN on push, so the real floor is this number. Thirty seconds costs one origin fetch per
 * colo per half-minute and makes "turn the download off" a thing that happens while you are still looking. */
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

/* Where a notice's link may point. An injected href is a redirect somebody else now controls, so it is an
 * allowlist rather than a URL check: the site's own pages, and the three off-site places the rest of the
 * site already links to. Anything else is dropped and the notice renders without its link. */
const ALLOWED_LINK_HOSTS = new Set(["intentic.dev", "www.intentic.dev", "status.intentic.dev", new URL(PLATFORM_WEB_ORIGIN).hostname, "github.com", "discord.gg"]);

/* A STRIP HOLDS A HEADLINE, NOT A PARAGRAPH, and this number is where that is enforced. It was 240, which
 * is fine on a desktop and five lines of wrapped text on a phone — against a strip whose height the layout
 * has to reserve in advance, because the bar below it is `position: fixed` and moves by a stylesheet value
 * rather than by a measurement. 120 characters is about three lines at 390px, which is what the narrow
 * `--notice-height` in LiveNotice.astro reserves room for. Anything longer belongs behind the `href`. */
const MAX_MESSAGE = 120;
const MAX_REASON = 140;
const MAX_LABEL = 40;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A string, trimmed and length-capped, or "" for anything that is not one. Never throws, never returns null. */
const text = (value: unknown, max: number): string => (typeof value === "string" ? value.trim().slice(0, max) : "");

/** Booleans only: a missing or non-boolean flag takes the fallback rather than being coerced. `"false"` is
 *  a string, and a switch that read it as truthy would be on when somebody meant it off. */
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

/* The parser. It never rejects a document for being partly wrong — a missing `switches` block means "no
 * switch is thrown", not "ignore the notice too" — because the alternative is that one stray key in the
 * file takes the whole lane down, at the exact moment somebody is using it to announce an incident.
 *
 * `undefined` is returned only for a document that is not an object at all: a 404 page, an HTML error, a
 * truncated body. That is the one case where there is nothing to read, and the caller leaves the built page
 * alone.
 *
 * A notice with no message is not active whatever the file says: an empty strip is worse than none, and
 * `active: true` with the message cleared is exactly what a half-finished edit looks like. */
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
