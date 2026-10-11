import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot as findRepoRoot } from "@intentic/constants/node";
import type { WebEnvironment } from "./environment";

// environment.ts reads `window.env` once, at import; this is the same object under the same name, and the module
// under test reads `production` through it on every call, so a case sets the mode it wants here.
const environment: WebEnvironment = {
    production: false,
    api: { url: `` },
    auth: { googleClientId: `` },
    analytics: { posthogKey: ``, posthogHost: `` },
    afterSignOut: ``,
};
jest.mock("./environment", () => ({ environment }));

const { SCRIPT_PATHS, bashCommand, oneLiner, psCommand, scriptSource } = await import("./scriptCommand");

// The delivery preference is a dev-only knob the cases below set for themselves; `checkout` is what an empty store
// reads as.
const load = (production: boolean): void => {
    environment.production = production;
    scriptSource.value = `checkout`;
};

test("local dev renders the repo-path form: never a curl of the deployed site", () => {
    load(false);
    expect(bashCommand(`cleanupHost`, `sudo `, ``)).toBe(`sudo sh _site/site/public/scripts/cleanup-host.sh`);
});

test("production renders the vanity-url curl one-liner", () => {
    load(true);
    expect(bashCommand(`cleanupHost`, `sudo `, ``)).toBe(`curl -fsSL https://intentic.dev/cleanup-host | sudo sh`);
});

test("a PowerShell script with no arguments is piped straight into iex", () => {
    load(true);
    expect(psCommand(`ps1`, `$env:SETUP_CODE='abc'; `)).toBe(`$env:SETUP_CODE='abc'; irm https://intentic.dev/connect.ps1 | iex`);
});

// `irm | iex` cannot forward parameters, so an argument-taking script has to be invoked as a scriptblock.
test("a PowerShell script with arguments is fetched into a scriptblock", () => {
    load(true);
    expect(psCommand(`cleanupPs1`, ``, `-Slug sandbox-abc123 -Yes`)).toBe(
        `& ([scriptblock]::Create((irm https://intentic.dev/cleanup.ps1))) -Slug sandbox-abc123 -Yes`,
    );
});

test("local dev runs the PowerShell script by path, arguments appended", () => {
    load(false);
    expect(psCommand(`cleanupPs1`, ``, `-Slug sandbox-abc123 -Yes`)).toBe(`& ./_site/site/public/scripts/cleanup.ps1 -Slug sandbox-abc123 -Yes`);
});

// The dialog that hands out a connect command is read on the dev machine and PASTED on another one, where the
// checkout does not exist, so a dev build has to be able to ask for the released form.
test("a dev build renders the published form when the developer asks for it", () => {
    load(false);
    scriptSource.value = `published`;
    expect(bashCommand(`deviceSh`, `env PAIR_TOKEN='t' `, ``)).toBe(`curl -fsSL https://intentic.dev/device | env PAIR_TOKEN='t' sh`);
    expect(psCommand(`devicePs1`, `$env:PAIR_TOKEN='t'; `)).toBe(`$env:PAIR_TOKEN='t'; irm https://intentic.dev/device.ps1 | iex`);
});

// The switch is a dev affordance, not a second production mode: production has only the fetched delivery, so
// leaving the preference on "checkout" there must not produce a path a deployed browser could never run.
test("a deployed build ignores the preference entirely", () => {
    load(true);
    scriptSource.value = `checkout`;
    expect(bashCommand(`deviceSh`, ``, ``)).toBe(`curl -fsSL https://intentic.dev/device | sh`);
});

test("every script key points at a file that exists in the repo", () => {
    load(false);
    const repoRoot = findRepoRoot(import.meta.url);
    for (const path of Object.values(SCRIPT_PATHS)) {
        expect(existsSync(join(repoRoot, path)), `${path} is missing`).toBe(true);
    }
});

describe(`the one-liner`, () => {
    test(`production hands out the verb route in each shell`, () => {
        load(true);
        expect(oneLiner(`remove`, [`sandbox-abc123`], `unix`)).toBe(`curl -fsSL https://intentic.dev/remove/sandbox-abc123 | sh`);
        expect(oneLiner(`rollback`, [`sandbox-abc123`], `windows`)).toBe(`irm https://intentic.dev/rollback/sandbox-abc123 | iex`);
        expect(oneLiner(`rebuild`, [`sandbox-abc123`, `0123abcd`], `unix`)).toBe(`curl -fsSL https://intentic.dev/rebuild/sandbox-abc123/0123abcd | sh`);
        expect(oneLiner(`remove`, [], `windows`)).toBe(`irm https://intentic.dev/remove | iex`);
    });

    test(`a deployed build ignores a source passed in`, () => {
        load(true);
        expect(oneLiner(`update`, [`sandbox-abc123`], `unix`, `checkout`)).toBe(`curl -fsSL https://intentic.dev/update/sandbox-abc123 | sh`);
    });

    test(`a dev build on the checkout runs the same script by path with the verb's arguments`, () => {
        load(false);
        expect(oneLiner(`restart`, [`sandbox-abc123`], `unix`)).toBe(`sh _site/site/public/scripts/recreate.sh 'sandbox-abc123' '--restart'`);
        expect(oneLiner(`restart`, [`sandbox-abc123`], `windows`)).toBe(`& ./_site/site/public/scripts/recreate.ps1 -Slug 'sandbox-abc123' -Restart`);
        expect(oneLiner(`device`, [`box.example.com`, `AB12CD34`], `windows`)).toBe(
            `& ./_site/site/public/scripts/device.ps1 -Sandbox 'box.example.com' -Code 'AB12CD34'`,
        );
        expect(oneLiner(`remove`, [], `unix`)).toBe(`sh _site/site/public/scripts/cleanup.sh`);
        expect(oneLiner(`fix`, [`Q7XK2M9P`], `unix`, `published`)).toBe(`curl -fsSL https://intentic.dev/fix/Q7XK2M9P | sh`);
    });

    test(`an argument the verb cannot carry is refused rather than handed out`, () => {
        load(true);
        expect(() => oneLiner(`update`, [`Not A Slug`], `unix`)).toThrow();
    });
});
