import { expect, test } from "@playwright/test";
import { composeProvisioner } from "../src/provisioners/compose.js";
import { icProvisioner } from "../src/provisioners/ic.js";
import type { Provisioner } from "../src/provisioner.js";
import { SIGN_IN_IS_SEEDED } from "../src/seed.js";
import { readWorldFile } from "../src/world-file.js";
import { TRIAL_REPLY } from "../src/world.js";

// One spec, run once per provisioning path (compose/ic); two tests split where a SEEDED sign-in stops being enough and
// a real Google sign-in is required.

const world = readWorldFile();

const PROVISIONERS: Record<string, () => Provisioner> = {
    compose: composeProvisioner,
    ic: icProvisioner,
};

test.describe.configure({ mode: `serial` });

test.skip(world.standDown !== undefined, world.standDown ?? ``);

let provisioner: Provisioner | undefined;
// Why this path can't run here; held once since both tests share one provisioned sandbox.
let laneStandDown: string | undefined;

test.afterAll(async () => {
    await provisioner?.teardown();
    provisioner = undefined;
});

test(`a new account reaches a connected sandbox`, async ({ page }, testInfo) => {
    const make = PROVISIONERS[testInfo.project.name];
    if (make === undefined) {
        throw new Error(`no provisioner named ${testInfo.project.name} — the project and the registry have drifted`);
    }
    provisioner = make();

    // Checked before provisioning starts, so an unsupported lane fails with a message, not mid-provision.
    laneStandDown = await provisioner.standDown?.();
    test.skip(laneStandDown !== undefined, laneStandDown ?? ``);

    await page.goto(`${world.webUrl ?? ``}/`);
    await expect(page).not.toHaveURL(/\/login/);

    // The one segment that differs across the four provisioning paths.
    await provisioner.provision({ page, world });

    await page.goto(`${world.webUrl ?? ``}/workspace`);
    await expect(page).toHaveURL(/\/workspace$/, { timeout: 120_000 });
});

test(`the free agent answers`, async ({ page }) => {
    // Both tests share the sandbox the test above provisioned; a stood-down lane skips here too.
    test.skip(laneStandDown !== undefined, laneStandDown ?? ``);
    test.skip(
        SIGN_IN_IS_SEEDED,
        `needs the stand-in Google: this journey's sign-in is seeded, and a provisioned daemon verifies Google ID tokens for real — it answers the seeded credential with 401`,
    );

    await page.goto(`${world.webUrl ?? ``}/workspace`);

    // Answers the local-network-access permission card the shell shows; best-effort since an answered run skips it.
    await page
        .getByRole(`button`, { name: `Allow`, exact: true })
        .first()
        .click({ timeout: 60_000 })
        .catch(() => undefined);

    await expect(page.getByText(/Connecting to/i)).toHaveCount(0, { timeout: 180_000 });

    // Trial is what a new user lands on with no sign-in; the Google channel needs a real account, uncovered here.
    await page.goto(`${world.webUrl ?? ``}/agents`);
    const composer = page.locator(`textarea[name="draft"]`);
    // Composer renders only once connected; its visibility is the assertion that a trial was offered.
    await expect(composer).toBeVisible({ timeout: 120_000 });

    await composer.fill(`Say hello.`);
    await composer.press(`Enter`);

    // TRIAL_REPLY collides with no UI copy; matching it proves the pipe carried a message, not a specific answer.
    await expect(page.getByText(TRIAL_REPLY, { exact: false }).first()).toBeVisible({ timeout: 180_000 });
});
