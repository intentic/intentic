import { ignoreWalk } from "../ignore-tree.js";
import type { Scenario } from "../scenario.js";

export const scenario: Scenario = {
    what: "the same ignore check on a repeat walk, where the compiled matchers and their per-path answers are already cached",
    setup: () => {
        const walk = ignoreWalk();
        walk();
        return walk;
    },
};
