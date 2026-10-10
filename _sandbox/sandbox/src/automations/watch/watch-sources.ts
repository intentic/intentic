import { Script, createContext } from "node:vm";
import type { WatchSource } from "@intentic/sandbox-contract";
import { maxSatisfying, validRange } from "semver";

// The ready-made checks a watch can name instead of a guard command (WatchSourceSchema): the daemon asks the registry,
// GitHub or the page itself, with no shell, no extension and no model. Each answers whether its condition holds and what
// it saw, which is what `fireOn: change` compares and what the wake is told.

export type SourceCheck =
    | { readonly pass: true; readonly output: string }
    // `detail` is what the check is still waiting for, in a sentence the run history shows.
    | { readonly pass: false; readonly detail: string };

export type SourceFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface SourceContext {
    readonly fetch: SourceFetch;
    // Where an authenticated request finds its way: a connected GitHub card's credential-gateway address
    // (GITHUB_API_URL_<card>), else GITHUB_TOKEN or GH_TOKEN, when the owner set one.
    readonly env: Readonly<Record<string, string | undefined>>;
}

// GitHub's API as this sandbox reaches it: through a connected GitHub card's credential gateway when there is one, which
// signs the request itself, else directly, with a token when one is set. Unauthenticated requests share an hourly limit
// per address that a datacentre's address is often past already.
const githubApi = (env: SourceContext["env"]): { readonly base: string; readonly headers: Record<string, string> } => {
    const gateway = Object.entries(env).find(([key, value]) => key.startsWith("GITHUB_API_URL_") && value !== undefined && value !== "");
    if (gateway?.[1] !== undefined) {
        return { base: gateway[1].replace(/\/$/, ""), headers: {} };
    }
    const token = env["GITHUB_TOKEN"] ?? env["GH_TOKEN"];
    return { base: "https://api.github.com", headers: token === undefined || token === "" ? {} : { authorization: `Bearer ${token}` } };
};

// One request may take this long before the check reads as not passing; a 60-second guard has the same bound.
const FETCH_TIMEOUT_MS = 20_000;
// What a page may weigh before the rest is ignored: a watch reads a release page, not a download.
const PAGE_MAX_CHARS = 2_000_000;
const USER_AGENT = "intentic-sandbox-watch";

// The source in a few words, for a run's detail, a notification and the wake's "Check command" line.
export const sourceLabel = (source: WatchSource): string => {
    if (source.kind === "npm") {
        const spec = source.range ?? source.tag;
        return `npm ${source.package}${spec === undefined ? "" : `@${spec}`}`;
    }
    if (source.kind === "github-release") {
        return `GitHub releases of ${source.repo}${source.prereleases === true ? " (prereleases too)" : ""}`;
    }
    return source.select === undefined ? source.url : `${source.url} (matching ${source.select})`;
};

// What upsert refuses, so a source that could never be checked is never saved: a range semver cannot read, a pattern
// that does not compile. Undefined when it can run.
export const sourceProblem = (source: WatchSource): string | undefined => {
    if (source.kind === "npm" && source.range !== undefined && validRange(source.range) === null) {
        return `"${source.range}" is not a semver range npm understands, like >=1.4.3 or ^2`;
    }
    if (source.kind === "url") {
        if (!/^https?:\/\//.test(source.url)) {
            return "a watched page must be an http or https address";
        }
        if (source.select !== undefined) {
            try {
                // Compiled only to learn whether it can be; the check compiles its own each time.
                void new RegExp(source.select);
            } catch (error) {
                return `the select pattern does not compile: ${error instanceof Error ? error.message : String(error)}`;
            }
        }
    }
    return undefined;
};

const timed = async (context: SourceContext, url: string, headers: Record<string, string>): Promise<Response | string> => {
    try {
        return await context.fetch(url, { headers: { "user-agent": USER_AGENT, ...headers }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (error) {
        return `could not reach ${new URL(url).host}: ${error instanceof Error ? error.message : String(error)}`;
    }
};

// A scoped name keeps its @ and escapes its slash, the registry's own spelling.
const registryUrl = (name: string): string =>
    `https://registry.npmjs.org/${name.startsWith("@") ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name)}`;

interface Packument {
    readonly "dist-tags"?: Record<string, string>;
    readonly versions?: Record<string, unknown>;
}

const checkNpm = async (source: Extract<WatchSource, { kind: "npm" }>, context: SourceContext): Promise<SourceCheck> => {
    // The abbreviated document: dist-tags and the version list, without every version's readme.
    const response = await timed(context, registryUrl(source.package), { accept: "application/vnd.npm.install-v1+json" });
    if (typeof response === "string") {
        return { pass: false, detail: response };
    }
    if (response.status === 404) {
        return { pass: false, detail: `npm has no package named ${source.package}` };
    }
    if (!response.ok) {
        return { pass: false, detail: `the npm registry answered ${response.status}` };
    }
    const packument = (await response.json()) as Packument;
    if (source.range !== undefined) {
        const match = maxSatisfying(Object.keys(packument.versions ?? {}), source.range);
        const latest = packument["dist-tags"]?.["latest"];
        return match === null
            ? {
                  pass: false,
                  detail: `no published version of ${source.package} satisfies ${source.range} yet${latest === undefined ? "" : ` (latest is ${latest})`}`,
              }
            : { pass: true, output: `${source.package}@${match}` };
    }
    const tag = source.tag ?? "latest";
    const version = packument["dist-tags"]?.[tag];
    return version === undefined
        ? { pass: false, detail: `${source.package} has no "${tag}" tag` }
        : { pass: true, output: `${source.package}@${version}` };
};

interface Release {
    readonly tag_name?: string;
    readonly name?: string | null;
    readonly html_url?: string;
    readonly draft?: boolean;
    readonly prerelease?: boolean;
}

const checkGithubRelease = async (source: Extract<WatchSource, { kind: "github-release" }>, context: SourceContext): Promise<SourceCheck> => {
    const api = githubApi(context.env);
    const response = await timed(context, `${api.base}/repos/${source.repo}/releases?per_page=20`, {
        accept: "application/vnd.github+json",
        ...api.headers,
    });
    if (typeof response === "string") {
        return { pass: false, detail: response };
    }
    if (response.status === 404) {
        return { pass: false, detail: `GitHub has no public repository ${source.repo}` };
    }
    if (!response.ok) {
        return {
            pass: false,
            detail: `GitHub answered ${response.status}${response.status === 403 ? " (likely its hourly limit for requests without a token)" : ""}`,
        };
    }
    const releases = (await response.json()) as readonly Release[];
    const newest = releases.find((release) => release.draft !== true && (source.prereleases === true || release.prerelease !== true));
    if (newest?.tag_name === undefined) {
        return { pass: false, detail: `${source.repo} has published no ${source.prereleases === true ? "" : "full "}release yet` };
    }
    // Only what names the release, never its notes: a typo fixed in the notes is not a new release.
    const name =
        newest.name !== undefined && newest.name !== null && newest.name !== "" && newest.name !== newest.tag_name ? ` (${newest.name})` : "";
    return { pass: true, output: [`${newest.tag_name}${name}`, ...(newest.html_url === undefined ? [] : [newest.html_url])].join("\n") };
};

// A page's words, not its markup: scripts and styles go whole, tags go, entities a page always uses come back, and runs
// of whitespace become one, so a page re-rendered with fresh nonces does not read as changed.
export const pageText = (html: string): string =>
    html
        .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim();

// How long one `select` pattern may run against a page. A pattern that backtracks (`(a+)+$`) on a page that feeds it
// takes exponential time, and on the daemon's own thread that is every conversation frozen, so it is stopped instead.
const SELECT_TIMEOUT_MS = 1_000;
const selectRun = new Script("match = pattern.exec(text)");

// The pattern's first match on the page, or "timeout" when it would not finish in time. Run inside a context of its own
// only for the deadline, which V8 enforces even mid-backtrack; the pattern and page are plain values, nothing escapes.
const boundedMatch = (pattern: string, text: string): RegExpExecArray | null | "timeout" => {
    const scope: { pattern: RegExp; text: string; match: RegExpExecArray | null } = { pattern: new RegExp(pattern), text, match: null };
    const context = createContext(scope);
    try {
        selectRun.runInContext(context, { timeout: SELECT_TIMEOUT_MS });
    } catch (error) {
        if ((error as { code?: unknown }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
            return "timeout";
        }
        throw error;
    }
    return scope.match;
};

const checkUrl = async (source: Extract<WatchSource, { kind: "url" }>, context: SourceContext): Promise<SourceCheck> => {
    const response = await timed(context, source.url, { accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" });
    if (typeof response === "string") {
        return { pass: false, detail: response };
    }
    if (!response.ok) {
        return { pass: false, detail: `the page answered ${response.status}` };
    }
    const body = (await response.text()).slice(0, PAGE_MAX_CHARS);
    if (source.select === undefined) {
        const html = (response.headers.get("content-type") ?? "").includes("html");
        return { pass: true, output: html ? pageText(body) : body.trim() };
    }
    // Matched against the page as served, so a pattern can anchor on markup; its first group when it has one.
    const match = boundedMatch(source.select, body);
    if (match === "timeout") {
        return {
            pass: false,
            detail: `matching ${source.select} against the page took longer than ${SELECT_TIMEOUT_MS / 1_000}s, so it was stopped: simplify the pattern`,
        };
    }
    if (match === null) {
        return { pass: false, detail: `nothing on the page matches ${source.select}` };
    }
    return { pass: true, output: (match[1] ?? match[0]).trim() };
};

export const checkSource = async (source: WatchSource, context: SourceContext): Promise<SourceCheck> => {
    try {
        if (source.kind === "npm") {
            return await checkNpm(source, context);
        }
        if (source.kind === "github-release") {
            return await checkGithubRelease(source, context);
        }
        return await checkUrl(source, context);
    } catch (error) {
        // A body that would not parse is a check that did not pass, said as such, never a crashed tick.
        return { pass: false, detail: `the check failed: ${error instanceof Error ? error.message : String(error)}` };
    }
};
