import { ignoreWalk } from "../ignore-tree.js";
import type { Scenario } from "../scenario.js";

export const scenario: Scenario = {
    what: "the workspace walk's ignore check (IgnoreScope.isIgnored), first walk: 8,000 monorepo-shaped paths under two .gitignore layers",
    setup: ignoreWalk,
};
