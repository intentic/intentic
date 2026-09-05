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

/* HOW BIG THE MACHINE IS, read from where this verb happens to be standing.
 *
 * This CLI answers from inside a throwaway `docker run -i --rm` probe container that carries no --memory of its
 * own, so /proc/meminfo here reports the docker ENGINE's total: the WSL guest on Windows, the Docker Desktop VM
 * on macOS, the host itself on native Linux. In all three that is exactly the number the cap should be a share
 * of, and it costs no round-trip to the machine, because the flow was already going to start this container.
 *
 * Unreadable or unparseable means we could not measure, and localSandboxMemory() falls back to its constants
 * rather than sizing a cgroup off a guess. */
const engineMemoryBytes = (): number => {
    try {
        return Number(/^MemTotal:\s+(\d+) kB$/mu.exec(readFileSync("/proc/meminfo", "utf8"))?.[1] ?? 0) * 1024;
    } catch {
        return 0;
    }
};

// And how many cores it has, by the same argument: an uncapped probe sees the engine's own count, which is the
// ceiling a CPU ask is held to. 0 when it cannot be read, which localSandboxCpus treats as "honour the ask as typed".
const engineCpus = (): number => {
    try {
        return availableParallelism();
    } catch {
        return 0;
    }
};

/* THE OWNER'S STANDING ASKS, seeded onto a container that does not carry them yet.
 *
 * Each of these lives ON the sandbox, in the contract's replay allowlist, so every recreate reads it back off the
 * container being replaced. But "said once" needs a first time, and a container that does not carry the value
 * has nowhere to be read from. So the runner hands it to this probe as a docker `-e`, exactly once, and the
 * image writes it onto the container it emits — which is what turns `SANDBOX_MEMORY=10g ic …` (or `ic sandbox
 * reshape`) into a standing cap rather than a one-run argument.
 *
 * Three answers, read off the probe's own environment, which carries nothing the runner did not put there:
 *   - absent    ⇒ replay whatever the old container carried (the ordinary recreate)
 *   - a value   ⇒ that value, replacing the old one — a fresh ask outranks what the container carried
 *   - empty     ⇒ CLEAR it: back to the derived cap, no CPU ceiling, no owner directives. The one shape only a
 *                 deliberate `reshape … default` produces; the runners never forward a blank from their own shell.
 * Merged BEFORE the allowlist filter so the winning value is re-emitted onto the new container like any other
 * replayed pair. */
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

/* WHAT THE RUNNER DECIDED FOR THIS LAUNCH, off its flags: the four facts a recreate sets per run rather than
 * replaying (the contract's SandboxRun says why each is runner-set). Present only when the flag carried
 * something — an empty `--channel` would pin the sandbox to a channel named "" on the next update. */
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
        // Decoded here and re-encoded by the emitter: the contract's `definition` field is the TOML text,
        // so every caller (this CLI, the hosted provisioner) hands over the same thing.
        ...(given(flags.definitionB64) ? { definition: Buffer.from(flags.definitionB64, "base64").toString("utf8") } : {}),
    };
};

/* THE RUN CONTRACT, SPOKEN BY THE IMAGE, `intentic sandbox run-command`.
 *
 * The sandbox creation scripts (connect.sh, recreate.sh, connect.ps1) are standalone curl|sh files: they can
 * import nothing, so for years they hand-copied the docker-run shape behind "keep in lockstep" comments, and
 * the lockstep broke (the SYS_ADMIN drift, see @intentic/sandbox-run). This verb is how they stop copying:
 * every flow already has the target image in hand (pulled, built, or local) and the image carries this CLI,
 * so the script asks THE IMAGE ITSELF what its run command is and executes the answer. The contract ships
 * with the image, a stale script still runs a new image correctly.
 *
 * Env rides stdin as printenv -0 output (NUL-framed. HOST_SSH_KEY is a multi-line key, line framing
 * re-splits it): a recreate pipes `docker exec <old> printenv -0` straight in, connect pipes the pairs its
 * wizard collected. Filtering to the replay allowlist happens here, in TS, where it is tested.
 *
 * Output is the complete `docker run …` line, shell-quoted (--format sh, the default), or the argv as JSON
 * for PowerShell to splat (--format json). Nothing else goes to stdout, the caller executes it verbatim. */
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
        // stdin carries NAME=VALUE pairs, NUL-framed; empty input means a fresh container with no env to carry.
        // The runner's seeds (see `seeded`) are merged over it before the allowlist filter.
        const env = replayableEnv(seeded(parseNulEnv(readFileSync(0, "utf8")), process.env));
        const replayed = (name: string): string | undefined => env.find(([key]) => key === name)?.[1];
        // The loopback shortcut's port derives from the sandbox id, which derives from the connect token this
        // container is already being handed, so no flow computes an address, and a recreate reproduces the
        // same port by replaying the same token. A run with no token (bare dev) publishes nothing.
        const sandboxId = sandboxIdFromToken(replayed("CONNECT_TOKEN") ?? "");
        /* The local shape's ceilings, sized to this machine — or to the owner's own asks, replayed off the
         * container being replaced, on a machine the derived share is wrong about. The hosted shape drops them
         * entirely in the contract. Read from the ALLOWLISTED pairs, not the raw stdin dump, so each var has to
         * earn its place in REPLAY_ENV to be honoured, and is re-emitted for the next recreate. */
        const memory = localSandboxMemory(engineMemoryBytes(), replayed("SANDBOX_MEMORY"));
        const cpus = localSandboxCpus(engineCpus(), replayed("SANDBOX_CPUS"));
        // The owner's own directives, from the same allowlist the overlay's are held to: a bad token stops the
        // recreate by name here exactly as an overlay's would.
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
            // The caller hands the directive LINES through; extraction + allowlist validation both live in the
            // contract, so a typo'd or smuggled token stops the recreate with its name.
            runtime: runtimeDirectivesOf(flags.runtime ?? ""),
            mounts: (flags.mounts ?? "").split("\n").filter((mount) => mount !== ""),
            dns: (flags.dns ?? "").split(/\s+/).filter((server) => server !== ""),
        };
        this.process.stdout.write(flags.format === "json" ? `${JSON.stringify(sandboxRunArgv(run))}\n` : `${sandboxRunCommand(run)}\n`);
    },
});
