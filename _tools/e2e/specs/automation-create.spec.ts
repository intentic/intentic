import { expect, test } from "@playwright/test";
import { DAEMON_URL } from "../stack.js";

// The automations journey: the create dialog's form (hand-mirrored Zod schemas in api-contract) must round-trip
// through the daemon's POST /automations and come back in the list, the drift guard for the mirrored shapes.
test(`a schedule automation created in the UI lands in the daemon's manifest and is listed back`, async ({ page }) => {
    await page.goto(`/automations`);
    await page.getByRole(`button`, { name: `New automation` }).click();
    await page.getByPlaceholder(`morning-briefing`).fill(`e2e-morning`);
    // Trigger defaults to Schedule with a valid default cadence; only the prompt is still required.
    await page.getByPlaceholder(`Check the inbox and summarize anything urgent.`).fill(`Say hello.`);
    await page.getByRole(`button`, { name: `Create` }).click();

    await expect(page.getByText(`e2e-morning`)).toBeVisible();

    // Ground truth from the daemon's manifest, independent of the UI.
    const listed = (await (await fetch(`${DAEMON_URL}/automations`)).json()) as {
        automations: { id: string; trigger: { kind: string } }[];
    };
    const created = listed.automations.find((automation) => automation.id === `e2e-morning`);
    expect(created?.trigger.kind).toBe(`schedule`);

    // Leave the reused daemon as found.
    await fetch(`${DAEMON_URL}/automations/e2e-morning`, { method: `DELETE` });
});
