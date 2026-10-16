import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { auditPage, WCAG_22_AA } from "./audit.js";

const looks = [`light`, `dark`, `sanctum`] as const;
const screens = [
    `login`, `agents`, `chat`, `workspace`, `settings`, `settings/appearance`, `settings/organisation`, `sandbox`,
    `sandbox/access`, `sandbox/areas`, `sandbox/personas`, `sandbox/data-protection`, `sandbox/audit`,
    `capabilities`, `ext/approvals`, `ext/workflows`, `ext/e-urzad/office-ezd`, `ext/e-urzad/office-ed`,
] as const;

const open = async (page: Page, path: string): Promise<void> => {
    await page.goto(`${path}?mode=full`, { waitUntil: `domcontentloaded` });
    if (![`agents`, `chat`, `workspace`].includes(path)) {
        await page.locator(`main h1, main h2`).first().waitFor();
    }
    if (path !== `login`) {
        await expect(page.locator(`#main-content`)).toBeVisible();
        await expect(page.locator(`#main-content`)).not.toHaveText(``);
        if ((page.viewportSize()?.width ?? 0) >= 768) {
            // The shared side chat loads after the route. Scanning just the shell can miss all of its controls.
            await page.locator(`.chat-turns`).first().waitFor();
            await expect(page.locator(`textarea:visible`).first()).toBeVisible();
        }
        if (path === `agents`) {
            await page.locator(`.session-card button`).first().waitFor();
        }
        if (path === `settings/organisation`) {
            await page.getByRole(`button`, { name: /^Transport office demo/ }).click();
            await page.getByRole(`switch`).first().waitFor();
        }
        if (path.startsWith(`ext/e-urzad/`)) {
            await page.getByRole(`status`).filter({ hasText: /Last read from the office|Ostatni odczyt z urzędu/ }).waitFor();
        }
    }
    await page.evaluate(() => document.fonts.ready);
};

const clean = async (page: Page): Promise<void> => {
    const findings = await auditPage(page, WCAG_22_AA);
    await test.info().attach(`axe-findings`, { body: JSON.stringify(findings, null, 2), contentType: `application/json` });
    expect(findings).toEqual([]);
};

for (const look of looks) {
    test.describe(`${look} WCAG 2.2 AA`, () => {
        test.beforeEach(async ({ page }) => {
            await page.addInitScript((selected) => {
                localStorage.setItem(`ui-color-scheme`, selected === `light` ? `light` : `dark`);
                localStorage.setItem(`ui-skin`, selected === `sanctum` ? `sanctum` : `none`);
                localStorage.setItem(`ui-locale`, `en`);
            }, look);
        });
        for (const screen of screens) {
            test(screen, async ({ page }) => {
                await open(page, screen);
                await clean(page);
            });
        }
        test(`switch contrast`, async ({ page }) => {
            await open(page, `settings/organisation`);
            const ratios = await page.getByRole(`switch`, { name: `Product analytics off`, exact: true }).evaluate((input) => {
                const root = input.closest(`.p-toggleswitch`)!;
                const slider = root.querySelector(`.p-toggleswitch-slider`)!;
                const handle = root.querySelector(`.p-toggleswitch-handle`)!;
                const context = document.createElement(`canvas`).getContext(`2d`, { willReadFrequently: true })!;
                // Canvas resolves the browser's oklch/oklab/mixed CSS colours to sRGB, including transparency.
                const rgba = (color: string): number[] => {
                    context.clearRect(0, 0, 1, 1);
                    context.fillStyle = color;
                    context.fillRect(0, 0, 1, 1);
                    return [...context.getImageData(0, 0, 1, 1).data];
                };
                const luminance = (rgb: number[]): number => rgb.slice(0, 3).map((value) => {
                    const channel = value / 255;
                    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
                }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
                const contrast = (a: number[], b: number[]): number => {
                    const light = Math.max(luminance(a), luminance(b));
                    const dark = Math.min(luminance(a), luminance(b));
                    return (light + 0.05) / (dark + 0.05);
                };
                let parent = root.parentElement;
                while (parent !== null && rgba(getComputedStyle(parent).backgroundColor)[3] !== 255) {
                    parent = parent.parentElement;
                }
                const track = rgba(getComputedStyle(slider).backgroundColor);
                const knob = rgba(getComputedStyle(handle).backgroundColor);
                const surface = rgba(getComputedStyle(parent ?? document.body).backgroundColor);
                return { trackAlpha: track[3], handleAlpha: knob[3], track: contrast(track, surface), handle: contrast(knob, track) };
            });
            expect(ratios.trackAlpha).toBe(255);
            expect(ratios.handleAlpha).toBe(255);
            expect(ratios.track).toBeGreaterThanOrEqual(3);
            expect(ratios.handle).toBeGreaterThanOrEqual(3);
            await test.info().attach(`switch-contrast`, { body: JSON.stringify(ratios), contentType: `application/json` });
            await clean(page);
        });
    });
}

test(`command palette names its dialog, navigates results and restores focus`, async ({ page }) => {
    await open(page, `agents`);
    const trigger = page.getByRole(`searchbox`, { name: `Filter agents by your messages or id` });
    await trigger.focus();
    await page.keyboard.press(`Control+Shift+p`);
    const dialog = page.getByRole(`dialog`, { name: `Jump to anything`, exact: true });
    await expect(dialog).toBeVisible();
    const input = dialog.getByRole(`combobox`, { name: `Jump to anything`, exact: true });
    await expect(input).toBeFocused();
    await input.fill(`> Go to: Agents`);
    const option = dialog.getByRole(`option`, { name: /Go to: Agents/ });
    await expect(option).toHaveAttribute(`aria-selected`, `true`);
    await expect(input).toHaveAttribute(`aria-activedescendant`, await option.getAttribute(`id`) ?? ``);
    await clean(page);
    await input.fill(`> no-such-command-73921`);
    await expect(dialog.getByRole(`status`)).toHaveText(`Nothing matches.`);
    await clean(page);
    await page.keyboard.press(`Escape`);
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
});

test(`organisation policy groups and switches work from the keyboard`, async ({ page }) => {
    await open(page, `settings/organisation`);
    const mode = page.locator(`#main-content [role="tablist"]`).filter({ has: page.getByRole(`tab`, { name: `Read-only`, exact: true }) }).first();
    await expect(mode).toHaveAttribute(`aria-label`, /.+/);
    const tabs = mode.getByRole(`tab`);
    await tabs.first().focus();
    await page.keyboard.press(`End`);
    await expect(tabs.last()).toBeFocused();
    await expect(tabs.last()).toHaveAttribute(`aria-selected`, `true`);
    await page.keyboard.press(`ArrowRight`);
    await expect(tabs.first()).toBeFocused();
    await expect(tabs.first()).toHaveAttribute(`tabindex`, `0`);
    await expect(tabs.last()).toHaveAttribute(`tabindex`, `-1`);
    await page.keyboard.press(`ArrowLeft`);
    await expect(tabs.last()).toBeFocused();
    await page.keyboard.press(`Home`);
    await expect(tabs.first()).toBeFocused();
    const pin = page.getByRole(`switch`, { name: `Privacy shield on, with images masked`, exact: true });
    await expect(pin).toBeChecked();
    await pin.focus();
    await page.keyboard.press(`Space`);
    await expect(pin).not.toBeChecked();
    await expect(page.getByRole(`button`, { name: `Save as new version`, exact: true })).toBeEnabled();
    await clean(page);
});

for (const width of [1440, 320]) {
    test(`shared modal traps and restores keyboard focus at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(`kit`);
        const trigger = page.getByRole(`button`, { name: `Open modal`, exact: true });
        await trigger.focus();
        await page.keyboard.press(`Enter`);
        const dialog = page.getByRole(`dialog`, { name: `A modal`, exact: true });
        await expect(dialog).toBeVisible();
        await expect(dialog).toHaveAttribute(`aria-modal`, `true`);
        for (const key of Array.from({ length: 16 }, (_, index) => index < 8 ? `Tab` : `Shift+Tab`)) {
            await page.keyboard.press(key);
            expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
        }
        // Only the shared modal is the subject here; the development kit has independent examples outside it.
        const result = await new AxeBuilder({ page }).withTags(WCAG_22_AA).include(`[role="dialog"]`).analyze();
        expect(result.violations).toEqual([]);
        await page.keyboard.press(`Escape`);
        await expect(dialog).toBeHidden();
        await expect(trigger).toBeFocused();
    });
}

test(`office refresh announces waiting, failure, empty results and a successful connection`, async ({ page }) => {
    await open(page, `ext/e-urzad/office-ezd`);
    // Replace the refresh and its cached reread after the real demo transport has installed. No office service is contacted.
    await page.evaluate(() => {
        const original = globalThis.fetch;
        let failed = false;
        let refreshed = false;
        const empty = () => Response.json({ snapshot: {
            card: `office-ezd`, service: `ezd-rp`, syncedAt: `2026-10-15T10:00:00.000Z`,
            cases: [], tasks: [], deliveries: [], proofs: [], actions: [],
        } });
        globalThis.fetch = async (input, init) => {
            const request = new Request(input, init);
            const path = new URL(request.url).pathname;
            if (refreshed && path.endsWith(`/x/intentic.e-urzad/accounts/office-ezd/overview`) && request.method === `GET`) {
                return empty();
            }
            if (!path.endsWith(`/x/intentic.e-urzad/accounts/office-ezd/sync`) || request.method !== `POST`) {
                return original(input, init);
            }
            if (!failed) {
                failed = true;
                await new Promise<void>((resolve) => document.addEventListener(`a11y-release`, () => resolve(), { once: true }));
                return Response.json({ error: `The office is temporarily unavailable. Please retry.` }, { status: 503 });
            }
            refreshed = true;
            return empty();
        };
    });
    const refresh = page.getByRole(`button`, { name: `Refresh from the office`, exact: true });
    const connection = page.getByRole(`button`, { name: `Test connection`, exact: true });
    await refresh.focus();
    await page.keyboard.press(`Enter`);
    await expect(refresh).toBeDisabled();
    await expect(connection).toBeDisabled();
    await expect(page.getByRole(`status`).filter({ hasText: `Reading the office…` })).toBeVisible();
    await page.evaluate(() => document.dispatchEvent(new Event(`a11y-release`)));
    await expect(page.getByRole(`alert`)).toContainText(`The office is temporarily unavailable. Please retry.`);
    await expect(refresh).toBeEnabled();
    await expect(page.getByText(`Organizacja komunikacji miejskiej`, { exact: true })).toBeVisible();
    await clean(page);
    await refresh.click();
    await expect(page.getByRole(`alert`)).toHaveCount(0);
    await expect(page.getByText(`No cases in progress, or none read yet.`, { exact: true })).toBeVisible();
    await expect(page.getByText(`No tasks, or none read yet.`, { exact: true })).toBeVisible();
    await connection.click();
    await expect(page.getByRole(`status`).filter({ hasText: `Connected` })).toBeVisible();
    await clean(page);
});

test.describe(`office calendar dates`, () => {
    test.use({ timezoneId: `America/Los_Angeles` });
    test(`deadlines keep their calendar day west of UTC`, async ({ page }) => {
        await open(page, `ext/e-urzad/office-ezd`);
        await expect(page.getByText(/KT\.7240\.12\.2026 · JRWA 7240 · due Oct 22, 2026/)).toBeVisible();
    });
});

test(`system reduced motion and forced colours preserve keyboard focus`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: `reduce`, forcedColors: `active` });
    await open(page, `agents`);
    await expect(page.locator(`html`)).toHaveAttribute(`data-motion`, `reduced`);
    expect(await page.locator(`html`).evaluate((element) => getComputedStyle(element).getPropertyValue(`--motion-quick`).trim())).toBe(`0ms`);
    await page.keyboard.press(`Tab`);
    const skip = page.getByRole(`link`, { name: `Skip to main content` });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    const indicator = await skip.evaluate((element) => {
        const style = getComputedStyle(element);
        return { style: style.outlineStyle, width: style.outlineWidth, visible: element.matches(`:focus-visible`) };
    });
    expect(indicator).toEqual({ style: `solid`, width: `2px`, visible: true });
    await page.keyboard.press(`Enter`);
    await expect(page.locator(`#main-content`)).toBeFocused();
    await clean(page);
});

for (const screen of [`agents`, `sandbox/access`, `ext/approvals`, `ext/e-urzad/office-ezd`]) {
    test(`200% text size: ${screen}`, async ({ page }) => {
        await open(page, screen);
        const before = await page.locator(`html`).evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
        await page.addStyleTag({ content: `:root { font-size: ${before * 2}px !important; }` });
        await expect(page.locator(`html`)).toHaveCSS(`font-size`, `${before * 2}px`);
        await expect(page.locator(`#main-content`)).toBeVisible();
        const overflow = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(`#main-content, #main-content .ui-page, body`)]
            .filter((element) => element.scrollWidth > element.clientWidth + 1)
            .map((element) => ({ tag: element.tagName, width: element.clientWidth, scroll: element.scrollWidth })));
        expect(overflow).toEqual([]);
        await clean(page);
    });
}

test(`keyboard bypass reaches the main controls`, async ({ page }) => {
    await open(page, `agents`);
    await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
        }
    });
    await page.keyboard.press(`Tab`);
    const skip = page.getByRole(`link`, { name: `Skip to main content` });
    await expect(skip).toBeFocused();
    await expect(skip).toBeInViewport();
    await page.keyboard.press(`Enter`);
    await expect(page.locator(`#main-content`)).toBeFocused();
    await page.keyboard.press(`Tab`);
    expect(await page.evaluate(() => document.getElementById(`main-content`)?.contains(document.activeElement))).toBe(true);
});

test(`agent cards expose independent native buttons`, async ({ page }) => {
    await open(page, `agents`);
    const focus = page.getByRole(`button`, { name: /^Focus agent:/ }).first();
    await expect(focus).toHaveJSProperty(`tagName`, `BUTTON`);
    await focus.focus();
    await page.keyboard.press(`Space`);
    await expect(focus.locator(`xpath=ancestor::*[contains(@class,'session-card')]`)).toHaveClass(/session-card-on/);
    expect(await page.locator(`.session-card [role="button"] button, .session-card button button`).count()).toBe(0);
});

test(`area disclosure and persona routing have names and keyboard actions`, async ({ page }) => {
    await open(page, `sandbox/areas`);
    const disclosure = page.getByRole(`button`, { name: /^Toggle details for / }).first();
    await expect(disclosure).toHaveAttribute(`aria-expanded`, `false`);
    await disclosure.focus();
    await page.keyboard.press(`Enter`);
    await expect(disclosure).toHaveAttribute(`aria-expanded`, `true`);
    await clean(page);
    await open(page, `sandbox/personas`);
    await expect(page.getByRole(`switch`, { name: /Match new chats/ })).toBeVisible();
});

for (const locale of [`en`, `pl`] as const) {
    for (const screen of [`agents`, `settings/organisation`, `sandbox/access`, `sandbox/areas`, `ext/approvals`, `ext/e-urzad/office-ezd`, `ext/e-urzad/office-ed`]) {
        test(`${locale} reflow at 320px: ${screen}`, async ({ page }) => {
            await page.setViewportSize({ width: 320, height: 800 });
            await page.addInitScript((language) => localStorage.setItem(`ui-locale`, language), locale);
            await open(page, screen);
            await expect(page.locator(`html`)).toHaveAttribute(`lang`, locale);
            const overflow = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(`#main-content, #main-content .ui-page, body`)]
                .filter((element) => element.scrollWidth > element.clientWidth + 1)
                .map((element) => ({ tag: element.tagName, class: element.className, width: element.clientWidth, scroll: element.scrollWidth })));
            expect(overflow).toEqual([]);
            await clean(page);
        });
    }
}
