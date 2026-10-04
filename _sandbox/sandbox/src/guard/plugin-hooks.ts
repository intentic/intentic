import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type FrontmatterHooks, frontmatterHooks, undefinedIfCliSeesNothing } from "./frontmatter-hooks.js";

/* What one Claude Code plugin directory runs as hooks: the `hooks` of its hooks files (hooks/hooks.json, any the manifest
 * names, a block inline in the manifest), its skills', subagents' and commands' frontmatter, and its hooks module: the
 * `modules` a hooks file names, code Claude Code runs in its own process with the session's environment. A module may
 * import any file of the plugin, so a plugin with one pins every file a module could load. Read the way the CLI reads
 * them; settings-hooks.ts folds the result into the approval's digest. */

// One `modules` entry: the hooks file naming it, the name as written, and the file it resolves to.
export interface PluginModule {
    readonly declaredIn: string;
    readonly name: string;
    readonly path: string;
}

export interface PluginHooks {
    // Every place the plugin declares classic hooks, the hooks files and the manifest first, then definitions.
    readonly declared: readonly FrontmatterHooks[];
    readonly modules: readonly PluginModule[];
    // Every file a module could load, sorted; empty for a plugin with no module.
    readonly code: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// A JSON file the CLI reads, or undefined where it reads nothing: absent, or not strict JSON.
export const jsonIn = async (path: string): Promise<unknown> => {
    const text = await readFile(path, "utf8").catch(undefinedIfCliSeesNothing);
    if (text === undefined) {
        return undefined;
    }
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return undefined;
    }
};

const MANIFEST = join(".claude-plugin", "plugin.json");
// The suffixes a hooks module and every file it imports are named with; a file named otherwise is never loaded.
const MODULE_FILE = /\.(?:ts|tsx|jsx|js|mjs|cjs|mts|cts)$/u;
// Never loaded as plugin code: Claude Code writes the types folder itself as it loads a module, which would otherwise
// unsettle the approval on every first load.
const NOT_CODE = new Set([".git", "node_modules"]);
const TYPES_DIR = join(".claude-plugin", "types");

// The hooks files a manifest names besides hooks/hooks.json: one path or a list, relative to the plugin.
const namedHookFiles = (manifest: unknown, dir: string): string[] => {
    const named = isRecord(manifest) ? manifest["hooks"] : undefined;
    const paths = typeof named === "string" ? [named] : Array.isArray(named) ? named.filter((path: unknown): path is string => typeof path === "string") : [];
    return paths.map((path) => join(dir, path));
};

// Every module-named file under the plugin, as the namespace names it; a symlinked folder is not followed, so a link
// back up cannot loop the walk.
const codeFiles = async (dir: string, readable: (path: string) => string, rel = ""): Promise<string[]> => {
    const entries = (await readdir(readable(join(dir, rel)), { withFileTypes: true }).catch(undefinedIfCliSeesNothing)) ?? [];
    const found = await Promise.all(
        entries.map(async (entry): Promise<string[]> => {
            const path = join(rel, entry.name);
            if (NOT_CODE.has(entry.name) || path === TYPES_DIR) {
                return [];
            }
            if (entry.isDirectory()) {
                return codeFiles(dir, readable, path);
            }
            const isFile = entry.isFile() || (entry.isSymbolicLink() && (await stat(readable(join(dir, path))).catch(() => undefined))?.isFile() === true);
            return isFile && MODULE_FILE.test(entry.name) ? [join(dir, path)] : [];
        }),
    );
    return found.flat();
};

// One hooks file's `modules`, each resolved against the file's own folder.
const modulesOf = (file: string, parsed: unknown): PluginModule[] => {
    const named = isRecord(parsed) ? parsed["modules"] : undefined;
    if (!Array.isArray(named)) {
        return [];
    }
    return named.filter((name: unknown): name is string => typeof name === "string").map((name) => ({ declaredIn: file, name, path: join(dirname(file), name) }));
};

export const pluginHooks = async (dir: string, readable: (path: string) => string): Promise<PluginHooks> => {
    const manifestFile = join(dir, MANIFEST);
    const manifest = await jsonIn(readable(manifestFile));
    const hookFiles = [...new Set([join(dir, "hooks", "hooks.json"), ...namedHookFiles(manifest, dir)])];
    const [files, definitions] = await Promise.all([
        Promise.all(hookFiles.map(async (file) => ({ file, parsed: await jsonIn(readable(file)) }))),
        frontmatterHooks(dir, readable),
    ]);
    const inline = isRecord(manifest) && isRecord(manifest["hooks"]) ? [{ file: manifestFile, hooks: manifest["hooks"] }] : [];
    const declared = [
        ...files.flatMap(({ file, parsed }) => (isRecord(parsed) && parsed["hooks"] !== undefined && parsed["hooks"] !== null ? [{ file, hooks: parsed["hooks"] }] : [])),
        ...inline,
        ...definitions,
    ];
    const modules = files.flatMap(({ file, parsed }) => modulesOf(file, parsed));
    // The module itself is pinned even where it lies outside the walk's reach (a suffix the walk skips).
    const code = modules.length === 0 ? [] : [...new Set([...(await codeFiles(dir, readable)), ...modules.map((module) => module.path)])].toSorted();
    return { declared, modules, code };
};

// Plugins a settings file enables by `name@marketplace`, keyed to true; `false` keeps one off.
export const enabledPluginsOf = (enabled: unknown): string[] =>
    isRecord(enabled)
        ? Object.entries(enabled)
              .filter(([, on]) => on === true)
              .map(([key]) => key)
        : [];

// Where Claude Code installed each enabled plugin, from its own installed_plugins.json: every `installPath` recorded
// under the plugin's key, whatever version of that file's shape holds it. Empty for one it has not installed.
export const installedPluginDirs = async (configDir: string, readable: (path: string) => string, keys: readonly string[]): Promise<Map<string, string[]>> => {
    const installed = keys.length === 0 ? undefined : await jsonIn(readable(join(configDir, "plugins", "installed_plugins.json")));
    const plugins = isRecord(installed) && isRecord(installed["plugins"]) ? installed["plugins"] : {};
    const pathsIn = (value: unknown): string[] => {
        if (Array.isArray(value)) {
            return value.flatMap(pathsIn);
        }
        if (!isRecord(value)) {
            return [];
        }
        return typeof value["installPath"] === "string" ? [value["installPath"]] : Object.values(value).flatMap(pathsIn);
    };
    return new Map(keys.map((key) => [key, [...new Set(pathsIn(plugins[key]))].toSorted()]));
};

// The plugin folders among one root's skills (`<root>/skills/<name>` holding a plugin manifest), which Claude Code loads
// as plugins of their own.
export const skillFolderPlugins = async (root: string, readable: (path: string) => string): Promise<{ readonly name: string; readonly dir: string }[]> => {
    const names = ((await readdir(readable(join(root, "skills"))).catch(undefinedIfCliSeesNothing)) ?? []).toSorted();
    const found = await Promise.all(
        names.map(async (name) => {
            const dir = join(root, "skills", name);
            return (await stat(readable(join(dir, MANIFEST))).catch(() => undefined))?.isFile() === true ? [{ name, dir }] : [];
        }),
    );
    return found.flat();
};
