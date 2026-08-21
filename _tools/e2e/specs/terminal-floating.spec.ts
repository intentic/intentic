import { execFileSync } from "node:child_process";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { DAEMON_CONTAINER } from "../stack.js";

/* The terminal's float-and-dock journey: docked panel → right-click the strip → its menu's float row → a real
 * browser window → resize it → dock back → float again.
 *
 * WHAT MAKES THIS WORTH AN E2E RATHER THAN A UNIT TEST: a floating panel is a SECOND COPY OF THE APP in a real
 * window (_editor/web/src/composables/floating.ts), so every step of the chain is genuinely per-window, and no
 * amount of jsdom can stand in for it. The floating window opens its own socket, attaches tmux itself, measures
 * its own pane, and its fit observer belongs to it; the docked window mounts nothing while it floats and takes
 * the panel back when that window's heartbeat stops. When a link in that chain breaks, fits silently stop, tmux
 * stays at the grid of a window nobody is looking at, and the prompt strands mid-window.
 *
 * The bar also turns into a left rail out there, which is why the pane is measured in the floating window rather
 * than assumed to be full width. */

declare global {
    interface Window {
        __termFrames: { session: string | null; cols: number; rows: number }[];
    }
}

/* Every resize frame a window's client sends, straight off the wire: ground truth for "did the fit reach the
 * PTY". Installed on the CONTEXT rather than on the page, because the window that sends them changes: the
 * docked window owns the socket while the panel is in its column, the floating window owns it while the panel is
 * out there, and each of them has to be asked about its own. */
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

// The bar menu's float row. The bar's empty space opens the strip-wide menu (kill all / sweep / float) rather
// than floating on the spot, so every move here goes through this row.
const floatRow = (page: Page): Locator => page.locator(`.p-contextmenu-item`, { hasText: `Move panel into new window` });

// The daemon's view of the attach client, the end-to-end proof a fit actually landed.
const tmuxClient = (session: string): string =>
    execFileSync(`docker`, [`exec`, DAEMON_CONTAINER, `tmux`, `list-clients`, `-t`, session, `-F`, `#{client_width}x#{client_height}`], {
        encoding: `utf8`,
    }).trim();

/* Right-click the bar's empty space (the flex-1 spacer) for its own menu, then take the float row: the click on
 * the row is what carries the user activation window.open needs to escape the popup blocker. The window it opens
 * arrives as a new page on the context, boots the app on /floating/terminal, and is not ready until its OWN
 * xterm has attached, which is the thing the old shape never had to wait for. */
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
    // Open the terminal via the shell's keybinding dispatcher (a synthetic keydown is enough, only the float
    // gesture below needs real user activation).
    await page.waitForTimeout(3_000);
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent(`keydown`, { key: `\``, code: `Backquote`, ctrlKey: true })));
    await expect(page.locator(`.xterm-screen`)).toBeVisible({ timeout: 30_000 });
    // Wait for the shell to attach and the docked fit to reach the PTY.
    const dockedFirst = await lastFrame(page);
    await page.waitForTimeout(2_000);

    const floater = await float(page);
    // Let the window settle (the browser adjusts the bounds after open) and its own attach + fit run.
    await page.waitForTimeout(3_000);
    // The docked window gives the panel up entirely while it floats: nothing of it is left mounted there.
    await expect(page.locator(`.xterm-screen`)).toHaveCount(0);

    const floatedBody = await floater.locator(`.term-body`).boundingBox();
    // Asked of the FLOATING window, whose socket it is now. Same tmux session as the docked window had: the
    // panel moved windows, the shell did not restart.
    const floated = await lastFrame(floater);
    expect(floated.session).toBe(dockedFirst.session);
    // A grid refitted to the floating pane (17px cells at fontSize 13, ±2 rows of slack), and the daemon's
    // attach client followed.
    expect(floated.rows).toBeGreaterThan((floatedBody!.height - 16) / 17 - 2);
    expect(tmuxClient(floated.session!)).toBe(`${floated.cols}x${floated.rows}`);
    // The grown screen stays top-anchored: a PTY born at the wrong size (xterm's 80x24 default) banks blank rows
    // in tmux's pane history, and growing into the new window resurrects them ABOVE the prompt, the "shifted
    // terminal". A top row holding the prompt proves the birth grid was right.
    const pane = execFileSync(`docker`, [`exec`, DAEMON_CONTAINER, `tmux`, `capture-pane`, `-p`, `-t`, floated.session!], { encoding: `utf8` });
    expect(pane.split(`\n`)[0]!.trim()).not.toBe(``);
    // And the CLIENT paints it there too: xterm parks its helper textarea on the cursor cell, so a fresh prompt's
    // cursor must sit in the top rows of the pane. Junk rows shifting the live screen down (stale scrollback
    // surviving the move) land it much lower.
    const cursorTop = await floater.evaluate(() => {
        const textarea = document.querySelector(`.xterm-helper-textarea`);
        const screen = document.querySelector(`.xterm-screen`);
        return textarea === null || screen === null ? -1 : textarea.getBoundingClientRect().top - screen.getBoundingClientRect().top;
    });
    expect(cursorTop).toBeGreaterThanOrEqual(0);
    expect(cursorTop).toBeLessThan(5 * 17);

    // The window is the user's to resize, maximize and full-screen, and the fit observer must live in IT for
    // those layout changes to reach the grid at all. Headless windows ignore resizeTo, so drive the same path
    // through the panel's layout instead.
    await floater.evaluate(() => {
        document.body.style.height = `500px`;
    });
    await page.waitForTimeout(2_000);
    const shrunk = await lastFrame(floater);
    expect(shrunk.rows).toBeLessThan(floated.rows);
    expect(tmuxClient(shrunk.session!)).toBe(`${shrunk.cols}x${shrunk.rows}`);

    /* Dock back by CLOSING the window, which is the whole dock mechanism now rather than a special case of it:
     * the window stops announcing itself, and every other window takes that as the panel coming home. The docked
     * window mounts the panel again, attaches the same tmux session, and fits it to its column. */
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

    // Float AGAIN. The second cycle is where per-window state historically rotted (observers and renderer
    // bindings left pointing at a window that had gone), leaving the fit dead and the grid frozen at the docked
    // size. It is also the cheapest proof the previous window's claim was really retired rather than merely
    // hidden: a stale claim would make this press raise a window that no longer exists instead of opening one.
    const floater2 = await float(page);
    await page.waitForTimeout(3_000);
    const floatedBody2 = await floater2.locator(`.term-body`).boundingBox();
    const floated2 = await lastFrame(floater2);
    expect(floated2.rows).toBeGreaterThan((floatedBody2!.height - 16) / 17 - 2);
    expect(tmuxClient(floated2.session!)).toBe(`${floated2.cols}x${floated2.rows}`);
});
