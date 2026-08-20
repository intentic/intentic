import { expect, test } from "@playwright/test";

// The desktop-sync journey: the card offers Enable only when the daemon reports an sshHostname (the tunnel-
// derived name, the e2e daemon gets CONNECT_TOKEN + ZONE for exactly this), and Enable mints a pairing token
// via POST /system/sync/pair, rendered as the copy-paste agent one-liner.
test(`enabling desktop sync mints a pairing and renders the agent one-liner`, async ({ page }) => {
    await page.goto(`/sandbox`);
    await page.getByRole(`button`, { name: `Enable desktop sync` }).click();

    await expect(page.getByText(`Run this on your computer`)).toBeVisible();
    await expect(page.getByText(`Linux / macOS`)).toBeVisible();
    await expect(page.getByText(`Windows (PowerShell)`)).toBeVisible();
});
