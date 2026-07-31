import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { monorepoRoot, packageRoot } from "./repos.js";
import { QueryDatasetSchema } from "./schema.js";
import { DEFAULT_TOLERANCE } from "./score.js";

// The intentic corpus IS this checkout, so its golden anchors drift every time the tree moves — and silently: a
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

    // A `def`/`sym` query names a symbol, so its anchor is mechanically checkable: the name has to appear inside
    // the window the scorer accepts. Where the answer to a `q` is written is a judgement call and stays the
    // dataset author's.
    it("keep def/sym symbols inside the window the scorer accepts", () => {
        const drifted: string[] = [];
        for (const queryCase of dataset.cases) {
            if (queryCase.verb !== "def" && queryCase.verb !== "sym") {
                continue;
            }
            for (const anchor of queryCase.expected) {
                const line = anchor.line;
                if (line === undefined) {
                    continue;
                }
                const tolerance = anchor.tolerance ?? DEFAULT_TOLERANCE;
                const lines = readFileSync(join(monorepoRoot, anchor.file), "utf8").split("\n");
                const window = lines.slice(Math.max(0, line - 1 - tolerance), line + tolerance);
                if (!window.some((text) => text.includes(queryCase.query))) {
                    drifted.push(`${queryCase.id}: "${queryCase.query}" is not within ±${tolerance} of ${anchor.file}:${line}`);
                }
            }
        }
        expect(drifted).toEqual([]);
    });
});
