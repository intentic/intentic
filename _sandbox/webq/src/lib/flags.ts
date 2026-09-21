/* Flag parsers and the flag groups both verbs share — declared once so `webq fetch` and `webq crawl`. */
import { countParser } from "@intentic/agent-cli/flags";
import type { BrowserMode } from "./page.js";

const browserModeParser = (raw: string): BrowserMode => {
    if (raw === "auto" || raw === "never" || raw === "force") {
        return raw;
    }
    throw new Error(`--browser takes auto|never|force, got "${raw}"`);
};

/** A URL an agent typed: a bare host is meant as https. */
export const urlParser = (raw: string): string => {
    const trimmed = raw.trim();
    return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
};

// The options shared verbatim by fetch and crawl.
export const sharedFlagParameters = {
    raw: { kind: "boolean", default: false, brief: "Whole page, skip fit-pruning of chrome" },
    query: { kind: "parsed", parse: String, optional: true, brief: "Keep only blocks relevant to this (BM25); crawl: also steer link order" },
    browser: { kind: "parsed", parse: browserModeParser, default: "auto", brief: "JS rendering: auto|never|force" },
    out: { kind: "parsed", parse: String, optional: true, brief: "Directory for the markdown files" },
    fresh: { kind: "boolean", default: false, brief: "Bypass the cache for this run" },
    maxAge: { kind: "parsed", parse: countParser, optional: true, brief: "Cache freshness window in seconds (default 900)" },
    timeout: { kind: "parsed", parse: countParser, default: "20", brief: "Per-page deadline in seconds" },
    threshold: { kind: "parsed", parse: countParser, optional: true, brief: "Fit-pruning score floor (default 0.48; lower keeps more)" },
    json: { kind: "boolean", default: false, brief: "Machine-readable result on stdout" },
} as const;

export interface SharedFlags {
    readonly raw: boolean;
    readonly query?: string;
    readonly browser: BrowserMode;
    readonly out?: string;
    readonly fresh: boolean;
    readonly maxAge?: number;
    readonly timeout: number;
    readonly threshold?: number;
    readonly json: boolean;
}
