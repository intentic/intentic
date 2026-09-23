import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { packageRoot } from "@intentic/constants/node";
import { unstubbed } from "@intentic/testing";
import { jsExecutionServer } from "../../execution/js-tool.js";
import { createDiagnosticsServer } from "../../logs/diagnostics-tools.js";
import { createDepsServer } from "../../workspace/deps/deps-tools.js";

// Every tool an in-process SDK server defines declares its effect: without annotations the Claude Code binary runs it
// alone and counts it a destructive write. Tools are recognized by the call's shape anywhere in the daemon's source, so
// a server added later is held to this without being named here.

const SOURCE_ROOT = join(packageRoot(import.meta.url), "src");

// A `/` opens a regex only where an expression may begin: after an operator, a bracket, or one of these keywords.
const BEFORE_REGEX = /[(,=:[{!&|?;+\-*%^~<>]/;
const KEYWORD_BEFORE = /\b(?:return|typeof|case|in|of|delete|void|throw|new|yield|await|else|do)\s*$/;
// Stands for a value that just ended, after which a slash divides.
const VALUE_END = ")";

const isComment = (source: string, at: number): boolean => source[at] === "/" && (source[at + 1] === "/" || source[at + 1] === "*");

const commentEnd = (source: string, at: number): number => {
    if (source[at + 1] === "/") {
        const end = source.indexOf("\n", at);
        return end === -1 ? source.length : end;
    }
    const end = source.indexOf("*/", at + 2);
    return end === -1 ? source.length : end + 2;
};

// A newline ends an unterminated quote, so one stray apostrophe cannot swallow the rest of the file.
const quotedEnd = (source: string, at: number): number => {
    let i = at + 1;
    while (i < source.length && source[i] !== source[at] && source[i] !== "\n") {
        i += source[i] === "\\" ? 2 : 1;
    }
    return i + 1;
};

// Unterminated on its line means the slash was a division after all.
const regexEnd = (source: string, at: number): number | undefined => {
    let i = at + 1;
    let inClass = false;
    while (i < source.length && source[i] !== "\n" && (inClass || source[i] !== "/")) {
        if (source[i] === "\\") {
            i += 1;
        } else if (source[i] === "[" || source[i] === "]") {
            inClass = source[i] === "[";
        }
        i += 1;
    }
    return source[i] === "/" ? i + 1 : undefined;
};

// One past the literal or comment opening at `at`, or undefined when none does. `previous` is the last code character
// before it, which is what tells a regex from a division.
const literalEnd = (source: string, at: number, previous: string): number | undefined => {
    const char = source[at];
    if (isComment(source, at)) {
        return commentEnd(source, at);
    }
    if (char === '"' || char === "'") {
        return quotedEnd(source, at);
    }
    if (char === "`") {
        return templateEnd(source, at);
    }
    const opensRegex = previous === "" || BEFORE_REGEX.test(previous) || KEYWORD_BEFORE.test(source.slice(Math.max(0, at - 8), at));
    return char === "/" && opensRegex ? regexEnd(source, at) : undefined;
};

// One past the `}` closing a template's `${`: the expression is walked as code, so a backtick quoted inside it cannot end
// the template.
const interpolationEnd = (source: string, from: number): number => {
    let depth = 0;
    let previous = "{";
    let i = from;
    while (i < source.length) {
        const end = literalEnd(source, i, previous);
        if (end !== undefined) {
            previous = isComment(source, i) ? previous : VALUE_END;
            i = end;
            continue;
        }
        const char = source.charAt(i);
        if (char === "}" && depth === 0) {
            return i + 1;
        }
        depth += char === "{" ? 1 : char === "}" ? -1 : 0;
        previous = /\s/.test(char) ? previous : char;
        i += 1;
    }
    return i;
};

const templateEnd = (source: string, at: number): number => {
    let i = at + 1;
    while (i < source.length && source[i] !== "`") {
        if (source[i] === "\\") {
            i += 2;
        } else if (source.startsWith("${", i)) {
            i = interpolationEnd(source, i + 2);
        } else {
            i += 1;
        }
    }
    return i + 1;
};

const blank = (text: string): string => text.replace(/[^\n]/g, " ");

// The source with comments blanked to spaces and every string, template and regex blanked inside its delimiters, newlines
// kept: offsets and brackets stay true, a literal still reads as an argument, and a comma or a parenthesis inside prose
// is never read as code.
const codeOf = (source: string): string => {
    let code = "";
    let previous = "";
    let i = 0;
    while (i < source.length) {
        const end = literalEnd(source, i, previous);
        if (end === undefined) {
            const char = source.charAt(i);
            code += char;
            previous = /\s/.test(char) ? previous : char;
            i += 1;
            continue;
        }
        const literal = source.slice(i, end);
        const comment = isComment(source, i);
        code += comment || literal.length < 2 ? blank(literal) : `${literal.charAt(0)}${blank(literal.slice(1, -1))}${literal.slice(-1)}`;
        previous = comment ? previous : VALUE_END;
        i = end;
    }
    return code;
};

const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);

// Each top-level argument of the call whose `(` sits at `open`, as offsets into the code.
const argumentsOf = (code: string, open: number): { readonly start: number; readonly end: number }[] => {
    const spans: { readonly start: number; readonly end: number }[] = [];
    let depth = 0;
    let start = open + 1;
    for (let i = open + 1; i < code.length; i += 1) {
        const char = code.charAt(i);
        if (OPENERS.has(char)) {
            depth += 1;
        } else if (CLOSERS.has(char) && depth > 0) {
            depth -= 1;
        } else if (char === ")" || (char === "," && depth === 0)) {
            if (code.slice(start, i).trim() !== "") {
                spans.push({ start, end: i });
            }
            if (char === ")") {
                return spans;
            }
            start = i + 1;
        }
    }
    return spans;
};

// The SDK's tool(name, description, shape, handler, extras), reached through sdk() or any value bound to it.
const TOOL_CALL = /\.\s*tool\s*(?:<[^()]*>)?\s*\(/g;
const SERVER_CALL = /\bcreateSdkMcpServer\s*\(/;
// Extras giving the effect in the shared vocabulary, which spells out both hints: an absent destructiveHint reads as true.
const DECLARES = /\bannotations\s*:[\s\S]*\btoolAnnotations\s*\(/;

interface ToolDefinition {
    // Source-relative path and line of the call.
    readonly at: string;
    readonly name: string;
    readonly declared: boolean;
}

const definitionsIn = (file: string, source: string): ToolDefinition[] => {
    const code = codeOf(source);
    return [...code.matchAll(TOOL_CALL)].map((match) => {
        const [name, , , , extras] = argumentsOf(code, match.index + match[0].length - 1);
        return {
            at: `${file}:${source.slice(0, match.index).split("\n").length}`,
            name:
                name === undefined
                    ? ""
                    : source
                          .slice(name.start, name.end)
                          .trim()
                          .replace(/^["'`]|["'`]$/g, ""),
            declared: extras !== undefined && DECLARES.test(code.slice(extras.start, extras.end)),
        };
    });
};

const sourceFiles = async (dir: string): Promise<string[]> => {
    const entries = await readdir(dir, { withFileTypes: true });
    const found = await Promise.all(
        entries.map(async (entry) => {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) {
                return sourceFiles(path);
            }
            return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
        }),
    );
    return found.flat();
};

// Every module that builds an SDK server, and every SDK tool defined anywhere, read in one batch.
const scan = async (): Promise<{ readonly servers: readonly string[]; readonly tools: readonly ToolDefinition[] }> => {
    const modules = await Promise.all(
        (await sourceFiles(SOURCE_ROOT)).map(async (path) => ({ file: relative(SOURCE_ROOT, path), source: await readFile(path, "utf8") })),
    );
    // A text prefilter only; both shapes are matched on the code alone.
    const candidates = modules.filter(({ source }) => /\btool\b|createSdkMcpServer/.test(source));
    return {
        servers: candidates.filter(({ source }) => SERVER_CALL.test(codeOf(source))).map(({ file }) => file),
        tools: candidates.flatMap(({ file, source }) => definitionsIn(file, source)),
    };
};

test("every tool an SDK server defines passes its effect as annotations", async () => {
    const { servers, tools } = await scan();
    expect(tools.length, "the scan recognized no SDK tool at all: the source root or the call's shape moved").toBeGreaterThan(0);
    expect(
        servers.filter((file) => !tools.some((tool) => tool.at.startsWith(`${file}:`))),
        "These modules build an SDK server whose tools this scan cannot see: define them with sdk().tool(…) in the same module.",
    ).toEqual([]);
    expect(
        tools.filter((tool) => !tool.declared).map((tool) => `${tool.at} ${tool.name}`),
        "These SDK tools declare no effect. Pass `{ annotations: toolAnnotations(effect) }` (@intentic/sandbox-contract/peer-mcp-server) as " +
            "tool()'s fifth argument: `read` changes nothing and may run beside other reads, `write` changes something recoverable, " +
            "`destructive` may lose something.",
    ).toEqual([]);
});

// The scanner's own edge: prose full of commas and parentheses, a backtick quoted inside a template's expression and a
// regex holding a quote must not shift an argument, and a commented-out call is not a call.
test("a tool call is read by its arguments, not by the prose inside them", () => {
    const source = [
        'const a = sdk().tool("plain", "one, two (three", {}, async () => ok(`${flag ? "`x`" : "y"}, z`));',
        'const b = sdk().tool("marked", /"[,(]/.source, {}, handler, { annotations: toolAnnotations("read") });',
        '// sdk().tool("commented", "d", {}, handler)',
        'const c = claude.tool("hand-written", "d", {}, handler, { annotations: { readOnlyHint: true } });',
    ].join("\n");
    expect(definitionsIn("fixture.ts", source)).toEqual([
        { at: "fixture.ts:1", name: "plain", declared: false },
        { at: "fixture.ts:2", name: "marked", declared: true },
        { at: "fixture.ts:4", name: "hand-written", declared: false },
    ]);
});

// What McpServer keeps per tool and answers tools/list from; private to it, hence the cast.
const annotationsOf = (server: McpSdkServerConfigWithInstance, name: string): unknown => {
    const registry = server.instance as unknown as { _registeredTools: Record<string, { readonly annotations?: unknown }> };
    return registry["_registeredTools"][name]?.annotations;
};

test("the SDK carries each declared effect into what tools/list answers", () => {
    const signal = new AbortController().signal;
    expect(annotationsOf(createDiagnosticsServer({ historyRoot: SOURCE_ROOT, usage: unstubbed("usage", {}) }), "errors")).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
    });
    // A write has to say it is not destructive, or the runtime reads it as one.
    expect(
        annotationsOf(createDepsServer({ dependencies: unstubbed("dependencies", {}), canInstall: true, origin: { kind: "request" } }), "install"),
    ).toEqual({ readOnlyHint: false, destructiveHint: false });
    const plan = { cwd: SOURCE_ROOT, env: {}, readRoots: [], writeRoots: [], allowSpawn: false };
    expect(annotationsOf(jsExecutionServer({ plan, placement: undefined, signal }), "run")).toEqual({ readOnlyHint: false, destructiveHint: true });
});
