import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shrunkSurfaces } from "@intentic/constants/contract-shrink";
import { packageRoot } from "@intentic/constants/node";
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

// The wire outside oRPC is pinned the same way: a changed tunnel path, a gone control message or a renamed verdict is a
// shrink the push gate and the landing draft both flag, where before nothing could see it.
test("the lock flags a change to the wire no oRPC route carries", () => {
    const base = currentLock() as Record<string, Record<string, unknown>>;
    const moved = structuredClone(base);
    (moved["wire:tunnel"] as { path: string }).path = "/tunnel/v3";
    delete (moved["wire:browser-wire"] as { webTransport?: unknown }).webTransport;
    expect(shrunkSurfaces(base, moved)).toEqual(["wire:browser-wire.webTransport", "wire:tunnel.path"]);
    expect(shrunkSurfaces(moved, base)).toEqual(["wire:tunnel.path"]);
});
