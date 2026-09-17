import { buildCommand, type CommandContext } from "@stricli/core";
import { loadConfig } from "../env.config.js";
import { ARTIFACT_PATH } from "../lib/artifact.js";
import { columns, createOutput } from "../lib/output.js";
import { withRunLog } from "../lib/run-log.js";
import { collectDeployments, type DeploymentView } from "./deployments.js";

// The rows the command's own brief promises. `out.result` is a no-op in text mode, so a text run that printed only a
// count showed a person nothing of what it had just read. An unreachable Komodo makes every `live` false, which is a
// different fact from "Komodo does not have it", so the column says it does not know rather than saying no.
const deploymentTable = (deployments: readonly DeploymentView[], komodoReachable: boolean | undefined): string[] => {
    const live = (deployment: DeploymentView): string => (komodoReachable === false ? "?" : deployment.live ? "yes" : "no");
    return columns([
        ["LIVE", "DEPLOYMENT", "IMAGE", "URL"],
        ...deployments.map((deployment) => [live(deployment), deployment.name, deployment.image, deployment.url ?? "(no domain)"]),
    ]);
};

export const deploymentsCommand = buildCommand<{ artifact?: string }>({
    docs: { brief: "List the app deployments Komodo manages, with their desired config (read-only)" },
    parameters: {
        flags: { artifact: { kind: "parsed", parse: String, optional: true, brief: `Path to the artifact (default: ${ARTIFACT_PATH})` } },
    },
    async func(this: CommandContext, flags: { artifact?: string }) {
        const out = createOutput(withRunLog(this.process.stdout, "deployments"), loadConfig().intenticOutput);
        const { deployments, komodoReachable } = await collectDeployments(flags.artifact ?? ARTIFACT_PATH, out.log);
        if (deployments.length === 0) {
            out.text("The artifact declares no app deployments.");
        } else {
            for (const line of deploymentTable(deployments, komodoReachable)) {
                out.text(line);
            }
            if (komodoReachable === false) {
                out.text("");
                out.text("Komodo is not reachable, so these are the desired configs and LIVE is unknown for every row.");
            }
        }
        // Omitted entirely when no komodo is declared, absence must not read as "down" anywhere downstream.
        out.result({ deployments, ...(komodoReachable !== undefined ? { komodoReachable } : {}) });
    },
});
