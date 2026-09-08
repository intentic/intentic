import { createHash } from "node:crypto";
import type { IssueReport } from "@intentic/sandbox-contract";

// What makes two crashes the same crash, decided before anything else costs money (pure, synchronous, no dependencies).
// Line/column, filename hashes, session ids and origins are exactly what must be discarded, since they vary per copy,
// not per bug. The caller's automation id is part of the key, so two products' identical error message never merges.

// 16 hex chars: short enough to read as a reference, wide against collisions; valid as entryId/filename.
const DIGEST_CHARS = 16;

// NUL joins the parts because it cannot occur in any of them, so ["a", "b"] and ["ab"] can never hash alike.
const digest = (parts: readonly string[]): string =>
    createHash("sha256")
        .update(parts.join("\u0000"))
        .digest("hex")
        .slice(0, DIGEST_CHARS);

// Frames deciding the group: deep enough to separate callers, shallow enough not to split one bug in two.
const FRAMES = 5;

// A message is a template; its pasted-in values are what stop it grouping. Rules below apply widest-first, so a uuid
// isn't half-eaten by the hex rule first.
const MESSAGE_MAX = 200;
export const messageClass = (message: string): string =>
    message
        .slice(0, MESSAGE_MAX * 4)
        // A uuid, whole: a request id, a tenant, a row.
        .replaceAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
        // Anything the app quoted at us. The quotes stay so the shape of the sentence survives.
        .replaceAll(/"[^"]*"/g, '"<v>"')
        .replaceAll(/'[^']*'/g, "'<v>'")
        // A URL inside the text: keeps that one was there and where it pointed, drops the host and the query.
        .replaceAll(/https?:\/\/[^\s"')]+/gi, (url) => `<url:${pathOf(url)}>`)
        // A long hex run: a sha, a token fragment, an object address.
        .replaceAll(/\b[0-9a-f]{8,}\b/gi, "<hex>")
        // Whatever numbers are left. Last, so the rules above got first refusal on them.
        .replaceAll(/\d+/g, "#")
        .replaceAll(/\s+/g, " ")
        .trim()
        .slice(0, MESSAGE_MAX);

// The path a URL points at, query and fragment stripped; a bare path (bundler spec, react-native module) passes through
// unchanged, why this isn't just `new URL(...)`.
const pathOf = (candidate: string): string => {
    const withoutQuery = candidate.split(/[?#]/)[0] ?? candidate;
    const scheme = /^[a-z][a-z0-9+.-]*:\/\/[^/]+(?<path>\/.*)?$/i.exec(withoutQuery);
    return scheme === null ? withoutQuery : (scheme.groups?.["path"] ?? "/");
};

// True for a build-hash token in a filename (index-DdSk2Fs1.js, main.a1b2c3d4.chunk.js): long, and mixing digits with
// letters. Ordinary names (polyfills-legacy, bundle2) stay intact.
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
    // Extension split off first, restored untouched; else an all-hash basename collapses to just its extension.
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
    // A stem that was the hash keeps its original name: an empty file component identifies nothing.
    return `${dir}${kept === "" ? base : `${kept}${extension}`}`;
};

// One stack line to its function and file; both browser dialects are handled directly since a trace can arrive from
// anywhere:
// V8: "at fn (url:line:col)"
// SpiderMonkey/JSC: "fn@url:line:col"
// Line and column are always dropped: in minified code they move every build, so keeping them would re-split a bug
// after each deploy.
// V8 tried first: its `at ` prefix is unambiguous; `@` alone could match an email address in a V8 line.
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

// First few identifying frames of a stack; a V8 stack's first line (the message) is rejected by frameOf failing to
// match, so nothing here needs to know the dialect.
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

// The frame to show as the inbox's second line: the first one that isn't the site's own library code, since "it broke
// in react-dom" says nothing about the crash. Falls back to the top frame when everything is vendor.
const VENDOR = /\/(?:node_modules|vendor|chunk-vendors|~partytown)\//;
export const culpritOf = (stack: string | undefined): string | undefined => {
    if (stack === undefined) {
        return undefined;
    }
    const frames = framesOf(stack);
    return frames.find((frame) => !VENDOR.test(frame)) ?? frames[0];
};

// `unique` backs a non-grouping report; the caller supplies it (a fresh uuid) rather than this function minting one,
// keeping it pure and testable. Three cases:
// a host `fingerprint`: the app knows something the stack doesn't (Sentry's convention)
// kind "report": never grouped, each person's words stay separate
// crash/detection: grouped structurally, by where and what, with anything that varies per browser or build removed
export const fingerprintOf = (automationId: string, report: IssueReport, unique: string): string => {
    if (report.fingerprint !== undefined) {
        return digest([automationId, "custom", report.fingerprint]);
    }
    if (report.kind === "report") {
        return digest([automationId, "report", unique]);
    }
    const frames = report.stack === undefined ? [] : framesOf(report.stack);
    // A stackless crash (cross-origin window.onerror, old browsers) falls back to the page, not one mega-issue.
    const where = frames.length > 0 ? frames : [pathOf(report.url ?? "")];
    return digest([automationId, report.kind, messageClass(report.message), ...where]);
};

// The inbox's headline for a group: derived, never typed, so two arrivals of one crash can't end up under two names.
// Built from the raw message (ids and all), except a written report leads with what the person wrote, not the SDK's
// summary.
const TITLE_MAX = 300;
export const titleOf = (report: IssueReport): string => {
    const source = report.kind === "report" ? (report.description ?? report.message) : report.message;
    const line = source.replaceAll(/\s+/g, " ").trim();
    return (line === "" ? report.message : line).slice(0, TITLE_MAX);
};
