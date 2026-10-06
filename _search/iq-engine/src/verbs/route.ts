import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { type RgOptions, rgSearch } from "../engines/lexical.js";
import { jsxRoutes, matchRoutes, parseRouteAddress, type RouteAddress, type RouteDecl, type RouteMatch, routeTable } from "../engines/routes.js";
import type { FileEntry, RankedGroup, RankedHit } from "../types.js";
import { classOf } from "../workspace/scan.js";

// ROUTES: an address (`/agents`, `/sandbox/agent?section=tools`) answers with the route that declares it and the view
// that route loads, then follows each parameter and query value into the view: the branch that tests for it, and the
// component that branch mounts. Nothing here knows an app's routes; it reads them from whichever files build a router.

export interface RouteAnswer {
    readonly groups: RankedGroup[];
    // Capsule lines: the declaration and its view, then one line per value followed into it.
    readonly facts: readonly string[];
    // One declaration matched (or several declaring the same view).
    readonly confident: boolean;
    readonly note: string;
}

type RgBase = Omit<RgOptions, "pattern">;

// What a file that builds a router names: vue-router, react-router, Angular. A file with none of these declares no routes
// this reads, so only these are parsed.
const ROUTER_MARKERS = String.raw`\b(?:createRouter|createWebHistory|createWebHashHistory|createBrowserRouter|createHashRouter|createMemoryRouter|RouteRecordRaw|RouteObject|VueRouter|provideRouter|RouterModule)\b|<Route\b`;
const CODE_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte)$/;
const RESOLVE_EXTS = [".vue", ".tsx", ".ts", ".jsx", ".js", ".mjs", ".svelte"];
// How far a branch's block is read for the components it mounts, and how many local imports are read for a nav table.
const BLOCK_LINES = 15;
const NAV_IMPORTS = 10;
// Component names listed per branch in the capsule.
const LISTED_COMPONENTS = 6;

const escapeRegExp = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A relative or `@/`-rooted import from `from`, as a workspace path the sweep admits; a package import is not one.
export const resolveImport = (from: string, spec: string, allowed: ReadonlySet<string>): string | undefined => {
    let base: string;
    if (spec.startsWith(".")) {
        base = posix.normalize(posix.join(posix.dirname(from), spec));
    } else if (/^[@~]\//.test(spec)) {
        // The usual alias for the package's own src directory.
        const src = from.lastIndexOf("/src/");
        if (src === -1) {
            return undefined;
        }
        base = `${from.slice(0, src + 5)}${spec.slice(2)}`;
    } else {
        return undefined;
    }
    for (const candidate of [base, ...RESOLVE_EXTS.map((ext) => `${base}${ext}`), ...RESOLVE_EXTS.map((ext) => `${base}/index${ext}`)]) {
        if (allowed.has(candidate)) {
            return candidate;
        }
    }
    return undefined;
};

// Where a file imports an identifier from: a default or a named import.
export const importSpecOf = (text: string, name: string): string | undefined => {
    const escaped = escapeRegExp(name);
    const found =
        new RegExp(String.raw`import\s+(?:type\s+)?${escaped}\s*(?:,\s*\{[^}]*\})?\s*from\s*[\x60'"]([^\x60'"]+)[\x60'"]`).exec(text) ??
        new RegExp(String.raw`import\s*(?:[\w$]+\s*,\s*)?\{[^}]*\b${escaped}\b[^}]*\}\s*from\s*[\x60'"]([^\x60'"]+)[\x60'"]`).exec(text);
    return found?.[1];
};

const tagsIn = (line: string): string[] => [...line.matchAll(/<([A-Z][\w$]*)/g)].map((match) => match[1]!);

export interface Branch {
    // 1-based line of the test.
    readonly line: number;
    // Components the branch mounts, in order.
    readonly components: readonly string[];
}

// The line of a view that tests for one value (`slug === 'agent'`, `case "tools":`, `agent: SandboxAgent` in a lookup
// table), preferring one that also names the parameter, and the components that branch mounts: on the line itself, or in
// the block it opens.
export const branchFor = (text: string, name: string, value: string): Branch | undefined => {
    const quoted = String.raw`[\x60'"]${escapeRegExp(value)}[\x60'"]`;
    const test = new RegExp(String.raw`(?:===?|!==?)\s*${quoted}|${quoted}\s*(?:===?|!==?)|\bcase\s+${quoted}\s*:`);
    const table = new RegExp(String.raw`^\s*[\x60'"]?${escapeRegExp(value)}[\x60'"]?\s*:\s*([A-Z][\w$]*)\s*,?\s*$`);
    const lines = text.split("\n");
    let best: { index: number; rank: number } | undefined;
    lines.forEach((source, index) => {
        const tested = test.test(source);
        const tabled = !tested && table.test(source);
        if (!tested && !tabled) {
            return;
        }
        const rank = (source.includes(name) ? 2 : 0) + (/\bv-(?:else-)?if\b|<[A-Z]/.test(source) ? 1 : 0);
        if (best === undefined || rank > best.rank) {
            best = { index, rank };
        }
    });
    if (best === undefined) {
        return undefined;
    }
    const at = (best as { index: number }).index;
    const source = lines[at]!;
    const tabled = table.exec(source);
    if (tabled !== null) {
        return { line: at + 1, components: [tabled[1]!] };
    }
    const own = tagsIn(source);
    if (own.length > 0) {
        return { line: at + 1, components: own.slice(0, 1) };
    }
    // The test opens a block (`<template v-else-if="section === 'tools'">`): what it mounts is inside, up to the line
    // that closes it at the same indent.
    const indent = /^\s*/.exec(source)![0].length;
    const mounted: string[] = [];
    for (let index = at + 1; index < Math.min(lines.length, at + 1 + BLOCK_LINES); index += 1) {
        const inner = lines[index]!;
        if (inner.trim() !== "" && /^\s*/.exec(inner)![0].length <= indent) {
            break;
        }
        mounted.push(...tagsIn(inner));
    }
    return { line: at + 1, components: mounted };
};

// A nav table's entry for a value (`{ slug: 'agent', label: … }`): where the app lists the section a value names.
const navLine = (text: string, value: string): number | undefined => {
    const entry = new RegExp(String.raw`\b(?:slug|value|key|id|name|tab|section|route)\s*:\s*[\x60'"]${escapeRegExp(value)}[\x60'"]`);
    const index = text.split("\n").findIndex((source) => entry.test(source));
    return index === -1 ? undefined : index + 1;
};

const localImports = (text: string): string[] =>
    [...text.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s*[\x60'"](\.[^\x60'"]+)[\x60'"]/g)].map((match) => match[1]!).slice(0, NAV_IMPORTS);

interface Located {
    readonly path: string;
    readonly line: number;
    readonly kind: "def" | "path" | "text";
}

const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

// The router files in scope, most likely first: source over tests, then the larger table (an app's router over a test
// fixture declaring one route).
const routerFiles = async (root: string, rgBase: RgBase): Promise<{ path: string; text: string; routes: RouteDecl[] }[]> => {
    const markers = await rgSearch({ ...rgBase, pattern: ROUTER_MARKERS, caseSensitive: true });
    const paths = [...new Set(markers.hits.map((hit) => hit.path))].filter((path) => CODE_FILE.test(path));
    const read = await Promise.all(
        paths.map(async (path) => {
            const text = await readFile(join(root, path), "utf8").catch(() => undefined);
            return text === undefined ? undefined : { path, text, routes: [...routeTable(text), ...jsxRoutes(text)] };
        }),
    );
    return read.filter((file) => file !== undefined && file.routes.length > 0) as { path: string; text: string; routes: RouteDecl[] }[];
};

export const routeAnswer = async (query: string, root: string, entries: readonly FileEntry[], rgBase: RgBase): Promise<RouteAnswer | undefined> => {
    const address: RouteAddress | undefined = parseRouteAddress(query);
    if (address === undefined) {
        return undefined;
    }
    const allowed = new Set(entries.map((entry) => entry.path));
    const files = await routerFiles(root, rgBase);
    const matches = files.flatMap((file) => matchRoutes(file.routes, address).map((match) => ({ ...match, file })));
    if (matches.length === 0) {
        return undefined;
    }
    const rankOf = (match: RouteMatch & { file: { path: string; routes: readonly RouteDecl[] } }): number[] => [
        match.statics,
        -match.values.length,
        match.route.redirect ? 0 : 1,
        classOf(match.file.path) === "src" ? 1 : 0,
        match.file.routes.length,
    ];
    const compare = (a: number[], b: number[]): number => {
        for (let index = 0; index < a.length; index += 1) {
            if (a[index] !== b[index]) {
                return b[index]! - a[index]!;
            }
        }
        return 0;
    };
    const ordered = matches.toSorted((a, b) => compare(rankOf(a), rankOf(b)));
    const best = ordered[0]!;
    const viewOf = (match: (typeof ordered)[number]): string | undefined => {
        const component = match.route.component;
        if (component === undefined) {
            return undefined;
        }
        const spec = component.kind === "import" ? component.spec : importSpecOf(match.file.text, component.spec);
        return spec === undefined ? undefined : resolveImport(match.file.path, spec, allowed);
    };
    // Equally specific declarations: the same address declared twice in one router (a second shell's table), or in
    // another router whose view is a real file. A test's one-route stub router (`{ path, component: page }`) ties on
    // specificity but loads nothing of the app's, and does not count.
    const tied = ordered.filter(
        (match) =>
            compare(rankOf(match).slice(0, 4), rankOf(best).slice(0, 4)) === 0 && (match.file.path === best.file.path || viewOf(match) !== undefined),
    );
    const view = viewOf(best);
    const views = new Set(tied.map((match) => viewOf(match) ?? `${match.file.path}:${match.route.line}`));

    const located: Located[] = [];
    const facts: string[] = [];
    const declared = `${best.file.path}:${best.route.line}`;
    facts.push(`route: ${best.route.pattern} at ${declared}${view !== undefined ? ` loads ${view}` : best.route.redirect ? " redirects" : ""}`);
    for (const match of tied) {
        located.push({ path: match.file.path, line: match.route.line, kind: "def" });
        if (match.route.component !== undefined && match.route.component.line !== match.route.line) {
            located.push({ path: match.file.path, line: match.route.component.line, kind: "text" });
        }
    }

    // Follows each value into the view: a path parameter first, then the query, the order a screen narrows in.
    const steps: Located[] = [];
    const navs: Located[] = [];
    let current = view;
    let text = current === undefined ? undefined : await readFile(join(root, current), "utf8").catch(() => undefined);
    for (const [name, value] of [...best.values, ...address.query]) {
        if (current === undefined || text === undefined) {
            break;
        }
        const nav = navLine(text, value);
        if (nav !== undefined) {
            navs.push({ path: current, line: nav, kind: "text" });
        } else {
            for (const spec of localImports(text)) {
                const imported = resolveImport(current, spec, allowed);
                const importedText = imported === undefined ? undefined : await readFile(join(root, imported), "utf8").catch(() => undefined);
                const line = importedText === undefined ? undefined : navLine(importedText, value);
                if (imported !== undefined && line !== undefined) {
                    navs.push({ path: imported, line, kind: "text" });
                    break;
                }
            }
        }
        const branch = branchFor(text, name, value);
        if (branch === undefined) {
            continue;
        }
        steps.push({ path: current, line: branch.line, kind: "text" });
        const listed = branch.components.slice(0, LISTED_COMPONENTS).join(" · ");
        const more = branch.components.length > LISTED_COMPONENTS ? ` +${branch.components.length - LISTED_COMPONENTS} more` : "";
        // One component is the screen for this value: descend into it for the next one. Several are a section's parts.
        const only = branch.components.length === 1 ? branch.components[0] : undefined;
        const spec = only === undefined ? undefined : importSpecOf(text, only);
        const next = spec === undefined ? undefined : resolveImport(current, spec, allowed);
        facts.push(
            `${name}=${value}: ${basename(current)}:${branch.line}${listed === "" ? "" : ` mounts ${listed}${more}`}${next !== undefined ? ` (${next})` : ""}`,
        );
        if (next !== undefined) {
            current = next;
            text = await readFile(join(root, next), "utf8").catch(() => undefined);
        }
    }
    // The screen the address ends on: the last view descended into, anchored on the branch for the last value when
    // that branch is in it, else on its first line.
    const deepest = steps.findLast((step) => step.path === current) ?? (current !== undefined ? { path: current, line: 1, kind: "path" as const } : undefined);
    const spots: Located[] = [
        ...(deepest !== undefined ? [deepest] : []),
        ...located,
        ...steps.toReversed(),
        ...(view !== undefined ? [{ path: view, line: 1, kind: "path" as const }] : []),
        ...navs,
    ];
    const lineCache = new Map<string, string[]>();
    const lineText = async (path: string, line: number): Promise<string> => {
        let lines = lineCache.get(path);
        if (lines === undefined) {
            lines = ((await readFile(join(root, path), "utf8").catch(() => "")) as string).split("\n");
            lineCache.set(path, lines);
        }
        return (lines[line - 1] ?? "").trimEnd();
    };
    // Grouped by file in the order above; within a file the earlier spot outranks the later, so the answer line names the
    // branch rather than whichever of the file's lines comes first.
    const byPath = new Map<string, { hit: RankedHit; order: number }[]>();
    for (const [order, spot] of spots.entries()) {
        const hits = byPath.get(spot.path) ?? [];
        // A file's first-line anchor only stands in when nothing more specific in it was found.
        if (hits.some((entry) => entry.hit.line === spot.line) || (spot.kind === "path" && hits.length > 0)) {
            continue;
        }
        const hit: RankedHit = { path: spot.path, line: spot.line, text: await lineText(spot.path, spot.line), tags: [{ kind: spot.kind }], score: 0 };
        hits.push({ hit, order });
        byPath.set(spot.path, hits);
    }
    const groups = [...byPath.entries()].map(([path, hits], rank) => ({
        path,
        score: 1 / (rank + 1),
        hits: hits.map(({ hit, order }) => ({ ...hit, score: 1 / (rank + 1) - order * 1e-4 })).toSorted((a, b) => a.line - b.line),
    }));
    return {
        groups,
        facts,
        confident: views.size === 1,
        note: `route ${best.route.pattern}`,
    };
};
