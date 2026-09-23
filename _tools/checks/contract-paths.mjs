#!/usr/bin/env node
// A route the sandbox contract declares is called through a typed client, never by spelling its path: a spelled path
// is a second copy of the route that the contract cannot type, validate or rename. Discovered by shape: the contract's
// own `path: "…"` literals (read by regex, since this runs pre-install) against every literal, and every literal inside
// one, outside tests; a match fails in what is held to zero, and extension packages are held to a ratchet baseline.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cannotMeasure, finish } from "./lib/report.mjs";
import { ADOPTING, ratchet } from "./lib/ratchet.mjs";
import { root, subjectFiles, TEST_FILE } from "./lib/repo.mjs";

const CONTRACTS = `_shared/sandbox-contract/src/contracts`;
// The app's own route table: `/agents/:id` is a screen as well as a daemon route, and a literal it answers to is
// navigation unless its line hands it to a daemon call.
const APP_ROUTER = `_editor/web/src/router/index.ts`;

// Held to zero: the app, and what an author copies from (the extension seed, the site's code samples); each has a typed
// client. Ratcheted: the extension packages, to what the baseline allows.
const HELD = /^(_editor\/web\/src|_tools\/extension-example\/seed\/src|_site\/site\/src\/lib)\//;
const RATCHETED = /^(_extensions\/[^/]+\/src|_shared\/extension-[^/]+\/src)\//;
const SOURCE = /\.(ts|mts|cts|js|mjs|vue)$/;
// A line that hands a literal to the daemon, whatever else it looks like: an extension's backend reaches it as `daemon`.
const DAEMON_CALL = /\bsandbox(Json|Request|Blob|Upload)\w*\s*[<(]|\bpostTurnControl\(|\.(sandbox|daemon)\.(json|request)\s*[<(]/;

// Stands for one `${…}` of a template literal: whatever it holds, it is one segment's worth.
const HOLE = "\u0000";

const pathsIn = (text) => [...text.matchAll(/\bpath:\s*["'`]([^"'`]*)["'`]/g)].map((match) => match[1]);

const routes = [
    ...new Set(
        readdirSync(join(root, CONTRACTS))
            .filter((file) => file.endsWith(".contract.ts"))
            .flatMap((file) => pathsIn(readFileSync(join(root, CONTRACTS, file), "utf8")).filter((path) => path.startsWith("/"))),
    ),
];
// Absolute, or a child of the shell's `/`; a catch-all or a param-first pattern answers to everything, so it says nothing.
const appRoutes = pathsIn(readFileSync(join(root, APP_ROUTER), "utf8"))
    .map((path) => (path.startsWith("/") ? path : `/${path}`))
    .filter((path) => path !== "/" && !path.includes("(.*)") && !path.startsWith("/:"));
if (routes.length === 0 || appRoutes.length === 0) {
    cannotMeasure(`contract-paths: no route paths read from ${routes.length === 0 ? CONTRACTS : APP_ROUTER}, so there is nothing to tell a route by`);
}

/* Reading literals out of code, without a parser: comments skipped, a template's substitutions become HOLE, and a `/`
   after an operand is division while anywhere else it opens a regex literal, whose quotes are not strings. */

const scan = (text) => {
    const at = { i: 0, line: 1, operand: false, found: [] };
    const next = () => {
        at.line += text[at.i] === "\n" ? 1 : 0;
        at.i += 1;
    };
    const until = (stop) => {
        while (at.i < text.length && !stop(text[at.i])) {
            next();
        }
    };
    const escaped = () => {
        next();
        const char = text[at.i] ?? "";
        next();
        return char;
    };
    const quoted = (quote) => {
        const line = at.line;
        let value = "";
        next();
        while (at.i < text.length && text[at.i] !== quote && text[at.i] !== "\n") {
            value += text[at.i] === "\\" ? escaped() : text[at.i++];
        }
        next();
        at.found.push({ value, line });
    };
    const template = () => {
        const line = at.line;
        let value = "";
        next();
        while (at.i < text.length && text[at.i] !== "`") {
            if (text[at.i] === "$" && text[at.i + 1] === "{") {
                value += HOLE;
                at.i += 2;
                code(true);
            } else if (text[at.i] === "\\") {
                value += escaped();
            } else {
                value += text[at.i];
                next();
            }
        }
        next();
        at.found.push({ value, line });
    };
    const regex = () => {
        let inClass = false;
        next();
        while (at.i < text.length && text[at.i] !== "\n" && (inClass || text[at.i] !== "/")) {
            inClass = text[at.i] === "[" || (inClass && text[at.i] !== "]");
            at.i += text[at.i] === "\\" ? 2 : 1;
        }
        next();
    };
    const comment = () => {
        if (text[at.i + 1] === "/") {
            until((char) => char === "\n");
            return true;
        }
        if (text[at.i + 1] === "*") {
            at.i += 2;
            until(() => text.startsWith("*/", at.i));
            at.i += 2;
            return true;
        }
        return false;
    };
    const readers = { '"': () => quoted('"'), "'": () => quoted("'"), "`": template };
    // A literal opening here, if any: a quote or backtick, or a `/` where no operand has just ended.
    const literalAt = (char) => readers[char] ?? (char === "/" && !at.operand ? regex : undefined);
    const BRACES = { "{": 1, "}": -1 };
    // One token of code, returning the brace depth after it: -1 once a substitution's own closing brace is passed.
    const token = (depth, inTemplate) => {
        const char = text[at.i];
        if (char === "/" && comment()) {
            return depth;
        }
        const read = literalAt(char);
        if (read !== undefined) {
            read();
            at.operand = true;
            return depth;
        }
        next();
        if (char === "}" && depth === 0) {
            return inTemplate ? -1 : 0;
        }
        at.operand = /\S/.test(char) ? /[\w$)\]]/.test(char) : at.operand;
        return depth + (BRACES[char] ?? 0);
    };
    function code(inTemplate) {
        let depth = 0;
        while (at.i < text.length && depth >= 0) {
            depth = token(depth, inTemplate);
        }
    }
    code(false);
    return at.found;
};

// The code of a file: a Vue component's script blocks, whose template attributes are markup rather than literals.
const codeOf = (path, text) =>
    path.endsWith(".vue") ? [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join("\n") : text;

/* Matching a literal to a route, segment by segment; the query is dropped. */

const isParam = (segment) => (segment.startsWith("{") && segment.endsWith("}")) || segment.startsWith(":");
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A route's literal segment is matched by the same text, or by a partly substituted one that could spell it; a whole
// substitution is a value, so it only ever stands where the route has a parameter.
const spells = (wanted, actual) => {
    if (wanted === actual || isParam(wanted)) {
        return wanted === actual || actual !== "";
    }
    return actual.replaceAll(HOLE, "") !== "" && new RegExp(`^${actual.split(HOLE).map(escape).join(".+")}$`).test(wanted);
};
const pathOf = (value) => value.split("?")[0];
const contractRoute = (value) => {
    const actual = pathOf(value).split("/");
    return routes.find((route) => {
        const wanted = route.split("/");
        return wanted.length === actual.length && wanted.every((segment, index) => spells(segment, actual[index]));
    });
};
// An app route's `:param?` may be absent; any param takes any one segment, since a screen is named by value.
const answersTo = (pattern, value) => {
    const wanted = pattern.split("/");
    const actual = pathOf(value).split("/");
    const required = wanted.filter((segment) => !segment.endsWith("?")).length;
    return (
        actual.length >= required &&
        actual.length <= wanted.length &&
        actual.every((segment, index) => (isParam(wanted[index]) ? segment !== "" : segment === wanted[index]))
    );
};
const isNavigation = (value, line) => !DAEMON_CALL.test(line) && appRoutes.some((pattern) => answersTo(pattern, value));

// Every literal of the code, and every literal inside one: a code sample shipped as a string spells its routes a level
// down, where the file's own scan reads one long string. A nested literal keeps the file's line.
const literalsIn = (text, above = 0) =>
    scan(text).flatMap(({ value, line }) => [{ value, line: above + line }, ...(/["'`]/.test(value) ? literalsIn(value, above + line - 1) : [])]);

const findingsOf = (path) => {
    const text = codeOf(path, readFileSync(join(root, path), "utf8"));
    const lines = text.split("\n");
    return literalsIn(text).flatMap(({ value, line }) => {
        const route = value.startsWith("/") ? contractRoute(value) : undefined;
        return route === undefined || isNavigation(value, lines[line - 1] ?? "") ? [] : [{ at: `${path}:${line}`, route }];
    });
};

const subjects = subjectFiles().filter((path) => SOURCE.test(path) && !TEST_FILE.test(path));
const held = [];
const perFile = new Map();
for (const path of subjects) {
    if (HELD.test(path)) {
        held.push(...findingsOf(path));
    } else if (RATCHETED.test(path)) {
        const findings = findingsOf(path);
        if (findings.length > 0) {
            perFile.set(path, findings);
        }
    }
}

const { grown: over } = ratchet("contract-paths", "contract-paths", new Map([...perFile].map(([path, findings]) => [path, findings.length])));
if (ADOPTING) {
    process.exit(0);
}
const grown = over.flatMap(({ key, count, allowed }) => [
    ...perFile.get(key).map(({ at, route }) => `${at}  spells ${route}`),
    `${key}: ${count} spelled route(s), the baseline allows ${allowed}`,
]);

finish(
    [
        [
            "a contract route spelled as a path where a typed client reaches it: call it through sandboxRpc (or rpcQuery) in the app, api.sandbox.rpc or api.daemon.rpc in an extension",
            held.map(({ at, route }) => `${at}  spells ${route}`),
        ],
        ["an extension spelling more contract routes than _tools/checks/baselines/contract-paths.json allows", grown],
    ],
    [`${routes.length} contract routes, ${subjects.length} files read: none spelled in the app, the extension seed or the site's samples, extensions within their baseline`],
);
