import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { describe, expect, it } from "vitest";
import { REPLAY_ENV } from "./index.js";

// Parses the Rust source of the ic host-side connect flow (_sandbox/ic) and pins its env keys against the contract's
// replay allowlist, the one place the two languages must agree.

const connectSource = readFileSync(join(repoRoot(import.meta.url), "_sandbox/ic/src/sandbox/connect.rs"), "utf8");

// The env pairs connect.rs frames for `sandbox run-command`: the ("KEY", value) tuples of its nul_frame call.
const rustKeys = (): Set<string> => {
    const block = /nul_frame\(&\[([\s\S]*?)\]\)/.exec(connectSource)?.[1] ?? "";
    return new Set([...block.matchAll(/\("([A-Z_]+)"/g)].map((match) => match[1] ?? ""));
};

// Capabilities that fail silently when missing; nothing here makes the sandbox refuse to start.
const REQUIRED = [
    // Reachability: the published address, the sandbox's signed proof, and the edge it presents that proof to.
    "SANDBOX_PUBLIC_URL",
    "SANDBOX_GRANT",
    "INGRESS_URL",
    // Identity and platform: the daemon's credential, the owner, the announce origin, the browser origin.
    "CONNECT_TOKEN",
    "OWNER_EMAIL",
    "PLATFORM_URL",
    "WEB_ORIGIN",
    "GOOGLE_CLIENT_ID",
    // The two pairings this machine can't re-derive: folder sync and device enrollment.
    "SYNC_PAIR_TOKEN",
    "HOST_PAIR_TOKEN",
    "HOST_PLATFORM",
    "HOST_LABEL",
] as const;

describe("ic sandbox connect env", () => {
    const keys = rustKeys();

    // A Rust rewrite could make the extraction return nothing, passing every assertion below vacuously.
    it("extracts a plausible env set from the Rust source", () => {
        expect(keys.size).toBeGreaterThanOrEqual(REQUIRED.length);
    });

    it("passes every key a connected sandbox cannot be without", () => {
        expect(REQUIRED.filter((key) => !keys.has(key))).toEqual([]);
    });

    it("requires nothing the run contract would not replay", () => {
        const replayed: readonly string[] = REPLAY_ENV;
        expect(REQUIRED.filter((key) => !replayed.includes(key))).toEqual([]);
    });

    it("passes only keys the run contract replays, so a recreate keeps them", () => {
        const replayed: readonly string[] = REPLAY_ENV;
        expect([...keys].filter((key) => !replayed.includes(key))).toEqual([]);
    });
});
