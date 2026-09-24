import { rankByFuzzy } from "@intentic/base/fuzzy";
import { repoPaths } from "../fixtures.js";
import type { Scenario } from "../scenario.js";

// Typed one character at a time, as quick-open re-ranks on every keystroke.
const TYPED = "sandbox/sessionstore";

export const scenario: Scenario = {
    what: "quick-open ranking (rankByFuzzy): 20 keystrokes, each re-ranking 20,000 paths",
    setup: () => {
        const paths = repoPaths(3, 20_000);
        return () => {
            let last = 0;
            for (let length = 1; length <= TYPED.length; length++) {
                last = rankByFuzzy(TYPED.slice(0, length), paths).length;
            }
            if (last === 0) {
                throw new Error(`"${TYPED}" matched no path`);
            }
            return last;
        };
    },
};
