import { join } from "node:path";
import { DEFAULT_TEMPLATE_REF, DEFAULT_TEMPLATE_SOURCE, scaffoldMonorepo } from "@intentic/scaffold";
import { buildCommand, type CommandContext } from "@stricli/core";
import { loadConfig } from "../env.config.js";
import { createOutput } from "../lib/output.js";

interface MonorepoFlags {
    dir?: string;
    name: string;
    source?: string;
    ref?: string;
}

// Scaffold an EMPTY pnpm+turbo monorepo (shell + shared packages, git-inited, no apps) at <dir>/<name>. Apps are
// added into it afterwards with `add-app`. Shells to @intentic/scaffold, which fetches the source and lays the
// shell down verbatim.
export const monorepoCommand = buildCommand<MonorepoFlags>({
    docs: { brief: "Scaffold an empty pnpm+turbo monorepo at <dir>/<name>" },
    parameters: {
        flags: {
            dir: { kind: "parsed", parse: String, optional: true, brief: "Directory holding the workspace repos (default: .)" },
            name: { kind: "parsed", parse: String, brief: "Monorepo name, becomes the repo directory name" },
            source: { kind: "parsed", parse: String, optional: true, brief: `Template source git URL (default: ${DEFAULT_TEMPLATE_SOURCE})` },
            ref: { kind: "parsed", parse: String, optional: true, brief: `Template source branch/tag (default: ${DEFAULT_TEMPLATE_REF})` },
        },
    },
    async func(this: CommandContext, flags: MonorepoFlags) {
        const out = createOutput(this.process.stdout, loadConfig().intenticOutput);
        const repoDir = join(flags.dir ?? ".", flags.name);
        await scaffoldMonorepo({
            repoDir,
            source: flags.source ?? DEFAULT_TEMPLATE_SOURCE,
            ref: flags.ref ?? DEFAULT_TEMPLATE_REF,
        });
        out.text(`created empty monorepo ${flags.name} at ${repoDir}`);
        out.result({ name: flags.name, dir: repoDir });
    },
});
