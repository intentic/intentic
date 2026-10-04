import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { HookMarketplace, HookPlugin, HookScript, SettingsHook } from "@intentic/sandbox-contract";
import { frontmatterHooks } from "./frontmatter-hooks.js";
import { enabledPluginsOf, installedPluginDirs, jsonIn, pluginHooks, skillFolderPlugins } from "./plugin-hooks.js";

/* The hooks Claude Code loads for one turn, folded to one sha256: from the user and project sources
 * (`settingSources: ["user", "project"]`) each settings file's and each skill, subagent or command frontmatter's `hooks`
 * as canonical JSON, plus the bytes of every script a hook names by an existing path; and from every plugin the turn
 * loads that the image does not ship, its hooks the same way plus its hooks module's code (plugin-hooks.ts). The
 * settings' `enabledPlugins` and `extraKnownMarketplaces` are in it too, since they make Claude Code install and load
 * plugins of its own. What a script reads without being named is outside.
 *
 * Exempt, decided 2026-10-04: only the plugins baked into the image (iq, webq, the extensions under EXTENSIONS_DIR, and
 * the managed policy plugin, which managed settings load and so never reaches this scan). Nothing in /work can change
 * them, and the image is what the owner runs. Git-installed extensions and plugin
 * connections are pinned to a commit the owner chose, but their checkouts sit under /work/.intentic, which every turn
 * can write, so the pin says what was cloned rather than what the CLI loads; and an extension's install review is of the
 * powers its manifest declares, never of a hooks module. They are hashed like the rest: a plugin declaring no hooks and
 * no module adds nothing, so only one that does asks. */

export interface HookPlace {
    // The CLI's working directory as the turn's namespace sees it; the project's settings file lives under it.
    readonly cwd: string;
    readonly home: string;
    // Claude Code's user config directory: CLAUDE_CONFIG_DIR, else ~/.claude.
    readonly configDir: string;
    // The file the daemon opens for a path the turn's namespace names; the caller owns the namespace's layout.
    readonly readable: (path: string) => string;
    // The plugins the turn mounts that the image does not ship (agent-mounts.ts), as the turn's namespace names them.
    readonly plugins?: readonly MountedPlugin[];
}

export interface MountedPlugin {
    readonly name: string;
    readonly from: "plugin" | "extension" | "persona";
    readonly dir: string;
}

// The place as the CLI will resolve it: the daemon's own environment is the one the turn's CLI inherits.
export const hookPlaceOf = (cwd: string, readable: (path: string) => string, plugins: readonly MountedPlugin[] = []): HookPlace => {
    const home = process.env["HOME"] ?? homedir();
    return { cwd, home, configDir: process.env["CLAUDE_CONFIG_DIR"] ?? join(home, ".claude"), readable, plugins };
};

// A plugin in the set, as the approval lists it (its module's summary is filled in by hook-approvals.ts).
export interface FoundPlugin {
    readonly plugin: Omit<HookPlugin, "module">;
    // Its hooks module, as its hooks.json names it.
    readonly module?: string;
    // The directory as the daemon opens it, for reading what the module does.
    readonly readDir?: string;
}

export interface HookSet {
    readonly digest: string;
    readonly hooks: readonly SettingsHook[];
    readonly scripts: readonly HookScript[];
    readonly plugins: readonly FoundPlugin[];
    readonly marketplaces: readonly HookMarketplace[];
}

type Source = SettingsHook["source"];

// One place a source declares hooks: its settings file, a definition's frontmatter, or a plugin's hooks file.
interface Declaration {
    readonly source: Source;
    // The skill, subagent, command or plugin hooks file, in the namespace's view; absent for the settings file itself.
    readonly file?: string;
    readonly hooks: unknown;
    // The plugin declaring it, by its listed name, and its directory, which ${CLAUDE_PLUGIN_ROOT} names.
    readonly plugin?: { readonly name: string; readonly root: string };
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

// A settings file's keys this reads; empty for a file that is absent or not strict JSON, which Claude Code also loads
// nothing from.
const settingsIn = async (path: string): Promise<Record<string, unknown>> => {
    const parsed = await jsonIn(path);
    return isRecord(parsed) ? parsed : {};
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
const rowsOf = ({ source, file, hooks, plugin }: Declaration, place: HookPlace): SettingsHook[] => {
    const where = { source, ...(plugin === undefined ? {} : { plugin: plugin.name }), ...(file === undefined ? {} : { declaredIn: spelled(file, place) }) };
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
const pathOf = (word: string, place: HookPlace, pluginRoot: string | undefined): string | undefined => {
    const plugin = /^\$(?:\{CLAUDE_PLUGIN_ROOT\}|CLAUDE_PLUGIN_ROOT\b)/u.exec(word);
    if (plugin !== null && pluginRoot !== undefined) {
        return join(pluginRoot, word.slice(plugin[0].length));
    }
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
const scriptOf = async (word: Word, place: HookPlace, pluginRoot?: string): Promise<HookScript | undefined> => {
    const path = pathOf(word.text, place, pluginRoot);
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

type SettingsSource = "user" | "project";

// One config root the CLI reads, with its settings file's keys.
interface Root {
    readonly source: SettingsSource;
    readonly root: string;
    readonly keys: Record<string, unknown>;
}

// One plugin as the set holds it: the row the approval lists, the places it declares hooks, its module, its code.
interface PluginPart {
    readonly found: FoundPlugin;
    readonly declarations: readonly Declaration[];
    readonly modules: readonly { readonly declaredIn: string; readonly name: string }[];
    readonly code: readonly string[];
}

const pluginPart = async (plugin: Omit<HookPlugin, "module" | "dir">, dir: string, place: HookPlace): Promise<PluginPart> => {
    const read = await pluginHooks(dir, place.readable);
    const declarations = read.declared.map(({ file, hooks }): Declaration => ({ source: "plugin", file, hooks, plugin: { name: plugin.name, root: dir } }));
    // The CLI admits one module per plugin and refuses the plugin's module outright for a second, so the first is the one
    // the card describes; every one named is pinned all the same.
    const module = read.modules[0];
    return {
        found: { plugin: { ...plugin, dir: spelled(dir, place) }, ...(module === undefined ? {} : { module: module.name, readDir: place.readable(dir) }) },
        declarations,
        modules: read.modules,
        code: read.code,
    };
};

// A plugin's module as a row of the set, so the count and the ledger see it beside the classic hooks.
const moduleRows = ({ found, modules }: PluginPart, place: HookPlace): SettingsHook[] =>
    modules.map((module) => ({ source: "plugin", plugin: found.plugin.name, declaredIn: spelled(module.declaredIn, place), event: "*", type: "module", run: module.name }));

// Where a marketplace entry fetches from: its repository, address or path, else the entry itself.
const locationOf = (entry: unknown): string => {
    const from = isRecord(entry) ? entry["source"] : undefined;
    if (isRecord(from)) {
        for (const key of ["repo", "url", "path"]) {
            if (typeof from[key] === "string") {
                return from[key];
            }
        }
    }
    return JSON.stringify(canonical(entry));
};

const marketplacesOf = ({ source, keys }: Root): HookMarketplace[] => {
    const added = keys["extraKnownMarketplaces"];
    return isRecord(added) ? Object.entries(added).map(([name, entry]) => ({ source, name, location: locationOf(entry) })) : [];
};

// Every plugin the CLI loads at `place` beyond the image's own: the turn's mounts, plugin folders among the skills,
// and the plugins settings enable, at each place Claude Code installed them.
const pluginsAt = async (place: HookPlace, roots: readonly Root[]): Promise<{ parts: PluginPart[]; uninstalled: FoundPlugin[] }> => {
    const enabled = roots.flatMap(({ source, keys }) => enabledPluginsOf(keys["enabledPlugins"]).map((key) => ({ source, key })));
    const [installs, skillFolders] = await Promise.all([
        installedPluginDirs(place.configDir, place.readable, enabled.map(({ key }) => key)),
        Promise.all(roots.map(async ({ source, root }) => (await skillFolderPlugins(root, place.readable)).map((plugin) => ({ ...plugin, source })))),
    ]);
    const parts = await Promise.all([
        ...(place.plugins ?? []).map((plugin) => pluginPart({ name: plugin.name, from: plugin.from }, plugin.dir, place)),
        ...skillFolders.flat().map(({ name, dir, source }) => pluginPart({ name, from: "skills", source }, dir, place)),
        ...enabled.flatMap(({ source, key }) => (installs.get(key) ?? []).map((dir) => pluginPart({ name: key, from: "settings", source }, dir, place))),
    ]);
    const uninstalled = enabled.filter(({ key }) => (installs.get(key) ?? []).length === 0).map(({ source, key }): FoundPlugin => ({ plugin: { name: key, from: "settings", source } }));
    return { parts, uninstalled };
};

// The hooks the CLI would load at `place`, and the one digest an approval pins; undefined when no source declares any,
// no plugin brings a module, and the settings enable no plugin of their own.
export const settingsHookSet = async (place: HookPlace): Promise<HookSet | undefined> => {
    const projectRoot = join(place.cwd, ".claude");
    const roots = await Promise.all(
        ([
            ["user", place.configDir],
            ["project", projectRoot],
        ] as const).map(async ([source, root]): Promise<Root> => ({ source, root, keys: await settingsIn(place.readable(join(root, "settings.json"))) })),
    );
    const [definitions, { parts, uninstalled }] = await Promise.all([Promise.all(roots.map(({ root }) => frontmatterHooks(root, place.readable))), pluginsAt(place, roots)]);
    const declarations: Declaration[] = [
        ...roots.map(({ source, keys }): Declaration => ({ source, hooks: keys["hooks"] })),
        ...roots.flatMap(({ source }, index) => (definitions[index] ?? []).map(({ file, hooks }): Declaration => ({ source, file, hooks }))),
    ];
    // A plugin declaring no hooks and no module adds nothing, so mounting one never asks.
    const contributing = parts.filter((part) => part.modules.length > 0 || part.declarations.some((declaration) => rowsOf(declaration, place).length > 0));
    const fromSettings = parts.filter((part) => part.found.plugin.from === "settings" && !contributing.includes(part));
    const plugins = [...contributing.map((part) => part.found), ...fromSettings.map((part) => part.found), ...uninstalled];
    const marketplaces = roots.flatMap(marketplacesOf);
    const hooks = [
        ...declarations.flatMap((declaration) => rowsOf(declaration, place)),
        ...contributing.flatMap((part) => [...part.declarations.flatMap((declaration) => rowsOf(declaration, place)), ...moduleRows(part, place)]),
    ];
    if (hooks.length === 0 && plugins.length === 0 && marketplaces.length === 0) {
        return undefined;
    }
    const pluginDeclarations = contributing.flatMap((part) => part.declarations);
    const found = await Promise.all([
        ...[...declarations, ...pluginDeclarations].flatMap(({ hooks: declared, plugin }) =>
            hookObjectsOf(declared)
                .flatMap(candidatesOf)
                .map((word) => scriptOf(word, place, plugin?.root)),
        ),
        ...contributing.flatMap((part) => part.code).map(async (path): Promise<HookScript> => ({ path: spelled(path, place), sha256: await sha256File(place.readable(path)).catch(() => "unreadable") })),
    ]);
    const scripts = [...new Map(found.filter((script) => script !== undefined).map((script) => [script.path, script])).values()].toSorted((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
    // Keys beyond the first two only where there is something under them, so a set with no plugin in it keeps the digest
    // it was approved under before plugins counted.
    const settingsPlugins = roots
        .filter(({ keys }) => keys["enabledPlugins"] !== undefined || keys["extraKnownMarketplaces"] !== undefined)
        .map(({ source, keys }) => [source, keys["enabledPlugins"] ?? null, keys["extraKnownMarketplaces"] ?? null]);
    const digest = sha256Text(
        JSON.stringify(
            canonical({
                sources: declarations.map(({ source, file, hooks: declared }) => [source, file === undefined ? null : spelled(file, place), declared ?? null]),
                scripts: scripts.map((script) => [script.path, script.sha256]),
                ...(contributing.length === 0
                    ? {}
                    : {
                          plugins: contributing.map(({ found: { plugin }, declarations: declared, modules }) => [
                              plugin.dir ?? null,
                              declared.map(({ file, hooks: value }) => [file === undefined ? null : spelled(file, place), value ?? null]),
                              modules.map((module) => [spelled(module.declaredIn, place), module.name]),
                          ]),
                      }),
                ...(settingsPlugins.length === 0 ? {} : { settings: settingsPlugins }),
            }),
        ),
    );
    return { digest, hooks, scripts, plugins, marketplaces };
};
