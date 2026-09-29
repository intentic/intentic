import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { anchorsOf } from "./anchors.js";
import { monorepoRoot, packageRoot } from "./repos.js";
import { QueryDatasetSchema } from "./schema.js";

// The intentic corpus IS this checkout, so its golden anchors decay every time the tree moves, and silently: a
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
    //: only on a symbol that left the file it is anchored to, or one the file now declares twice. Both are real
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

// A no-answer case is scored by whether iq said "weak", an answerable one by where its anchors ranked; a case holding
// both, or neither, would be scored by the wrong rule, so the schema refuses it rather than the report guessing.
describe("every dataset", () => {
    const datasets = readdirSync(join(packageRoot, "datasets")).filter((name) => name.endsWith(".queries.json"));

    it("parses, with anchors on every answerable case and none on a no-answer one", () => {
        const refused = datasets.flatMap((name) => {
            const parsed = QueryDatasetSchema.safeParse(JSON.parse(readFileSync(join(packageRoot, "datasets", name), "utf8")));
            return parsed.success ? [] : [`${name}: ${parsed.error.message}`];
        });
        expect(refused).toEqual([]);
    });

    it("refuses a no-answer case that names an anchor, and an answerable case that names none", () => {
        const accepts = (queryCase: object): boolean =>
            QueryDatasetSchema.safeParse({ repo: "r", cases: [{ id: "c", verb: "q", query: "anything", ...queryCase }] }).success;
        expect(accepts({ slices: ["no-answer"], expected: [{ file: "a.ts" }] })).toBe(false);
        expect(accepts({ expected: [] })).toBe(false);
        expect(accepts({ slices: ["no-answer"], expected: [] })).toBe(true);
        expect(accepts({ slices: ["paraphrase"], expected: [{ file: "a.ts" }] })).toBe(true);
    });
});
