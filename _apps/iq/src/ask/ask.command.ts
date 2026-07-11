import { buildCommand, type CommandContext } from "@stricli/core";
import { outputAliases, outputFlagParameters, scopeFlagParameters, type SearchFlags } from "../lib/flags.js";
import { runSearch } from "../lib/run.js";

export const ask = buildCommand({
    docs: { brief: "Natural-language semantic search over code and docs" },
    parameters: {
        flags: { ...scopeFlagParameters, ...outputFlagParameters },
        aliases: outputAliases,
        positional: { kind: "tuple", parameters: [{ parse: String, brief: "A question about the codebase", placeholder: "question" }] },
    },
    async func(this: CommandContext, flags: SearchFlags, question: string) {
        await runSearch(this, "ask", question, flags, {});
    },
});
