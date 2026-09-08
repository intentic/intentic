import { expect, type Page, test } from "@playwright/test";
import { activationPath, EXPECTED_ACTIVATIONS, EXPECTED_RAIL_IDS, FIXTURE_CAPABILITIES, FIXTURE_PANELS } from "../fixtures/extension-facts.js";
import { DAEMON_URL } from "../stack.js";

// Every extension view mounts against stubbed /panels and /capabilities, with the real router, registry and components.
// Console errors are not asserted: opened views hit a loopback daemon lacking a matching workspace.

const stubFacts = async (page: Page): Promise<void> => {
    // Exact URLs, not globs: /capabilities has sub-routes (marketplace, secret, login) that must reach the daemon.
    await page.route(`${DAEMON_URL}/panels`, async (route) => {
        await route.fulfill({ json: { panels: FIXTURE_PANELS } });
    });
    await page.route(`${DAEMON_URL}/capabilities`, async (route) => {
        await route.fulfill({ json: { capabilities: FIXTURE_CAPABILITIES, recommendations: [] } });
    });
};

// True once the rail's extensions have activated, when the failure states below become meaningful. A tile is seated
// only if visited or badging; everything else counts under the More menu.
const shellReady = async (page: Page): Promise<void> => {
    await expect(page.locator(`nav a[href^="/ext/"], nav [aria-label*="not on the rail"]`).first()).toBeVisible();
};

// Rows are the areas not currently seated; the menu's label carries a count, matched on its stable half.
const openMore = async (page: Page): Promise<void> => {
    await page.locator(`nav [aria-label^="More areas"]`).click();
};

// Takes an unseated area from the menu instead of naming one: which areas badge depends on the fixture, so a hardcoded
// name breaks for unrelated reasons.
const anUnseatedArea = async (page: Page): Promise<{ href: string; label: string }> => {
    const keep = page.locator(`button[aria-label^="Keep "]`).first();
    await expect(keep).toBeAttached();
    const aria = (await keep.getAttribute(`aria-label`)) ?? ``;
    const row = page.locator(`div:has(> button[aria-label="${aria}"])`).first();
    return { href: (await row.locator(`a[href]`).getAttribute(`href`)) ?? ``, label: aria.replace(/^Keep /, ``).replace(/ on the rail$/, ``) };
};

test.beforeEach(async ({ page }) => {
    await stubFacts(page);
});

test(`a tile opened from More says its seat lasts only as long as the visit`, async ({ page }) => {
    await page.goto(`/agents`);
    await shellReady(page);
    await openMore(page);
    const area = await anUnseatedArea(page);

    await expect(page.locator(`nav a[href="${area.href}"]`)).toHaveCount(0);

    await page.locator(`a[href="${area.href}"]`).first().click();
    const tile = page.locator(`nav a[href="${area.href}"]`);
    await expect(tile).toBeVisible();
    await expect(tile).toHaveAttribute(`aria-label`, /here while you are · right-click to keep/);

    await page.goto(`/agents`);
    await shellReady(page);
    await expect(page.locator(`nav a[href="${area.href}"]`)).toHaveCount(0);
});

test(`an area is kept on the rail from the menu row it was found on`, async ({ page }) => {
    await page.goto(`/agents`);
    await shellReady(page);
    await openMore(page);
    const area = await anUnseatedArea(page);
    const keep = page.locator(`button[aria-label="Keep ${area.label} on the rail"]`);

    await expect(keep).toHaveCSS(`opacity`, `0`);
    await page.locator(`div:has(> button[aria-label="Keep ${area.label} on the rail"])`).first().hover();
    await expect(keep).toHaveCSS(`opacity`, `1`);

    await keep.click();
    await expect(page.locator(`nav a[href="${area.href}"]`)).toBeVisible();
    await expect(keep).toHaveCount(0);

    await page.goto(`/agents`);
    await shellReady(page);
    const tile = page.locator(`nav a[href="${area.href}"]`);
    await expect(tile).toBeVisible();
    await expect(tile).not.toHaveAttribute(`aria-label`, /right-click to keep/);
});

test(`the rail and its More menu show exactly the views the fixture activates`, async ({ page }) => {
    await page.goto(`/agents`);
    await shellReady(page);
    await openMore(page);

    const hrefs = await page.locator(`a[href^="/ext/"]`).evaluateAll((links) => links.map((link) => link.getAttribute(`href`) ?? ``));
    // Format: /ext/<id> or /ext/<id>/<key>; id identifies the view family.
    const railIds = [...new Set(hrefs.map((href) => href.split(`/`)[2] ?? ``))].filter((id) => id !== ``);

    // Both directions of the set check matter:
    // missing ⇒ a detect() rule changed, or the fixture dropped its evidence.
    // unexpected ⇒ a rail view shipped without a line in EXPECTED_ACTIVATIONS, so the matrix below silently stops
    // covering it.
    expect(railIds.toSorted()).toEqual([...new Set(EXPECTED_RAIL_IDS)].toSorted());
});

test(`every registered extension view mounts`, async ({ page }) => {
    // One test walks every route rather than one test per view: a single seeded world runs on one worker, so failures
    // accumulate and a run names every broken view at once instead of one per re-run.
    const broken: string[] = [];

    for (const activation of EXPECTED_ACTIVATIONS) {
        const path = activationPath(activation);
        await page.goto(path);
        try {
            await shellReady(page);
            await expect(page.getByText(`extension crashed rendering this view`)).toBeHidden({ timeout: 15_000 });
            await expect(page.getByText(`this view's content is no longer in the workspace`)).toBeHidden({ timeout: 1_000 });
            await expect(page.getByText(`is switched off`)).toBeHidden({ timeout: 1_000 });
        } catch (error) {
            broken.push(
                `${path} (${activation.id}, expected because ${activation.why}): ${error instanceof Error ? error.message.split(`\n`)[0] : String(error)}`,
            );
        }
    }

    expect(broken, `${broken.length} of ${EXPECTED_ACTIVATIONS.length} extension views did not mount`).toEqual([]);
});
