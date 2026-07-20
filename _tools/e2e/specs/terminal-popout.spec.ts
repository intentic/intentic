import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { DAEMON_CONTAINER } from "../stack.js";

// The terminal pop-out journey: docked panel → right-click the strip → Document PiP window → pip-side resize →
// dock back. The panel's live xterm moves documents wholesale (the shell's Teleport), so the regression surface
// is the remount: the fit must re-measure in the PIP window and the PTY must follow every step. The machinery
// under test is per-window (the fit ResizeObserver, the post-move redraw jiggle) — when a document move goes
// undetected, fits silently stop, tmux stays at the docked grid, and the prompt strands mid-window.

declare global {
    interface Window {
        __termFrames: { session: string | null; cols: number; rows: number }[];
        documentPictureInPicture?: { window: Window | null };
    }
}

// Every resize frame the client sends, straight off the wire — ground truth for "did the fit reach the PTY".
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

// The daemon's view of the attach client — the end-to-end proof a fit actually landed.
const tmuxClient = (session: string): string =>
    execFileSync(`docker`, [`exec`, DAEMON_CONTAINER, `tmux`, `list-clients`, `-t`, session, `-F`, `#{client_width}x#{client_height}`], {
        encoding: `utf8`,
    }).trim();

test(`popping the terminal panel out refits the grid to the floating window and back`, async ({ page }) => {
    await page.addInitScript(recordResizeFrames);
    await page.goto(`/workspace`);
    // Open the terminal via the shell's keybinding dispatcher (a synthetic keydown is enough — only the
    // pop-out gesture below needs real user activation).
    await page.waitForTimeout(3_000);
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent(`keydown`, { key: `\``, code: `Backquote`, ctrlKey: true })));
    await expect(page.locator(`.xterm-screen`)).toBeVisible({ timeout: 30_000 });
    // Wait for the shell to attach and the docked fit to reach the PTY.
    await page.waitForFunction(() => window.__termFrames.length > 0, undefined, { timeout: 30_000 });
    await page.waitForTimeout(2_000);

    // Right-click the strip's empty space (the flex-1 spacer) — the pop-out gesture.
    const bar = page.locator(`.term > div`).nth(1);
    const box = await bar.boundingBox();
    if (box === null) {
        throw new Error(`terminal bar not found`);
    }
    await page.mouse.click(box.x + box.width * 0.55, box.y + box.height / 2, { button: `right` });
    await page.waitForFunction(() => window.documentPictureInPicture?.window !== null, undefined, { timeout: 10_000 });
    // Let the PIP window settle (Chrome adjusts the bounds after open) and the moved-mount refit run.
    await page.waitForTimeout(3_000);

    const popped = await page.evaluate(() => {
        const pip = window.documentPictureInPicture!.window!;
        return {
            bodyHeight: pip.document.querySelector(`.term-body`)?.getBoundingClientRect().height ?? 0,
            frame: window.__termFrames.at(-1),
        };
    });
    // The last resize frame matches a grid refitted to the PIP body (17px cells at fontSize 13, ±2 rows of
    // slack), and the daemon's attach client followed.
    expect(popped.frame).toBeDefined();
    expect(popped.frame!.rows).toBeGreaterThan((popped.bodyHeight - 16) / 17 - 2);
    expect(tmuxClient(popped.frame!.session!)).toBe(`${popped.frame!.cols}x${popped.frame!.rows}`);

    // Chrome restores a PIP window's remembered bounds AFTER open (and the user drags it freely) — the fit
    // observer must live in the PIP window for those layout changes to reach the grid at all. resizeTo is a
    // no-op on a headless PIP window, so drive the same path through the panel's layout instead.
    await page.evaluate(() => {
        window.documentPictureInPicture!.window!.document.body.style.height = `500px`;
    });
    await page.waitForTimeout(2_000);
    const shrunk = await page.evaluate(() => window.__termFrames.at(-1));
    expect(shrunk!.rows).toBeLessThan(popped.frame!.rows);
    expect(tmuxClient(shrunk!.session!)).toBe(`${shrunk!.cols}x${shrunk!.rows}`);

    // Dock back (closing the PIP window fires its pagehide): the panel returns to the main grid and the PTY
    // follows back down — the re-docked screen fills the docked pane short of at most one row.
    await page.evaluate(() => window.documentPictureInPicture!.window!.close());
    await page.waitForTimeout(2_000);
    const docked = await page.evaluate(() => ({
        frame: window.__termFrames.at(-1),
        screenHeight: document.querySelector(`.xterm-screen`)?.getBoundingClientRect().height ?? 0,
        cellHeight: document.querySelector(`.term-cell`)?.getBoundingClientRect().height ?? 0,
    }));
    expect(docked.frame!.rows).toBeLessThan(shrunk!.rows);
    expect(docked.screenHeight).toBeGreaterThan(docked.cellHeight - 26);
    expect(tmuxClient(docked.frame!.session!)).toBe(`${docked.frame!.cols}x${docked.frame!.rows}`);
});
