import { buildCommand, type CommandContext } from "@stricli/core";
import { outputAliases, outputFlagParameters, scopeFlagParameters, type SearchFlags } from "../lib/flags.js";
import { runSearch } from "../lib/run.js";

export const map = buildCommand({
    docs: { brief: "The repo's skeleton: files ranked by importance, each with its exported signatures" },
    parameters: {
        flags: { ...scopeFlagParameters, ...outputFlagParameters },
        aliases: outputAliases,
        positional: { kind: "tuple", parameters: [] },
    },
    async func(this: CommandContext, flags: SearchFlags) {
        await runSearch(this, "map", "", flags, {});
    },
});
