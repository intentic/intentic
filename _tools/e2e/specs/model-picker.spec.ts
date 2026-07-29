import { expect, test } from "@playwright/test";

// The unified model picker (T3Chat-style): one searchable list spanning every provider, a provider rail that
// FILTERS (never switches), harness folded into "via Claude Code" rows, and keyboard-first selection. The
// daemon endpoints are mocked so the catalogs are deterministic; everything else is the real Vue app — the
// pill trigger, the Popover host, the picker wiring, and the atomic provider+harness+model selection.

const CLAUDE_CATALOG = {
    models: [
        { id: "claude-opus-4-6", label: "Opus 4.6" },
        { id: "claude-sonnet-4-5", label: "Sonnet 4.5" },
        { id: "claude-haiku-4-5", label: "Haiku 4.5" },
    ],
    default: "claude-opus-4-6",
};
const CODEX_CATALOG = {
    models: [
        { id: "gpt-5.1", label: "GPT-5.1" },
        { id: "gpt-5.1-codex", label: "GPT-5.1 Codex" },
    ],
    default: "gpt-5.1",
};
const GROK_CATALOG = {
    models: [
        { id: "grok-4", label: "Grok 4" },
        { id: "grok-4-fast", label: "Grok 4 Fast" },
    ],
    default: "grok-4",
};

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

const connectAll = async (page: import("@playwright/test").Page): Promise<void> => {
    await page.route("**/claude/accounts", (route) => route.fulfill({ json: { accounts: [{ id: "claude-1", label: "Claude" }] } }));
    await page.route("**/codex/accounts", (route) => route.fulfill({ json: { accounts: [{ id: "codex-1", label: "ChatGPT" }] } }));
    await page.route("**/grok/accounts", (route) => route.fulfill({ json: { accounts: [{ id: "grok-1", label: "Grok" }] } }));
    await page.route("**/claude/models", (route) => route.fulfill({ json: CLAUDE_CATALOG }));
    await page.route("**/codex/models", (route) => route.fulfill({ json: CODEX_CATALOG }));
    await page.route("**/grok/models", (route) => route.fulfill({ json: GROK_CATALOG }));
};

const openPicker = async (page: import("@playwright/test").Page): Promise<void> => {
    await page.goto("/workspace");
    await expect(page.locator('textarea[name="draft"]')).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Provider and model" }).click();
};

test("search spans providers and Enter picks the top hit — an atomic cross-provider switch", async ({ page }) => {
    const { pageErrors, vueErrors } = collectErrors(page);
    await connectAll(page);
    await openPicker(page);

    // Browse mode groups by provider — every connected provider's catalog is in one list.
    await expect(page.getByRole("option", { name: "Opus 4.6 — current model" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("option", { name: "GPT-5.1", exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: "Grok 4", exact: true })).toBeVisible();

    // The search input is auto-focused on open (desktop). "fast" narrows to the sole label match across all
    // providers; the other providers' rows drop out. (fill, not type: type races the just-opened popover's
    // input mount — this asserts the settled search state a real user sees.)
    await expect(page.getByRole("searchbox")).toBeFocused();
    await page.getByRole("searchbox").fill("fast");
    await expect(page.getByRole("option", { name: "Grok 4 Fast", exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: "GPT-5.1", exact: true })).toBeHidden();
    // Enter takes the highlighted top hit (highlight snaps to row 0 on every result change).
    await page.keyboard.press("Enter");

    // One keystroke switched provider AND model: the conversation now targets Grok 4 Fast, picker closed.
    await expect(page.getByRole("button", { name: "Provider and model" })).toContainText("Grok 4 Fast", { timeout: 15_000 });
    await expect(page.getByRole("searchbox")).toBeHidden();

    expect(pageErrors, `uncaught page errors:\n${pageErrors.join("\n")}`).toEqual([]);
    expect(vueErrors, `Vue render/lifecycle errors:\n${vueErrors.join("\n")}`).toEqual([]);
});

test("a 'via Claude Code' row selects the translator harness and surfaces the API-key caveat", async ({ page }) => {
    const { pageErrors, vueErrors } = collectErrors(page);
    await connectAll(page);
    await openPicker(page);

    // The codex group carries the deterministic translator row alongside the native catalog.
    const translatorRow = page.getByRole("option", { name: "GPT-5 Codex via Claude Code" });
    await expect(translatorRow).toBeVisible({ timeout: 15_000 });
    await translatorRow.click();

    // The pick applied provider+harness+model atomically; reopening shows the row as current and the footer
    // explains the harness's API-key requirement.
    await expect(page.getByRole("button", { name: "Provider and model" })).toContainText("GPT-5 Codex", { timeout: 15_000 });
    await page.getByRole("button", { name: "Provider and model" }).click();
    await expect(page.getByRole("option", { name: "GPT-5 Codex via Claude Code — current model" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Runs this model through the Claude Code harness")).toBeVisible();

    expect(pageErrors, `uncaught page errors:\n${pageErrors.join("\n")}`).toEqual([]);
    expect(vueErrors, `Vue render/lifecycle errors:\n${vueErrors.join("\n")}`).toEqual([]);
});

test("the rail filters without switching, and the no-results escape widens the search", async ({ page }) => {
    const { pageErrors, vueErrors } = collectErrors(page);
    await connectAll(page);
    await openPicker(page);
    await expect(page.getByRole("option", { name: "Grok 4", exact: true })).toBeVisible({ timeout: 15_000 });

    // Scoping to Codex hides the other providers' rows — but does NOT touch the conversation's provider.
    await page.getByRole("radio", { name: "Codex" }).click();
    await expect(page.getByRole("option", { name: "GPT-5.1", exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: "Grok 4", exact: true })).toBeHidden();
    await expect(page.getByRole("button", { name: "Provider and model" })).toContainText("Opus 4.6");

    // A query with no hits inside the scoped provider offers the one-click escape to all providers.
    await page.getByRole("searchbox").fill("grok");
    await expect(page.getByText("No models match.")).toBeVisible();
    await page.getByRole("button", { name: "Search all providers" }).click();
    await expect(page.getByRole("option", { name: "Grok 4", exact: true })).toBeVisible();

    // Esc clears the query first (grouped view returns), a second Esc closes the picker.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("option", { name: "Opus 4.6 — current model" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("searchbox")).toBeHidden();

    expect(pageErrors, `uncaught page errors:\n${pageErrors.join("\n")}`).toEqual([]);
    expect(vueErrors, `Vue render/lifecycle errors:\n${vueErrors.join("\n")}`).toEqual([]);

    await page.screenshot({ path: "./.cache/model-picker.png", fullPage: true });
});

/* THE PANEL MUST NEVER COVER THE PILL IT HANGS OFF. The picker is the tallest overlay in the app and its
 * trigger sits a couple of rows off the bottom of the window, so on a short window the panel wants more room
 * than there is above it — and PrimeVue answers that by pinning the overlay to the top of the viewport, which
 * put it straight over the pill. That is unrecoverable from the pointer alone: every click aimed at the pill
 * lands inside the overlay, which is the one click the dismiss logic deliberately ignores, so the picker could
 * not be closed by its own button or by the space around it. The panel is capped to the room it has instead
 * (ChatPanel), and this is the geometry that says so. */
test("on a short window the panel fits above the pill instead of covering it", async ({ page }) => {
    const { pageErrors, vueErrors } = collectErrors(page);
    // Short enough that the picker's natural height (search + list + session footer) exceeds the room above
    // the composer pill — the state a small laptop window or a popped-out chat window is routinely in.
    await page.setViewportSize({ width: 1100, height: 520 });
    await connectAll(page);
    await openPicker(page);

    const pill = page.getByRole("button", { name: "Provider and model" });
    const panel = page.locator(".p-popover");
    await expect(page.getByRole("option", { name: "Opus 4.6 — current model" })).toBeVisible({ timeout: 15_000 });

    const pillBox = (await pill.boundingBox())!;
    const panelBox = (await panel.boundingBox())!;
    // Wholly above the pill, and wholly on screen — a panel clipped off the top hides its own search box.
    expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(pillBox.y);
    expect(panelBox.y).toBeGreaterThanOrEqual(0);
    // The list gave way rather than the panel overflowing: rows still scroll inside it.
    await expect(page.locator("#model-picker-list")).toBeVisible();

    // And so the pill still closes what it opened.
    await pill.click();
    await expect(page.getByRole("searchbox")).toBeHidden();

    expect(pageErrors, `uncaught page errors:\n${pageErrors.join("\n")}`).toEqual([]);
    expect(vueErrors, `Vue render/lifecycle errors:\n${vueErrors.join("\n")}`).toEqual([]);
});
