import { execFileSync } from "node:child_process";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { DAEMON_CONTAINER } from "../stack.js";

// Docked panel floats into a real second window (own socket, tmux attach, fit observer) and back; the docked side
// unmounts entirely while floating and reclaims on that window's heartbeat stop. No jsdom stand-in reaches this.

declare global {
    interface Window {
        __termFrames: { session: string | null; cols: number; rows: number }[];
    }
}

// Ground truth for whether a fit reached the PTY; installed on the context since the owning window changes.
const recordResizeFrames = `
    window.__termFrames = [];
    const origSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
        try {
            if (String(this.url).includes("/system/terminal")) {
                const msg = JSON.parse(String(data));
                if (msg.type === "resize") {
                    window.__termFrames.push({ session: new URL(this.url).searchParams.get("session"), cols: msg.cols, rows: msg.rows });
                }
            }
        } catch {}
        return origSend.call(this, data);
    };
`;

// The newest resize frame that window sent, once it has sent one at all.
const lastFrame = async (page: Page): Promise<{ session: string | null; cols: number; rows: number }> => {
    await page.waitForFunction(() => window.__termFrames.length > 0, undefined, { timeout: 30_000 });
    const frame = await page.evaluate(() => window.__termFrames.at(-1));
    expect(frame).toBeDefined();
    return frame!;
};

// Bar's empty space opens a strip-wide menu (kill all, sweep, float); this is the row that floats it.
const floatRow = (page: Page): Locator => page.locator(`.p-contextmenu-item`, { hasText: `Move panel into new window` });

// The daemon's view of the attach client, the end-to-end proof a fit actually landed.
const tmuxClient = (session: string): string =>
    execFileSync(`docker`, [`exec`, DAEMON_CONTAINER, `tmux`, `list-clients`, `-t`, session, `-F`, `#{client_width}x#{client_height}`], {
        encoding: `utf8`,
    }).trim();

// Click on the float row carries the user activation window.open needs to dodge the popup blocker. The opened page
// isn't ready until its own xterm has attached.
const float = async (page: Page): Promise<Page> => {
    const bar = page.locator(`.term > div`).nth(1);
    const box = await bar.boundingBox();
    if (box === null) {
        throw new Error(`terminal bar not found`);
    }
    await page.mouse.click(box.x + box.width * 0.55, box.y + box.height / 2, { button: `right` });
    const [window_] = await Promise.all([page.context().waitForEvent(`page`), floatRow(page).click()]);
    expect(new URL(window_.url()).pathname).toContain(`/floating/terminal`);
    await expect(window_.locator(`.xterm-screen`)).toBeVisible({ timeout: 30_000 });
    return window_;
};

test(`floating the terminal panel refits the grid to its own window and back`, async ({ page }) => {
    await page.context().addInitScript(recordResizeFrames);
    await page.goto(`/workspace`);
    // Synthetic keydown is enough here; only the float gesture below needs real user activation.
    await page.waitForTimeout(3_000);
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent(`keydown`, { key: `\``, code: `Backquote`, ctrlKey: true })));
    await expect(page.locator(`.xterm-screen`)).toBeVisible({ timeout: 30_000 });
    const dockedFirst = await lastFrame(page);
    await page.waitForTimeout(2_000);

    const floater = await float(page);
    // Lets the browser settle the new window's bounds and its own attach/fit run.
    await page.waitForTimeout(3_000);
    await expect(page.locator(`.xterm-screen`)).toHaveCount(0);

    const floatedBody = await floater.locator(`.term-body`).boundingBox();
    // Same tmux session as before: the panel moved windows, but the shell didn't restart.
    const floated = await lastFrame(floater);
    expect(floated.session).toBe(dockedFirst.session);
    // 17px cells at fontSize 13, ±2 rows slack; the daemon's attach client must match the refit.
    expect(floated.rows).toBeGreaterThan((floatedBody!.height - 16) / 17 - 2);
    expect(tmuxClient(floated.session!)).toBe(`${floated.cols}x${floated.rows}`);
    // A wrong birth size banks blank rows in tmux's scrollback that resurface above the prompt when the pane grows.
    const pane = execFileSync(`docker`, [`exec`, DAEMON_CONTAINER, `tmux`, `capture-pane`, `-p`, `-t`, floated.session!], { encoding: `utf8` });
    expect(pane.split(`\n`)[0]!.trim()).not.toBe(``);
    // xterm parks its helper textarea on the cursor cell; stale scrollback would push it lower than the top rows.
    const cursorTop = await floater.evaluate(() => {
        const textarea = document.querySelector(`.xterm-helper-textarea`);
        const screen = document.querySelector(`.xterm-screen`);
        return textarea === null || screen === null ? -1 : textarea.getBoundingClientRect().top - screen.getBoundingClientRect().top;
    });
    expect(cursorTop).toBeGreaterThanOrEqual(0);
    expect(cursorTop).toBeLessThan(5 * 17);

    // Headless windows ignore resizeTo; changing the panel's own height drives the same fit path instead.
    await floater.evaluate(() => {
        document.body.style.height = `500px`;
    });
    await page.waitForTimeout(2_000);
    const shrunk = await lastFrame(floater);
    expect(shrunk.rows).toBeLessThan(floated.rows);
    expect(tmuxClient(shrunk.session!)).toBe(`${shrunk.cols}x${shrunk.rows}`);

    // Docking back means closing the window: it stops announcing itself, and another window takes that as the panel
    // coming home and remounts it.
    await floater.close({ runBeforeUnload: true });
    await expect(page.locator(`.xterm-screen`)).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(2_000);
    const docked = await page.evaluate(() => ({
        frame: window.__termFrames.at(-1),
        screenHeight: document.querySelector(`.xterm-screen`)?.getBoundingClientRect().height ?? 0,
        cellHeight: document.querySelector(`.term-cell`)?.getBoundingClientRect().height ?? 0,
    }));
    expect(docked.frame!.session).toBe(dockedFirst.session);
    expect(docked.frame!.rows).toBeLessThan(shrunk.rows);
    expect(docked.screenHeight).toBeGreaterThan(docked.cellHeight - 26);
    expect(tmuxClient(docked.frame!.session!)).toBe(`${docked.frame!.cols}x${docked.frame!.rows}`);

    // A second float proves the first window's claim was actually retired, not stale: a stale claim would try to raise
    // a dead window instead of opening a new one.
    const floater2 = await float(page);
    await page.waitForTimeout(3_000);
    const floatedBody2 = await floater2.locator(`.term-body`).boundingBox();
    const floated2 = await lastFrame(floater2);
    expect(floated2.rows).toBeGreaterThan((floatedBody2!.height - 16) / 17 - 2);
    expect(tmuxClient(floated2.session!)).toBe(`${floated2.cols}x${floated2.rows}`);
});
