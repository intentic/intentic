import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { HookScript, SettingsHook } from "@intentic/sandbox-contract";
import { frontmatterHooks, undefinedIfCliSeesNothing } from "./frontmatter-hooks.js";

/* The hooks Claude Code loads from the user and project sources for one turn (`settingSources: ["user", "project"]`),
 * folded to one sha256: each settings file's and each skill, subagent or command frontmatter's `hooks` as canonical JSON,
 * plus the bytes of every script a hook names by an existing path. What a script reads without being named is outside. */

export interface HookPlace {
    // The CLI's working directory as the turn's namespace sees it; the project's settings file lives under it.
    readonly cwd: string;
    readonly home: string;
    // Claude Code's user config directory: CLAUDE_CONFIG_DIR, else ~/.claude.
    readonly configDir: string;
    // The file the daemon opens for a path the turn's namespace names; the caller owns the namespace's layout.
    readonly readable: (path: string) => string;
}

// The place as the CLI will resolve it: the daemon's own environment is the one the turn's CLI inherits.
export const hookPlaceOf = (cwd: string, readable: (path: string) => string): HookPlace => {
    const home = process.env["HOME"] ?? homedir();
    return { cwd, home, configDir: process.env["CLAUDE_CONFIG_DIR"] ?? join(home, ".claude"), readable };
};

export interface HookSet {
    readonly digest: string;
    readonly hooks: readonly SettingsHook[];
    readonly scripts: readonly HookScript[];
}

type Source = SettingsHook["source"];

// One place a source declares hooks: its settings file, or a definition's frontmatter.
interface Declaration {
    readonly source: Source;
    // The skill, subagent or command file, in the namespace's view; absent for the settings file itself.
    readonly file?: string;
    readonly hooks: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// Keys sorted at every depth, arrays kept in order: a reformatted or reordered file is the same set, a reordered hook
// list is not.
const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) {
        return value.map(canonical);
    }
    if (isRecord(value)) {
        return Object.fromEntries(
            Object.keys(value)
                .toSorted()
                .map((key) => [key, canonical(value[key])]),
        );
    }
    return value;
};

const sha256Text = (text: string): string => createHash("sha256").update(text).digest("hex");

// A settings file's `hooks` value; undefined for a file that is absent or not strict JSON, which Claude Code also
// loads nothing from.
const hooksIn = async (path: string): Promise<unknown> => {
    const text = await readFile(path, "utf8").catch(undefinedIfCliSeesNothing);
    if (text === undefined) {
        return undefined;
    }
    try {
        const parsed: unknown = JSON.parse(text);
        return isRecord(parsed) ? parsed["hooks"] : undefined;
    } catch {
        return undefined;
    }
};

// The path as the approval shows and pins it, the same whichever worktree the turn ran in.
const spelled = (path: string, place: HookPlace): string => {
    const inProject = relative(place.cwd, path);
    if (inProject !== "" && !inProject.startsWith("..") && !isAbsolute(inProject)) {
        return `$CLAUDE_PROJECT_DIR/${inProject}`;
    }
    const inHome = relative(place.home, path);
    return inHome !== "" && !inHome.startsWith("..") && !isAbsolute(inHome) ? `~/${inHome}` : path;
};

// What one hook runs, as the row a person approves: its command line, else its address, script, prompt or tool.
const runOf = (hook: Record<string, unknown>): string => {
    const text = (key: string): string | undefined => (typeof hook[key] === "string" ? hook[key] : undefined);
    const command = text("command");
    if (command !== undefined) {
        const args = Array.isArray(hook["args"]) ? hook["args"].map(String) : [];
        return [command, ...args].join(" ");
    }
    return text("url") ?? text("file") ?? text("script") ?? text("prompt") ?? text("tool") ?? JSON.stringify(canonical(hook));
};

// Every hook a declaration holds, in file order; a piece of unexpected shape becomes a row of its raw JSON rather than
// vanishing, since the CLI may still run it.
const rowsOf = ({ source, file, hooks }: Declaration, place: HookPlace): SettingsHook[] => {
    const where = file === undefined ? { source } : { source, declaredIn: spelled(file, place) };
    const raw = (event: string, value: unknown): SettingsHook => ({ ...where, event, type: "unknown", run: JSON.stringify(canonical(value)) });
    if (hooks === undefined || hooks === null) {
        return [];
    }
    if (!isRecord(hooks)) {
        return [raw("*", hooks)];
    }
    return Object.entries(hooks).flatMap(([event, matchers]) => {
        if (!Array.isArray(matchers)) {
            return [raw(event, matchers)];
        }
        return matchers.flatMap((entry: unknown) => {
            if (!isRecord(entry) || !Array.isArray(entry["hooks"])) {
                return [raw(event, entry)];
            }
            const matcher = typeof entry["matcher"] === "string" && entry["matcher"] !== "" ? entry["matcher"] : undefined;
            return entry["hooks"].map(
                (hook: unknown): SettingsHook =>
                    isRecord(hook)
                        ? {
                              ...where,
                              event,
                              ...(matcher === undefined ? {} : { matcher }),
                              type: typeof hook["type"] === "string" ? hook["type"] : "unknown",
                              run: runOf(hook),
                          }
                        : raw(event, hook),
            );
        });
    });
};

// Every hook object a source declares, for the script scan; the malformed pieces rowsOf shows raw name no file.
const hookObjectsOf = (hooks: unknown): Record<string, unknown>[] =>
    isRecord(hooks)
        ? Object.values(hooks).flatMap((matchers) =>
              Array.isArray(matchers)
                  ? matchers.flatMap((entry: unknown) =>
                        isRecord(entry) && Array.isArray(entry["hooks"]) ? entry["hooks"].filter((hook: unknown) => isRecord(hook)) : [],
                    )
                  : [],
          )
        : [];

// Shell words with the operators kept apart, so a redirection's target is told from an argument.
const TOKEN = /\d*[<>]&\d*-?|\d*>>?|&>>?|<<?<?|&&|\|\|?|[;&()`]|(?:[^\s;&|<>()`"']|"[^"]*"|'[^']*')+/gu;
// A descriptor duplication (`2>&1`): a redirection with no file after it.
const DUPLICATION = /^\d*[<>]&\d*-?$/u;
const REDIRECT = /^(?:\d*>>?|&>>?|<<?<?)$/u;
const OPERATOR = /^(?:&&|\|\|?|[;&()`])$/u;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
// Programs whose first plain argument is what actually runs.
const LAUNCHERS = new Set(["sh", "bash", "zsh", "dash", "node", "bun", "deno", "tsx", "python", "python3", "ruby", "perl", "php", "pwsh", "env", "exec", "nohup"]);
const SCRIPT_NAME = /\.(?:sh|bash|zsh|js|mjs|cjs|ts|mts|cts|py|rb|pl|php|ps1|lua)$/u;

interface Word {
    readonly text: string;
    // In a place a program runs from: a command's first word, or a launcher's first plain argument.
    readonly runs: boolean;
}

interface Position {
    readonly commandStart: boolean;
    readonly launcher: boolean;
}

const COMMAND_START: Position = { commandStart: true, launcher: false };

// One plain word at a position: what it names (itself, and a `--flag=value`'s value), and where the next word stands.
const step = (text: string, at: Position): { readonly words: Word[]; readonly next: Position } => {
    if (at.commandStart && ASSIGNMENT.test(text)) {
        return { words: [], next: at };
    }
    const plain = !text.startsWith("-");
    const equals = text.indexOf("=");
    return {
        words: [{ text, runs: at.commandStart || (at.launcher && plain) }, ...(!plain && equals !== -1 ? [{ text: text.slice(equals + 1), runs: false }] : [])],
        next: { commandStart: false, launcher: at.commandStart ? LAUNCHERS.has(basename(text)) : at.launcher && !plain },
    };
};

// The words of a command line that could name a file. Not a shell parser: a redirection's target is left out (a log
// the hook appends to would otherwise change the digest on every run), and so is anything behind a variable.
const wordsOf = (line: string): Word[] => {
    const words: Word[] = [];
    let at = COMMAND_START;
    let redirected = false;
    for (const token of line.match(TOKEN) ?? []) {
        if (DUPLICATION.test(token)) {
            continue;
        }
        if (REDIRECT.test(token) || OPERATOR.test(token)) {
            redirected = REDIRECT.test(token);
            at = redirected ? at : COMMAND_START;
            continue;
        }
        if (redirected) {
            redirected = false;
            continue;
        }
        const stepped = step(token.replaceAll(/["']/gu, ""), at);
        words.push(...stepped.words);
        at = stepped.next;
    }
    return words;
};

// The candidate words of one hook: its command line, its argv, its script file.
const candidatesOf = (hook: Record<string, unknown>): Word[] => [
    ...(typeof hook["command"] === "string" ? wordsOf(hook["command"]) : []),
    ...(Array.isArray(hook["args"]) ? hook["args"].filter((arg: unknown): arg is string => typeof arg === "string").map((text) => ({ text, runs: false })) : []),
    ...(typeof hook["file"] === "string" ? [{ text: hook["file"], runs: true }] : []),
];

// A word as the path the hook's shell would open, in the namespace's view; undefined behind a variable this can't
// resolve.
const pathOf = (word: string, place: HookPlace): string | undefined => {
    const project = /^\$(?:\{CLAUDE_PROJECT_DIR\}|CLAUDE_PROJECT_DIR\b)/u.exec(word);
    if (project !== null) {
        return join(place.cwd, word.slice(project[0].length));
    }
    const home = /^(?:~(?=\/|$)|\$(?:\{HOME\}|HOME\b))/u.exec(word);
    if (home !== null) {
        return join(place.home, word.slice(home[0].length));
    }
    return word.includes("$") || word.includes("*") ? undefined : resolve(place.cwd, word);
};

const sha256File = async (path: string): Promise<string> => {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) {
        hash.update(chunk as Buffer);
    }
    return hash.digest("hex");
};

// A word that names an existing script: in a place a program runs from, named like a script, or executable. Data a
// hook merely mentions (a log it tees to) stays out, or the approval would never hold.
const scriptOf = async (word: Word, place: HookPlace): Promise<HookScript | undefined> => {
    const path = pathOf(word.text, place);
    if (path === undefined) {
        return undefined;
    }
    const file = place.readable(path);
    const stats = await stat(file).catch(() => undefined);
    if (stats === undefined || !stats.isFile() || !(word.runs || SCRIPT_NAME.test(path) || (stats.mode & 0o111) !== 0)) {
        return undefined;
    }
    // An unreadable script still pins its presence, so it becoming readable later changes the set.
    const sha256 = await sha256File(file).catch(() => "unreadable");
    return { path: spelled(path, place), sha256 };
};

// Every declaration the CLI reads at `place`: the two settings files, then each source's definitions that declare hooks.
const declarationsAt = async (place: HookPlace): Promise<Declaration[]> => {
    const projectRoot = join(place.cwd, ".claude");
    const [user, project, userDefinitions, projectDefinitions] = await Promise.all([
        hooksIn(place.readable(join(place.configDir, "settings.json"))),
        hooksIn(place.readable(join(projectRoot, "settings.json"))),
        frontmatterHooks(place.configDir, place.readable),
        frontmatterHooks(projectRoot, place.readable),
    ]);
    return [
        { source: "user", hooks: user },
        { source: "project", hooks: project },
        ...userDefinitions.map(({ file, hooks }): Declaration => ({ source: "user", file, hooks })),
        ...projectDefinitions.map(({ file, hooks }): Declaration => ({ source: "project", file, hooks })),
    ];
};

// The hooks the CLI would load at `place`, and the one digest an approval pins; undefined when no source declares any.
export const settingsHookSet = async (place: HookPlace): Promise<HookSet | undefined> => {
    const declarations = await declarationsAt(place);
    const hooks = declarations.flatMap((declaration) => rowsOf(declaration, place));
    if (hooks.length === 0) {
        return undefined;
    }
    const found = await Promise.all(declarations.flatMap(({ hooks: declared }) => hookObjectsOf(declared).flatMap(candidatesOf)).map((word) => scriptOf(word, place)));
    const scripts = [...new Map(found.filter((script) => script !== undefined).map((script) => [script.path, script])).values()].toSorted((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
    const digest = sha256Text(
        JSON.stringify(
            canonical({
                sources: declarations.map(({ source, file, hooks: declared }) => [source, file === undefined ? null : spelled(file, place), declared ?? null]),
                scripts: scripts.map((script) => [script.path, script.sha256]),
            }),
        ),
    );
    return { digest, hooks, scripts };
};
