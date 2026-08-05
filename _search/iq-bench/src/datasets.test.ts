import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { anchorsOf } from "./anchors.js";
import { monorepoRoot, packageRoot } from "./repos.js";
import { QueryDatasetSchema } from "./schema.js";

// The intentic corpus IS this checkout, so its golden anchors decay every time the tree moves — and silently: a
// stale anchor scores zero for every config at once, which reads as a hard case rather than a broken label. The
// external repos are pinned at a locked SHA and cannot drift, so this guard is only about the live one.
const dataset = QueryDatasetSchema.parse(JSON.parse(readFileSync(join(packageRoot, "datasets/intentic.queries.json"), "utf8")));

describe("intentic golden anchors", () => {
    it("name files that still exist", () => {
        const missing = dataset.cases.flatMap((queryCase) =>
            queryCase.expected.filter((anchor) => !existsSync(join(monorepoRoot, anchor.file))).map((anchor) => `${queryCase.id} → ${anchor.file}`),
        );
        expect(missing).toEqual([]);
    });

    // def/sym lines are DERIVED from the tree rather than stored, so this cannot fail on a line that merely moved
    // — only on a symbol that left the file it is anchored to, or one the file now declares twice. Both are real
    // label breakage, and both name themselves in the thrown message.
    it("name a symbol each anchored file declares exactly once", () => {
        const unresolved = dataset.cases
            .filter((queryCase) => queryCase.verb === "def" || queryCase.verb === "sym")
            .flatMap((queryCase) => {
                try {
                    anchorsOf(queryCase, monorepoRoot);
                    return [];
                } catch (error) {
                    return [`${queryCase.id}: ${(error as Error).message}`];
                }
            });
        expect(unresolved).toEqual([]);
    });
});
