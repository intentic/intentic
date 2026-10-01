// What an answer claims about the workspace, read out of its markdown: the paths it cites (with any line anchors), the
// identifiers its code spans name, and the calls and imports in its fenced code. Pure text in, references out: nothing
// here knows the workspace, so the checks in check.ts decide what is grounded.

export interface PathRef {
    readonly kind: "path";
    // 1-based line of the answer the reference sits on, which is what an issue points back to.
    readonly line: number;
    readonly raw: string;
    readonly path: string;
    readonly start?: number;
    readonly end?: number;
}

export interface NameRef {
    readonly kind: "name";
    readonly line: number;
    readonly raw: string;
    // The last segment of a dotted or `::` chain: `Option.resolve_envvar_value` is checked as `resolve_envvar_value`.
    readonly name: string;
    // From fenced code (a call or an import) rather than a prose code span; code spans also anchor drift checks.
    readonly inCode: boolean;
    // A plain lowercase word in backticks (`settle`, `pack`): too often prose to call unknown, but beside an anchor it
    // still says where the anchor should point, so it feeds the drift check only.
    readonly plain?: true;
}

export type Reference = PathRef | NameRef;

// Extensions a bare `name.ext` (no directory) must carry to be read as a file rather than a dotted identifier.
const FILE_EXTENSIONS = new Set(
    (
        "ts tsx mts cts js jsx mjs cjs py pyi go rs java kt kts rb php cs swift scala dart c h cc cpp hpp cxx m mm vue svelte astro " +
        "md mdx rst txt json jsonc yaml yml toml ini sql sh bash zsh ps1 css scss sass less html htm xml gradle lua ex exs erl r jl"
    ).split(" "),
);

// A segment may be a dot-directory (`.github`); the leaf is `name.ext` or a dotfile (`.env`, `.gitignore`).
const SEGMENT = String.raw`\.?[\w@+-][\w@.+-]*`;
const LEAF = String.raw`(?:${SEGMENT}\.[A-Za-z][A-Za-z0-9]{0,9}|\.[\w][\w.-]*)`;
const PATH_BODY = String.raw`(?:~?\/|\.{1,2}\/)?(?:${SEGMENT}\/)*${LEAF}`;
const ANCHOR_TAIL = String.raw`(?::(\d+)(?:\s*[-–]\s*(\d+))?|#L(\d+)(?:-L?(\d+))?)?`;
const PATH_SPAN = new RegExp(String.raw`^(${PATH_BODY})${ANCHOR_TAIL}$`);
// Prose paths outside code spans must name a directory: a bare `index.ts` in a sentence is too often not a citation.
const PROSE_PATH = new RegExp(String.raw`(?<![\w/.@-])((?:~?\/|\.{1,2}\/)?(?:${SEGMENT}\/)+${LEAF})${ANCHOR_TAIL}`, "g");
const BARE_ANCHOR = /^:(\d+)(?:\s*[-–]\s*(\d+))?$/;
const LINES_PHRASE = /\blines?\s+(\d+)(?:\s*(?:[-–]|to)\s*(\d+))?/gi;
const CHAIN = String.raw`[A-Za-z_$][\w$]*(?:(?:\.|::|#)[A-Za-z_$][\w$]*)*`;
const NAME_SPAN = new RegExp(String.raw`^(${CHAIN})(?:\(\))?$`);
const CALL_SPAN = new RegExp(String.raw`^(${CHAIN})\(.*\)$`);
const PATH_SYMBOL_SPAN = new RegExp(String.raw`^(${PATH_BODY})::(${CHAIN})$`);
// Go's method-with-receiver form, `(*node).insertChild` or `(Engine).Run`.
const RECEIVER_SPAN = /^\(\*?[A-Za-z_]\w*\)\.([A-Za-z_]\w*)(?:\(.*\))?$/;

// Words a code span holds that are values or keywords, never a workspace symbol.
const NOT_NAMES = new Set(
    (
        "true false null undefined none nil void this self super new delete typeof instanceof async await yield return if else " +
        "for while do switch case break continue try catch finally throw class def function fn func let const var import export " +
        "from as in of is not and or with pass lambda raise struct enum impl trait pub mod use static final public private " +
        "protected interface type extends implements package go defer chan select map range print println len str int float bool " +
        "list dict set tuple object string number boolean any unknown never symbol bigint require module exports default"
    ).split(" "),
);

const isFileLike = (path: string): boolean => {
    if (path.includes("/") || /^\.[\w]/.test(path)) {
        return true;
    }
    const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
    return FILE_EXTENSIONS.has(ext);
};

// A code span is taken as a symbol only when it looks like one: a call, a chain, snake_case, camelCase, PascalCase or a
// CONSTANT. A plain lowercase word (`size`, `etag`) is as likely prose in backticks, and checking it proves nothing.
const looksLikeSymbol = (chain: string, called: boolean): boolean => {
    const last = lastSegment(chain);
    if (NOT_NAMES.has(last.toLowerCase()) && !called) {
        return false;
    }
    if (called || /[.:#]/.test(chain)) {
        return last.length >= 2;
    }
    return (
        (last.includes("_") && last.replace(/_/g, "").length >= 2) ||
        /[a-z][A-Z]/.test(last) ||
        /^[A-Z][a-z0-9]+[A-Z]/.test(last) ||
        /^[A-Z][A-Z0-9_]{2,}$/.test(last) ||
        /^[A-Z][a-z]{3,}$/.test(last)
    );
};

const lastSegment = (chain: string): string => chain.split(/\.|::|#/).at(-1)!;

const numberOr = (...values: (string | undefined)[]): number | undefined => {
    const found = values.find((value) => value !== undefined);
    return found === undefined ? undefined : Number(found);
};

const pathRef = (line: number, raw: string, path: string, start?: number, end?: number): PathRef => ({
    kind: "path",
    line,
    raw,
    path,
    ...(start !== undefined ? { start } : {}),
    ...(end !== undefined && start !== undefined && end > start ? { end } : {}),
});

// Code languages whose blocks are not source the workspace could define: shell transcripts, data and diffs.
const NON_CODE_FENCES = new Set([
    "sh",
    "bash",
    "zsh",
    "shell",
    "console",
    "text",
    "txt",
    "plaintext",
    "diff",
    "json",
    "jsonc",
    "yaml",
    "yml",
    "toml",
    "ini",
    "sql",
    "log",
    "output",
    "markdown",
    "md",
]);

const CODE_CALL = /(?<![\w$])([A-Za-z_$][\w$]*)\s*\(/g;
const CODE_DEFINES = /\b(?:def|function|class|fn|func|interface|type|struct|enum|const|let|var|val)\s+\*?\s*([A-Za-z_$][\w$]*)/g;
const PY_IMPORT = /^\s*from\s+[\w.]+\s+import\s+\(?([\w\s,]+)\)?/;
const JS_IMPORT = /^\s*import\s+(?:type\s+)?\{([^}]*)\}\s+from\s/;

// Calls and imported names in one fenced block, minus what the block defines itself (proposed code may define and then
// call a new function in the same breath).
const codeNames = (lines: readonly { text: string; line: number }[]): NameRef[] => {
    const defined = new Set<string>();
    for (const { text } of lines) {
        for (const match of text.matchAll(CODE_DEFINES)) {
            defined.add(match[1]!);
        }
    }
    const refs: NameRef[] = [];
    const push = (line: number, raw: string, name: string): void => {
        if (name.length >= 2 && !defined.has(name) && !NOT_NAMES.has(name.toLowerCase())) {
            refs.push({ kind: "name", line, raw, name, inCode: true });
        }
    };
    for (const { text, line } of lines) {
        const imported = PY_IMPORT.exec(text)?.[1] ?? JS_IMPORT.exec(text)?.[1];
        if (imported !== undefined) {
            for (const part of imported.split(",")) {
                const name = part
                    .trim()
                    .replace(/^type\s+/, "")
                    .split(/\s+as\s+/)[0]!
                    .trim();
                if (/^[A-Za-z_$][\w$]*$/.test(name)) {
                    push(line, name, name);
                }
            }
            continue;
        }
        // Comments and strings say nothing about what exists.
        const code = text.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""').replace(/(\/\/|#).*$/, "");
        for (const match of code.matchAll(CODE_CALL)) {
            push(line, `${match[1]}()`, match[1]!);
        }
    }
    return refs;
};

export const extractReferences = (text: string): Reference[] => {
    const refs: Reference[] = [];
    const lines = text.split("\n");
    let fence: { lang: string; lines: { text: string; line: number }[] } | undefined;
    lines.forEach((content, index) => {
        const line = index + 1;
        const fenceMark = /^\s*(```|~~~)\s*([\w+-]*)/.exec(content);
        if (fenceMark !== null) {
            if (fence === undefined) {
                fence = { lang: fenceMark[2]!.toLowerCase(), lines: [] };
            } else {
                if (!NON_CODE_FENCES.has(fence.lang)) {
                    refs.push(...codeNames(fence.lines));
                }
                fence = undefined;
            }
            return;
        }
        if (fence !== undefined) {
            fence.lines.push({ text: content, line });
            return;
        }
        const linePaths: PathRef[] = [];
        const addPath = (ref: PathRef): void => {
            linePaths.push(ref);
            refs.push(ref);
        };
        for (const span of content.matchAll(/`([^`\n]+)`/g)) {
            const body = span[1]!.trim();
            const bare = BARE_ANCHOR.exec(body);
            if (bare !== null) {
                const previous = linePaths.at(-1);
                if (previous !== undefined) {
                    addPath(pathRef(line, body, previous.path, Number(bare[1]), numberOr(bare[2])));
                }
                continue;
            }
            const pathSymbol = PATH_SYMBOL_SPAN.exec(body);
            if (pathSymbol !== null) {
                addPath(pathRef(line, body, pathSymbol[1]!));
                refs.push({ kind: "name", line, raw: body, name: lastSegment(pathSymbol[2]!), inCode: false });
                continue;
            }
            const path = PATH_SPAN.exec(body);
            if (path !== null && isFileLike(path[1]!)) {
                addPath(pathRef(line, body, path[1]!, numberOr(path[2], path[4]), numberOr(path[3], path[5])));
                continue;
            }
            const receiver = RECEIVER_SPAN.exec(body);
            if (receiver !== null) {
                refs.push({ kind: "name", line, raw: body, name: receiver[1]!, inCode: false });
                continue;
            }
            const call = CALL_SPAN.exec(body);
            const name = NAME_SPAN.exec(body);
            const chain = name?.[1] ?? call?.[1];
            if (chain !== undefined && looksLikeSymbol(chain, call !== null || body.endsWith("()"))) {
                refs.push({ kind: "name", line, raw: body, name: lastSegment(chain), inCode: false });
            } else if (name !== null && /^[a-z][a-z0-9]{2,}$/.test(body) && !NOT_NAMES.has(body)) {
                refs.push({ kind: "name", line, raw: body, name: body, inCode: false, plain: true });
            }
        }
        // Paths written as plain prose, outside any code span.
        const prose = content.replace(/`[^`\n]+`/g, (span) => " ".repeat(span.length));
        for (const match of prose.matchAll(PROSE_PATH)) {
            addPath(pathRef(line, match[0], match[1]!, numberOr(match[2], match[4]), numberOr(match[3], match[5])));
        }
        // "…/index.ts, lines 81–94": a range written out in words belongs to the path cited just before it on the line.
        for (const match of content.matchAll(LINES_PHRASE)) {
            const before = linePaths.findLast((ref) => content.indexOf(ref.raw) < (match.index ?? 0));
            if (before !== undefined) {
                addPath(pathRef(line, match[0], before.path, Number(match[1]), numberOr(match[2])));
            }
        }
    });
    return refs;
};
