import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { REPLAY_ENV } from "./index.js";

/* The two connect scripts stand up the same container from two dialects, and nothing but this test compares
 * them. What they hand the run contract is invisible at every other layer: a key the POSIX script passes and
 * the PowerShell one doesn't produces a sandbox that boots, logs nothing, serves every request — and quietly
 * lacks one capability. PLATFORM_URL was missing from connect.ps1 for exactly that reason: the daemon skips
 * announcing when it is empty, the setup screen waits for nothing but that announce, so setup on Windows could
 * never finish while the sandbox itself looked perfectly healthy. */

const script = (name: string): string => readFileSync(new URL(`../../../_apps/site/public/scripts/${name}`, import.meta.url), "utf8");

// connect.sh frames its pairs NUL-separated for the run contract: `printf '%s=%s\0' KEY "$VALUE"`.
const shellKeys = (source: string): Set<string> => new Set([...source.matchAll(/printf '%s=%s\\0' ([A-Z_]+)/g)].map((match) => match[1] ?? ""));

// connect.ps1 collects the same pairs in $EnvPairs — the literal array plus any conditional appends. Scoped to
// that array, because the file is full of other `'KEY=*'` strings (the claim parser matches on them).
const powershellKeys = (source: string): Set<string> => {
    const block = /\$EnvPairs = @\(([\s\S]*?)\n\)/.exec(source)?.[1] ?? "";
    const appends = [...source.matchAll(/\$EnvPairs \+= '([A-Z_]+)=/g)].map((match) => match[1] ?? "");
    return new Set([...[...block.matchAll(/['"]([A-Z_]+)=/g)].map((match) => match[1] ?? ""), ...appends]);
};

// Differences that are real platform differences rather than drift. SELF_HOST_VIA names the transport to a
// self-host deploy target; connect.sh tunnels to the host through cloudflared, while the Windows path deploys
// to a Docker-in-Docker container on the shared network reached directly by name, so there is no via to send.
const WINDOWS_EXEMPT = new Set(["SELF_HOST_VIA"]);

describe("connect.sh / connect.ps1 env parity", () => {
    const posix = shellKeys(script("connect.sh"));
    const windows = powershellKeys(script("connect.ps1"));

    // If a rewrite changes either dialect's syntax, the extractions above silently return nothing and every
    // assertion below passes vacuously. Anchor both on a floor and on keys neither script can be without.
    it("extracts a plausible env set from both scripts", () => {
        expect(posix.size).toBeGreaterThanOrEqual(10);
        expect(windows.size).toBeGreaterThanOrEqual(10);
        for (const required of ["CONNECT_TOKEN", "SANDBOX_PUBLIC_URL", "PLATFORM_URL"]) {
            expect([...posix, ...windows].filter((key) => key === required)).toHaveLength(2);
        }
    });

    it("passes everything the POSIX script passes on Windows too", () => {
        expect([...posix].filter((key) => !windows.has(key) && !WINDOWS_EXEMPT.has(key))).toEqual([]);
    });

    it("passes only keys the run contract replays, so a recreate keeps them", () => {
        const replayed: readonly string[] = REPLAY_ENV;
        expect([...posix, ...windows].filter((key) => !replayed.includes(key))).toEqual([]);
    });
});
