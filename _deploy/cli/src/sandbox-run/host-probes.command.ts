import { hostRuntimeOf, OPTIONAL_DIRECTIVES, runtimeDirectivesOf } from "@intentic/sandbox-run";
import { buildCommand, type CommandContext } from "@stricli/core";

// Emits one TSV line (token, probe kind, name) per optional directive an overlay asks for, so recreate.sh's script
// never needs the directive list itself. A probe is a kind+name, never a shell string: the output is piped into sh.
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
        // Same allowlist as the run itself, so a bad token fails identically here; both sources are probed.
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
