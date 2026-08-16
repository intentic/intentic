import { expect, test } from "@playwright/test";
import { composeProvisioner } from "../src/provisioners/compose.js";
import type { Provisioner } from "../src/provisioner.js";
import { SIGN_IN_IS_SEEDED } from "../src/seed.js";
import { readWorldFile } from "../src/world-file.js";
import { TRIAL_REPLY } from "../src/world.js";

/* THE JOURNEY — arrive, sign in, get a connected sandbox, send a message, read a reply.
 *
 * One spec file, run once per way of getting a sandbox. That shape is the whole point of this tier: the four
 * onboarding paths differ in exactly one segment, so writing four end-to-end tests would mean maintaining four
 * copies of the two segments that are identical, and finding a regression in either of them four times or —
 * far more likely — not at all. Every existing check on these paths stops at `/health`, which is why a sign-in
 * button that rendered and did nothing once shipped.
 *
 * Two tests rather than one, and the split is not cosmetic. The first ends where a SEEDED sign-in can honestly
 * take a journey; the second needs a real one, and says so in its own skip message. See seed.ts — a
 * compose-provisioned daemon verifies Google ID tokens for real, so the seeded credential that gets a browser
 * past the platform is refused by the box. That is the daemon behaving exactly as it should.
 *
 * They share one provisioned sandbox: `serial` plus a module-level provisioner, because provisioning is the
 * expensive minute of this tier and doing it twice would buy nothing.
 */

const world = readWorldFile();

const PROVISIONERS: Record<string, () => Provisioner> = {
    compose: composeProvisioner,
};

test.describe.configure({ mode: `serial` });

test.skip(world.standDown !== undefined, world.standDown ?? ``);

let provisioner: Provisioner | undefined;

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

    /* ARRIVE, SIGNED IN. What matters here is that the app ACCEPTS the session: an app that bounced this to
     * /login would fail on the next line rather than three steps later, wearing a different symptom. */
    await page.goto(`${world.webUrl ?? ``}/`);
    await expect(page).not.toHaveURL(/\/login/);

    // GET A CONNECTED SANDBOX — the one segment that differs between the four paths.
    await provisioner.provision({ page, world });

    /* THE WORKSPACE. Setup ends here on every session, and reaching it is where a SEEDED sign-in stops being
     * enough: the shell's next move is to talk to the daemon, and the daemon verifies for real. So this test
     * ends on the route, and everything that needs the box to answer is the test below. */
    await page.goto(`${world.webUrl ?? ``}/workspace`);
    await expect(page).toHaveURL(/\/workspace$/, { timeout: 120_000 });
});

/* THE SECOND HALF, waiting on a real sign-in.
 *
 * A provisioned daemon authenticates people against Google itself — that is the whole reason the sandbox ever
 * asked for Google a second time — so it refuses the seeded credential the platform accepted, with a 401 on
 * every call. Nothing here is wrong; the seeded sign-in simply cannot reach a box that verifies for real.
 *
 * So this test is written and skipped rather than absent. It is what the stand-in Google is FOR, and a step
 * that exists in the suite with its reason attached is the one kind of gap that does not get forgotten.
 */
test(`the free agent answers`, async ({ page }) => {
    test.skip(
        SIGN_IN_IS_SEEDED,
        `needs the stand-in Google: this journey's sign-in is seeded, and a provisioned daemon verifies Google ID tokens for real — it answers the seeded credential with 401`,
    );

    await page.goto(`${world.webUrl ?? ``}/workspace`);

    /* SAY YES TO REACHING THE BOX ON THIS COMPUTER — a real step in the real flow, not harness scaffolding.
     *
     * A sandbox on the user's own machine is a loopback hop away, and the app would rather take that than go
     * out to a tunnel and back. But the reach is INTO the machine the browser runs on, which Chrome gates
     * behind a permission, so the app asks first with a card of its own and remembers the answer. Until that
     * card is answered the app never even PROBES the local address: every call goes to the tunnel hostname,
     * which in a hermetic run resolves nowhere.
     *
     * The card appears in the shell, so it is answered here. Best-effort because a run that already has the
     * answer never shows it — what must hold either way is the assertion under it. */
    await page
        .getByRole(`button`, { name: `Allow`, exact: true })
        .first()
        .click({ timeout: 60_000 })
        .catch(() => undefined);

    // The browser has adopted an address that answers AND been accepted by it. Everything before this was the
    // platform's word for the box; this is the box's own.
    await expect(page.getByText(/Connecting to/i)).toHaveCount(0, { timeout: 180_000 });

    /* The trial is the free channel this tier walks (the world switches it on and points it at the stand-in
     * model). The Google free channel — the "Try free with Google" card a new user meets first — needs a real
     * Google account inside the box and is deliberately not covered here. */
    await page.goto(`${world.webUrl ?? ``}/agents`);
    const composer = page.locator(`textarea[name="draft"]`);
    // The composer only renders once something is connected, so waiting for it IS the assertion that the
    // daemon offered the trial.
    await expect(composer).toBeVisible({ timeout: 120_000 });

    await composer.fill(`Say hello.`);
    await composer.press(`Enter`);

    /* A REPLY RENDERS — browser → daemon → platform trial → upstream → back onto the screen. The text is the
     * stand-in's, chosen so no UI copy could be mistaken for it: what this asserts is that the whole pipe
     * carried a message, not that a model said anything in particular. */
    await expect(page.getByText(TRIAL_REPLY, { exact: false }).first()).toBeVisible({ timeout: 180_000 });
});
