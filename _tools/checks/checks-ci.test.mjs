import assert from "node:assert/strict";
import { test } from "node:test";
import { blocksCi, CHECKS, CI_BLOCKING, CI_REPORTED } from "./manifest.mjs";

test("every check is classified for CI exactly once, with a reason", () => {
    const ids = CHECKS.map(({ id }) => id).toSorted();
    const classified = [...Object.keys(CI_BLOCKING), ...Object.keys(CI_REPORTED)].toSorted();
    assert.deepEqual(classified, ids);
    for (const reason of [...Object.values(CI_BLOCKING), ...Object.values(CI_REPORTED)]) {
        assert.match(reason, /\S/);
    }
});

test("blocksCi answers from the blocking list alone", () => {
    assert.equal(blocksCi("lockfile"), true);
    assert.equal(blocksCi("i18n-keys"), false);
    assert.equal(blocksCi("code-shape"), false);
    assert.equal(blocksCi("no-such-check"), false);
});
