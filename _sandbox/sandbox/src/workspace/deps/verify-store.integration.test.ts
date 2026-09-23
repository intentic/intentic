import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileVerifyStore, freshFailures } from "./verify-store.js";

// What a red names as new decides whether a land is sent back for it, so a standing failure must never read as fresh.

test("a copy of a failure beyond what the last red held is fresh, the held copies are not", () => {
    expect(freshFailures(["a", "a", "b"], ["a"])).toEqual(["a", "b"]);
    expect(freshFailures(["a"], ["a", "a"])).toEqual([]);
});

test("the first red names everything it failed on; the next names only what appeared since; green starts over", async () => {
    const store = fileVerifyStore(join(await mkdtemp(join(tmpdir(), "verify-store-")), "verify.json"));
    expect(await store.record("app", "red", 1, ["x", "y"])).toEqual({ edge: "broken", attempt: 1, fresh: ["x", "y"] });
    expect(await store.record("app", "red", 2, ["x", "y", "z"])).toEqual({ edge: "broken", attempt: 2, fresh: ["z"] });
    expect(await store.record("app", "red", 3)).toEqual({ edge: "broken", attempt: 3 });
    expect(await store.record("app", "green", 4)).toEqual({ edge: "fixed", attempt: 0 });
    expect(await store.record("app", "red", 5, ["x"])).toEqual({ edge: "broken", attempt: 1, fresh: ["x"] });
});
