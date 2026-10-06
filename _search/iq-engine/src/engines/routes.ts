// App routes as a router declares them. The owner names editor screens by their address ("/sandbox/agent?section=tools")
// in about a third of his asks, and a bare iq query for one matched file names instead (AGENTS.md for `/agents`). This
// reads route tables from source, joins nested paths, and matches an address against them, without knowing any app's
// routes in advance.

export interface RouteDecl {
    // The full path, parents joined: `/sandbox/:tab?` for a child `sandbox/:tab?` under `/`.
    readonly pattern: string;
    // The line its `path` is written on.
    readonly line: number;
    // What it loads: an import specifier (`../features/agents/Agents.vue`) or a component identifier, and its line.
    readonly component?: { readonly line: number; readonly spec: string; readonly kind: "import" | "identifier" };
    // A route that only sends elsewhere; it matches, but it is not where the screen is built.
    readonly redirect: boolean;
}

interface Prop {
    readonly key: string;
    readonly line: number;
    // Offsets of the value: from after the colon to the comma or brace that ends it.
    readonly from: number;
    to: number;
}

interface ObjectFrame {
    readonly kind: "{";
    readonly parent: ObjectFrame | undefined;
    readonly props: Prop[];
    // A key may start here: just after `{` or a `,` at this depth.
    keyAllowed: boolean;
    path?: { readonly value: string; readonly line: number };
}

interface OtherFrame {
    readonly kind: "[" | "(";
    readonly parent: ObjectFrame | undefined;
}

type Frame = ObjectFrame | OtherFrame;

const ROUTE_KEYS = new Set(["path", "component", "components", "element", "Component", "lazy", "loadComponent", "redirect"]);
const COMPONENT_KEYS = ["component", "components", "element", "Component", "lazy", "loadComponent"] as const;

const IDENT_START = /[A-Za-z_$]/;
const IDENT = /[\w$]/;
// After one of these a `/` opens a regex literal rather than dividing.
const REGEX_PRECEDES = new Set([
    "",
    "(",
    ",",
    "=",
    ":",
    "[",
    "!",
    "&",
    "|",
    "?",
    "{",
    "}",
    ";",
    "+",
    "-",
    "*",
    "%",
    "<",
    ">",
    "~",
    "^",
    "return",
    "typeof",
    "case",
    "in",
    "of",
    "void",
    "yield",
    "await",
    "delete",
    "new",
]);

// The object literals in a source file that have a string `path`, with their parents: a small scanner that skips
// strings, template literals, comments and regex literals and tracks bracket depth. Not a parser: it reads route tables
// as they are written (vue-router, react-router's data routers, Angular's `Routes`), and anything else simply yields no
// routes.
export const routeTable = (text: string): RouteDecl[] => {
    const stack: Frame[] = [];
    const objects: { frame: ObjectFrame; from: number; to: number }[] = [];
    let line = 1;
    let at = 0;
    let last = "";
    const length = text.length;
    const top = (): Frame | undefined => stack.at(-1);
    const nearestObject = (): ObjectFrame | undefined => {
        for (let index = stack.length - 1; index >= 0; index -= 1) {
            const frame = stack[index]!;
            if (frame.kind === "{") {
                return frame;
            }
        }
        return undefined;
    };
    const endProp = (frame: ObjectFrame, offset: number): void => {
        const open = frame.props.at(-1);
        if (open !== undefined && open.to === -1) {
            open.to = offset;
        }
    };
    // Reads a quoted string or a template literal starting at `at`; returns its text when it has no interpolation.
    const literal = (): string | undefined => {
        const quote = text[at]!;
        at += 1;
        let out = "";
        let plain = true;
        while (at < length) {
            const char = text[at]!;
            if (char === "\\") {
                out += text[at + 1] ?? "";
                at += 2;
                continue;
            }
            if (char === "\n") {
                line += 1;
                if (quote !== "`") {
                    return undefined;
                }
            }
            if (char === quote) {
                at += 1;
                return plain ? out : undefined;
            }
            if (quote === "`" && char === "$" && text[at + 1] === "{") {
                // Interpolation: skip to its matching brace, strings and nested templates included.
                plain = false;
                at += 2;
                let depth = 1;
                while (at < length && depth > 0) {
                    const inner = text[at]!;
                    if (inner === "\n") {
                        line += 1;
                    }
                    if (inner === "'" || inner === '"' || inner === "`") {
                        literal();
                        continue;
                    }
                    depth += inner === "{" ? 1 : inner === "}" ? -1 : 0;
                    at += 1;
                }
                continue;
            }
            out += char;
            at += 1;
        }
        return undefined;
    };
    while (at < length) {
        const char = text[at]!;
        if (char === "\n") {
            line += 1;
            at += 1;
            continue;
        }
        if (char === " " || char === "\t" || char === "\r") {
            at += 1;
            continue;
        }
        if (char === "/" && text[at + 1] === "/") {
            while (at < length && text[at] !== "\n") {
                at += 1;
            }
            continue;
        }
        if (char === "/" && text[at + 1] === "*") {
            const end = text.indexOf("*/", at + 2);
            const stop = end === -1 ? length : end + 2;
            for (let index = at; index < stop; index += 1) {
                if (text[index] === "\n") {
                    line += 1;
                }
            }
            at = stop;
            continue;
        }
        if (char === "/" && REGEX_PRECEDES.has(last)) {
            // A regex literal: to the closing slash outside a character class.
            at += 1;
            let inClass = false;
            while (at < length && text[at] !== "\n") {
                const inner = text[at]!;
                if (inner === "\\") {
                    at += 2;
                    continue;
                }
                if (inner === "[") {
                    inClass = true;
                } else if (inner === "]") {
                    inClass = false;
                } else if (inner === "/" && !inClass) {
                    break;
                }
                at += 1;
            }
            at += 1;
            last = "/re";
            continue;
        }
        if (char === "'" || char === '"' || char === "`") {
            const frame = top();
            const startLine = line;
            const value = literal();
            // A quoted key: `"path": "..."`.
            if (frame?.kind === "{" && frame.keyAllowed && /^\s*:/.test(text.slice(at, at + 8)) && value !== undefined) {
                const colon = text.indexOf(":", at);
                frame.props.push({ key: value, line: startLine, from: colon + 1, to: -1 });
                frame.keyAllowed = false;
                at = colon + 1;
                last = ":";
                continue;
            }
            const open = frame?.kind === "{" ? frame.props.at(-1) : undefined;
            if (frame?.kind === "{" && open?.key === "path" && open.to === -1 && frame.path === undefined && value !== undefined && last === ":") {
                frame.path = { value, line: startLine };
            }
            last = "str";
            continue;
        }
        if (IDENT_START.test(char)) {
            let end = at + 1;
            while (end < length && IDENT.test(text[end]!)) {
                end += 1;
            }
            const word = text.slice(at, end);
            const frame = top();
            const after = /^[ \t]*:(?!:)/.exec(text.slice(end, end + 8));
            if (frame?.kind === "{" && frame.keyAllowed && after !== null) {
                const colon = end + after[0].length;
                frame.props.push({ key: word, line, from: colon, to: -1 });
                frame.keyAllowed = false;
                at = colon;
                last = ":";
                continue;
            }
            at = end;
            last = word;
            continue;
        }
        if (char === "{") {
            const frame: ObjectFrame = { kind: "{", parent: nearestObject(), props: [], keyAllowed: true };
            stack.push(frame);
            objects.push({ frame, from: at, to: -1 });
            at += 1;
            last = "{";
            continue;
        }
        if (char === "[" || char === "(") {
            stack.push({ kind: char === "[" ? "[" : "(", parent: nearestObject() });
            at += 1;
            last = char;
            continue;
        }
        if (char === "}" || char === "]" || char === ")") {
            const frame = stack.pop();
            if (frame?.kind === "{") {
                endProp(frame, at);
                const record = objects.find((object) => object.frame === frame);
                if (record !== undefined) {
                    record.to = at;
                }
            }
            at += 1;
            last = char;
            continue;
        }
        if (char === ",") {
            const frame = top();
            if (frame?.kind === "{") {
                endProp(frame, at);
                frame.keyAllowed = true;
            }
            at += 1;
            last = ",";
            continue;
        }
        at += 1;
        last = char;
    }
    const lineAt = (offset: number): number => {
        let count = 1;
        for (let index = 0; index < offset && index < length; index += 1) {
            if (text.charCodeAt(index) === 10) {
                count += 1;
            }
        }
        return count;
    };
    const fullPath = (frame: ObjectFrame): string => {
        const own = frame.path?.value ?? "";
        if (own.startsWith("/")) {
            return own;
        }
        let parent = frame.parent;
        while (parent !== undefined && parent.path === undefined) {
            parent = parent.parent;
        }
        const base = parent === undefined ? "" : fullPath(parent);
        const joined = `${base.replace(/\/+$/, "")}/${own}`;
        return joined === "/" ? "/" : joined.replace(/\/+$/, "") || "/";
    };
    const routes: RouteDecl[] = [];
    for (const { frame } of objects) {
        // A route loads something, redirects, or holds child routes; a bare `{ path, query }` is a link target.
        if (frame.path === undefined || !frame.props.some((prop) => (ROUTE_KEYS.has(prop.key) && prop.key !== "path") || prop.key === "children")) {
            continue;
        }
        const componentProp = frame.props.find((prop) => (COMPONENT_KEYS as readonly string[]).includes(prop.key));
        const component = componentProp === undefined ? undefined : componentOf(text.slice(componentProp.from, componentProp.to === -1 ? undefined : componentProp.to));
        routes.push({
            pattern: fullPath(frame),
            line: frame.path.line,
            ...(component !== undefined && componentProp !== undefined
                ? {
                      component: {
                          spec: component.spec,
                          kind: component.kind,
                          // The import's own line: a wrapped lazy import can sit lines below its `component:` key.
                          line: component.offset === undefined ? componentProp.line : lineAt(componentProp.from + component.offset),
                      },
                  }
                : {}),
            redirect: frame.props.some((prop) => prop.key === "redirect") && componentProp === undefined,
        });
    }
    return routes.toSorted((a, b) => a.line - b.line);
};

// The view a component property loads: a lazy `import('…')` anywhere in its value (wrapped or not), else the first
// component identifier or JSX tag.
const componentOf = (value: string): { spec: string; kind: "import" | "identifier"; offset?: number } | undefined => {
    const lazy = /import\(\s*[`'"]([^`'"$]+)[`'"]\s*\)/.exec(value);
    if (lazy !== null) {
        return { spec: lazy[1]!, kind: "import", offset: lazy.index };
    }
    const named = /^\s*<?\s*([A-Z][\w$]*)/.exec(value);
    return named === null ? undefined : { spec: named[1]!, kind: "identifier" };
};

// JSX route elements, `<Route path="/agents" element={<Agents />} />`: the flat form only, read line by line.
export const jsxRoutes = (text: string): RouteDecl[] =>
    text.split("\n").flatMap((source, index): RouteDecl[] => {
        // A comment describing the form is not a route.
        if (/^\s*(?:\/\/|\/\*|\*)/.test(source)) {
            return [];
        }
        const match = /<Route\b[^>]*\bpath=["'{`]+([^"'}`]+)["'}`]+/.exec(source);
        if (match === null) {
            return [];
        }
        const element = /\b(?:element|component)=\{?\s*<?\s*([A-Z][\w$]*)/.exec(source);
        return [
            {
                pattern: match[1]!.startsWith("/") ? match[1]! : `/${match[1]!}`,
                line: index + 1,
                ...(element !== null ? { component: { line: index + 1, spec: element[1]!, kind: "identifier" as const } } : {}),
                redirect: false,
            },
        ];
    });

// ---- matching an address ----

export interface RouteAddress {
    // `/sandbox/agent`, decoded, no trailing slash.
    readonly path: string;
    readonly segments: readonly string[];
    // `?section=tools`, in the order written.
    readonly query: readonly (readonly [string, string])[];
}

// An address as the browser shows it: a leading slash, no whitespace, optionally a query and a hash. A last segment with
// a file extension is a file path, not a screen.
export const parseRouteAddress = (query: string): RouteAddress | undefined => {
    const trimmed = query.trim();
    if (!/^\/[^\s]*$/.test(trimmed) || trimmed.startsWith("//")) {
        return undefined;
    }
    let url: URL;
    try {
        url = new URL(trimmed, "http://route.invalid");
    } catch {
        return undefined;
    }
    const segments = url.pathname
        .split("/")
        .filter((segment) => segment !== "")
        .map((segment) => {
            try {
                return decodeURIComponent(segment);
            } catch {
                return segment;
            }
        });
    if (/\.[A-Za-z][A-Za-z0-9]{0,4}$/.test(segments.at(-1) ?? "")) {
        return undefined;
    }
    return { path: `/${segments.join("/")}`, segments, query: [...url.searchParams.entries()] };
};

export interface CompiledRoute {
    readonly regex: RegExp;
    readonly params: readonly string[];
    // Literal segments: an address matching more of them matches a more specific route.
    readonly statics: number;
    // `/:pathMatch(.*)*` and friends: matches anything, so it answers nothing.
    readonly catchAll: boolean;
}

const escapeRegExp = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

// vue-router's and react-router's path syntax: `:name`, `:name?` / `:name*` / `:name+`, `:name(regex)`, and `*` splats.
export const compileRoute = (pattern: string): CompiledRoute => {
    const params: string[] = [];
    let statics = 0;
    let catchAll = false;
    let source = "";
    for (const segment of pattern.split("/").filter((part) => part !== "")) {
        const param = /^:([\w$]+)(?:\(((?:[^()]|\([^()]*\))*)\))?([?*+])?$/.exec(segment);
        if (param !== null) {
            params.push(param[1]!);
            // Its own groups made non-capturing, so the capture index of each parameter stays its position.
            const inner = param[2] === undefined ? "[^/]+" : param[2].replaceAll(/\((?!\?)/g, "(?:");
            const modifier = param[3];
            const wide = inner === ".*" || inner === ".+" || modifier === "*" || modifier === "+";
            catchAll ||= wide && statics === 0 && pattern.split("/").filter((part) => part !== "").length === 1;
            if (modifier === "?" || modifier === "*") {
                source += `(?:/(${wide ? ".*" : inner}))?`;
            } else {
                source += `/(${wide ? ".+" : inner})`;
            }
            continue;
        }
        if (segment === "*" || segment === "**") {
            params.push("*");
            catchAll ||= statics === 0;
            source += "(?:/(.*))?";
            continue;
        }
        statics += 1;
        source += `/${escapeRegExp(segment)}`;
    }
    return { regex: new RegExp(`^${source === "" ? "/?" : `${source}/?`}$`, "i"), params, statics, catchAll };
};

export interface RouteMatch {
    readonly route: RouteDecl;
    // Parameter values in pattern order; an optional one left out is absent.
    readonly values: readonly (readonly [string, string])[];
    readonly statics: number;
}

// The routes an address matches, most specific first: most literal segments, then fewest parameters. A catch-all never
// counts, since it matches every address and sends it home.
export const matchRoutes = (routes: readonly RouteDecl[], address: RouteAddress): RouteMatch[] => {
    const matches: RouteMatch[] = [];
    for (const route of routes) {
        const compiled = compileRoute(route.pattern);
        if (compiled.catchAll) {
            continue;
        }
        const found = compiled.regex.exec(address.path);
        if (found === null) {
            continue;
        }
        const values = compiled.params.flatMap((name, index): (readonly [string, string])[] => {
            const value = found[index + 1];
            return value === undefined || value === "" ? [] : [[name, value] as const];
        });
        matches.push({ route, values, statics: compiled.statics });
    }
    return matches.toSorted((a, b) => b.statics - a.statics || a.values.length - b.values.length || Number(a.route.redirect) - Number(b.route.redirect));
};
