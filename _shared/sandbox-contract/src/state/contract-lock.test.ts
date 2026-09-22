import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import { test, expect } from "bun:test";
import { currentLock } from "./contract-lock.js";

// contract.lock.json must match the exported schemas; the git-aware half of this check lives in contract-shrink.mjs.
// Needs 30s: serializing ~500 schemas can run past the unit hang detector under load.
test(
    "contract.lock.json matches the schemas this package exports",
    () => {
        const committed = JSON.parse(readFileSync(join(packageRoot(import.meta.url), "contract.lock.json"), "utf8")) as Record<string, unknown>;
        expect(
            currentLock(),
            "the wire contract moved — run `pnpm --filter @intentic/sandbox-contract lock` and commit contract.lock.json with this change. " +
                "If a schema or field was removed or changed (not added), land it as a `type!:` commit with a `Breaking-Note:` trailer " +
                "saying, in the user's words, what stops working and what to do instead.",
        ).toEqual(committed);
    },
    { timeout: 30_000 },
);
