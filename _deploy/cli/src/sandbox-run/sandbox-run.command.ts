import { readFileSync } from "node:fs";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { parseNulEnv, replayableEnv, runtimeDirectivesOf, sandboxNames, sandboxRunArgv, sandboxRunCommand } from "@intentic/sandbox-run";
import { buildCommand, type CommandContext } from "@stricli/core";

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
        const env = replayableEnv(parseNulEnv(readFileSync(0, "utf8")));
        // The loopback shortcut's port derives from the sandbox id, which derives from the connect token this
        // container is already being handed, so no flow computes an address, and a recreate reproduces the
        // same port by replaying the same token. A run with no token (bare dev) publishes nothing.
        const sandboxId = sandboxIdFromToken(env.find(([name]) => name === "CONNECT_TOKEN")?.[1] ?? "");
        const run = {
            names: sandboxNames(flags.slug),
            image: flags.image,
            baseImage: flags.baseImage,
            ...(sandboxId !== undefined ? { sandboxId } : {}),
            localPublish: flags.noLocalPublish !== true,
            unsupported: (flags.unsupported ?? "").split(/\s+/).filter((token) => token !== ""),
            ...(flags.environmentHash !== undefined && flags.environmentHash !== "" ? { environmentHash: flags.environmentHash } : {}),
            ...(flags.channel !== undefined && flags.channel !== "" ? { channel: flags.channel } : {}),
            ...(flags.previousImage !== undefined && flags.previousImage !== "" ? { previousImage: flags.previousImage } : {}),
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
