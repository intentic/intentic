import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import type { DependencyFreshness } from "@intentic/sandbox-contract";
import type { Ecosystem, Freshness, FreshnessResolver, PinnedPackage, RangeOperator } from "../../dependencies/registry-freshness.js";
import { successorFor } from "../../dependencies/successors.js";
import type { WorkspacePins } from "../../dependencies/workspace-pins.js";
import { EDIT_TOOLS } from "../../rules/edit-tools.js";
import { agentCommand, commandWords } from "./agent-installs.js";

// Checks a version about to be written against the registry, in front of the tool call, since nothing downstream
// catches a stale pin. Matching a version the workspace already pins is a good reason to keep it, not a mistake.
// PreToolUse reports what is known; PostToolUse catches a cold lookup, deduplicated to one request.

// How many packages one notice names; a longer notice goes unread.
const NAMED = 5;

const MANIFESTS: readonly { readonly pattern: RegExp; readonly ecosystem: Ecosystem }[] = [
    { pattern: /(^|\/)package\.json$/, ecosystem: "npm" },
    { pattern: /(^|\/)pnpm-workspace\.yaml$/, ecosystem: "npm" },
    { pattern: /(^|\/)(requirements[\w.-]*\.txt|pyproject\.toml|Pipfile)$/, ecosystem: "pypi" },
    { pattern: /(^|\/)Cargo\.toml$/, ecosystem: "crates" },
];

export const manifestEcosystem = (path: string): Ecosystem | undefined => MANIFESTS.find((entry) => entry.pattern.test(path))?.ecosystem;

// Keys that hold a version number without naming a dependency, such as a manifest's own "version" field.
const NOT_DEPENDENCIES = new Set([
    "version",
    "name",
    "engines",
    "node",
    "npm",
    "pnpm",
    "yarn",
    "bun",
    "packageManager",
    "edition",
    "license",
    "main",
    "module",
    "types",
    "typings",
    "author",
    "description",
    "homepage",
]);

// A workspace's own packages are not on any registry; asking after them is a guaranteed miss.
const isLocal = (specifier: string): boolean =>
    specifier.startsWith("workspace:") ||
    specifier.startsWith("catalog:") ||
    specifier.startsWith("file:") ||
    specifier.startsWith("link:") ||
    specifier.startsWith("git");

const RANGES: readonly RangeOperator[] = ["^", "~", ">="];

// Splits `^1.2.3` into its operator and version. A tag, URL, or two-bound range returns undefined rather than a guess.
export const splitRange = (specifier: string): { readonly range: RangeOperator; readonly version: string } | undefined => {
    const value = specifier.trim();
    if (value === "" || isLocal(value)) {
        return undefined;
    }
    const range = RANGES.find((operator) => value.startsWith(operator)) ?? "";
    const version = value.slice(range.length).trim();
    return /^\d+\.\d+/.test(version) ? { range, version } : undefined;
};

// Matches only dependency blocks in a JSON manifest, not every version-shaped string in the file.
const JSON_BLOCK = /"(?:dependencies|devDependencies|peerDependencies|optionalDependencies|catalog|catalogs)"\s*:\s*\{/g;
const JSON_ENTRY = /"([^"\s]+)"\s*:\s*"([^"]+)"/g;
// A pnpm catalog is YAML; its entries are not inside braces the JSON scan can find.
const YAML_ENTRY = /^\s{2,}(?:"([^"]+)"|([@\w][\w\-./]*)):\s*"?([\^~>=]*\d+\.\d+[\w.-]*)"?\s*(?:#.*)?$/gm;
const PY_ENTRY = /^\s*([A-Za-z0-9][\w.-]*)\s*(?:\[[^\]]*\])?\s*==\s*(\d+\.\d+[\w.-]*)/gm;
const TOML_ENTRY = /^\s*([A-Za-z0-9][\w-]*)\s*=\s*"([\^~]?\d+\.\d+[\w.-]*)"/gm;

// The block's own braces starting at `from`; a nested object's entries cannot leak in.
const blockBody = (text: string, from: number): string => {
    let depth = 0;
    for (let index = from; index < text.length; index++) {
        const character = text[index];
        if (character === "{") {
            depth++;
        } else if (character === "}") {
            depth--;
            if (depth === 0) {
                return text.slice(from + 1, index);
            }
        }
    }
    return text.slice(from + 1);
};

// One name/specifier pair as some format spells it, before anything decides whether it names a real dependency.
interface RawEntry {
    readonly name: string | undefined;
    readonly specifier: string | undefined;
}

const matchesOf = (pattern: RegExp, body: string, read: (match: RegExpExecArray) => RawEntry): RawEntry[] => {
    pattern.lastIndex = 0;
    const entries: RawEntry[] = [];
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(body)) !== null) {
        entries.push(read(match));
    }
    return entries;
};

// Walks only the dependency blocks, brace by brace, so a nested object cannot leak its keys in.
const jsonEntries = (body: string): RawEntry[] => {
    JSON_BLOCK.lastIndex = 0;
    const entries: RawEntry[] = [];
    let block: RegExpExecArray | null;
    while ((block = JSON_BLOCK.exec(body)) !== null) {
        entries.push(
            ...matchesOf(JSON_ENTRY, blockBody(body, block.index + block[0].length - 1), (match) => ({ name: match[1], specifier: match[2] })),
        );
    }
    return entries;
};

const entriesFor = (path: string, body: string): RawEntry[] => {
    if (path.endsWith(".json")) {
        return jsonEntries(body);
    }
    if (/\.ya?ml$/.test(path)) {
        return matchesOf(YAML_ENTRY, body, (match) => ({ name: match[1] ?? match[2], specifier: match[3] }));
    }
    const python = matchesOf(PY_ENTRY, body, (match) => ({ name: match[1], specifier: match[2] }));
    // A pyproject.toml holds both spellings; the union of both scans is what it declares.
    return path.endsWith(".toml") ? [...matchesOf(TOML_ENTRY, body, (match) => ({ name: match[1], specifier: match[2] })), ...python] : python;
};

export const pinsInManifest = (path: string, body: string): PinnedPackage[] => {
    const ecosystem = manifestEcosystem(path);
    if (ecosystem === undefined) {
        return [];
    }
    const found = new Map<string, PinnedPackage>();
    for (const { name, specifier } of entriesFor(path, body)) {
        if (name === undefined || specifier === undefined || NOT_DEPENDENCIES.has(name)) {
            continue;
        }
        const split = splitRange(specifier);
        if (split !== undefined) {
            found.set(name, { ecosystem, name, version: split.version, range: split.range });
        }
    }
    return [...found.values()];
};

const NODE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun", "npx"]);
const NODE_ADD_VERBS = new Set(["add", "install", "i"]);

const PY_MANAGERS = new Set(["pip", "pip3", "uv"]);
const PY_ADD_VERBS = new Set(["install", "add"]);

// Which ecosystem an invocation adds to, and its arguments; the one place that knows a manager's command shape.
interface InstallTargets {
    readonly ecosystem: Ecosystem;
    readonly args: readonly string[];
}

// Every package manager this recognises, as a table: adding one is a new entry, not a branch.
const MANAGERS = new Map<string, { readonly ecosystem: Ecosystem; readonly verbs: ReadonlySet<string> }>([
    ...[...NODE_MANAGERS].map((name) => [name, { ecosystem: "npm" as const, verbs: NODE_ADD_VERBS }] as const),
    ...[...PY_MANAGERS].map((name) => [name, { ecosystem: "pypi" as const, verbs: PY_ADD_VERBS }] as const),
    ["cargo", { ecosystem: "crates" as const, verbs: new Set(["add"]) }] as const,
]);

const installTargets = (command: string): InstallTargets[] =>
    commandWords(agentCommand(command)).flatMap<InstallTargets>((invocation) => {
        const words = [...invocation];
        const manager = MANAGERS.get(words.shift()?.split("/").at(-1) ?? "");
        if (manager === undefined) {
            return [];
        }
        // Flags are dropped wholesale; none of them names a package.
        const args = words.filter((word) => !word.startsWith("-"));
        const rest = args.slice(1);
        const verb = args[0];
        return verb !== undefined && manager.verbs.has(verb) && rest.length > 0 ? [{ ecosystem: manager.ecosystem, args: rest }] : [];
    });

// Splits one argument into the package it names and the version it pins. `@scope/name@1.2.3` splits at the last `@`,
// since the first is the scope.
const splitArgument = (
    ecosystem: Ecosystem,
    argument: string,
): { readonly name: string; readonly version?: string; readonly range?: RangeOperator } | undefined => {
    if (ecosystem === "pypi") {
        const [name, version] = argument.split("==");
        if (name === undefined || name === "") {
            return undefined;
        }
        return version !== undefined && /^\d+\.\d+/.test(version) ? { name, version, range: "" } : { name };
    }
    const at = argument.lastIndexOf("@");
    if (at <= 0) {
        return argument === "" ? undefined : { name: argument };
    }
    const name = argument.slice(0, at);
    const split = splitRange(argument.slice(at + 1));
    return split === undefined ? { name } : { name, version: split.version, range: split.range };
};

// Packages an install command names with an explicit version, e.g. `pnpm add react@18.2.0`: a version recalled rather
// than looked up.
export const pinsInCommand = (command: string): PinnedPackage[] => {
    const found = new Map<string, PinnedPackage>();
    for (const { ecosystem, args } of installTargets(command)) {
        for (const argument of args) {
            const split = splitArgument(ecosystem, argument);
            if (split?.version !== undefined) {
                found.set(`${ecosystem} ${split.name}`, { ecosystem, name: split.name, version: split.version, range: split.range ?? "" });
            }
        }
    }
    return [...found.values()];
};

// Every package an install command adds, versioned or not. Only these are eligible for a `superseded` suggestion, a
// remark about choosing.
export const namesAddedByCommand = (command: string): { readonly ecosystem: Ecosystem; readonly name: string }[] => {
    const found = new Map<string, { ecosystem: Ecosystem; name: string }>();
    for (const { ecosystem, args } of installTargets(command)) {
        for (const argument of args) {
            const split = splitArgument(ecosystem, argument);
            if (split !== undefined) {
                found.set(`${ecosystem} ${split.name}`, { ecosystem, name: split.name });
            }
        }
    }
    return [...found.values()];
};

const GAP_WORDS: Record<Freshness["gap"], string> = {
    major: "a whole major behind",
    minor: "behind by a minor series",
    patch: "behind by patches",
};

// One package's line in the notice.
const lineFor = (pinned: PinnedPackage, freshness: Freshness, mode: DependencyFreshness): string => {
    const written = `${pinned.range}${pinned.version}`;
    const parts: string[] = [];
    if (freshness.latest !== pinned.version || pinned.range !== "") {
        parts.push(`${pinned.name} ${written} — the registry's latest is ${freshness.latest}, ${GAP_WORDS[freshness.gap]}.`);
    } else {
        parts.push(`${pinned.name} ${written} —`);
    }
    if (freshness.deprecated !== undefined) {
        parts.push(`Its author has deprecated it: "${freshness.deprecated.slice(0, 160)}".`);
    }
    if (mode === "full") {
        const successor = successorFor(pinned.ecosystem, pinned.name);
        // `abandoned` speaks about a written-down version only once the registry has corroborated it.
        if (successor?.kind === "abandoned" && freshness.deprecated !== undefined) {
            parts.push(`Reach for ${successor.to} instead — ${successor.reason}.`);
        }
    }
    return `  ${parts.join(" ")}`;
};

const suggestionFor = (name: string, ecosystem: Ecosystem): string | undefined => {
    const successor = successorFor(ecosystem, name);
    return successor?.kind === "superseded"
        ? `  ${name} works, but ${successor.to} is what this would usually reach for now — ${successor.reason}.`
        : undefined;
};

// Two sections, never merged: a version line is a registry measurement, a suggestion is a judgement with no lookup
// behind it. Merging them would claim the registry checked something it did not.
export const freshnessNotice = (lines: readonly string[], suggestions: readonly string[]): string | undefined => {
    if (lines.length === 0 && suggestions.length === 0) {
        return undefined;
    }
    const shownLines = lines.slice(0, NAMED);
    const shownSuggestions = suggestions.slice(0, NAMED - shownLines.length);
    const hidden = lines.length + suggestions.length - shownLines.length - shownSuggestions.length;
    const versions =
        shownLines.length === 0
            ? []
            : [
                  "Dependency versions, checked against the registry just now:",
                  ...shownLines,
                  // Without this, the notice reads as "newer is better" and churns a healthy manifest.
                  "Take the newer version unless something needs the older one. Matching a version this workspace already " +
                      "pins elsewhere, or a version another dependency requires, is a good reason to keep it; recalling it " +
                      "from memory is not. Say which applies rather than changing it silently.",
              ];
    const alternatives =
        shownSuggestions.length === 0
            ? []
            : [
                  "On what to reach for, since this is adding a dependency rather than moving one:",
                  ...shownSuggestions,
                  "A judgement rather than a lookup, so weigh it against what this project already uses and say what you chose.",
              ];
    return [...versions, ...alternatives, hidden > 0 ? `…and ${hidden} more.` : ""].filter((line) => line !== "").join("\n");
};

const editedPath = (input: unknown): string | undefined => {
    const named = input as { file_path?: unknown; path?: unknown };
    const path = typeof named.file_path === "string" ? named.file_path : named.path;
    return typeof path === "string" && path !== "" ? path : undefined;
};

const editedBody = (input: unknown): string => {
    const named = input as { content?: unknown; new_string?: unknown; edits?: unknown };
    if (typeof named.content === "string") {
        return named.content;
    }
    if (typeof named.new_string === "string") {
        return named.new_string;
    }
    return Array.isArray(named.edits) ? JSON.stringify(named.edits) : "";
};

const bashCommand = (input: unknown): string | undefined => {
    const command = (input as { command?: unknown }).command;
    return typeof command === "string" && command !== "" ? command : undefined;
};

// Created once per turn; the `told` set stops five edits of a manifest from producing five identical notices.
export const freshnessHooks = (
    mode: DependencyFreshness | undefined,
    resolve: FreshnessResolver | undefined,
    // What this workspace already pins; absent means no suppression.
    known?: WorkspacePins,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> => {
    if (mode === undefined || mode === "off" || resolve === undefined) {
        return {};
    }
    const told = new Set<string>();

    const report = async (
        pins: readonly PinnedPackage[],
        adding: readonly { readonly ecosystem: Ecosystem; readonly name: string }[],
    ): Promise<string | undefined> => {
        // Filters already-told and workspace-pinned versions before the lookup, so suppression is free.
        const fresh = pins.filter(
            (pinned) =>
                !told.has(`${pinned.ecosystem} ${pinned.name} ${pinned.version}`) &&
                known?.(pinned.ecosystem, pinned.name).has(pinned.version) !== true,
        );
        const resolved = await Promise.all(
            fresh.map(async (pinned) => {
                try {
                    return { pinned, freshness: await resolve(pinned) };
                } catch {
                    // A resolver that throws said nothing; never the agent's problem.
                    return { pinned, freshness: undefined };
                }
            }),
        );
        const lines: string[] = [];
        for (const { pinned, freshness } of resolved) {
            if (freshness === undefined) {
                continue;
            }
            told.add(`${pinned.ecosystem} ${pinned.name} ${pinned.version}`);
            lines.push(lineFor(pinned, freshness, mode));
        }
        const suggestions =
            mode === "full"
                ? adding.flatMap((entry) => {
                      const key = `suggest ${entry.ecosystem} ${entry.name}`;
                      if (told.has(key)) {
                          return [];
                      }
                      const suggestion = suggestionFor(entry.name, entry.ecosystem);
                      if (suggestion === undefined) {
                          return [];
                      }
                      told.add(key);
                      return [suggestion];
                  })
                : [];
        return freshnessNotice(lines, suggestions);
    };

    const fromInput = async (toolName: string, input: unknown): Promise<string | undefined> => {
        if (toolName === "Bash") {
            const command = bashCommand(input);
            return command === undefined ? undefined : report(pinsInCommand(command), namesAddedByCommand(command));
        }
        const path = editedPath(input);
        if (path === undefined || manifestEcosystem(path) === undefined) {
            return undefined;
        }
        return report(pinsInManifest(path, editedBody(input)), []);
    };

    return {
        PreToolUse: [
            {
                matcher: `Bash|${EDIT_TOOLS}`,
                hooks: [
                    async (input) => {
                        if (input.hook_event_name !== "PreToolUse") {
                            return {};
                        }
                        const additionalContext = await fromInput(input.tool_name, input.tool_input);
                        return additionalContext === undefined ? {} : { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext } };
                    },
                ],
            },
        ],
        // The catch-up pass; `told` stops it repeating what PreToolUse already said.
        PostToolUse: [
            {
                matcher: `Bash|${EDIT_TOOLS}`,
                hooks: [
                    async (input) => {
                        if (input.hook_event_name !== "PostToolUse") {
                            return {};
                        }
                        const additionalContext = await fromInput(input.tool_name, input.tool_input);
                        return additionalContext === undefined ? {} : { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext } };
                    },
                ],
            },
        ],
    };
};
