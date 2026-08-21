import { buildCommand, type CommandContext } from "@stricli/core";
import { outputAliases, outputFlagParameters, scopeFlagParameters, type SearchFlags } from "../lib/flags.js";
import { runMulti } from "../lib/run.js";

export const multi = buildCommand({
    docs: { brief: "Batch queries in one spawn, one query per argument (or per stdin line), shared --budget" },
    parameters: {
        flags: { ...scopeFlagParameters, ...outputFlagParameters },
        aliases: outputAliases,
        positional: {
            kind: "array",
            parameter: { parse: String, brief: "A query, optionally led by a verb: 'def foo', 'refs bar --kind call'", placeholder: "query" },
        },
    },
    async func(this: CommandContext, flags: SearchFlags, ...queries: string[]) {
        await runMulti(this, flags, queries);
    },
});
