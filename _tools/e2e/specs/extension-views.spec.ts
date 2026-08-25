import { expect, type Page, test } from "@playwright/test";
import { activationPath, EXPECTED_ACTIVATIONS, EXPECTED_RAIL_IDS, FIXTURE_CAPABILITIES, FIXTURE_PANELS } from "../fixtures/extension-facts.js";
import { DAEMON_URL } from "../stack.js";

/* EVERY EXTENSION VIEW MOUNTS.
 *
 * Each view is a lazily imported Vue component behind an `import()`, wrapped in an error boundary, activated by
 * a `detect()` over daemon facts. Nothing in the build proves any of that resolves: a view whose chunk fails to
 * load, whose setup throws, or whose registration drifted from its manifest is a perfectly green `pnpm build`
 * and a card reading "The … extension crashed rendering this view" the first time a user opens it.
 *
 * THE FACTS ARE STUBBED, THE VIEWS ARE REAL. `/panels` and `/capabilities` are served from
 * fixtures/extension-facts.ts instead of from a workspace built repo-by-repo in the daemon: activation depends
 * on evidence (a deploy.config.ts, a connected komodo, a docs/user-stories dir), and materialising all of it as
 * real content would make this suite a test of the daemon's discovery rules, which have their own tests, at
 * ten times the runtime, while still not guaranteeing every view activates. Stubbing the two fact routes is
 * what makes "every view" reachable and deterministic. Everything downstream is the real app: the real router,
 * the real registry, the real components and their real chunks.
 *
 * WHAT IS ASSERTED is the absence of the three states the host renders when something is wrong, crashed,
 * undetected, switched off, each matched on the app's own wording. Console errors are deliberately NOT
 * asserted on: only the fact routes are stubbed, so an opened view's own data requests hit a loopback daemon
 * with no such workspace and log failures that say nothing about whether the view mounted. A view rendering its
 * own "couldn't load" state IS mounted; a view behind the error boundary is not. */

const stubFacts = async (page: Page): Promise<void> => {
    // Exact URLs, not globs: `/capabilities` has sub-routes (marketplace, secret, login) that must reach the
    // daemon untouched, and a `**/capabilities*` pattern would swallow them.
    await page.route(`${DAEMON_URL}/panels`, async (route) => {
        await route.fulfill({ json: { panels: FIXTURE_PANELS } });
    });
    await page.route(`${DAEMON_URL}/capabilities`, async (route) => {
        await route.fulfill({ json: { capabilities: FIXTURE_CAPABILITIES, recommendations: [] } });
    });
};

/* The shell is up once the rail's extensions have activated, the point after which the three failure states
 * below are meaningful rather than merely not-yet-rendered.
 *
 * "An extension tile is on the rail" no longer says that. The column seats a tile while it has something to
 * report and keeps the rest behind the More menu (core-views/registry.ts), and nothing behind a badge has data
 * on this fixture, so the honest signal is EITHER: an area seated (the one being visited, or one that is
 * badging) or the More tile counting the ones that are not. */
const shellReady = async (page: Page): Promise<void> => {
    await expect(page.locator(`nav a[href^="/ext/"], nav [aria-label*="not on the rail"]`).first()).toBeVisible();
};

// Open the rail's More menu, whose rows are the areas that are not currently seated. Its label carries the
// count, so it is matched on the stable half of it.
const openMore = async (page: Page): Promise<void> => {
    await page.locator(`nav [aria-label^="More areas"]`).click();
};

test.beforeEach(async ({ page }) => {
    await stubFacts(page);
});

test(`the rail and its More menu show exactly the views the fixture activates`, async ({ page }) => {
    await page.goto(`/agents`);
    await shellReady(page);
    // BOTH RUNS TOGETHER, because the split between them is a matter of what is badging this second and this
    // spec is about what ACTIVATED. Every area is in exactly one of the two (ShellDesktop cuts them from one
    // list), so their union is the inventory however the seats fall on the day.
    await openMore(page);

    const hrefs = await page.locator(`a[href^="/ext/"]`).evaluateAll((links) => links.map((link) => link.getAttribute(`href`) ?? ``));
    // `/ext/<id>` or `/ext/<id>/<key>`, the id is what identifies the view family.
    const railIds = [...new Set(hrefs.map((href) => href.split(`/`)[2] ?? ``))].filter((id) => id !== ``);

    /* Set equality, both directions, and the reason each direction matters:
     *  • something expected is MISSING ⇒ a detect() rule changed, or the fixture no longer carries its evidence.
     *  • something UNEXPECTED appeared ⇒ a rail view was added without a line in EXPECTED_ACTIVATIONS, so the
     *    matrix below would silently not cover it. That is the failure this assertion exists to prevent,
     *    "every view loads" is only true while the inventory keeps up with the registry. */
    expect(railIds.toSorted()).toEqual([...new Set(EXPECTED_RAIL_IDS)].toSorted());
});

test(`every registered extension view mounts`, async ({ page }) => {
    // One test walking every route rather than one test per view: the suite runs with a single worker against a
    // shared seeded world, so 21 separate contexts would cost far more than they report. Failures accumulate so
    // a run names EVERY broken view at once, the thing you actually want when a shared dependency breaks them
    // all, instead of fixing them one re-run at a time.
    const broken: string[] = [];

    for (const activation of EXPECTED_ACTIVATIONS) {
        const path = activationPath(activation);
        await page.goto(path);
        try {
            await shellReady(page);
            // The error boundary's card: the view was found and mounted, and then threw.
            await expect(page.getByText(`extension crashed rendering this view`)).toBeHidden({ timeout: 15_000 });
            // ExtensionHost's empty state: detect() yielded no activation for this key, so the fixture and the
            // rule disagree.
            await expect(page.getByText(`this view's content is no longer in the workspace`)).toBeHidden({ timeout: 1_000 });
            // The owning extension is disabled in this sandbox, a different failure with the same blank result.
            await expect(page.getByText(`is switched off`)).toBeHidden({ timeout: 1_000 });
        } catch (error) {
            broken.push(
                `${path} (${activation.id}, expected because ${activation.why}): ${error instanceof Error ? error.message.split(`\n`)[0] : String(error)}`,
            );
        }
    }

    expect(broken, `${broken.length} of ${EXPECTED_ACTIVATIONS.length} extension views did not mount`).toEqual([]);
});
