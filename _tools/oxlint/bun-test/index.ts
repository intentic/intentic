import { eslintCompatPlugin } from "@oxlint/plugins";

import { expectExpectRule } from "./rules/expect-expect.ts";
import { noDisabledTestsRule } from "./rules/no-disabled-tests.ts";
import { noFocusedTestsRule } from "./rules/no-focused-tests.ts";
import { noIdenticalTitleRule } from "./rules/no-identical-title.ts";
import { noRestrictedMatchersRule } from "./rules/no-restricted-matchers.ts";
import { noStandaloneExpectRule } from "./rules/no-standalone-expect.ts";

/** Test hygiene for suites that import from "bun:test", which oxlint's own jest/vitest rules cannot see. */
const bunTestPlugin = eslintCompatPlugin({
    meta: { name: "bun-test" },
    rules: {
        "expect-expect": expectExpectRule,
        "no-disabled-tests": noDisabledTestsRule,
        "no-focused-tests": noFocusedTestsRule,
        "no-identical-title": noIdenticalTitleRule,
        "no-restricted-matchers": noRestrictedMatchersRule,
        "no-standalone-expect": noStandaloneExpectRule,
    },
});

export default bunTestPlugin;
