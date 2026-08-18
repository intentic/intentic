import { buildCommand, type CommandContext } from "@stricli/core";
import { outputAliases, outputFlagParameters, scopeFlagParameters, type SearchFlags } from "../lib/flags.js";
import { runSearch } from "../lib/run.js";

export const impact = buildCommand({
    docs: { brief: "What a change reaches: the files one import hop either side of it, and which of them are tests" },
    parameters: {
        flags: { ...scopeFlagParameters, ...outputFlagParameters },
        aliases: outputAliases,
        positional: {
            kind: "tuple",
            parameters: [
                {
                    parse: String,
                    optional: true,
                    brief: "Comma-separated paths to ask about (default: your uncommitted changes)",
                    placeholder: "paths",
                },
            ],
        },
    },
    async func(this: CommandContext, flags: SearchFlags, paths?: string) {
        await runSearch(this, "impact", paths ?? "", flags, {});
    },
});
