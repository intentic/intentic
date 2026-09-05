import { hostRuntimeOf, OPTIONAL_DIRECTIVES, runtimeDirectivesOf } from "@intentic/sandbox-run";
import { buildCommand, type CommandContext } from "@stricli/core";

/* WHICH OF AN OVERLAY'S ASKS THE HOST HAS TO BE QUIZZED ABOUT, `intentic sandbox host-probes`.
 *
 * The second half of the "ask the image" road (see sandbox-run.command.ts). A creation flow runs on a host and
 * therefore CAN interrogate that host's docker; what it cannot do is know which directives are worth
 * interrogating it about, because that list lives in TypeScript and the flows include a standalone curl|sh
 * script. So the image tells it: one line per optional directive the overlay actually asks for.
 *
 *     --gpus=all<TAB>runtime<TAB>nvidia
 *
 * The flow interprets the two probe kinds (~10 lines of sh, ~3 of TS), runs them, and passes the failures back
 * as `run-command --unsupported`. Adding a directive to the table therefore changes NO flow, which is the
 * whole point, and the property the first cut of this lacked: it hard-coded one token across five files.
 *
 * A probe is a KIND plus a name, never a shell string. The consumer is a script people pipe from curl into sh,
 * and a table that could inject commands into it is a table worth attacking. Output is TSV because the sh side
 * reads it with `while IFS=' ' read`, and nothing in the vocabulary can contain a tab. */
export const hostProbesCli = buildCommand<{ runtime?: string; hostRuntime?: string }>({
    docs: { brief: "Print the host probes for the optional runtime directives an overlay asks for (used by recreate.sh)" },
    parameters: {
        flags: {
            runtime: {
                kind: "parsed",
                parse: String,
                optional: true,
                brief: "The overlay's '# intentic:runtime' directive lines, verbatim, same input as run-command",
            },
            hostRuntime: {
                kind: "parsed",
                parse: String,
                optional: true,
                brief: "The owner's own directive tokens (the container's SANDBOX_RUNTIME), space-separated: probed alongside the overlay's",
            },
        },
    },
    func(this: CommandContext, flags) {
        // Validated through the same allowlist as the run itself: a flow must never probe for a directive the
        // run would then refuse, and an overlay with a bad token should fail here exactly as it fails there.
        // Both sources, because the run carries their union and a GPU the owner asked for is dropped on a host
        // without one exactly as the docker card's would be — so it has to be asked about the same way.
        const asked = new Set([...runtimeDirectivesOf(flags.runtime ?? ""), ...hostRuntimeOf(flags.hostRuntime)]);
        for (const entry of OPTIONAL_DIRECTIVES) {
            if (!asked.has(entry.token)) {
                continue;
            }
            const target = entry.probe.kind === "runtime" ? entry.probe.name : entry.probe.path;
            this.process.stdout.write(`${entry.token}\t${entry.probe.kind}\t${target}\n`);
        }
    },
});
