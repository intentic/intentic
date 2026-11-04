import { page as pages, topPath } from "@intentic/sandbox-contract/app-routes";
import { chromium } from "@playwright/test";
import { demoHome, demoPage } from "../fixtures/demo-pages.ts";
import { auditPage, printFindings } from "./audit.ts";

const demo = process.env.AXE_DEMO_URL ?? `http://127.0.0.1:47160/demo`;
const site = process.env.AXE_SITE_URL ?? `http://localhost:47149`;
const screens = [
    [`demo sign-in`, `${demo}${topPath(`login`)}`],
    [`demo sandbox home`, `${demo}/${demoPage(pages.agents())}`],
    [`demo chat and composer`, `${demo}/${demoPage(pages.chat())}`],
    [`demo settings`, `${demo}/${demoHome(pages.account())}`],
    [`demo workspace`, `${demo}/${demoPage(pages.workspace())}`],
    [`demo design kit`, `${demo}${topPath(`kit`)}`],
    [`site home`, `${site}/`],
    [`site privacy`, `${site}/privacy/`],
    [`site docs`, `${site}/docs/`],
    [`site pricing`, `${site}/pricing/`],
    [`site accessibility`, `${site}/accessibility/`],
    [`site Polish accessibility`, `${site}/pl/deklaracja-dostepnosci/`],
] as const;

const browser = await chromium.launch({ headless: true, channel: `chromium` });
try {
    for (const [name, url] of screens) {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(url, { waitUntil: `domcontentloaded` });
        await page.waitForTimeout(1_500);
        const findings = await auditPage(page);
        printFindings(name, findings);
        for (const finding of findings) {console.log(JSON.stringify({ screen: name, ...finding }));}
        await context.close();
    }
} finally {
    await browser.close();
}
