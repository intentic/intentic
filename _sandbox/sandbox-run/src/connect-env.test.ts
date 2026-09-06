import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { describe, expect, it } from "vitest";
import { REPLAY_ENV } from "./index.js";

/* The connect flow lives in the ic host-side CLI (_sandbox/ic, Rust), and what it hands the run contract is
 * invisible at every other layer: a key it fails to pass produces a sandbox that boots, logs nothing, serves
 * every request, and quietly lacks one capability. PLATFORM_URL taught this: the daemon skips announcing
 * when it is empty, the setup screen waits for nothing but that announce, so setup could never finish while
 * the sandbox itself looked perfectly healthy. This test parses the Rust source (the same way its
 * predecessor parsed connect.sh and connect.ps1) and pins that list against the contract's replay allowlist
 *: the one place the two languages must agree. */

const connectSource = readFileSync(join(repoRoot(import.meta.url), "_sandbox/ic/src/sandbox/connect.rs"), "utf8");

// The env pairs connect.rs frames for `sandbox run-command`: the ("KEY", value) tuples of its nul_frame call.
const rustKeys = (): Set<string> => {
    const block = /nul_frame\(&\[([\s\S]*?)\]\)/.exec(connectSource)?.[1] ?? "";
    return new Set([...block.matchAll(/\("([A-Z_]+)"/g)].map((match) => match[1] ?? ""));
};

/* WHAT A CONNECTED SANDBOX CANNOT BE WITHOUT, and this is the direction that actually broke.
 *
 * The allowlist check below only ever asked whether a key connect.rs passes is one the contract replays,
 * which catches a key that should not be there and is blind to one that stopped being there at all. When the
 * reachability migration deleted the zrok trio from the Rust and put SANDBOX_GRANT/INGRESS_URL in its place
 * everywhere else — the platform mints them, the allowlist replays them, the daemon reads them — connect.rs
 * was the one layer nobody added them back to. Every install for the next four days produced a container
 * that came up healthy, registered with the platform, and answered 502 on its own address forever, because
 * a daemon with no edge dials no tunnel.
 *
 * So: a floor of names, each one a capability that fails SILENTLY when its value never arrives. Nothing here
 * makes a sandbox refuse to start, which is exactly why the list has to exist. */
const REQUIRED = [
    // Reachability: the address the platform published, the signed proof of which sandbox this is, and the
    // edge that proof is presented to. Missing ⇒ a box on a public name that never answers.
    "SANDBOX_PUBLIC_URL",
    "SANDBOX_GRANT",
    "INGRESS_URL",
    // Identity and the platform it reports to: the daemon's own credential, the owner it binds, the origin
    // it announces to, and the browser origin it accepts. Missing ⇒ a setup screen that waits forever.
    "CONNECT_TOKEN",
    "OWNER_EMAIL",
    "PLATFORM_URL",
    "WEB_ORIGIN",
    "GOOGLE_CLIENT_ID",
    // The two pairings this machine can never re-derive from inside the container: the folder sync and the
    // device enrollment. Missing ⇒ a machine whose sandboxes are unmanageable from the browser.
    "SYNC_PAIR_TOKEN",
    "HOST_PAIR_TOKEN",
    "HOST_PLATFORM",
    "HOST_LABEL",
] as const;

describe("ic sandbox connect env", () => {
    const keys = rustKeys();

    // If a rewrite changes the Rust shape, the extraction above silently returns nothing and the assertions
    // below pass vacuously. Anchor on a floor and on keys the flow cannot be without.
    it("extracts a plausible env set from the Rust source", () => {
        expect(keys.size).toBeGreaterThanOrEqual(REQUIRED.length);
    });

    it("passes every key a connected sandbox cannot be without", () => {
        expect(REQUIRED.filter((key) => !keys.has(key))).toEqual([]);
    });

    // The two lists describe the same values from opposite ends, so a name required here that the contract
    // does not replay would be a capability every recreate silently drops.
    it("requires nothing the run contract would not replay", () => {
        const replayed: readonly string[] = REPLAY_ENV;
        expect(REQUIRED.filter((key) => !replayed.includes(key))).toEqual([]);
    });

    it("passes only keys the run contract replays, so a recreate keeps them", () => {
        const replayed: readonly string[] = REPLAY_ENV;
        expect([...keys].filter((key) => !replayed.includes(key))).toEqual([]);
    });
});
