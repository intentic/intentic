import { codeLineStat } from "@intentic/code-read";
import { grammars } from "@intentic/code-read/grammars";
import { edited, typescriptModule } from "../fixtures.js";
import type { Scenario } from "../scenario.js";

export const scenario: Scenario = {
    what: "the review row's comment-free line counts (codeLineStat): both sides of a 40-function .ts file, walked by Shiki's tokenizer where they differ",
    setup: async () => {
        const before = typescriptModule(1, 40);
        const after = edited(before);
        // The counting worker is long-lived, so the count is of a warm tokenizer: a same-sized file of other text goes first.
        const other = typescriptModule(2, 40);
        await codeLineStat(other, edited(other), "src/rows.ts", grammars);
        return async () => {
            const count = await codeLineStat(before, after, "src/rows.ts", grammars);
            if (count === undefined || !("stat" in count) || count.stat.additions === 0) {
                throw new Error(`codeLineStat gave up or saw no change: ${JSON.stringify(count)}`);
            }
            return count;
        };
    },
};
