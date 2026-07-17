import { expect, test } from "@playwright/test";

// The Grok MODEL picker must list xAI's live catalog, and it must self-heal a catalog that loaded empty before
// the account connected. Every provider's list is daemon-owned (fetched from /{provider}/models into a shared
// record by loadProviderModels; Claude falls back to its static tier aliases until then) — Grok's stays [] until
// a fetch succeeds. The regression this guards: after a Grok account connects, selecting Grok showed NO models
// because nothing re-fetched the catalog on that gesture. The daemon is fully mocked here (no real xAI account);
// we drive the real Vue app + real picker wiring. /claude/models and /codex/models are left unmocked — their
// failed fetches must degrade to the static floor (Claude's aliases) without breaking the page.

// The Grok "swirl" mark's path starts with this; the old placeholder was a diagonal bar "M6 3h4l8 18h-4z".
const GROK_LOGO_PREFIX = "M9.27 15.29";
const GROK_PLACEHOLDER_PREFIX = "M6 3h4l8";

const CATALOG = { models: [{ id: "grok-4", label: "Grok 4" }, { id: "grok-3", label: "Grok 3" }], default: "grok-4" };

// Fail the test on any uncaught page error or Vue render/lifecycle error (main.ts prefixes the latter "[vue]").
const collectErrors = (page: import("@playwright/test").Page): { pageErrors: string[]; vueErrors: string[] } => {
    const pageErrors: string[] = [];
    const vueErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    page.on("console", (msg) => {
        if (msg.type() === "error" && msg.text().startsWith("[vue]")) {
            vueErrors.push(msg.text());
        }
    });
    return { pageErrors, vueErrors };
};

test("the Grok model picker lists the live catalog and shows the real Grok logo", async ({ page }) => {
    const { pageErrors, vueErrors } = collectErrors(page);

    // Only Grok connected, with a live catalog; the other providers empty so the composer auto-selects Grok.
    await page.route("**/grok/accounts", (route) => route.fulfill({ json: { accounts: [{ id: "grok-1", label: "Grok" }] } }));
    await page.route("**/grok/models", (route) => route.fulfill({ json: CATALOG }));
    await page.route("**/claude/accounts", (route) => route.fulfill({ json: { accounts: [] } }));
    await page.route("**/codex/accounts", (route) => route.fulfill({ json: { accounts: [] } }));

    await page.goto("/workspace");
    await expect(page.locator('textarea[name="draft"]')).toBeVisible({ timeout: 30_000 });

    // The composer chip shows the model NAME, not just the Grok icon — the reported "icon, no name" bug. Once the
    // catalog loads, the empty grok selection is repointed to the default ("grok-4" → "Grok 4").
    await expect(page.getByRole("button", { name: "Provider and model" })).toContainText("Grok 4", { timeout: 15_000 });

    // Open the provider/model popover from the composer pill (stable aria-label handle).
    await page.getByRole("button", { name: "Provider and model" }).click();

    // The MODEL section lists every model from the live catalog.
    await expect(page.getByRole("button", { name: "Grok 4", exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Grok 3", exact: true })).toBeVisible();

    // The Grok logo is the real swirl mark, not the old placeholder bar. (ProviderLogo renders one <path>.)
    expect(await page.locator(`path[d^="${GROK_LOGO_PREFIX}"]`).count()).toBeGreaterThan(0);
    await expect(page.locator(`path[d^="${GROK_PLACEHOLDER_PREFIX}"]`)).toHaveCount(0);

    expect(pageErrors, `uncaught page errors:\n${pageErrors.join("\n")}`).toEqual([]);
    expect(vueErrors, `Vue render/lifecycle errors:\n${vueErrors.join("\n")}`).toEqual([]);

    await page.screenshot({ path: "./.cache/grok-models.png", fullPage: true });
});

test("selecting Grok refetches its catalog, self-healing an empty list", async ({ page }) => {
    const { pageErrors, vueErrors } = collectErrors(page);

    // Claude + Grok both connected, so the composer opens on Claude (the default) and Grok is switchable. The
    // Grok catalog is withheld until `grokReady` flips — so it can ONLY appear via a re-fetch after selecting
    // Grok. Without the selectProvider re-fetch, grokModels stays [] (loaded empty at startup) and this fails.
    let grokReady = false;
    await page.route("**/grok/models", (route) => route.fulfill({ json: grokReady ? CATALOG : { models: [] } }));
    await page.route("**/grok/accounts", (route) => route.fulfill({ json: { accounts: [{ id: "grok-1", label: "Grok" }] } }));
    await page.route("**/claude/accounts", (route) => route.fulfill({ json: { accounts: [{ id: "claude-1", label: "Claude" }] } }));
    await page.route("**/codex/accounts", (route) => route.fulfill({ json: { accounts: [] } }));

    await page.goto("/workspace");
    await expect(page.locator('textarea[name="draft"]')).toBeVisible({ timeout: 30_000 });

    // Open the picker on Claude and confirm its static models are there (sanity — the picker itself works).
    await page.getByRole("button", { name: "Provider and model" }).click();
    await expect(page.getByRole("button", { name: "Opus", exact: true })).toBeVisible({ timeout: 15_000 });

    // Now the catalog becomes available and the user switches to Grok. The switch must trigger a re-fetch.
    grokReady = true;
    await page.getByRole("button", { name: "Grok", exact: true }).click();

    // The MODEL section populates from the freshly-fetched catalog — the whole point of the fix.
    await expect(page.getByRole("button", { name: "Grok 4", exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Grok 3", exact: true })).toBeVisible();

    expect(pageErrors, `uncaught page errors:\n${pageErrors.join("\n")}`).toEqual([]);
    expect(vueErrors, `Vue render/lifecycle errors:\n${vueErrors.join("\n")}`).toEqual([]);
});
