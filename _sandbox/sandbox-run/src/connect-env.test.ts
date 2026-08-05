import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REPLAY_ENV } from "./index.js";

/* The connect flow lives in the ic host-side CLI (_sandbox/ic, Rust), and what it hands the run contract is
 * invisible at every other layer: a key it fails to pass produces a sandbox that boots, logs nothing, serves
 * every request — and quietly lacks one capability. PLATFORM_URL taught this: the daemon skips announcing
 * when it is empty, the setup screen waits for nothing but that announce, so setup could never finish while
 * the sandbox itself looked perfectly healthy. This test parses the Rust source (the same way its
 * predecessor parsed connect.sh and connect.ps1) and pins that list against the contract's replay allowlist
 * — the one place the two languages must agree. */

const connectSource = readFileSync(new URL("../../../_sandbox/ic/src/sandbox/connect.rs", import.meta.url), "utf8");

// The env pairs connect.rs frames for `sandbox run-command`: the ("KEY", value) tuples of its nul_frame call.
const rustKeys = (): Set<string> => {
    const block = /nul_frame\(&\[([\s\S]*?)\]\)/.exec(connectSource)?.[1] ?? "";
    return new Set([...block.matchAll(/\("([A-Z_]+)"/g)].map((match) => match[1] ?? ""));
};

describe("ic sandbox connect env", () => {
    const keys = rustKeys();

    // If a rewrite changes the Rust shape, the extraction above silently returns nothing and the assertions
    // below pass vacuously. Anchor on a floor and on keys the flow cannot be without.
    it("extracts a plausible env set from the Rust source", () => {
        expect(keys.size).toBeGreaterThanOrEqual(10);
        for (const required of ["CONNECT_TOKEN", "SANDBOX_PUBLIC_URL", "PLATFORM_URL"]) {
            expect(keys.has(required), required).toBe(true);
        }
    });

    it("passes only keys the run contract replays, so a recreate keeps them", () => {
        const replayed: readonly string[] = REPLAY_ENV;
        expect([...keys].filter((key) => !replayed.includes(key))).toEqual([]);
    });
});
