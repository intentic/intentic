import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import {
    HOST_RUNTIME_ENV,
    hostRuntimeOf,
    localSandboxCpus,
    localSandboxMemory,
    parseNulEnv,
    replayableEnv,
    runtimeDirectivesOf,
    sandboxNames,
    sandboxRunArgv,
    sandboxRunCommand,
} from "@intentic/sandbox-run";
import { buildCommand, type CommandContext } from "@stricli/core";

// Reads the docker engine's memory from /proc/meminfo inside this throwaway probe container: the engine total is what a
// share should be taken of. Unreadable means unmeasured; the caller falls back to its own constants.
const engineMemoryBytes = (): number => {
    try {
        return Number(/^MemTotal:\s+(\d+) kB$/mu.exec(readFileSync("/proc/meminfo", "utf8"))?.[1] ?? 0) * 1024;
    } catch {
        return 0;
    }
};

// Same argument, for cores: an uncapped probe sees the engine's own count, the ceiling a CPU ask is held to. 0 when
// unreadable, which the caller treats as "honour the ask as typed".
const engineCpus = (): number => {
    try {
        return availableParallelism();
    } catch {
        return 0;
    }
};

// Seeds owner asks from the probe's env onto the replayed pairs: absent keeps the old value, empty clears it.
const SEEDED_ENV = ["SANDBOX_MEMORY", "SANDBOX_CPUS", HOST_RUNTIME_ENV] as const;
export const seeded = (dumped: readonly (readonly [string, string])[], probeEnv: Readonly<Record<string, string | undefined>>): [string, string][] =>
    SEEDED_ENV.reduce<[string, string][]>(
        (pairs, name) => {
            const seed = probeEnv[name];
            if (seed === undefined) {
                return pairs;
            }
            const without = pairs.filter(([key]) => key !== name);
            return seed.trim() === "" ? without : [...without, [name, seed]];
        },
        dumped.map(([name, value]) => [name, value]),
    );

// The four facts a recreate sets per run rather than replaying (from its flags); included only when the flag actually
// carried something.
const runnerFacts = (flags: {
    environmentHash?: string;
    channel?: string;
    previousImage?: string;
    definitionB64?: string;
}): { environmentHash?: string; channel?: string; previousImage?: string; definition?: string } => {
    const given = (value: string | undefined): value is string => value !== undefined && value !== "";
    return {
        ...(given(flags.environmentHash) ? { environmentHash: flags.environmentHash } : {}),
        ...(given(flags.channel) ? { channel: flags.channel } : {}),
        ...(given(flags.previousImage) ? { previousImage: flags.previousImage } : {}),
        // Decoded here, re-encoded by the emitter, so `definition` stays the same TOML text for every caller.
        ...(given(flags.definitionB64) ? { definition: Buffer.from(flags.definitionB64, "base64").toString("utf8") } : {}),
    };
};

// Lets curl|sh scripts ask the image for its run command instead of hand-copying it. Env rides stdin as NUL-framed
// `printenv -0`; output is a quoted command line or a JSON argv.
export const sandboxRunCommandCli = buildCommand<{
    slug: string;
    image: string;
    baseImage: string;
    environmentHash?: string;
    channel?: string;
    previousImage?: string;
    runtime?: string;
    mounts?: string;
    dns?: string;
    definitionB64?: string;
    format?: string;
    noLocalPublish: boolean;
    unsupported?: string;
}>({
    docs: { brief: "Print the canonical docker-run command for a sandbox container (used by connect.sh/recreate.sh)" },
    parameters: {
        flags: {
            slug: { kind: "parsed", parse: String, brief: "The sandbox slug every per-sandbox name derives from" },
            image: { kind: "parsed", parse: String, brief: "The image to run (freshly pulled/built by the calling flow)" },
            baseImage: {
                kind: "parsed",
                parse: String,
                brief: "The base the daemon keeps composing overlays against (SANDBOX_BASE_IMAGE)",
            },
            environmentHash: {
                kind: "parsed",
                parse: String,
                optional: true,
                brief: "The approved overlay's sha256, when `image` was built from one (SANDBOX_ENVIRONMENT_HASH)",
            },
            channel: {
                kind: "parsed",
                parse: String,
                optional: true,
                brief: "The release channel this sandbox follows, e.g. stable (SANDBOX_CHANNEL)",
            },
            previousImage: {
                kind: "parsed",
                parse: String,
                optional: true,
                brief: "The base image this swap replaces, so the daemon can offer a rollback (SANDBOX_PREVIOUS_IMAGE)",
            },
            runtime: {
                kind: "parsed",
                parse: String,
                optional: true,
                brief: "The overlay's '# intentic:runtime' directive lines, verbatim, validated against the allowlist here",
            },
            mounts: {
                kind: "parsed",
                parse: String,
                optional: true,
                brief: "Extra -v specs, newline-separated (the /agent-auth replay, dev compiled-tree binds)",
            },
            dns: {
                kind: "parsed",
                parse: String,
                optional: true,
                brief: "DNS resolvers, space-separated (fresh public resolvers dodge negatively-cached tunnel NXDOMAINs)",
            },
            definitionB64: {
                kind: "parsed",
                parse: String,
                optional: true,
                brief: "A sandbox definition (sandbox.toml), base64 — seeds an empty workspace on first boot (SANDBOX_DEFINITION_SEED)",
            },
            format: { kind: "parsed", parse: String, optional: true, brief: "sh (default): one quoted command line; json: the docker argv" },
            noLocalPublish: {
                kind: "boolean",
                brief: "Drop the loopback shortcut's -p, what a flow re-asks for when docker refused the derived port",
            },
            unsupported: {
                kind: "parsed",
                parse: String,
                optional: true,
                brief: "Optional directive tokens this host failed its probe for (see `sandbox host-probes`), dropped, and why recorded",
            },
        },
    },
    func(this: CommandContext, flags) {
        // stdin carries NUL-framed NAME=VALUE pairs (empty = a fresh container); the runner's seeds merge in first.
        const env = replayableEnv(seeded(parseNulEnv(readFileSync(0, "utf8")), process.env));
        const replayed = (name: string): string | undefined => env.find(([key]) => key === name)?.[1];
        // Loopback port derives from the connect token already on this container; no token means no publish.
        const sandboxId = sandboxIdFromToken(replayed("CONNECT_TOKEN") ?? "");
        // Sized to this machine or a replayed owner ask; read from allowlisted pairs so each var earns re-emission.
        const memory = localSandboxMemory(engineMemoryBytes(), replayed("SANDBOX_MEMORY"));
        const cpus = localSandboxCpus(engineCpus(), replayed("SANDBOX_CPUS"));
        // Owner's directives share the overlay's allowlist: a bad token stops the recreate the same way.
        const hostRuntime = hostRuntimeOf(replayed(HOST_RUNTIME_ENV));
        const run = {
            names: sandboxNames(flags.slug),
            image: flags.image,
            baseImage: flags.baseImage,
            memory,
            ...(cpus === undefined ? {} : { cpus }),
            hostRuntime,
            ...(sandboxId !== undefined ? { sandboxId } : {}),
            localPublish: flags.noLocalPublish !== true,
            unsupported: (flags.unsupported ?? "").split(/\s+/).filter((token) => token !== ""),
            ...runnerFacts(flags),
            env,
            // Directive lines pass through as-is; extraction and allowlist checks live in the contract.
            runtime: runtimeDirectivesOf(flags.runtime ?? ""),
            mounts: (flags.mounts ?? "").split("\n").filter((mount) => mount !== ""),
            dns: (flags.dns ?? "").split(/\s+/).filter((server) => server !== ""),
        };
        this.process.stdout.write(flags.format === "json" ? `${JSON.stringify(sandboxRunArgv(run))}\n` : `${sandboxRunCommand(run)}\n`);
    },
});
