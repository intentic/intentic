// contract.lock.json is every exported schema serialized to canonical JSON Schema, so git can flag a wire-contract
// change. contract-shrink demands a `!` commit with a Breaking-Note when a schema, field or type shrinks; additions
// pass freely. Derived from the package's exports, not a hand-kept list.

import { z } from "zod";
import * as contract from "../index.js";

// Canonical key order so two runs are byte-identical and a diff is a real contract change, not key-order noise. Arrays
// keep zod's own (stable) order.
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
            // The dialect banner is identical on every entry; pure weight, no signal.
            delete schema["$schema"];
            lock[name] = schema;
        } catch {
            // Holds a place even when unserializable: appearing, disappearing or becoming serializable is still a diff.
            lock[name] = "<unserializable>";
        }
    }
    return lock;
};

// One line per schema, not pretty-printed: keeps the lock short enough that a diff shows which surfaces moved.
// Path-level detail lives in the lock test and contract-shrink instead.
export const serializeLock = (lock: Record<string, unknown>): string =>
    `{\n${Object.entries(lock)
        .map(([name, schema]) => `${JSON.stringify(name)}: ${JSON.stringify(schema)}`)
        .join(",\n")}\n}\n`;
