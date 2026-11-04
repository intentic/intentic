// A user script as the agent writes it: plain JavaScript under a `// ==UserScript==` block, the header Tampermonkey and
// Violentmonkey read, so a script written here also installs there unchanged. This reads that block into what the
// browser registers and what the person is shown before they install it. Pure, so the popup's preview and the tests
// read a script exactly as the worker does.
//
// The rules that are this extension's, not the format's:
// - Every @match names one site exactly: a scheme and a host, no wildcards in either. A site is what the person allows
//   in the popup, one at a time, and a script may run only where its agent may already click and type.
// - @connect lists every other host the script may talk to or load from. Nothing else is reachable from the script's
//   world (runtime.ts writes it into the world's content security policy, which Chrome enforces).
// - Nothing is fetched to build a script: @require and @resource are refused, so what the person reviewed is all of it.

export type RunAt = "document_start" | "document_end" | "document_idle";

export interface ParsedScript {
    readonly name: string;
    readonly description: string;
    readonly version: string;
    // As written, for the browser's own matcher.
    readonly matches: readonly string[];
    readonly excludeMatches: readonly string[];
    readonly runAt: RunAt;
    // Content security policy sources, normalised (`https://api.example.com`).
    readonly connects: readonly string[];
    // The sites the matches fall on, as the popup's grant patterns (`https://github.com/*`), sorted and unique.
    readonly sites: readonly string[];
    // The whole text, header included: what is reviewed is what runs.
    readonly source: string;
    // Header lines this extension does not act on that a script may have relied on elsewhere, said to the agent.
    readonly warnings: readonly string[];
}

export type Parsed = { readonly ok: true; readonly script: ParsedScript } | { readonly ok: false; readonly message: string };

// Larger than any script a person could review; a bundle this size wants to be an extension of its own.
export const SOURCE_LIMIT = 256_000;
const NAME_LIMIT = 80;
const DESCRIPTION_LIMIT = 300;
const MATCH_LIMIT = 20;
const CONNECT_LIMIT = 20;

const RUN_AT = new Map<string, RunAt>([
    ["document-start", "document_start"],
    ["document-end", "document_end"],
    // Tampermonkey's: once <body> exists, which is document_end at the latest.
    ["document-body", "document_end"],
    ["document-idle", "document_idle"],
]);

// Header keys read elsewhere that ask for something this extension never does: said rather than silently dropped.
const REFUSED = {
    require: "@require fetches code from elsewhere, and nothing is fetched here: what the person reviews is all that runs. Bundle it into the script.",
    resource: "@resource fetches files from elsewhere, and nothing is fetched here. Inline what the script needs.",
    include: "@include takes globs and regular expressions that can cover any site. Use @match with an exact scheme and host for each site.",
    exclude: "@exclude takes globs and regular expressions. Use @exclude-match with a match pattern.",
} as const satisfies Record<string, string>;

const header = (source: string): { readonly entries: readonly (readonly [key: string, value: string])[] } | { readonly message: string } => {
    const lines = source.split(/\r?\n/);
    const start = lines.findIndex((line) => /^\s*\/\/\s*==UserScript==\s*$/.test(line));
    if (start === -1) {
        return {
            message: "The script has no `// ==UserScript==` header. Start it with one naming it and its sites: `// @name`, then one `// @match` per site.",
        };
    }
    const end = lines.findIndex((line, index) => index > start && /^\s*\/\/\s*==\/UserScript==\s*$/.test(line));
    if (end === -1) {
        return { message: "The `// ==UserScript==` header never ends: close it with `// ==/UserScript==`." };
    }
    const entries: (readonly [string, string])[] = [];
    for (const line of lines.slice(start + 1, end)) {
        const entry = /^\s*\/\/\s*@([\w:-]+)(?:\s+(.*?))?\s*$/.exec(line);
        if (entry !== null) {
            entries.push([entry[1]!.toLowerCase(), entry[2] ?? ""]);
        }
    }
    return { entries };
};

// A match pattern on exactly one site, and that site as the popup's grant pattern; or why it is not one.
export const matchSite = (pattern: string): { readonly site: string } | { readonly message: string } => {
    if (pattern === "<all_urls>") {
        return { message: `@match <all_urls> would run on every site. Name each site the script is for.` };
    }
    const parts = /^([a-z*]+):\/\/([^/]*)(\/.*)$/.exec(pattern);
    if (parts === null) {
        return { message: `@match ${pattern} is not a match pattern: write it as https://example.com/path*.` };
    }
    const [, scheme, host, ] = parts;
    if (scheme !== "https" && scheme !== "http") {
        return {
            message:
                scheme === "*"
                    ? `@match ${pattern} covers http and https at once; each is its own site to the person. Write https:// (and add an http:// line only if the site really serves both).`
                    : `@match ${pattern} is not a web page: only https:// and http:// sites can run a script.`,
        };
    }
    if (host === undefined || host === "" || host.includes("*")) {
        return {
            message: `@match ${pattern} has a wildcard host. Each host is its own site the person allows: write one @match per host (github.com, gist.github.com).`,
        };
    }
    if (!/^[a-z0-9.-]+(:\d{1,5})?$/i.test(host)) {
        return { message: `@match ${pattern} does not name a host.` };
    }
    return { site: `${scheme}://${host.toLowerCase()}/*` };
};

// An exclusion only narrows, so it may use any match pattern the browser reads; only its shape is checked here.
const EXCLUDE = /^(\*|https?):\/\/(\*|(\*\.)?[^/*]+)(\/.*)$/i;

// A @connect entry as a content security policy source, or why it is not one. A bare host means https.
export const connectSource = (value: string): { readonly source: string } | { readonly message: string } => {
    const trimmed = value.trim();
    if (trimmed === "*" || trimmed === "<all_urls>" || trimmed === "self" || trimmed === "'self'") {
        return { message: `@connect ${trimmed} would reach every host. Name each host the script talks to.` };
    }
    const withScheme = /^(https?):\/\/([^/]+)\/?$/i.exec(trimmed);
    const [scheme, host] = withScheme === null ? ["https", trimmed] : [withScheme[1]!.toLowerCase(), withScheme[2]!];
    if (!/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/i.test(host)) {
        return { message: `@connect ${value} is not a host: write it as api.example.com, *.example.com or https://api.example.com.` };
    }
    if (host.startsWith("*.") && !host.slice(2).includes(".")) {
        return { message: `@connect ${value} covers a whole top-level domain. Name the site's own domain.` };
    }
    return { source: `${scheme}://${host.toLowerCase()}` };
};

const oneLine = (value: string, limit: number): string => value.replace(/\s+/g, " ").trim().slice(0, limit);

interface Refusal {
    readonly message: string;
}
const refused = <T>(value: T | Refusal): value is Refusal => typeof value === "object" && value !== null && "message" in value;

// The sites every @match falls on, or the first that is not one site.
const readSites = (matches: readonly string[]): readonly string[] | Refusal => {
    if (matches.length === 0) {
        return { message: "The header has no `// @match`: name every site the script runs on, one per line." };
    }
    if (matches.length > MATCH_LIMIT) {
        return { message: `The header has ${matches.length} @match lines; ${MATCH_LIMIT} is the most one script may have.` };
    }
    const sites = new Set<string>();
    for (const match of matches) {
        const site = matchSite(match);
        if ("message" in site) {
            return site;
        }
        sites.add(site.site);
    }
    return [...sites].toSorted();
};

const readConnects = (lines: readonly string[]): readonly string[] | Refusal => {
    if (lines.length > CONNECT_LIMIT) {
        return { message: `The header has ${lines.length} @connect lines; ${CONNECT_LIMIT} is the most one script may have.` };
    }
    const connects = new Set<string>();
    for (const line of lines) {
        const connect = connectSource(line);
        if ("message" in connect) {
            return connect;
        }
        connects.add(connect.source);
    }
    return [...connects].toSorted();
};

const readRunAt = (line: string | undefined): RunAt | Refusal => {
    if (line === undefined) {
        return "document_idle";
    }
    return RUN_AT.get(line.toLowerCase()) ?? { message: `@run-at ${line} is not one of document-start, document-end or document-idle.` };
};

const grantWarnings = (grants: readonly string[]): string[] =>
    grants.length === 0
        ? []
        : [
              `@grant ${grants.join(", ")} has no effect here: there are no GM_ functions. Use \`intentic.storage\` for values that last, \`intentic.log\` for what script_logs shows, and plain fetch to the sites and @connect hosts.`,
          ];

export const parseUserScript = (source: string): Parsed => {
    if (source.length > SOURCE_LIMIT) {
        return { ok: false, message: `The script is ${Math.round(source.length / 1000)} kB; ${SOURCE_LIMIT / 1000} kB is the most a person can be asked to review.` };
    }
    const read = header(source);
    if ("message" in read) {
        return { ok: false, message: read.message };
    }
    const values = (key: string): string[] => read.entries.filter(([each]) => each === key).map(([, value]) => value).filter((value) => value !== "");
    const refusedKey = Object.entries(REFUSED).find(([key]) => read.entries.some(([each]) => each === key));
    if (refusedKey !== undefined) {
        return { ok: false, message: refusedKey[1] };
    }
    const name = oneLine(values("name")[0] ?? "", NAME_LIMIT);
    if (name === "") {
        return { ok: false, message: "The header has no `// @name`: the person sees the script by its name." };
    }
    const matches = values("match");
    const sites = readSites(matches);
    if (refused(sites)) {
        return { ok: false, message: sites.message };
    }
    const excludeMatches = values("exclude-match");
    const badExclude = excludeMatches.find((pattern) => !EXCLUDE.test(pattern));
    if (badExclude !== undefined) {
        return { ok: false, message: `@exclude-match ${badExclude} is not a match pattern.` };
    }
    const connects = readConnects(values("connect"));
    if (refused(connects)) {
        return { ok: false, message: connects.message };
    }
    const runAt = readRunAt(values("run-at")[0]);
    if (refused(runAt)) {
        return { ok: false, message: runAt.message };
    }
    return {
        ok: true,
        script: {
            name,
            description: oneLine(values("description")[0] ?? "", DESCRIPTION_LIMIT),
            version: oneLine(values("version")[0] ?? "", 40),
            matches,
            excludeMatches,
            runAt,
            connects,
            sites,
            source,
            warnings: grantWarnings(values("grant").filter((grant) => grant !== "none")),
        },
    };
};
