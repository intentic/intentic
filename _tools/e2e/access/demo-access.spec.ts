import { expect, test, type Page } from "@playwright/test";

// WHAT A PERSON BELOW THE OWNER MEETS, SCREEN BY SCREEN. The demo's daemon refuses each tier below its routes' floors
// with the daemon's own check (_site/demo/src/floors.ts, `?as=`), and logs every refusal it makes. The editor is meant
// to foresee each of them and never send it (_editor/web/src/client/sandbox/access/): a refusal that reaches the daemon
// is a read or a press the editor offered someone who could only be refused. And no screen may say an access refusal
// as a failure: the daemon's sentence in a red notice is what this suite was written against.

const TIERS = [`maintainer`, `collaborator`, `viewer`, `guest`] as const;

// Every screen the rail, the hub and the palette reach, the hub's sections included: a guest's fence and the hub send
// the ones a tier may not see elsewhere, and that is part of what is checked.
const SCREENS = [
    `chat`,
    `home`,
    `agents`,
    `workspace`,
    `capabilities`,
    `sandbox`,
    `sandbox/usage`,
    `sandbox/models`,
    `sandbox/agent`,
    `sandbox/environment`,
    `sandbox/secrets`,
    `sandbox/extensions`,
    `sandbox/extensions?view=browse`,
    `sandbox/access`,
    `sandbox/personas`,
    `sandbox/map`,
    `sandbox/data-protection`,
    `sandbox/activity`,
    `settings`,
    `settings/organisation`,
    `settings/notifications`,
    `ext/approvals`,
    `ext/workflows`,
    `ext/pipelines`,
    `ext/maintenance`,
    `ext/documentation`,
] as const;

// How long a screen is left for its reads to go out: the background loader and the polls run on idle beats.
const SETTLE_MS = 3_000;

// The daemon's words for an access refusal, which no screen may put in front of a person.
const REFUSAL_WORDS = /access required|not open to a guest member|running agents is not on for you/i;

// In-app navigation, as a click in the rail makes it: a reload per screen re-boots the whole editor. `base` is the
// demo's own path (`/demo/`), read off the page it first opened.
const visit = async (page: Page, base: string, screen: string): Promise<void> => {
    await page.evaluate((path) => {
        history.pushState({}, ``, path);
        dispatchEvent(new PopStateEvent(`popstate`, { state: history.state }));
    }, `${base}${screen}`);
    await page.waitForTimeout(SETTLE_MS);
};

for (const tier of TIERS) {
    test(`a ${tier} is never offered a refusal, and never shown one`, async ({ page }) => {
        const refused: string[] = [];
        page.on(`console`, (message) => {
            const text = message.text();
            if (text.startsWith(`[demo] ${tier} refused `)) {
                refused.push(text);
            }
        });
        await page.goto(`chat?as=${tier}&mode=full`, { waitUntil: `domcontentloaded` });
        await expect(page.locator(`#main-content`)).toBeVisible();
        const base = new URL(page.url()).pathname.replace(/[^/]*$/, ``);
        const shown: string[] = [];
        for (const screen of SCREENS) {
            await visit(page, base, screen);
            for (const alert of await page.getByRole(`alert`).allInnerTexts()) {
                if (REFUSAL_WORDS.test(alert)) {
                    shown.push(`${screen}: ${alert.replace(/\s+/g, ` `)}`);
                }
            }
        }
        expect(shown).toEqual([]);
        expect(refused).toEqual([]);
    });
}
