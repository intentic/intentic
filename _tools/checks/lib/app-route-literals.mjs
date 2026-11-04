// The app's addresses a file spells by hand, for the route-literals check. What counts as one is read off the app-routes
// tables as text, since the checks run before `pnpm install`, and literals are read by the scanner contract-paths uses
// (this directory's route-literals.mjs): comments skipped, a template literal's substitutions read as HOLE.
import { allowedAt, pragmaReason } from "./allow.mjs";
import { HOLE, scan } from "./route-literals.mjs";

/** The id a site's `allow(<id>): <reason>` names to say why it must spell an address. */
export const PRAGMA = "route-literal";

// The tables of app-pages.ts whose patterns are addresses, each below a frame or from the root.
const PAGE_TABLES = ["SANDBOX_PAGES", "ACCOUNT_PAGES", "TOP_PAGES", "LOCAL_PAGES"];

const QUOTED = "[`\"']([^`\"'\\n]*)[`\"']";
// A table's body: from `const NAME … = {` (or `[`) to the first line its bracket closes at the margin.
const bodyOf = (text, name) => new RegExp(String.raw`\bconst ${name}\b[^=\n]*=\s*([{[][\s\S]*?\n[}\]])`).exec(text)?.[1];
const valuesAfter = (text, key) => [...text.matchAll(new RegExp(`${key}${QUOTED}`, "gm"))].map((match) => match[1]);
// The segments paths.ts spells into an address itself, past the frame: `joined(SANDBOX_SEGMENT, …, \`floating\`, panel)`.
const joinedSegments = (paths) =>
    paths
        .split("\n")
        .flatMap((line) =>
            line.includes("joined(") ? valuesAfter(line.slice(line.indexOf("joined(")), "").filter((word) => /^[a-z][\w-]*$/.test(word)) : [],
        );

/**
 * The first segment of every address the app answers or once answered: each pattern of the page tables in `pages`
 * (app-pages.ts) and of LEGACY_ROUTES in `legacy` (legacy.ts), the frames `paths` (paths.ts) declares as `*_SEGMENT`,
 * and the segments paths.ts spells into an address itself (`floating`, whose address before frames was
 * `/floating/<panel>`). `missing` names each table the text no longer holds, so a rename cannot empty the rule.
 */
export const routeRoots = ({ pages, legacy, paths }) => {
    const tables = [
        ...PAGE_TABLES.map((name) => [name, bodyOf(pages, name), String.raw`^\s*[\w$]+:\s*`]),
        ["LEGACY_ROUTES", bodyOf(legacy, "LEGACY_ROUTES"), String.raw`\bpattern:\s*`],
    ];
    const missing = tables.filter(([, body]) => body === undefined).map(([name]) => name);
    const patterns = tables.flatMap(([, body, key]) => (body === undefined ? [] : valuesAfter(body, key)));
    const frames = valuesAfter(paths, String.raw`\bexport const \w+_SEGMENT\s*=\s*`);
    // A pattern's root is its first segment when that is static: `login/confirm` is `login`; a parameter is none.
    const roots = new Set([...patterns, ...frames, ...joinedSegments(paths)].map((pattern) => pattern.split("/")[0]));
    return { roots: [...roots].filter((root) => root !== "" && !root.startsWith(":")).toSorted(), missing };
};

// Where an address is written: the editor, the desktop app, the extensions, the demo, the daemon's push messages.
// Every part that hands a person an address of the editor: the editor and its pages, the desktop app, the extensions,
// the demo, the daemon (push messages, links in notices) and the platform's API (sign-in mail, Stripe's way back).
const SCOPE = /^(?:_editor\/web\/src|_editor\/desktop-app\/src|_extensions\/[^/]+\/src|_site\/demo\/src|_sandbox\/sandbox\/src|_platform\/api\/src)\//;
const KINDS = /\.(?:ts|mts|vue)$/;
// The tables themselves, and what a test feeds the code: suites, their fixtures and `testing.ts` helpers.
const EXEMPT = /^_shared\/sandbox-contract\/src\/app-routes\/|\.(?:test|spec)\.m?ts$|(?:^|[/.])testing\.m?ts$|\/(?:fixtures?|__fixtures__)\//;

/** Whether `path` (repo-relative) is a file the rule reads. */
export const isSubject = (path) => SCOPE.test(path) && KINDS.test(path) && !EXEMPT.test(path);

// A line that hands its literal to the daemon: its routes share prefixes with the app's (`/agents/…`, `/workspace/…`).
const DAEMON_REQUEST =
    /\b(?:sandboxRaw|sandboxJson|sandboxBlob|sandboxRequest|rawRouteUrl|procedurePath)\s*[<(]|\.request\s*[<(]|\bapi\.daemon\b|\bdaemon\.request\b|\bfetch\s*\(|\boc\.route\s*\(/;
// A user's home directory, `/home/ada/intentic`, is no frame: a lowercase name and a slash, where neither the name nor
// the segment after it is a route root (`/home/account/…`, `/home/demo/agents` stay addresses).
const HOME_DIRECTORY = /^\/home\/([a-z_][a-z0-9_.-]*)\/([^/?#]*)/;
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

const lineStarts = (text) => [0, ...[...text.matchAll(/\n/g)].map((match) => match.index + 1)];
const lineAt = (starts, offset) => {
    let [low, high] = [0, starts.length - 1];
    while (low < high) {
        const middle = (low + high + 1) >> 1;
        [low, high] = starts[middle] <= offset ? [middle, high] : [low, middle - 1];
    }
    return low + 1;
};
const blank = (text) => text.replace(/[^\n]/g, " ");
const shifted = (found, line, tagLine) => found.map((literal) => ({ ...literal, line: line - 1 + literal.line, tagLine }));

// A component's markup: its script and style blocks and its comments blanked, so offsets still count lines.
const MARKUP_BLANKS = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<!--[\s\S]*?-->/gi;
const TAG = /<[A-Za-z][^\s/>]*((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTRIBUTE = /([^\s"'=<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

// Every literal a component spells, with the line of the tag it sits in when it sits in one: its script blocks' code,
// the address a `to` or `href` attribute names, and the literals of a bound attribute's or an interpolation's code.
const componentLiterals = (text) => {
    const starts = lineStarts(text);
    const found = [...text.matchAll(/(<script\b[^>]*>)([\s\S]*?)<\/script\s*>/gi)].flatMap((block) =>
        shifted(scan(block[2]), lineAt(starts, block.index + block[1].length)),
    );
    const markup = text.replace(MARKUP_BLANKS, blank);
    for (const tag of markup.matchAll(TAG)) {
        const tagLine = lineAt(starts, tag.index);
        for (const attribute of tag[0].matchAll(ATTRIBUTE)) {
            const [whole, name, double, single] = attribute;
            const value = double ?? single;
            const line = lineAt(starts, tag.index + attribute.index + whole.length - value.length - 1);
            if (name === "to" || name === "href") {
                found.push({ value, line, tagLine });
            } else if (/^(?:[:@#]|v-)/.test(name)) {
                found.push(...shifted(scan(value), line, tagLine));
            }
        }
    }
    for (const interpolation of markup.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
        found.push(...shifted(scan(interpolation[1]), lineAt(starts, interpolation.index)));
    }
    return found;
};

// A literal as a finding shows it: its substitutions as `${…}`, cut short past 80 characters.
const shown = (value) => {
    const text = value.replaceAll(HOLE, "${…}");
    return text.length > 80 ? `${text.slice(0, 79)}…` : text;
};

/**
 * The app addresses `text` (the file at `path`) spells by hand, each at its 1-based line: a literal opening with
 * `/<root>` and then its end, `/`, `?`, `#` or a substitution. Not one handed to the daemon on its line, a user's home
 * directory, or a site that says why with `// allow(route-literal): <reason>` (`<!-- … -->` above a tag in markup).
 */
export const routeLiterals = (path, text, roots) => {
    const address = new RegExp(`^/(?:${roots.map(escape).join("|")})(?:$|[/?#${HOLE}])`);
    const lines = text.split("\n");
    const allowed = (line) => allowedAt(lines, line, PRAGMA) || (line > 1 && pragmaReason(lines[line - 2], PRAGMA) !== undefined);
    const homeDirectory = (value) => {
        const named = HOME_DIRECTORY.exec(value);
        return named !== null && !roots.includes(named[1]) && !roots.includes(named[2]);
    };
    const literals = path.endsWith(".vue") ? componentLiterals(text) : scan(text);
    return literals
        .filter(({ value, line, tagLine }) => {
            if (!address.test(value) || homeDirectory(value) || DAEMON_REQUEST.test(lines[line - 1] ?? "")) {
                return false;
            }
            return !allowed(line) && (tagLine === undefined || !allowed(tagLine));
        })
        .map(({ value, line }) => ({ line, literal: shown(value) }));
};
