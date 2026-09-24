import { codeLineStat, rememberAnalyses } from "@intentic/code-read";
import { analyze } from "@intentic/code-read/grammars";
import { edited, typescriptModule } from "../fixtures.js";
import type { Scenario } from "../scenario.js";

export const scenario: Scenario = {
    what: "the counting worker's recount of a file saved again (rememberAnalyses): the unchanged side is not tokenized twice",
    setup: async () => {
        const before = typescriptModule(1, 40);
        const saved = edited(before);
        const savedAgain = `${saved}\nexport const extra = 1;\n`;
        await analyze(typescriptModule(2, 40), "typescript");
        const remembered = rememberAnalyses(analyze, 4_000_000);
        await codeLineStat(before, saved, "src/rows.ts", remembered);
        return async () => {
            const stat = await codeLineStat(before, savedAgain, "src/rows.ts", remembered);
            if (stat === undefined || stat.additions === 0) {
                throw new Error(`codeLineStat gave up or saw no change: ${JSON.stringify(stat)}`);
            }
            return stat;
        };
    },
};
