import { expect, test } from "@playwright/test";
import { DAEMON_URL } from "../stack.js";

// The upload journey: seeded session → workspace shell (reachable via the daemon's /events heartbeat) → the
// real upload pipeline (upload-diff probe, per-file XHR to /workspace/upload) → tree refetch. The content is
// unique per run so the final read-back can't pass on a previous run's leftovers in a reused daemon.
test(`a file uploaded through the workspace UI round-trips to the daemon's disk`, async ({ page }) => {
    const content = `intentic browser e2e ${Date.now()}`;

    await page.goto(`/workspace`);
    // The picker input is hidden (drag-drop UI); setInputFiles drives it directly.
    await page.locator(`input[type="file"]`).setInputFiles({
        name: `e2e-upload.txt`,
        mimeType: `text/plain`,
        buffer: Buffer.from(content),
    });

    // The tree row appears only after the daemon accepted the write and the tree query refetched — the full
    // browser→daemon→disk→daemon→browser loop.
    await expect(page.getByRole(`treeitem`, { name: `e2e-upload.txt` })).toBeVisible({ timeout: 30_000 });

    // Ground truth straight from the daemon, independent of the UI.
    const raw = await fetch(`${DAEMON_URL}/workspace/raw?path=e2e-upload.txt`);
    expect(raw.status).toBe(200);
    expect(await raw.text()).toBe(content);
});
