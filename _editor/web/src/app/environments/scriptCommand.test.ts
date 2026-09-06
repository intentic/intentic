import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot as findRepoRoot } from "@intentic/constants/node";
import { expect, test, vi } from "vitest";
import type { WebEnvironment } from "./environment";

// environment.ts reads window.env once at import, so each case re-imports the module with the mode it wants.
const load = async (production: boolean): Promise<typeof import("./scriptCommand")> => {
    vi.resetModules();
    (globalThis as { window?: { env: WebEnvironment } }).window = {
        env: { production, api: { url: `` }, auth: { googleClientId: `` }, analytics: { posthogKey: ``, posthogHost: `` }, afterSignOut: `` },
    };
    return import("./scriptCommand");
};

test("local dev renders the repo-path form: never a curl of the deployed site", async () => {
    const { bashCommand } = await load(false);
    expect(bashCommand(`cleanupHost`, `sudo `, ``)).toBe(`sudo sh _site/site/public/scripts/cleanup-host.sh`);
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
    expect(psCommand(`cleanupPs1`, ``, `-Slug sandbox-abc123 -Yes`)).toBe(`& ./_site/site/public/scripts/cleanup.ps1 -Slug sandbox-abc123 -Yes`);
});

// The dialog that hands out a connect command is read on the dev machine and PASTED on another one, where the
// checkout does not exist, so a dev build has to be able to ask for the released form.
test("a dev build renders the published form when the developer asks for it", async () => {
    const { bashCommand, psCommand, scriptSource } = await load(false);
    scriptSource.value = `published`;
    expect(bashCommand(`deviceSh`, `env PAIR_TOKEN='t' `, ``)).toBe(`curl -fsSL https://intentic.dev/device | env PAIR_TOKEN='t' sh`);
    expect(psCommand(`devicePs1`, `$env:PAIR_TOKEN='t'; `)).toBe(`$env:PAIR_TOKEN='t'; irm https://intentic.dev/device.ps1 | iex`);
});

// The switch is a dev affordance, not a second production mode: production has only the fetched delivery, so
// leaving the preference on "checkout" there must not produce a path a deployed browser could never run.
test("a deployed build ignores the preference entirely", async () => {
    const { bashCommand, scriptSource } = await load(true);
    scriptSource.value = `checkout`;
    expect(bashCommand(`deviceSh`, ``, ``)).toBe(`curl -fsSL https://intentic.dev/device | sh`);
});

test("every script key points at a file that exists in the repo", async () => {
    const { SCRIPT_PATHS } = await load(false);
    const repoRoot = findRepoRoot(import.meta.url);
    for (const path of Object.values(SCRIPT_PATHS)) {
        expect(existsSync(join(repoRoot, path)), `${path} is missing`).toBe(true);
    }
});
