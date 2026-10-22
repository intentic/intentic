import { parseJsonWith } from "@intentic/base/json";
import type { AcpAgentConfig, CapabilityStatus } from "@intentic/sandbox-contract/schemas/capabilities";
import { z } from "zod";
import { runCheck } from "../../workload/run-check.js";
import { parseEnvBlock, splitCommand } from "../acp/acp-spawn.js";

const modelsResponse = z.object({
    type: z.literal("response"),
    id: z.literal("intentic-pi-probe"),
    success: z.literal(true),
    data: z.object({ models: z.array(z.object({ provider: z.string(), id: z.string() })) }),
});

// A read-only RPC exchange, with no prompt or saved session. EOF shuts Pi down after its responses. Discovery is off
// so a status read loads no workspace extensions and makes no catalog-refresh requests. A missing binary must still
// let the capability be saved: only then can its image fragment join the rebuild that installs it.
export const probePiAgent = async (config: AcpAgentConfig, cwd: string): Promise<CapabilityStatus> => {
    const argv = splitCommand(config.command);
    if (argv[0] === "") {
        throw new Error("Pi command is empty");
    }
    const outcome = await runCheck({
        argv: [
            ...argv,
            "--mode",
            "rpc",
            "--no-session",
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
            "--no-context-files",
            "--offline",
        ],
        cwd,
        env: { ...process.env, ...parseEnvBlock(config.env) },
        timeoutMs: 15_000,
        workload: { class: "command" },
        kind: "probe",
        captureBytes: 1_048_576,
        stdin: `${JSON.stringify({ id: "intentic-pi-probe", type: "get_available_models" })}\n`,
    });
    if (outcome.spawnError?.includes("ENOENT")) {
        return { state: "pending", detail: "Pi is not installed yet. Rebuild the sandbox from Sandbox > Environment, then sign in to Pi." };
    }
    if (outcome.exitCode !== 0) {
        throw new Error(
            `Pi RPC probe failed: ${outcome.spawnError ?? outcome.ended ?? (outcome.stderr.trim() || `exit ${outcome.exitCode ?? "unknown"}`)}`,
        );
    }
    for (const line of outcome.stdout.split("\n")) {
        const response = parseJsonWith(line, modelsResponse);
        if (response !== undefined) {
            return response.data.models.length === 0
                ? {
                      state: "pending",
                      detail: "Pi needs a model provider. Open Sign in, run /login (for Claude, /login anthropic), then choose a model with /model.",
                  }
                : { state: "active", detail: `Pi RPC · ${response.data.models.length} model${response.data.models.length === 1 ? "" : "s"}` };
        }
    }
    throw new Error("Pi did not answer get_available_models over RPC. Check the command and rebuild to install the current Pi CLI.");
};
