import { expect, test } from "@playwright/test";

// Model picker lists xAI's live catalog and self-heals an empty-at-startup one: opening it refetches every provider.
// Daemon is mocked, driving the real Vue app; Claude/Codex stay unmocked to prove their static-alias fallback.

// Prefix of Grok's swirl-mark path; the old placeholder icon's path was `M6 3h4l8 18h-4z`.
const GROK_LOGO_PREFIX = "M9.27 15.29";
const GROK_PLACEHOLDER_PREFIX = "M6 3h4l8";

const CATALOG = {
    models: [
        { id: "grok-4", label: "Grok 4" },
        { id: "grok-3", label: "Grok 3" },
    ],
    default: "grok-4",
};

// Fails the test on any uncaught page error or a Vue error (main.ts prefixes those `[vue]`).
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

test("the model picker lists Grok's live catalog and shows the real Grok logo", async ({ page }) => {
    const { pageErrors, vueErrors } = collectErrors(page);

    // Only Grok is connected with a live catalog; empty rosters elsewhere make the composer auto-select it.
    await page.route("**/grok/accounts", (route) => route.fulfill({ json: { accounts: [{ id: "grok-1", label: "Grok" }] } }));
    await page.route("**/providers/grok/models", (route) => route.fulfill({ json: CATALOG }));
    await page.route("**/claude/accounts", (route) => route.fulfill({ json: { accounts: [] } }));
    await page.route("**/codex/accounts", (route) => route.fulfill({ json: { accounts: [] } }));

    await page.goto("/workspace");
    await expect(page.locator('textarea[name="draft"]')).toBeVisible({ timeout: 30_000 });

    // Chip shows the model's name, not just the icon; selection repoints to the default once the catalog loads.
    await expect(page.getByRole("button", { name: "Provider and model" })).toContainText("Grok 4", { timeout: 15_000 });

    await page.getByRole("button", { name: "Provider and model" }).click();

    // Current selection's accessible name appends ` — current model`.
    await expect(page.getByRole("option", { name: "Grok 4 — current model" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("option", { name: "Grok 3", exact: true })).toBeVisible();

    // ProviderLogo renders a single <path>, checked against the swirl vs placeholder prefixes.
    expect(await page.locator(`path[d^="${GROK_LOGO_PREFIX}"]`).count()).toBeGreaterThan(0);
    await expect(page.locator(`path[d^="${GROK_PLACEHOLDER_PREFIX}"]`)).toHaveCount(0);

    expect(pageErrors, `uncaught page errors:\n${pageErrors.join("\n")}`).toEqual([]);
    expect(vueErrors, `Vue render/lifecycle errors:\n${vueErrors.join("\n")}`).toEqual([]);

    await page.screenshot({ path: "./.cache/grok-models.png", fullPage: true });
});

test("opening the picker refetches the catalogs, self-healing an empty Grok list", async ({ page }) => {
    const { pageErrors, vueErrors } = collectErrors(page);

    // Grok's catalog stays withheld until grokReady flips, reachable only through the picker's on-open refetch.
    let grokReady = false;
    await page.route("**/providers/grok/models", (route) => route.fulfill({ json: grokReady ? CATALOG : { models: [] } }));
    await page.route("**/grok/accounts", (route) => route.fulfill({ json: { accounts: [{ id: "grok-1", label: "Grok" }] } }));
    await page.route("**/claude/accounts", (route) => route.fulfill({ json: { accounts: [{ id: "claude-1", label: "Claude" }] } }));
    await page.route("**/codex/accounts", (route) => route.fulfill({ json: { accounts: [] } }));

    await page.goto("/workspace");
    await expect(page.locator('textarea[name="draft"]')).toBeVisible({ timeout: 30_000 });

    grokReady = true;
    await page.getByRole("button", { name: "Provider and model" }).click();
    await expect(page.getByRole("option", { name: "Grok 4", exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("option", { name: "Grok 3", exact: true })).toBeVisible();

    await page.getByRole("option", { name: "Grok 4", exact: true }).click();
    await expect(page.getByRole("button", { name: "Provider and model" })).toContainText("Grok 4", { timeout: 15_000 });

    expect(pageErrors, `uncaught page errors:\n${pageErrors.join("\n")}`).toEqual([]);
    expect(vueErrors, `Vue render/lifecycle errors:\n${vueErrors.join("\n")}`).toEqual([]);
});
