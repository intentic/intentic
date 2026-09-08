import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { pathExists } from "../path-exists.js";
import { errorMessage } from "@intentic/base/errors";
import { type EngineId, isNewer } from "@intentic/sandbox-contract";
import { readPack } from "../environment/packs.js";

// Per-engine table: what package upstream publishes it as, what a working install looks like, and what proves a copy
// still works. The floor is read from the pack that installs it (or Claude's own npm dependency), never restated by
// hand. Verification means the daemon's actual use still works, not just that the download finished.

const execFileAsync = promisify(execFile);

// Long enough for a cold binary's first exec; a timeout quarantines the copy instead of hanging the install.
const PROBE_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 1024 * 1024;

export interface EnginePaths {
    // Module a consumer imports, for an engine that runs in this process; absent for a purely spawned engine.
    readonly jsEntry?: string;
    // The executable a consumer spawns. Absent for a purely in-process engine.
    readonly binPath?: string;
}

export type EngineSource =
    | { readonly kind: "npm"; readonly package: string }
    // Translator only: a GitHub release asset instead of npm; same store and channels, different fetch.
    | { readonly kind: "github-release"; readonly repo: string; readonly asset: (version: string) => string; readonly binary: string };

export interface EngineDescriptor {
    readonly id: EngineId;
    readonly label: string;
    readonly source: EngineSource;
    // What lives where inside an installed prefix; whether paths exist is verify()'s question, not this one.
    readonly paths: (prefix: string) => Promise<EnginePaths>;
    // Version the image bakes; undefined is ordinary (no provider pack baked) and means store-only.
    readonly baked: () => Promise<string | undefined>;
    // Undefined when this installed prefix is fit to serve turns, else the sentence saying why it is not.
    readonly verify: (prefix: string) => Promise<string | undefined>;
    // What the engine calls itself when different from its published version; absent means they match.
    readonly reportedVersion?: (prefix: string) => Promise<string | undefined>;
    // Whether a published version satisfies a stated floor; only Claude overrides the default comparison.
    readonly satisfiesFloor?: (published: string, floor: string) => boolean;
}

const majorOf = (version: string): string => version.split(".")[0] ?? "";
const lastComponent = (version: string): number => Number(version.split(".").at(-1) ?? "0");

// The pin a pack's install line carries, the version the image bakes. Requires exactly one capture group match; more or
// none fails loudly rather than silently reading as no floor.
const packPin = async (pack: string, pattern: RegExp): Promise<string | undefined> => {
    const content = (await readPack(pack))?.content;
    const matches = content === undefined ? [] : [...content.matchAll(pattern)].map((match) => match[1]);
    return matches.length === 1 ? matches[0] : undefined;
};

// A binary that answers any of these is present and runnable; a non-zero exit still proves it launched, so only
// ENOENT/EACCES/ENOEXEC and a timeout count as failure.
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
        // Anything but "cannot execute this file" means the program ran and merely disliked the argument.
        return code === "ENOENT" || code === "EACCES" || code === "ENOEXEC" ? `${bin} could not be run (${String(code)})` : undefined;
    }
};

// Names the daemon calls on the Claude SDK; checked here so a missing export fails the install, not a turn.
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

// Imports a module and reports which exports are missing, for the two engines the daemon loads rather than spawns. A
// module that throws on load is caught here instead of at turn time.
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

// Path to the Claude CLI binary inside an installed prefix, computed rather than resolved through the loaded module so
// the daemon can name it directly. Musl and glibc variants are both listed, so an Alpine-based image needs no change
// here.
const claudeBinCandidates = (prefix: string): string[] => {
    const target = `${platform()}-${arch()}`;
    const suffix = platform() === "win32" ? ".exe" : "";
    const names = platform() === "linux" ? [target, `${target}-musl`] : [target];
    return names.map((name) => join(prefix, "node_modules", "@anthropic-ai", `claude-agent-sdk-${name}`, `claude${suffix}`));
};

const claudeBin = async (prefix: string): Promise<string | undefined> => {
    for (const candidate of claudeBinCandidates(prefix)) {
        if (await pathExists(candidate)) {
            return candidate;
        }
    }
    return undefined;
};

// Reads a package's own manifest to find its declared ESM entry, rather than assuming a path; require.resolve returns
// the CJS bundle and refuses a manifest subpath outside the package's `exports` map.
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
    // The daemon's own npm dependency, resolved through Node rather than restated; this build's version of it is the
    // floor, so a catalog bump moves both together.
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
    // The CLI's own version, read from the manifest the SDK ships beside its binaries rather than derived; it is the
    // number the API's floors are stated in.
    reportedVersion: async (prefix) => {
        const manifest = await readFile(join(prefix, "node_modules", CLAUDE_PACKAGE, "manifest.json"), "utf8")
            .then((raw) => JSON.parse(raw) as { version?: unknown })
            .catch(() => undefined);
        return typeof manifest?.version === "string" ? manifest.version : undefined;
    },
    // sdk 0.3.257 ships as Claude Code 2.1.257, sharing the last component; a CLI-numbered floor compares on that when
    // majors differ, else it compares normally. Only an assumption: the installed manifest version is re-checked
    // afterward.
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
    // The wrapper, not the platform binary: it runs `codex app-server --stdio` and picks the platform package.
    paths: async (prefix) => ({ binPath: join(prefix, "node_modules", "@openai", "codex", "bin", "codex.js") }),
    baked: () => packPin("codex", /@openai\/codex@(\S+)/g),
    verify: async (prefix) => {
        const { binPath } = await codexDescriptor.paths(prefix);
        if (binPath === undefined || !(await pathExists(binPath))) {
            return "the downloaded package has no codex wrapper";
        }
        // Runs via this process's own Node; npm's executable bit lands on the .bin link, not always the file.
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
        // No declared ESM entry means no copy at all; reporting found would let a bad download throw mid-turn instead.
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
        return binPath === undefined || !(await pathExists(binPath)) ? "the downloaded package has no opencode binary" : answersVersion(binPath);
    },
};

// CLIProxyAPI's own vocabulary, not Node's or Debian's: arm is `aarch64`, x86 is `amd64`; the wrong pair 404s. Mirrors
// the mapping in image-packs/translator.Dockerfile's `case`.
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
        return binPath === undefined || !(await pathExists(binPath)) ? "the downloaded archive has no cli-proxy-api binary" : answersVersion(binPath);
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
        // Unreachable while EngineId and this table agree; engine-descriptors.test.ts checks that by discovery.
        throw new Error(`no descriptor for engine ${id}`);
    }
    return descriptor;
};
