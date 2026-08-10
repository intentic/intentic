/* THE WIRE SURFACE, AS ONE COMPARABLE DOCUMENT — every zod schema this package exports, serialized to JSON
 * Schema and sorted into a canonical shape. `contract.lock.json` at the package root is this function's
 * committed output, and the pair is what makes "did the contract change?" a question git can answer.
 *
 * Two readers depend on that answer. contract-lock.test.ts fails whenever the committed file is out of step
 * with the code, so a contract change always lands WITH its lock diff — visible in review, attributable to a
 * commit. And prepass.mjs (invariant 6) compares the committed lock against its merge-base to insist that a
 * SHRUNK surface — a schema or field removed, a type changed — arrives as a `!` commit carrying a
 * `Breaking-Note:` trailer, which is what feeds the release's "Breaking changes" section and the update card's
 * warning. Additions pass freely; every persisted-manifest reader parses loosely, so growth breaks nobody.
 *
 * Serialized from the package's EXPORTS rather than a hand-kept list, on the repo's own rule (AGENTS.md:
 * "guard invariants by discovery, not enumeration"): a schema added tomorrow is in the lock tomorrow, and a
 * schema that stops being exported is a removal the lock shows. `unrepresentable: "any"` keeps the rare
 * function-valued corner from throwing — it serializes as `{}`, which still diffs when it moves. */

import { z } from "zod";
import * as contract from "./index.js";

// Canonical ordering, so two runs of the same code are byte-identical and a lock diff is a contract diff
// rather than a key-order shuffle. Arrays keep their order — for `required` and `enum` lists the order zod
// emits is stable, and sorting them would hide a reorder that is genuinely no change at all anyway.
const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) {
        return value.map(sorted);
    }
    if (typeof value === "object" && value !== null) {
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [key, sorted((value as Record<string, unknown>)[key])]),
        );
    }
    return value;
};

export const currentLock = (): Record<string, unknown> => {
    const lock: Record<string, unknown> = {};
    for (const name of Object.keys(contract).sort()) {
        const value = (contract as Record<string, unknown>)[name];
        if (!(value instanceof z.ZodType)) {
            continue;
        }
        try {
            const schema = sorted(z.toJSONSchema(value, { unrepresentable: "any" })) as Record<string, unknown>;
            // The dialect banner is identical on all ~500 entries — pure weight, no surface.
            delete schema["$schema"];
            lock[name] = schema;
        } catch {
            // A schema JSON Schema cannot express at all still holds a place in the lock: its appearance,
            // disappearance, or transition to serializable are each a surface change worth a diff.
            lock[name] = "<unserializable>";
        }
    }
    return lock;
};

/* ONE LINE PER SCHEMA, on purpose — not JSON.stringify(lock, null, 4). Pretty-printed, the lock is a 35k-line
 * wall nobody scrolls; a line per export keeps it ~500 lines and makes `git diff` read as the list of WHICH
 * surfaces moved, which is the level a reviewer reviews at. The path-level detail lives in the tooling: the
 * lock test diffs parsed objects and prepass invariant 6 names the exact removed paths, so nothing is lost by
 * not laying the structure out vertically. */
export const serializeLock = (lock: Record<string, unknown>): string =>
    `{\n${Object.entries(lock)
        .map(([name, schema]) => `${JSON.stringify(name)}: ${JSON.stringify(schema)}`)
        .join(",\n")}\n}\n`;
