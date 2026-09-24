import { fuzzyRanker } from "@intentic/base/fuzzy";
import { repoPaths } from "../fixtures.js";
import type { Scenario } from "../scenario.js";

// The same keystrokes as fuzzy-rank, through the ranker quick-open keeps between them.
const TYPED = "sandbox/sessionstore";

export const scenario: Scenario = {
    what: "quick-open as typed (fuzzyRanker): 20 keystrokes over 20,000 paths, each scoring only what the last one matched",
    setup: () => {
        const paths = repoPaths(3, 20_000);
        return () => {
            const rank = fuzzyRanker();
            let last = 0;
            for (let length = 1; length <= TYPED.length; length++) {
                last = rank(TYPED.slice(0, length), paths).length;
            }
            if (last === 0) {
                throw new Error(`"${TYPED}" matched no path`);
            }
            return last;
        };
    },
};
