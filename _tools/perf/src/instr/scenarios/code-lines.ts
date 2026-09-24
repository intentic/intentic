import { codeLineStat } from "@intentic/code-read";
import { analyze } from "@intentic/code-read/grammars";
import { edited, typescriptModule } from "../fixtures.js";
import type { Scenario } from "../scenario.js";

export const scenario: Scenario = {
    what: "the review row's comment-free line counts (codeLineStat): both sides of a 40-function .ts file tokenized by Shiki",
    setup: async () => {
        const before = typescriptModule(1, 40);
        const after = edited(before);
        // The grammar loads once per process; loading it here keeps the one-off load out of the count.
        await analyze("const warm = 1;\n", "typescript");
        return async () => {
            const stat = await codeLineStat(before, after, "src/rows.ts", analyze);
            if (stat === undefined || stat.additions === 0) {
                throw new Error(`codeLineStat gave up or saw no change: ${JSON.stringify(stat)}`);
            }
            return stat;
        };
    },
};
