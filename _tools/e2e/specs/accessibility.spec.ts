import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { WEB_URL } from "../stack.js";
import { auditPage, printFindings } from "../accessibility/audit.js";

interface BaselineEntry { rule: string; target: string; note: string }
// SAFETY: the checked-in baseline contains only reviewed rule, target, and note strings.
const baseline = JSON.parse(readFileSync(new URL(`../accessibility/baseline.json`, import.meta.url), `utf8`)) as BaselineEntry[];
const accepted = new Set(baseline.map(({ rule, target }) => `${rule}\t${target}`));

for (const [screen, path, ready] of [
    [`sandbox home`, `/agents`, `main`],
    [`composer`, `/chat`, `textarea[name="draft"]`],
    [`settings`, `/settings`, `main`],
] as const) {
    test(`${screen} has no new serious WCAG 2.1 A/AA violations`, async ({ page }) => {
        await page.goto(path);
        await page.locator(ready).first().waitFor();
        const findings = await auditPage(page);
        printFindings(screen, findings);
        expect(findings.filter(({ impact, rule, target }) =>
            (impact === `serious` || impact === `critical`) && !accepted.has(`${rule}\t${target}`)),
        ).toEqual([]);
    });
}

test(`chat with a message has no new serious WCAG 2.1 A/AA violations`, async ({ page }) => {
    await page.route(`**/grok/accounts`, (route) => route.fulfill({ json: { accounts: [{ id: `grok-1`, label: `Grok` }] } }));
    await page.route(`**/providers/grok/models`, (route) =>
        route.fulfill({ json: { models: [{ id: `grok-4`, label: `Grok 4` }], default: `grok-4` } }),
    );
    await page.route(`**/claude/accounts`, (route) => route.fulfill({ json: { accounts: [] } }));
    await page.route(`**/codex/accounts`, (route) => route.fulfill({ json: { accounts: [] } }));
    await page.route(`**/agent`, (route) => route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: `${[`data: {"kind":"session","sessionId":"a11y-s1"}`, `data: {"kind":"delta","text":"A test message."}`, `data: {"kind":"done"}`].join(`\n\n`)  }\n\n`,
    }));
    await page.goto(`/workspace`);
    const composer = page.locator(`textarea[name="draft"]`);
    await expect(composer).toBeVisible();
    await composer.fill(`Accessibility test`);
    await page.getByRole(`button`, { name: `Send` }).click();
    await expect(page.locator(`.chat-surface-assistant`).last()).toContainText(`A test message.`);
    const findings = await auditPage(page);
    printFindings(`chat with message`, findings);
    expect(findings.filter(({ impact, rule, target }) =>
        (impact === `serious` || impact === `critical`) && !accepted.has(`${rule}\t${target}`)),
    ).toEqual([]);
});

test(`sign-in has no new serious WCAG 2.1 A/AA violations`, async ({ browser }) => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
        const page = await context.newPage();
        await page.goto(new URL(`/login`, WEB_URL).href);
        await page.locator(`main`).first().waitFor();
        const findings = await auditPage(page);
        printFindings(`sign-in`, findings);
        expect(findings.filter(({ impact, rule, target }) =>
            (impact === `serious` || impact === `critical`) && !accepted.has(`${rule}\t${target}`)),
        ).toEqual([]);
    } finally {
        await context.close();
    }
});
