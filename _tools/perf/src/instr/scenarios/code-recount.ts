import { codeLineStat } from "@intentic/code-read";
import { grammars } from "@intentic/code-read/grammars";
import { edited, typescriptModule } from "../fixtures.js";
import type { Scenario } from "../scenario.js";

export const scenario: Scenario = {
    what: "the counting worker's recount of a file saved again: the lines both sides open with are walked once",
    setup: async () => {
        const before = typescriptModule(1, 40);
        const saved = edited(before);
        const savedAgain = `${saved}\nexport const extra = 1;\n`;
        const other = typescriptModule(2, 40);
        if ((await codeLineStat(other, edited(other), "src/rows.ts", grammars)) === undefined) {
            throw new Error("the warm-up count gave up, so the work would start from a cold tokenizer");
        }
        if ((await codeLineStat(before, saved, "src/rows.ts", grammars)) === undefined) {
            throw new Error("the first count gave up, so the recount would not start from a counted save");
        }
        return async () => {
            const count = await codeLineStat(before, savedAgain, "src/rows.ts", grammars);
            if (count === undefined || !("stat" in count) || count.stat.additions === 0) {
                throw new Error(`codeLineStat gave up or saw no change: ${JSON.stringify(count)}`);
            }
            return count;
        };
    },
};
