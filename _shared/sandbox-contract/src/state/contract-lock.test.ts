import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shrunkSurfaces } from "@intentic/constants/contract-shrink";
import { packageRoot } from "@intentic/constants/node";
import { RAW_ROUTE_LIST } from "../protocol/raw-routes.js";
import type { RouteMeta } from "../protocol/route-meta.js";
import { accessChanges, currentLock, serializeLock } from "./contract-lock.js";

const committedText = (): string => readFileSync(join(packageRoot(import.meta.url), "contract.lock.json"), "utf8");

const ACCESS_MOVED =
    "a route's access moved — run `pnpm --filter @intentic/sandbox-contract lock` and commit contract.lock.json with this change. " +
    "Any change to an existing route's reach (a lower floor, a guest, agent, panel or sync grant, a wider control rung, or a " +
    "tighter one that locks callers out) lands as a `type!:` commit with a `Breaking-Note:` trailer saying who can now reach " +
    "what, or who no longer can.";

// contract.lock.json must match the exported schemas; the git-aware half of this check lives in contract-shrink.mjs.
// Needs 30s: serializing ~500 schemas can run past the unit hang detector under load.
test(
    "contract.lock.json matches the schemas this package exports",
    () => {
        const committed = committedText();
        const current = currentLock();
        // Named first, so a reach change says which route before the whole-lock diff does.
        expect(accessChanges(committed, serializeLock(current)), ACCESS_MOVED).toEqual([]);
        expect(
            current,
            "the wire contract moved — run `pnpm --filter @intentic/sandbox-contract lock` and commit contract.lock.json with this change. " +
                "If a schema or field was removed or changed (not added), land it as a `type!:` commit with a `Breaking-Note:` trailer " +
                "saying, in the user's words, what stops working and what to do instead.",
        ).toEqual(JSON.parse(committed));
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

// The lock as it would be with one raw route declared otherwise: the declaration is swapped in place, and back.
const lockWith = (name: string, change: (declared: RouteMeta) => RouteMeta): Record<string, unknown> => {
    const route = RAW_ROUTE_LIST.find((candidate) => candidate.name === name);
    if (route === undefined) {
        throw new Error(`${name} is gone; pick another raw route with a maintainer floor and no grants`);
    }
    const declared = route.meta;
    Reflect.set(route, "meta", change(declared));
    try {
        return currentLock();
    } finally {
        Reflect.set(route, "meta", declared);
    }
};

const ROUTE = "POST /system/sync/report";

// A lowered floor on any route, not only the ones route-reach.test.ts pins: the lock check names it, and the push gate and
// the landing draft read it as a shrink that needs a declared break.
test("lowering one route's floor fails the lock check, naming the route", () => {
    const committed = currentLock();
    const lowered = lockWith(ROUTE, (declared) => ({ ...declared, floor: "viewer" }));
    expect(accessChanges(serializeLock(committed), serializeLock(lowered))).toEqual([`${ROUTE}: floor "maintainer" → "viewer"`]);
    expect(shrunkSurfaces(committed, lowered)).toEqual([`access:${ROUTE}.floor`]);
});

// A grant a route never declared still has a value in the lock, so granting it is a changed value, not growth that
// passes; taking one away reads the same way, since it locks out a caller that relied on it.
test("granting guest or agent reach reads as a shrink, and so does taking it back", () => {
    const committed = currentLock();
    const granted = lockWith(ROUTE, (declared) => ({ ...declared, guest: true, agent: true }));
    expect(accessChanges(serializeLock(committed), serializeLock(granted))).toEqual([`${ROUTE}: agent false → true, guest false → true`]);
    expect(shrunkSurfaces(committed, granted)).toEqual([`access:${ROUTE}.agent`, `access:${ROUTE}.guest`]);
    expect(shrunkSurfaces(granted, committed)).toEqual([`access:${ROUTE}.agent`, `access:${ROUTE}.guest`]);
});
