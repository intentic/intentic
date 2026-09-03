import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { currentLock } from "./contract-lock.js";

/* The committed lock and the code must say the same thing: see contract-lock.ts for what the pair buys.
 *
 * This is the HALF that runs everywhere the tests run; the other half (a shrunk lock needs a declared break)
 * lives in _tools/checks/contract-shrink.mjs, which has git and this suite does not.
 *
 * ITS OWN BUDGET, because the default one is a HANG DETECTOR and this test does real work: it serializes every
 * schema this package exports, ~500 of them, to JSON Schema. That is ~100ms with the machine to itself and it
 * measured 8.8s on a runner running every package's suite at once, so vitest's 5s default failed it as a hang
 * over a contract that had not moved: green on a box, red on a busy runner, the trap _tools/testing/src/vitest
 * .ts is written against. 30s is well clear of the work and still reports a genuine hang inside half a minute. */
test("contract.lock.json matches the schemas this package exports", { timeout: 30_000 }, () => {
    const committed: unknown = JSON.parse(readFileSync(new URL("../contract.lock.json", import.meta.url), "utf8"));
    expect(
        currentLock(),
        "the wire contract moved — run `pnpm --filter @intentic/sandbox-contract lock` and commit contract.lock.json with this change. " +
            "If a schema or field was removed or changed (not added), land it as a `type!:` commit with a `Breaking-Note:` trailer " +
            "saying, in the user's words, what stops working and what to do instead.",
    ).toEqual(committed);
});
