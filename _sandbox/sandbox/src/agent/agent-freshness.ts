import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import type { DependencyFreshness } from "@intentic/sandbox-contract";
import type { Ecosystem, Freshness, FreshnessResolver, PinnedPackage, RangeOperator } from "../dependencies/registry-freshness.js";
import { successorFor } from "../dependencies/successors.js";
import type { WorkspacePins } from "../dependencies/workspace-pins.js";
import { agentCommand, commandInvocations } from "./agent-installs.js";

/* THE VERSION ABOUT TO BE WRITTEN, CHECKED AGAINST THE REGISTRY THAT PUBLISHES IT.
 *
 * A model writes a version out of memory, and memory has a publication date. Nothing downstream catches it:
 * a stale pin installs cleanly, type-checks, and passes the suite, so every gate this sandbox already has
 * says yes to it. The only moment the mistake is visible is the moment it is made, which is why this stands
 * where it does — in front of the tool call that makes it, not at the end of the turn.
 *
 * Measured over this workspace's own 853 sessions: of the version literals an agent typed, more than half
 * were already behind the newest published release at the moment of typing, and a third of them were written
 * without any registry being consulted anywhere in the session. Three of those pins are still in this tree.
 *
 * IT INFORMS AND GETS OUT OF THE WAY, and the reason is in the same data. The single most common REASON to
 * write a version that is not the newest is completely legitimate: a new package inside a monorepo should
 * take the version the catalog already pins, not whatever npm published this morning. A gate that refused
 * would fight that case several times for every mistake it caught, so the fact is handed over and the model
 * decides — and the notice says out loud which reasons are good ones, because the failure mode of a bare
 * "there is a newer version" is a model that dutifully churns a healthy manifest.
 *
 * TWO PASSES OVER ONE TOOL CALL, which looks redundant and is not. `PreToolUse` reports what is already
 * known, which after the first lookup of a session is everything, at no cost. A cold lookup cannot be waited
 * for there — the agent is parked on the call — so it runs past its caller's grace and lands in the cache
 * (dependencies/registry-freshness.ts explains the two clocks), and `PostToolUse` is what picks it up. The
 * lookup is deduplicated across both, so the pair costs one request, and the model hears about it either
 * immediately or one beat later instead of not at all. */

// How many packages one notice names. A notice long enough to skim past is a notice that does not work, and
// the rest are still there to be found on the next edit.
const NAMED = 5;

const MANIFESTS: readonly { readonly pattern: RegExp; readonly ecosystem: Ecosystem }[] = [
    { pattern: /(^|\/)package\.json$/, ecosystem: "npm" },
    { pattern: /(^|\/)pnpm-workspace\.yaml$/, ecosystem: "npm" },
    { pattern: /(^|\/)(requirements[\w.-]*\.txt|pyproject\.toml|Pipfile)$/, ecosystem: "pypi" },
    { pattern: /(^|\/)Cargo\.toml$/, ecosystem: "crates" },
];

export const manifestEcosystem = (path: string): Ecosystem | undefined => MANIFESTS.find((entry) => entry.pattern.test(path))?.ecosystem;

/* Keys that hold a VERSION NUMBER without naming a dependency. `"version": "1.4.0"` in a package.json is the
 * manifest's own identity, and reporting it as a stale copy of some unrelated package on npm was the single
 * loudest false positive when this was first measured against the transcript history. */
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

// A workspace's own packages are not on any registry, and asking after them would be a guaranteed miss on
// every edit of every manifest in a monorepo.
const isLocal = (specifier: string): boolean =>
    specifier.startsWith("workspace:") || specifier.startsWith("catalog:") || specifier.startsWith("file:") || specifier.startsWith("link:") || specifier.startsWith("git");

const RANGES: readonly RangeOperator[] = ["^", "~", ">="];

// Split `^1.2.3` into the operator the manifest wrote and the version under it. Anything this cannot read —
// a tag, a URL, a range with two bounds — returns undefined and is left alone rather than guessed at.
export const splitRange = (specifier: string): { readonly range: RangeOperator; readonly version: string } | undefined => {
    const value = specifier.trim();
    if (value === "" || isLocal(value)) {
        return undefined;
    }
    const range = RANGES.find((operator) => value.startsWith(operator)) ?? "";
    const version = value.slice(range.length).trim();
    return /^\d+\.\d+/.test(version) ? { range, version } : undefined;
};

/* Dependency blocks in a JSON manifest, and only those blocks. Deliberately not "every version-shaped string
 * in the file": a package.json carries versions that are not dependencies, and a scan that took them all
 * would spend its credibility on the manifest's own `version` field within a turn. */
const JSON_BLOCK = /"(?:dependencies|devDependencies|peerDependencies|optionalDependencies|catalog|catalogs)"\s*:\s*\{/g;
const JSON_ENTRY = /"([^"\s]+)"\s*:\s*"([^"]+)"/g;
// A pnpm catalog is YAML, so its entries are not inside braces the JSON scan can find.
const YAML_ENTRY = /^\s{2,}(?:"([^"]+)"|([@\w][\w\-./]*)):\s*"?([\^~>=]*\d+\.\d+[\w.-]*)"?\s*(?:#.*)?$/gm;
const PY_ENTRY = /^\s*([A-Za-z0-9][\w.-]*)\s*(?:\[[^\]]*\])?\s*==\s*(\d+\.\d+[\w.-]*)/gm;
const TOML_ENTRY = /^\s*([A-Za-z0-9][\w-]*)\s*=\s*"([\^~]?\d+\.\d+[\w.-]*)"/gm;

// The braces of the block starting at `from`, so entries of a NESTED object cannot leak into it.
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

// One `name -> specifier` pair as some format spells it, before anything decides whether it is a dependency
// or a version this scan has any business reading.
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

// Only the dependency blocks, walked brace by brace so a nested object cannot leak its keys in.
const jsonEntries = (body: string): RawEntry[] => {
    JSON_BLOCK.lastIndex = 0;
    const entries: RawEntry[] = [];
    let block: RegExpExecArray | null;
    while ((block = JSON_BLOCK.exec(body)) !== null) {
        entries.push(...matchesOf(JSON_ENTRY, blockBody(body, block.index + block[0].length - 1), (match) => ({ name: match[1], specifier: match[2] })));
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
    // A pyproject.toml holds both spellings, so both scans run over it and the union is what it declares.
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

/* WHICH ECOSYSTEM AN INVOCATION IS ADDING TO, and the arguments it is adding — the one place that knows how
 * a package manager's command line is shaped. Both scanners below read it, so `pnpm add` and `uv add` are
 * recognised identically wherever the answer is used, and a manager added later is one entry here rather
 * than a branch in each of them. */
interface InstallTargets {
    readonly ecosystem: Ecosystem;
    readonly args: readonly string[];
}

// Every package manager this recognises, as a table rather than a chain of tests: adding one is an entry,
// and the shape "an executable, the verbs of its that ADD, and the registry behind it" is stated once.
const MANAGERS = new Map<string, { readonly ecosystem: Ecosystem; readonly verbs: ReadonlySet<string> }>([
    ...[...NODE_MANAGERS].map((name) => [name, { ecosystem: "npm" as const, verbs: NODE_ADD_VERBS }] as const),
    ...[...PY_MANAGERS].map((name) => [name, { ecosystem: "pypi" as const, verbs: PY_ADD_VERBS }] as const),
    ["cargo", { ecosystem: "crates" as const, verbs: new Set(["add"]) }] as const,
]);

const installTargets = (command: string): InstallTargets[] =>
    commandInvocations(agentCommand(command)).flatMap<InstallTargets>((invocation) => {
        const words = invocation.split(/\s+/).filter((word) => word !== "");
        const manager = MANAGERS.get(words.shift()?.split("/").at(-1) ?? "");
        if (manager === undefined) {
            return [];
        }
        // Flags are dropped wholesale. None of them names a package, and `-D`/`--save-exact` sitting between
        // the verb and its arguments is the normal shape rather than an edge case.
        const args = words.filter((word) => !word.startsWith("-"));
        const rest = args.slice(1);
        const verb = args[0];
        return verb !== undefined && manager.verbs.has(verb) && rest.length > 0 ? [{ ecosystem: manager.ecosystem, args: rest }] : [];
    });

/* One argument split into the package it names and the version it pins, in whichever spelling its ecosystem
 * uses. `@scope/name@1.2.3` splits at the LAST `@`, because the first one is the scope. */
const splitArgument = (ecosystem: Ecosystem, argument: string): { readonly name: string; readonly version?: string; readonly range?: RangeOperator } | undefined => {
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

/* Packages an install COMMAND names with an explicit version. This is the other half of the catch, and the
 * more valuable one: a manifest edit is a considered act, while `pnpm add react@18.2.0` is exactly the
 * reflex this feature exists for — a version recalled rather than looked up. */
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

// Every package an install command adds, versioned or not. Only these are eligible for a `superseded`
// suggestion: it is a remark about CHOOSING, so it belongs to the moment of the choice and nowhere else.
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
        // `abandoned` is the only kind allowed to speak about a version already written down, and only where
        // the registry has just corroborated it. Without that corroboration the list stays quiet, which is
        // what keeps an entry that has stopped being true from being repeated forever.
        if (successor?.kind === "abandoned" && freshness.deprecated !== undefined) {
            parts.push(`Reach for ${successor.to} instead — ${successor.reason}.`);
        }
    }
    return `  ${parts.join(" ")}`;
};

const suggestionFor = (name: string, ecosystem: Ecosystem): string | undefined => {
    const successor = successorFor(ecosystem, name);
    return successor?.kind === "superseded" ? `  ${name} works, but ${successor.to} is what this would usually reach for now — ${successor.reason}.` : undefined;
};

/* TWO SECTIONS THAT ARE NEVER MERGED, because they are not the same kind of statement and a notice that ran
 * them together would claim a registry looked at something it did not.
 *
 * A version line is a MEASUREMENT: the registry was asked, and here is what it said. A suggestion is a
 * JUDGEMENT out of the curated list, made about a package being added, with no lookup behind it. Filing the
 * second under "checked against the registry just now" would be a small lie, and the closing advice about
 * taking the newer version means nothing when there is no version in question. So each section carries its
 * own heading, its own closing line, and appears only when it has something in it. */
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
                  // The load-bearing sentence. Without it this reads as "newer is better" and earns a churned
                  // manifest: matching a version the workspace already pins is the commonest reason to write
                  // something other than the latest, and it is a GOOD reason.
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

// The same matcher agent-verification.ts uses, so a workspace running hashline edits is covered too.
const EDIT_TOOLS = "Edit|Write|NotebookEdit|mcp__hashline__edit|mcp__hashline__write";

/* Created once per turn, which is what the `told` set is scoped to: the model needs the fact once, and a
 * manifest edited five times must not produce five identical notices. */
export const freshnessHooks = (
    mode: DependencyFreshness | undefined,
    resolve: FreshnessResolver | undefined,
    // What this workspace already pins (dependencies/workspace-pins.ts). Absent ⇒ no suppression, which is
    // what the tests run on and what a turn with no readable tree gets.
    known?: WorkspacePins,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> => {
    if (mode === undefined || mode === "off" || resolve === undefined) {
        return {};
    }
    const told = new Set<string>();

    const report = async (pins: readonly PinnedPackage[], adding: readonly { readonly ecosystem: Ecosystem; readonly name: string }[]): Promise<string | undefined> => {
        /* Two filters before anything is asked, and the second is what keeps this feature bearable in a
         * monorepo: a version the workspace ALREADY uses for that package is a decision the project has made,
         * so writing it again is the correct answer rather than a stale one. Applied before the lookup, not
         * after, so the suppressed case costs no request either. */
        const fresh = pins.filter(
            (pinned) => !told.has(`${pinned.ecosystem} ${pinned.name} ${pinned.version}`) && known?.(pinned.ecosystem, pinned.name).has(pinned.version) !== true,
        );
        const resolved = await Promise.all(
            fresh.map(async (pinned) => {
                try {
                    return { pinned, freshness: await resolve(pinned) };
                } catch {
                    // A resolver that throws is a resolver that said nothing. Never the agent's problem.
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
        // The catch-up pass. A lookup too cold to answer before the call now has, and the `told` set is what
        // stops this from repeating whatever the first pass already said.
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
