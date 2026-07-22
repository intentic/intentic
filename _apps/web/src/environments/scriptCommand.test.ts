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

test("every script key points at a file that exists in the repo", async () => {
    const { SCRIPT_PATHS } = await load(false);
    const repoRoot = fileURLToPath(new URL(`../../../../`, import.meta.url));
    for (const path of Object.values(SCRIPT_PATHS)) {
        expect(existsSync(`${repoRoot}${path}`), `${path} is missing`).toBe(true);
    }
});
