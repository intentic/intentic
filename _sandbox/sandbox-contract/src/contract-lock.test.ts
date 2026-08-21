import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { currentLock } from "./contract-lock.js";

/* The committed lock and the code must say the same thing: see contract-lock.ts for what the pair buys.
 *
 * This is the HALF that runs everywhere the tests run; the other half (a shrunk lock needs a declared break)
 * lives in prepass.mjs, which has git and this suite does not. */
test("contract.lock.json matches the schemas this package exports", () => {
    const committed: unknown = JSON.parse(readFileSync(new URL("../contract.lock.json", import.meta.url), "utf8"));
    expect(
        currentLock(),
        "the wire contract moved — run `pnpm --filter @intentic/sandbox-contract lock` and commit contract.lock.json with this change. " +
            "If a schema or field was removed or changed (not added), land it as a `type!:` commit with a `Breaking-Note:` trailer " +
            "saying, in the user's words, what stops working and what to do instead.",
    ).toEqual(committed);
});
