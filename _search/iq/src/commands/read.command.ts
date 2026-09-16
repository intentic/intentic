import { buildCommand, type CommandContext } from "@stricli/core";
import { outputAliases, outputFlagParameters, scopeFlagParameters, type SearchFlags } from "../lib/flags.js";
import { runSearch } from "../lib/run.js";

export const read = buildCommand({
    docs: { brief: "Read a symbol's body by name, no line number needed" },
    parameters: {
        flags: { ...scopeFlagParameters, ...outputFlagParameters },
        aliases: outputAliases,
        positional: {
            kind: "tuple",
            parameters: [{ parse: String, brief: "name, path::name, or path::Outer::method", placeholder: "symbol" }],
        },
    },
    async func(this: CommandContext, flags: SearchFlags, symbol: string) {
        await runSearch(this, "read", symbol, flags, {});
    },
});
