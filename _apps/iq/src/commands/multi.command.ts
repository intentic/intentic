import { buildCommand, type CommandContext } from "@stricli/core";
import { outputAliases, outputFlagParameters, scopeFlagParameters, type SearchFlags } from "../lib/flags.js";
import { runMulti } from "../lib/run.js";

export const multi = buildCommand({
    docs: { brief: "Batch queries in one spawn — one query per stdin line, shared --budget" },
    parameters: {
        flags: { ...scopeFlagParameters, ...outputFlagParameters },
        aliases: outputAliases,
        positional: { kind: "tuple", parameters: [] },
    },
    async func(this: CommandContext, flags: SearchFlags) {
        await runMulti(this, flags);
    },
});
