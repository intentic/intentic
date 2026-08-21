import { buildCommand, type CommandContext } from "@stricli/core";
import { outputAliases, outputFlagParameters, scopeFlagParameters, type SearchFlags } from "../lib/flags.js";
import { runSearch } from "../lib/run.js";

export const outline = buildCommand({
    docs: { brief: "A file's skeleton, signatures + doc first-lines, without reading the file" },
    parameters: {
        flags: { ...scopeFlagParameters, ...outputFlagParameters },
        aliases: outputAliases,
        positional: { kind: "tuple", parameters: [{ parse: String, brief: "Workspace-relative file path", placeholder: "path" }] },
    },
    async func(this: CommandContext, flags: SearchFlags, path: string) {
        await runSearch(this, "outline", path, flags, {});
    },
});
