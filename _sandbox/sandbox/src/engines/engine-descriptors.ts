import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { errorMessage } from "@intentic/base/errors";
import { type EngineId, isNewer } from "@intentic/sandbox-contract";
import { readPack } from "../environment/packs.js";

/* WHAT EACH ENGINE IS, WHERE ITS VERSION COMES FROM, AND WHAT PROVES A COPY OF IT WORKS.
 *
 * An engine is the upstream program a runtime rides on (the noun is split from `runtime` in the contract's
 * schemas/engines.ts, which is where the reasoning lives). This table is the only place that knows the
 * per-engine specifics: which package upstream publishes it as, what a working install looks like on disk, and
 * what question decides whether a freshly downloaded copy is allowed to serve a turn.
 *
 * THE FLOOR IS READ, NEVER RESTATED. Four of the five engines are installed by a feature pack
 * (packs/<name>.Dockerfile), and that pack's pin is the version the image bakes. Reading the pin back out of
 * the pack means the floor cannot drift from what the image actually contains — the same reason cursor-sdk.ts
 * derives its install spec from the pack rather than keeping a third copy of the pin. Claude is the exception:
 * its engine is the daemon's OWN dependency, so its floor is the version of the package this build was
 * compiled against, read from that package's manifest.
 *
 * VERIFICATION IS NOT "DID THE DOWNLOAD FINISH". npm already checks tarball integrity, so the interesting
 * question is the one only this daemon can ask: does this version still do what the daemon calls it for? For a
 * spawned engine that is "the binary is there and it answers --version"; for one loaded in-process it is "the
 * module imports and still exports the names we call". A version that fails is quarantined and the image's
 * copy keeps serving turns, which is the property that makes tracking upstream safe to switch on at all. */

const execFileAsync = promisify(execFile);

// Long enough for a cold 300 MB binary's first exec on a busy machine, bounded so a hung one cannot hold an
// install open. A timeout reads as "this version does not work here", which is the safe answer: it quarantines
// a copy the sandbox was about to run for every turn.
const PROBE_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 1024 * 1024;

export interface EnginePaths {
    // The module a consumer imports, for an engine that runs IN this process (the Claude SDK's JS half,
    // @cursor/sdk). Absent for a purely spawned engine.
    readonly jsEntry?: string;
    // The executable a consumer spawns. Absent for a purely in-process engine.
    readonly binPath?: string;
}

export type EngineSource =
    | { readonly kind: "npm"; readonly package: string }
    // One engine (the translator) is published as a GitHub release asset rather than to npm. Same store, same
    // channels; only the fetch differs.
    | { readonly kind: "github-release"; readonly repo: string; readonly asset: (version: string) => string; readonly binary: string };

export interface EngineDescriptor {
    readonly id: EngineId;
    readonly label: string;
    readonly source: EngineSource;
    // What lives where, inside an installed prefix. Paths only: whether they EXIST is verify()'s question.
    readonly paths: (prefix: string) => Promise<EnginePaths>;
    // The version the image bakes. Undefined on an image that carries no copy of this engine at all, which is
    // an ordinary state (a core image bakes no provider packs) and reads as "the store is the only source".
    readonly baked: () => Promise<string | undefined>;
    // Undefined when this installed prefix is fit to serve turns, else the sentence saying why it is not.
    readonly verify: (prefix: string) => Promise<string | undefined>;
    /* WHAT THE ENGINE CALLS ITSELF, when that is not the version it is PUBLISHED under. Only Claude has the
     * split, and it matters: npm publishes `@anthropic-ai/claude-agent-sdk@0.3.257`, the program inside calls
     * itself Claude Code 2.1.257, and the API's version floors are stated in the second vocabulary. Absent
     * means the two are the same string, which is true of every other engine here. */
    readonly reportedVersion?: (prefix: string) => Promise<string | undefined>;
    /* Whether a PUBLISHED version satisfies a floor the provider named. Defaulted for the four engines whose
     * two vocabularies are one; Claude overrides it because comparing 0.3.257 against a floor of 2.1.251 the
     * ordinary way answers "no" for every version that has ever existed. */
    readonly satisfiesFloor?: (published: string, floor: string) => boolean;
}

const majorOf = (version: string): string => version.split(".")[0] ?? "";
const lastComponent = (version: string): number => Number(version.split(".").at(-1) ?? "0");

// The pin a pack's install line carries, which is the version the image bakes for that engine. One capture
// group, so a pack that stops naming exactly one version fails loudly here rather than silently reading as
// "no floor" — the same shape cursor-sdk.ts's spec reader holds the pack to.
const packPin = async (pack: string, pattern: RegExp): Promise<string | undefined> => {
    const content = (await readPack(pack))?.content;
    const matches = content === undefined ? [] : [...content.matchAll(pattern)].map((match) => match[1]);
    return matches.length === 1 ? matches[0] : undefined;
};

const exists = async (path: string): Promise<boolean> =>
    access(path, constants.F_OK).then(
        () => true,
        () => false,
    );

// A binary that answers any of these is present and runnable, which is all a spawned engine's probe claims. A
// non-zero exit still proves it launched (version-probe.ts's rule), so only ENOENT and a timeout are failures.
const answersVersion = async (bin: string, args: readonly string[] = ["--version"]): Promise<string | undefined> => {
    try {
        await execFileAsync(bin, [...args], { timeout: PROBE_TIMEOUT_MS, maxBuffer: MAX_BUFFER });
        return undefined;
    } catch (error) {
        const code = (error as { code?: unknown }).code;
        const killed = (error as { killed?: unknown }).killed === true;
        if (killed) {
            return `${bin} did not answer ${args.join(" ")} within ${PROBE_TIMEOUT_MS / 1000}s`;
        }
        // Anything that is not "cannot execute this file" means the program ran and disliked the argument,
        // which is not a reason to refuse the version.
        return code === "ENOENT" || code === "EACCES" || code === "ENOEXEC" ? `${bin} could not be run (${String(code)})` : undefined;
    }
};

// The names the daemon actually calls on the Claude SDK. A version missing one of these would fail deep inside
// a turn, at whichever call site got there first; asked here it costs one import and fails the install instead.
export const CLAUDE_SDK_EXPORTS = [
    "query",
    "tool",
    "createSdkMcpServer",
    "getSessionInfo",
    "getSessionMessages",
    "getSubagentMessages",
    "listSessions",
    "USAGE_LIMIT_ERROR_PREFIXES",
] as const;

// Import a module and report the exports it is missing, for the two engines this daemon loads rather than
// spawns. Importing is itself half the check: a module that throws on load says so here instead of at turn time.
const missingExports = async (entry: string, names: readonly string[]): Promise<string | undefined> => {
    let loaded: Record<string, unknown>;
    try {
        loaded = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
    } catch (error) {
        return `${entry} could not be imported: ${errorMessage(error)}`;
    }
    const missing = names.filter((name) => loaded[name] === undefined);
    return missing.length === 0 ? undefined : `${entry} does not export ${missing.join(", ")}`;
};

/* WHERE THE CLAUDE CLI BINARY SITS inside an installed prefix. The SDK publishes one platform package per
 * target and resolves among them itself; we compute the same answer so the version a turn runs is a path this
 * daemon can name (and hand to the SDK as pathToClaudeCodeExecutable) rather than one inferred from whatever
 * the loaded module happens to resolve. Musl is tried second on glibc and would be tried first on a musl
 * image; both are listed so an Alpine-based image needs no change here. */
const claudeBinCandidates = (prefix: string): string[] => {
    const target = `${platform()}-${arch()}`;
    const suffix = platform() === "win32" ? ".exe" : "";
    const names = platform() === "linux" ? [target, `${target}-musl`] : [target];
    return names.map((name) => join(prefix, "node_modules", "@anthropic-ai", `claude-agent-sdk-${name}`, `claude${suffix}`));
};

const claudeBin = async (prefix: string): Promise<string | undefined> => {
    for (const candidate of claudeBinCandidates(prefix)) {
        if (await exists(candidate)) {
            return candidate;
        }
    }
    return undefined;
};

/* The ESM entry a package declares, read off its own manifest rather than assembled from a path we happen to
 * know today. Lifted from cursor-sdk.ts, whose reasoning applies to every in-process engine: require.resolve
 * answers with the CJS bundle (whose named exports Node cannot see through) and refuses the manifest subpath
 * outright when the package's `exports` map does not list it. */
const readManifest = async (packageDir: string): Promise<Record<string, unknown> | undefined> =>
    readFile(join(packageDir, "package.json"), "utf8")
        .then((raw) => JSON.parse(raw) as Record<string, unknown>)
        .catch(() => undefined);

// The entry an installed package declares for ESM consumers, in the order Node itself consults.
const declaredEntry = (manifest: Record<string, unknown> | undefined): string | undefined => {
    const exported = (manifest?.["exports"] as { "."?: { import?: unknown } } | undefined)?.["."]?.import;
    return [exported, manifest?.["module"], manifest?.["main"]].find((value): value is string => typeof value === "string" && value !== "");
};

const declaredEsmEntry = async (packageDir: string): Promise<string | undefined> => {
    const declared = declaredEntry(await readManifest(packageDir));
    if (declared === undefined) {
        return undefined;
    }
    return isAbsolute(declared) ? declared : resolve(packageDir, declared);
};

const installedVersionOf = async (packageDir: string): Promise<string | undefined> => {
    const version = (await readManifest(packageDir))?.["version"];
    return typeof version === "string" ? version : undefined;
};

const CLAUDE_PACKAGE = "@anthropic-ai/claude-agent-sdk";

const claudeDescriptor: EngineDescriptor = {
    id: "claude",
    label: "Claude Code",
    source: { kind: "npm", package: CLAUDE_PACKAGE },
    paths: async (prefix) => {
        const bin = await claudeBin(prefix);
        return {
            jsEntry: join(prefix, "node_modules", CLAUDE_PACKAGE, "sdk.mjs"),
            ...(bin === undefined ? {} : { binPath: bin }),
        };
    },
    /* The daemon's own dependency, resolved through Node rather than restated: this build was compiled against
     * that package's types, so its version IS the floor, and a catalog bump moves both together with nothing to
     * keep in step by hand. */
    baked: async () => {
        const entry = await import.meta.resolve(CLAUDE_PACKAGE);
        return installedVersionOf(dirname(new URL(entry).pathname));
    },
    verify: async (prefix) => {
        const { jsEntry, binPath } = await claudeDescriptor.paths(prefix);
        if (binPath === undefined) {
            return `no ${platform()}-${arch()} Claude Code binary in the downloaded package`;
        }
        return (await missingExports(jsEntry ?? "", CLAUDE_SDK_EXPORTS)) ?? (await answersVersion(binPath));
    },
    /* The CLI's own version, which the SDK package states in the manifest it ships beside its binaries. Read
     * rather than derived: it is the number the API's floors are written in, so the one place it must not be a
     * guess is the check that a floor was actually cleared (engines/engines.ts). */
    reportedVersion: async (prefix) => {
        const manifest = await readFile(join(prefix, "node_modules", CLAUDE_PACKAGE, "manifest.json"), "utf8")
            .then((raw) => JSON.parse(raw) as { version?: unknown })
            .catch(() => undefined);
        return typeof manifest?.version === "string" ? manifest.version : undefined;
    },
    /* Anthropic publishes the two in lockstep, sharing the last component: sdk 0.3.257 ships Claude Code
     * 2.1.257. So a floor stated in CLI numbers is read by that component, and only when the majors differ —
     * a floor stated in SDK numbers still compares normally.
     *
     * It is an ASSUMPTION, so nothing rests on it being true: whatever it selects is checked after the install
     * against the manifest above, and a version that does not actually clear the floor is refused there rather
     * than quietly serving turns the provider will keep rejecting. */
    satisfiesFloor: (published, floor) => {
        if (majorOf(published) === majorOf(floor)) {
            return published === floor || isNewer(published, floor);
        }
        return lastComponent(published) >= lastComponent(floor);
    },
};

const codexDescriptor: EngineDescriptor = {
    id: "codex",
    label: "Codex",
    source: { kind: "npm", package: "@openai/codex" },
    // The wrapper, not the platform binary it execs: the adapter spawns `codex app-server --stdio` through it,
    // and the wrapper is what picks the right platform package (codex-path.ts).
    paths: async (prefix) => ({ binPath: join(prefix, "node_modules", "@openai", "codex", "bin", "codex.js") }),
    baked: () => packPin("codex", /@openai\/codex@(\S+)/g),
    verify: async (prefix) => {
        const { binPath } = await codexDescriptor.paths(prefix);
        if (binPath === undefined || !(await exists(binPath))) {
            return "the downloaded package has no codex wrapper";
        }
        // Run through this process's own Node rather than relying on the wrapper's executable bit, which npm
        // sets on `node_modules/.bin` links and not necessarily on the file itself.
        return answersVersion(process.execPath, [binPath, "--version"]);
    },
};

const CURSOR_PACKAGE = "@cursor/sdk";

const cursorDescriptor: EngineDescriptor = {
    id: "cursor",
    label: "Cursor",
    source: { kind: "npm", package: CURSOR_PACKAGE },
    paths: async (prefix) => {
        const entry = await declaredEsmEntry(join(prefix, "node_modules", "@cursor", "sdk"));
        return entry === undefined ? {} : { jsEntry: entry };
    },
    baked: () => packPin("cursor", /@cursor\/sdk@(\S+)/g),
    verify: async (prefix) => {
        const { jsEntry } = await cursorDescriptor.paths(prefix);
        // A copy that declares no ESM entry is no copy at all: answering "found it" here would turn a bad
        // download into an import that throws mid-turn (cursor-sdk.ts's rule, kept).
        return jsEntry === undefined ? "the downloaded package declares no ESM entry" : missingExports(jsEntry, ["Cursor"]);
    },
};

const opencodeDescriptor: EngineDescriptor = {
    id: "opencode",
    label: "OpenCode",
    source: { kind: "npm", package: "opencode-ai" },
    paths: async (prefix) => ({ binPath: join(prefix, "node_modules", ".bin", "opencode") }),
    baked: () => packPin("opencode", /opencode-ai@(\S+)/g),
    verify: async (prefix) => {
        const { binPath } = await opencodeDescriptor.paths(prefix);
        return binPath === undefined || !(await exists(binPath)) ? "the downloaded package has no opencode binary" : answersVersion(binPath);
    },
};

/* THE ARCHITECTURE WORD IN A CLIPROXYAPI ASSET NAME, which is upstream's own vocabulary and matches neither
 * Node's nor Debian's throughout: the arm build is `aarch64` where dpkg says `arm64`, and the x86 build is
 * `amd64` where the kernel says `x86_64`. Only the exact pair upstream publishes downloads; anything else 404s,
 * and a 404 here is the whole update path for this engine failing on every x64 sandbox. So the two tokens are
 * transcribed from the release's asset list, which is also where packs/translator.Dockerfile's `case` gets its
 * half of the same mapping — the pack starts from `dpkg --print-architecture`, so it only has arm to translate. */
export const releaseArch = (nodeArch: string = arch()): string => (nodeArch === "arm64" ? "aarch64" : nodeArch === "x64" ? "amd64" : nodeArch);

const translatorDescriptor: EngineDescriptor = {
    id: "translator",
    label: "Subscription translator",
    source: {
        kind: "github-release",
        repo: "router-for-me/CLIProxyAPI",
        asset: (version) => `CLIProxyAPI_${version}_linux_${releaseArch()}.tar.gz`,
        binary: "cli-proxy-api",
    },
    paths: async (prefix) => ({ binPath: join(prefix, "cli-proxy-api") }),
    baked: () => packPin("translator", /version=(\S+)/g),
    verify: async (prefix) => {
        const { binPath } = await translatorDescriptor.paths(prefix);
        return binPath === undefined || !(await exists(binPath)) ? "the downloaded archive has no cli-proxy-api binary" : answersVersion(binPath);
    },
};

export const ENGINE_DESCRIPTORS: readonly EngineDescriptor[] = [
    claudeDescriptor,
    codexDescriptor,
    cursorDescriptor,
    opencodeDescriptor,
    translatorDescriptor,
];

export const engineDescriptor = (id: EngineId): EngineDescriptor => {
    const descriptor = ENGINE_DESCRIPTORS.find((candidate) => candidate.id === id);
    if (descriptor === undefined) {
        // Unreachable while EngineId and this table agree, which engine-descriptors.test.ts asserts by
        // discovery rather than by enumeration.
        throw new Error(`no descriptor for engine ${id}`);
    }
    return descriptor;
};
