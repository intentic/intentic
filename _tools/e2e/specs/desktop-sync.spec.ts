import { expect, test } from "@playwright/test";

// The desktop-sync journey: the form offers Enable only when the daemon reports an sshHostname (the tunnel-
// derived name, the e2e daemon gets CONNECT_TOKEN + ZONE for exactly this), and Enable mints a pairing token
// via POST /system/sync/pair, rendered as the copy-paste agent one-liner.
test(`enabling desktop sync mints a pairing and renders the agent one-liner`, async ({ page }) => {
    // Pairing is a task, not a state to read, so it lives behind this button on the Devices board.
    await page.goto(`/sandbox/devices`);
    await page.getByRole(`button`, { name: `Add a device` }).click();
    await page.getByRole(`button`, { name: `Enable desktop sync` }).click();

    await expect(page.getByText(`Run this on your device`)).toBeVisible();
    await expect(page.getByText(`Linux / macOS`)).toBeVisible();
    await expect(page.getByText(`Windows (PowerShell)`)).toBeVisible();
});
