import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import type { WebEnvironment } from "./environment";

// environment.ts reads window.env once at import, so each case re-imports the module with the mode it wants.
const load = async (production: boolean): Promise<typeof import("./scriptCommand")> => {
    vi.resetModules();
    (globalThis as { window?: { env: WebEnvironment } }).window = {
        env: { production, api: { url: `` }, auth: { googleClientId: `` }, analytics: { posthogKey: ``, posthogHost: `` } },
    };
    return import("./scriptCommand");
};

test("local dev renders the repo-path form — never a curl of the deployed site", async () => {
    const { bashCommand } = await load(false);
    expect(bashCommand(`cleanupHost`, `sudo `, ``)).toBe(`sudo sh _apps/site/public/scripts/cleanup-host.sh`);
});

test("production renders the vanity-url curl one-liner", async () => {
    const { bashCommand } = await load(true);
    expect(bashCommand(`cleanupHost`, `sudo `, ``)).toBe(`curl -fsSL https://intentic.dev/cleanup-host | sudo sh`);
});

test("a PowerShell script with no arguments is piped straight into iex", async () => {
    const { psCommand } = await load(true);
    expect(psCommand(`ps1`, `$env:SETUP_CODE='abc'; `)).toBe(`$env:SETUP_CODE='abc'; irm https://intentic.dev/connect.ps1 | iex`);
});

// `irm | iex` cannot forward parameters, so an argument-taking script has to be invoked as a scriptblock.
test("a PowerShell script with arguments is fetched into a scriptblock", async () => {
    const { psCommand } = await load(true);
    expect(psCommand(`cleanupPs1`, ``, `-Slug sandbox-abc123 -Yes`)).toBe(
        `& ([scriptblock]::Create((irm https://intentic.dev/cleanup.ps1))) -Slug sandbox-abc123 -Yes`,
    );
});

test("local dev runs the PowerShell script by path, arguments appended", async () => {
    const { psCommand } = await load(false);
    expect(psCommand(`cleanupPs1`, ``, `-Slug sandbox-abc123 -Yes`)).toBe(`& ./_apps/site/public/scripts/cleanup.ps1 -Slug sandbox-abc123 -Yes`);
});

test("every script key points at a file that exists in the repo", async () => {
    const { SCRIPT_PATHS } = await load(false);
    const repoRoot = fileURLToPath(new URL(`../../../../`, import.meta.url));
    for (const path of Object.values(SCRIPT_PATHS)) {
        expect(existsSync(`${repoRoot}${path}`), `${path} is missing`).toBe(true);
    }
});
