import { buildCommand, type CommandContext } from "@stricli/core";
import { outputAliases, outputFlagParameters, scopeFlagParameters, type SearchFlags } from "../lib/flags.js";
import { runSearch } from "../lib/run.js";

export const def = buildCommand({
    docs: { brief: "Where is a symbol defined" },
    parameters: {
        flags: { ...scopeFlagParameters, ...outputFlagParameters },
        aliases: outputAliases,
        positional: { kind: "tuple", parameters: [{ parse: String, brief: "Symbol name", placeholder: "symbol" }] },
    },
    async func(this: CommandContext, flags: SearchFlags, symbol: string) {
        await runSearch(this, "def", symbol, flags, {});
    },
});
