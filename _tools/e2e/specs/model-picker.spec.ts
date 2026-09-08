import { expect, test } from "@playwright/test";

// Unified model picker: one searchable list across providers, a rail that filters (never switches), harness folded into
// 'via Claude Code' rows. Catalogs are mocked for determinism; everything else is the real app and picker wiring.

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
    await page.route("**/providers/claude/models", (route) => route.fulfill({ json: CLAUDE_CATALOG }));
    await page.route("**/providers/codex/models", (route) => route.fulfill({ json: CODEX_CATALOG }));
    await page.route("**/providers/grok/models", (route) => route.fulfill({ json: GROK_CATALOG }));
};

const openPicker = async (page: import("@playwright/test").Page): Promise<void> => {
    await page.goto("/workspace");
    await expect(page.locator('textarea[name="draft"]')).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Provider and model" }).click();
};

test("search spans providers and Enter picks the top hit: an atomic cross-provider switch", async ({ page }) => {
    const { pageErrors, vueErrors } = collectErrors(page);
    await connectAll(page);
    await openPicker(page);

    await expect(page.getByRole("option", { name: "Opus 4.6 — current model" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("option", { name: "GPT-5.1", exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: "Grok 4", exact: true })).toBeVisible();

    // fill, not type: type races the just-opened popover's input mount; this asserts the settled search state.
    await expect(page.getByRole("searchbox")).toBeFocused();
    await page.getByRole("searchbox").fill("fast");
    await expect(page.getByRole("option", { name: "Grok 4 Fast", exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: "GPT-5.1", exact: true })).toBeHidden();
    // Enter takes the highlighted top hit; the highlight snaps to row 0 on every result change.
    await page.keyboard.press("Enter");

    await expect(page.getByRole("button", { name: "Provider and model" })).toContainText("Grok 4 Fast", { timeout: 15_000 });
    await expect(page.getByRole("searchbox")).toBeHidden();

    expect(pageErrors, `uncaught page errors:\n${pageErrors.join("\n")}`).toEqual([]);
    expect(vueErrors, `Vue render/lifecycle errors:\n${vueErrors.join("\n")}`).toEqual([]);
});

test("a 'via Claude Code' row selects the translator harness and surfaces the API-key caveat", async ({ page }) => {
    const { pageErrors, vueErrors } = collectErrors(page);
    await connectAll(page);
    await openPicker(page);

    const translatorRow = page.getByRole("option", { name: "GPT-5 Codex via Claude Code" });
    await expect(translatorRow).toBeVisible({ timeout: 15_000 });
    await translatorRow.click();

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

    // Filtering to Codex hides other rows but doesn't touch the conversation's own provider (still Opus 4.6).
    await page.getByRole("radio", { name: "Codex" }).click();
    await expect(page.getByRole("option", { name: "GPT-5.1", exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: "Grok 4", exact: true })).toBeHidden();
    await expect(page.getByRole("button", { name: "Provider and model" })).toContainText("Opus 4.6");

    await page.getByRole("searchbox").fill("grok");
    await expect(page.getByText("No models match.")).toBeVisible();
    await page.getByRole("button", { name: "Search all providers" }).click();
    await expect(page.getByRole("option", { name: "Grok 4", exact: true })).toBeVisible();

    // Esc order matters: first clears the query (grouped view returns), second closes the picker.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("option", { name: "Opus 4.6 — current model" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("searchbox")).toBeHidden();

    expect(pageErrors, `uncaught page errors:\n${pageErrors.join("\n")}`).toEqual([]);
    expect(vueErrors, `Vue render/lifecycle errors:\n${vueErrors.join("\n")}`).toEqual([]);

    await page.screenshot({ path: "./.cache/model-picker.png", fullPage: true });
});

// On a short window PrimeVue's default overlay pins to the viewport top, covering the pill it hangs off and becoming
// unclosable by click. The panel is capped to the room it has (ChatPanel) instead.
test("on a short window the panel fits above the pill instead of covering it", async ({ page }) => {
    const { pageErrors, vueErrors } = collectErrors(page);
    // Short enough that the picker's height exceeds the room above the pill (a small laptop or popped-out window).
    await page.setViewportSize({ width: 1100, height: 520 });
    await connectAll(page);
    await openPicker(page);

    const pill = page.getByRole("button", { name: "Provider and model" });
    const panel = page.locator(".p-popover");
    await expect(page.getByRole("option", { name: "Opus 4.6 — current model" })).toBeVisible({ timeout: 15_000 });

    const pillBox = (await pill.boundingBox())!;
    const panelBox = (await panel.boundingBox())!;
    // Also checks the top isn't clipped off-screen, which would hide the search box.
    expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(pillBox.y);
    expect(panelBox.y).toBeGreaterThanOrEqual(0);
    // The list shrinks and scrolls inside the panel, rather than the panel overflowing the window.
    await expect(page.locator("#model-picker-list")).toBeVisible();

    await pill.click();
    await expect(page.getByRole("searchbox")).toBeHidden();

    expect(pageErrors, `uncaught page errors:\n${pageErrors.join("\n")}`).toEqual([]);
    expect(vueErrors, `Vue render/lifecycle errors:\n${vueErrors.join("\n")}`).toEqual([]);
});
