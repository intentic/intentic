// contract.lock.json is every exported schema serialized to canonical JSON Schema, so git can flag a wire-contract
// change. contract-shrink demands a `!` commit with a Breaking-Note when a schema, field or type shrinks; additions
// pass freely. Derived from the package's exports, not a hand-kept list, plus the wire no oRPC route carries: the
// manifests the Rust crates that define it write beside their TypeScript (the tunnel, what a browser sees of the front
// and the edge, and the front's control socket with Node), under `wire:` names no export can take.
//
// And who reaches each route: every raw route's and every procedure's RouteMeta, each reach field with its default
// resolved (route-meta.ts `routeAccess`), under `access:METHOD /path`. Resolved, so every field is a value on every
// route: a lowered floor, a `guest`, `agent` or `panel` granted, a control rung widened are each a changed value, which
// contract-shrink reads as a shrink, the same `!` and Breaking-Note a removed field needs. A field left absent could
// instead be added unseen, since growth passes freely. route-reach.test.ts in the daemon proves the gates honour
// exactly these declarations; this pins the declarations themselves.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
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

const ACCESS_PREFIX = "access:";

// The access half of the lock, one entry per route with its fields in key order; a procedure also names itself, so a
// route moving between procedures is seen.
const accessEntries = (): Record<string, Readonly<Record<string, string | boolean>>> => {
    const entries = new Map<string, Readonly<Record<string, string | boolean>>>();
    for (const route of [...contract.RAW_ROUTE_LIST, ...contract.SANDBOX_ROUTES]) {
        const key = `${ACCESS_PREFIX}${route.method} ${route.path}`;
        if (entries.has(key)) {
            throw new Error(`two routes declare ${route.method} ${route.path}; the lock can record only one reach for it`);
        }
        const access = contract.routeAccess(route.method, route.meta);
        const fields = route.name === `${route.method} ${route.path}` ? access : { ...access, procedure: route.name };
        entries.set(key, Object.fromEntries(Object.entries(fields).toSorted(([a], [b]) => a.localeCompare(b))));
    }
    return Object.fromEntries([...entries].toSorted(([a], [b]) => a.localeCompare(b)));
};

// A lock text's access half: route key to its fields. Entries under other names are not its business.
const accessHalf = (text: string): Record<string, Readonly<Record<string, string | boolean>>> => {
    const lock = z.record(z.string(), z.unknown()).parse(JSON.parse(text));
    return z
        .record(z.string(), z.record(z.string(), z.union([z.string(), z.boolean()])))
        .parse(Object.fromEntries(Object.entries(lock).filter(([key]) => key.startsWith(ACCESS_PREFIX))));
};

// Each route whose recorded reach differs between two locks, one line naming the route and every field that moved, so a
// failing lock check says which route's access changed rather than leaving it to a diff of hundreds of entries. Takes
// the two lock texts, as serializeLock writes them.
export const accessChanges = (baseText: string, headText: string): string[] => {
    const base = accessHalf(baseText);
    const head = accessHalf(headText);
    const keys = new Set([...Object.keys(base), ...Object.keys(head)]);
    return [...keys].toSorted().flatMap((key) => {
        const route = key.slice(ACCESS_PREFIX.length);
        const was = base[key];
        const now = head[key];
        if (was === undefined || now === undefined) {
            return [`${route}: ${was === undefined ? "new route" : "no longer declared"}`];
        }
        const moved = [...new Set([...Object.keys(was), ...Object.keys(now)])]
            .toSorted()
            .filter((field) => was[field] !== now[field])
            .map((field) => `${field} ${JSON.stringify(was[field]) ?? "absent"} → ${JSON.stringify(now[field]) ?? "absent"}`);
        return moved.length === 0 ? [] : [`${route}: ${moved.join(", ")}`];
    });
};

// Each written by its crate's own test: `tunnel`, `browser-wire` and `front-wire` under _sandbox/front/crates.
const WIRE_MANIFESTS = ["browser-wire", "front-wire", "tunnel"] as const;

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
    for (const manifest of WIRE_MANIFESTS) {
        // Read from src/ whether this runs from src/ or dist/: the manifests are data `cargo test` writes, never compiled.
        const text = readFileSync(join(packageRoot(import.meta.url), "src", "front", "generated", `${manifest}.json`), "utf8");
        lock[`wire:${manifest}`] = sorted(JSON.parse(text));
    }
    return { ...lock, ...accessEntries() };
};

// One line per schema, not pretty-printed: keeps the lock short enough that a diff shows which surfaces moved.
// Path-level detail lives in the lock test and contract-shrink instead.
export const serializeLock = (lock: Record<string, unknown>): string =>
    `{\n${Object.entries(lock)
        .map(([name, schema]) => `${JSON.stringify(name)}: ${JSON.stringify(schema)}`)
        .join(",\n")}\n}\n`;
