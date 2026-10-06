// The literals a file spells, and which of them name a sandbox contract route (contract-paths.mjs). Read without a
// parser, since the checks run pre-install: comments skipped, a template's substitutions become HOLE, and a `/` after
// an operand is division while anywhere else it opens a regex literal, whose quotes are not strings.
import { allowedAt } from "./allow.mjs";

// Stands for one `${…}` of a template literal: whatever it holds, it is one segment's worth.
export const HOLE = "\u0000";

// A line that hands a literal to the daemon, whatever else it looks like: an extension's backend reaches it as `daemon`.
const DAEMON_CALL = /\bsandbox(Json|Request|Blob|Upload)\w*\s*[<(]|\bpostTurnControl\(|\.(sandbox|daemon)\.(json|request)\s*[<(]/;

/** Every `path: "…"` literal of a contract or router file. */
export const pathsIn = (text) => [...text.matchAll(/\bpath:\s*["'`]([^"'`]*)["'`]/g)].map((match) => match[1]);

export const scan = (text) => {
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
export const codeOf = (path, text) =>
    path.endsWith(".vue") ? [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join("\n") : text;

/* Matching a literal to a route, segment by segment; the query is dropped. */

const isParam = (segment) => (segment.startsWith("{") && segment.endsWith("}")) || segment.startsWith(":");
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A route's literal segment is matched by the same text, or by a partly substituted one that could spell it; a whole
// substitution is a value, so it only ever stands where the route has a parameter, and so is one whose own text is only
// punctuation (`${n}-${name}`, a file name being built), which says nothing of any route.
const spells = (wanted, actual) => {
    if (wanted === actual || isParam(wanted)) {
        return wanted === actual || actual !== "";
    }
    return /[A-Za-z0-9]/.test(actual.replaceAll(HOLE, "")) && new RegExp(`^${actual.split(HOLE).map(escape).join(".+")}$`).test(wanted);
};
const pathOf = (value) => value.split("?")[0];
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

// The path a literal spells: the literal itself when it is absolute, or what follows a leading substitution, which is
// a base the route is joined to (`${target.base}/system/session`, `${origin}/logs/client`).
const spelledPath = (value) => {
    if (value.startsWith("/")) {
        return value;
    }
    return value.startsWith(`${HOLE}/`) ? value.slice(HOLE.length) : undefined;
};

// Every literal of the code, and every literal inside one: a code sample shipped as a string spells its routes a level
// down, where the file's own scan reads one long string. A nested literal keeps the file's line.
const literalsIn = (text, above = 0) =>
    scan(text).flatMap(({ value, line }) => [{ value, line: above + line }, ...(/["'`]/.test(value) ? literalsIn(value, above + line - 1) : [])]);

/**
 * The contract routes `code` spells, each at its 1-based line: `routes` are the contract's paths, `appRoutes` the app's
 * own screens, a literal naming one of which is navigation unless its line hands it to a daemon call. A site that
 * carries `// allow(contract-paths): <reason>` is excused.
 */
export const spelledRoutes = (code, { routes, appRoutes }) => {
    const contractRoute = (path) => {
        const actual = pathOf(path).split("/");
        return routes.find((route) => {
            const wanted = route.split("/");
            return wanted.length === actual.length && wanted.every((segment, index) => spells(segment, actual[index]));
        });
    };
    const isNavigation = (path, line) => !DAEMON_CALL.test(line) && appRoutes.some((pattern) => answersTo(pattern, path));
    const lines = code.split("\n");
    return literalsIn(code).flatMap(({ value, line }) => {
        const path = spelledPath(value);
        const route = path === undefined ? undefined : contractRoute(path);
        if (route === undefined || isNavigation(path, lines[line - 1] ?? "") || allowedAt(lines, line, "contract-paths")) {
            return [];
        }
        return [{ line, route }];
    });
};
