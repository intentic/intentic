import { createHash } from "node:crypto";
import type { IssueReport } from "@intentic/sandbox-contract";

/* WHAT MAKES TWO CRASHES THE SAME CRASH.
 *
 * This is the load-bearing idea of the whole intake, and it is worth being blunt about why: without it, one
 * broken deploy on one popular page is one agent turn per affected browser. Not a bug report, a bill. Grouping
 * happens BEFORE anything else costs money, which is why this module is pure, synchronous and has no
 * dependencies, it runs on every inbound report including the flood.
 *
 * The hard part is that everything distinguishing one browser's copy of a crash from another's is exactly what
 * is NOT the crash: the line and column of a minified bundle, the hash in its filename, the session id in a
 * message, the origin it was served from. So the whole file is a list of things to throw away, and each one is
 * a real observed way two copies of one bug failed to group.
 *
 * THE AUTOMATION IS PART OF THE KEY. Two sites reporting the same `TypeError: undefined is not a function` are
 * two products having two problems, and merging them would put one team's stack trace in another team's inbox. */

// Sixteen hex characters. Short enough to read out over the phone as a support reference, wide enough that a
// collision needs ~4 billion distinct crashes in one workspace. Hex also satisfies the contract's `entryId`,
// which matters because this string becomes a filename.
const DIGEST_CHARS = 16;

// NUL joins the parts because it cannot occur in any of them, so ["a", "b"] and ["ab"] can never hash alike.
const digest = (parts: readonly string[]): string =>
    createHash("sha256")
        .update(parts.join("\u0000"))
        .digest("hex")
        .slice(0, DIGEST_CHARS);

/* How many frames decide the group. Deep enough that two different callers of one broken helper stay apart,
 * shallow enough that the same bug reached through two code paths does not split in half. Five is the number
 * every error tracker converges on and the reason is the same: below it, framework internals at the top of a
 * stack swallow the distinction; above it, the tail is call-site noise. */
const FRAMES = 5;

/* ---- the message ----
 *
 * A message is a template with the day's values pasted into it, and the values are what stops it grouping:
 * "Failed to load /api/users/8813" and "…/9204" are one bug. Each rule below is one class of value, applied
 * widest-first so a uuid is not half-eaten by the hex rule before it is recognized.
 */
const MESSAGE_MAX = 200;
export const messageClass = (message: string): string =>
    message
        .slice(0, MESSAGE_MAX * 4)
        // A uuid, whole: a request id, a tenant, a row.
        .replaceAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
        // Anything the app quoted at us. The quotes stay so the shape of the sentence survives.
        .replaceAll(/"[^"]*"/g, '"<v>"')
        .replaceAll(/'[^']*'/g, "'<v>'")
        // A URL inside the text: keep that there WAS one and where it pointed, drop the host and the query.
        .replaceAll(/https?:\/\/[^\s"')]+/gi, (url) => `<url:${pathOf(url)}>`)
        // A long hex run: a sha, a token fragment, an object address.
        .replaceAll(/\b[0-9a-f]{8,}\b/gi, "<hex>")
        // Whatever numbers are left. Last, so the rules above got first refusal on them.
        .replaceAll(/\d+/g, "#")
        .replaceAll(/\s+/g, " ")
        .trim()
        .slice(0, MESSAGE_MAX);

/* ---- the frames ---- */

// The path a URL points at, with the query and fragment gone. A bare path (a bundler's relative spec, a
// react-native module) is returned as it stands, which is why this cannot just be `new URL(...)`.
const pathOf = (candidate: string): string => {
    const withoutQuery = candidate.split(/[?#]/)[0] ?? candidate;
    const scheme = /^[a-z][a-z0-9+.-]*:\/\/[^/]+(?<path>\/.*)?$/i.exec(withoutQuery);
    return scheme === null ? withoutQuery : (scheme.groups?.["path"] ?? "/");
};

/* A build hash inside a filename, the single commonest reason one bug reads as a new bug after every deploy:
 * `index-DdSk2Fs1.js` and `main.a1b2c3d4.chunk.js` are the two shapes bundlers emit, and an ES-module build
 * does the same thing one extension along. A token is a hash if it is long and mixes cases or digits with
 * letters, which keeps ordinary names (`polyfills-legacy`, `bundle2`) intact. */
const hashToken = (token: string): boolean => {
    if (token.length < 6) {
        return false;
    }
    if (/^[0-9a-f]{6,}$/i.test(token)) {
        return true;
    }
    return token.length >= 8 && /\d/.test(token) && /[a-z]/i.test(token) && !/^[a-z]+\d+$/i.test(token);
};

export const deHash = (file: string): string => {
    const slash = file.lastIndexOf("/");
    const dir = slash === -1 ? "" : file.slice(0, slash + 1);
    const base = file.slice(slash + 1);
    /* The extension is split off FIRST and put back untouched, so the stem is the only thing hash-stripping can
     * eat. Without that, a bundle named nothing but its own hash (`a1b2c3d4e5.js`, which is what several
     * bundlers emit for a shared chunk) reduced to `js`, and every such chunk on the site then grouped as one
     * file, which is the exact over-merging this whole module is trying to avoid. */
    const dot = base.lastIndexOf(".");
    const stem = dot <= 0 ? base : base.slice(0, dot);
    const extension = dot <= 0 ? "" : base.slice(dot);
    const kept = stem
        .split(/([.-])/)
        .filter((token) => !hashToken(token))
        .join("")
        // Separators left stranded by the token they introduced.
        .replaceAll(/[.-]{2,}/g, ".")
        .replace(/^[.-]+/, "")
        .replace(/[.-]+$/, "");
    // A stem that WAS the hash keeps its original name: an empty file component identifies nothing.
    return `${dir}${kept === "" ? base : `${kept}${extension}`}`;
};

/* One stack line → the two things that identify it: the function and the file it lives in. Both browser
 * dialects are handled here rather than by sniffing the user agent, because a stack can arrive from anywhere
 * (a server SDK, a react-native bundle, a copy-pasted trace):
 *
 *   V8        "    at doThing (https://site/assets/main.a1b2.js:2:1440)"   and its anonymous "    at https://…"
 *   SpiderMonkey / JavaScriptCore    "doThing@https://site/assets/main.a1b2.js:2:1440"
 *
 * The LINE AND COLUMN ARE ALWAYS DROPPED. In minified code they move on every build, so keeping them means a
 * bug that regroups from scratch after each deploy, which is indistinguishable from a bug nobody ever fixed.
 */
// Tried in this order. V8 first, because its `at ` prefix is unambiguous where the `@` form would happily
// match a V8 line that merely contains an email address.
const V8_FRAME = /^at\s+(?:(?<fn>.+?)\s+\()?(?<loc>[^()]+?)\)?$/;
const AT_FRAME = /^(?<fn>.*?)@(?<loc>.+)$/;

const framePartsOf = (text: string): { fn: string; loc: string } | undefined => {
    const match = V8_FRAME.exec(text) ?? AT_FRAME.exec(text);
    return match === null ? undefined : { fn: (match.groups?.["fn"] ?? "").trim(), loc: (match.groups?.["loc"] ?? "").trim() };
};

export const frameOf = (line: string): string | undefined => {
    const parts = framePartsOf(line.trim());
    if (parts === undefined) {
        return undefined;
    }
    // Strip the trailing :line:col (or :line) the browser appends to the file.
    const file = deHash(pathOf(parts.loc.replace(/:\d+(?::\d+)?$/, "")));
    return parts.fn === "" && file === "" ? undefined : `${parts.fn}@${file}`;
};

// The first few identifying frames of a stack. The first line of a V8 stack is the message, not a frame, and
// `frameOf` rejects it for us by failing to match, so nothing has to know which dialect produced this.
export const framesOf = (stack: string): string[] => {
    const frames: string[] = [];
    for (const line of stack.split("\n")) {
        const frame = frameOf(line);
        if (frame !== undefined) {
            frames.push(frame);
        }
        if (frames.length === FRAMES) {
            break;
        }
    }
    return frames;
};

/* The frame to SHOW, as the inbox's second line. The first one that looks like the site's own code rather than
 * a library's, because "it broke in node_modules/react-dom" is true of half the crashes on the internet and
 * tells the reader nothing about theirs. Falls back to the genuine top frame when everything is vendor. */
const VENDOR = /\/(?:node_modules|vendor|chunk-vendors|~partytown)\//;
export const culpritOf = (stack: string | undefined): string | undefined => {
    if (stack === undefined) {
        return undefined;
    }
    const frames = framesOf(stack);
    return frames.find((frame) => !VENDOR.test(frame)) ?? frames[0];
};

/* THE FINGERPRINT. `unique` is what a non-grouping report is keyed by, and the caller supplies it (a fresh
 * uuid per request) rather than this module minting one, which keeps the function pure and therefore testable
 * against a fixed expectation.
 *
 * The three cases, and why they differ:
 *
 *   a host-supplied `fingerprint`  the app knows something the stack does not, one screen's two failure modes,
 *                                  or two screens' one shared cause. Sentry's convention, worth keeping.
 *   kind "report"                  NEVER grouped. Two people describing the same annoyance in their own words
 *                                  are two things to read, and merging them would hide the second person's
 *                                  sentence behind a count of 2 on the first person's.
 *   crash / detection              grouped structurally: what went wrong and where, with everything that
 *                                  varies per browser and per build taken out.
 */
export const fingerprintOf = (automationId: string, report: IssueReport, unique: string): string => {
    if (report.fingerprint !== undefined) {
        return digest([automationId, "custom", report.fingerprint]);
    }
    if (report.kind === "report") {
        return digest([automationId, "report", unique]);
    }
    const frames = report.stack === undefined ? [] : framesOf(report.stack);
    /* A stackless crash is not rare, `window.onerror` from a cross-origin script gets "Script error." and
     * nothing else, and an old browser gives a message alone. Falling back to the PAGE is what keeps those
     * from collapsing into one useless mega-issue: same message on the checkout page and on the home page is
     * two problems worth seeing separately when there is nothing else to tell them apart. */
    const where = frames.length > 0 ? frames : [pathOf(report.url ?? "")];
    return digest([automationId, report.kind, messageClass(report.message), ...where]);
};

/* The headline the inbox lists a group under. Derived, never typed, so two arrivals of one crash cannot end up
 * filed under two names, and built from the RAW message rather than the normalized one: the reader wants the
 * sentence the browser actually produced, ids and all. A written report leads with what the person wrote,
 * because its `message` is a summary line the SDK made up from it. */
const TITLE_MAX = 300;
export const titleOf = (report: IssueReport): string => {
    const source = report.kind === "report" ? (report.description ?? report.message) : report.message;
    const line = source.replaceAll(/\s+/g, " ").trim();
    return (line === "" ? report.message : line).slice(0, TITLE_MAX);
};
