import { expect, type BrowserContext, type Page, test } from "@playwright/test";

declare global {
    interface Window {
        dropChatStrips: boolean;
        drewChat: boolean;
        chatWindow: {
            draws(): boolean;
            dock(): void;
            owner(): string | undefined;
            state(): { active?: string; panes: string[]; run?: { runId: string; mode: string } };
            select(sandbox: string): void;
            publish(id: string): void;
        };
    }
}

const fixture = `/`;
const open = async (context: BrowserContext, holder = false): Promise<Page> => {
    const page = await context.newPage();
    await page.goto(`${fixture}${holder ? `?holder` : ``}`);
    await page.waitForFunction(() => window.chatWindow !== undefined);
    return page;
};
const selected = (page: Page): Promise<string | undefined> => page.evaluate(() => window.chatWindow.state().active);
const draws = (page: Page): Promise<boolean> => page.evaluate(() => window.chatWindow.draws());
// Sampled every few milliseconds from here on, since a hand-back inside a reload lasts only as long as the page load.
const watchDraws = (page: Page): Promise<void> =>
    page.evaluate(() => {
        window.drewChat = false;
        setInterval(() => {
            window.drewChat ||= window.chatWindow.draws();
        }, 5);
    });

test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
        window.dropChatStrips = false;
        const post = BroadcastChannel.prototype.postMessage;
        BroadcastChannel.prototype.postMessage = function (message: { note?: { kind?: string } }): void {
            if (this.name !== `intentic.chat` || message.note?.kind !== `strip` || !window.dropChatStrips) {
                post.call(this, message);
            }
        };
    });
});

test(`a late board learns the existing owner's complete state`, async ({ context }) => {
    const holder = await open(context, true);
    await holder.evaluate(() => window.chatWindow.publish(`alpha`));
    const board = await open(context);

    await expect.poll(() => selected(board)).toBe(`alpha`);
    expect(await board.evaluate(() => window.chatWindow.state().run)).toEqual({ runId: `run-alpha`, mode: `pinned` });
    expect(await board.evaluate(() => window.chatWindow.draws())).toBe(false);
});

test(`lost updates recover without any further edit or focus event`, async ({ context }) => {
    const board = await open(context);
    const holder = await open(context, true);
    await holder.evaluate(() => window.chatWindow.publish(`before`));
    await expect.poll(() => selected(board)).toBe(`before`);
    await holder.evaluate(() => {
        window.dropChatStrips = true;
        window.chatWindow.publish(`after`);
    });
    expect(await selected(board)).toBe(`before`);
    await holder.evaluate(() => {
        window.dropChatStrips = false;
    });

    await expect.poll(() => selected(board)).toBe(`after`);
});

test(`both windows can reload repeatedly without inheriting a retired owner's state`, async ({ context }) => {
    const holder = await open(context, true);
    const board = await open(context);
    for (const id of [`first`, `second`, `third`]) {
        await holder.evaluate((value) => window.chatWindow.publish(value), id);
        await expect.poll(() => selected(board)).toBe(id);
        const oldOwner = await board.evaluate(() => window.chatWindow.owner());
        await Promise.all([holder.reload(), board.reload()]);
        await holder.waitForFunction(() => window.chatWindow !== undefined);
        await board.waitForFunction(() => window.chatWindow !== undefined);
        await expect.poll(() => selected(board)).toBe(id);
        expect(await board.evaluate(() => window.chatWindow.owner())).not.toBe(oldOwner);
    }
});

test(`a suspended holder keeps ownership and resumes publishing`, async ({ context }) => {
    const holder = await open(context, true);
    const board = await open(context);
    await holder.evaluate(() => window.chatWindow.publish(`held`));
    await expect.poll(() => selected(board)).toBe(`held`);
    const session = await context.newCDPSession(holder);
    await session.send(`Page.setWebLifecycleState`, { state: `frozen` });
    // The observation must outlast the production heartbeat expiry.
    await board.waitForTimeout(4_000);
    expect(await board.evaluate(() => window.chatWindow.draws())).toBe(false);
    expect(await selected(board)).toBe(`held`);
    await session.send(`Page.setWebLifecycleState`, { state: `active` });
    await holder.evaluate(() => window.chatWindow.publish(`resumed`));
    await expect.poll(() => selected(board)).toBe(`resumed`);
});

test(`a competing floating window cannot retire the surviving owner's claim`, async ({ context }) => {
    const holder = await open(context, true);
    const board = await open(context);
    await holder.evaluate(() => window.chatWindow.publish(`winner`));
    await expect.poll(() => selected(board)).toBe(`winner`);
    const loser = await context.newPage();
    await loser.goto(`${fixture}?holder`);
    await expect(loser).toHaveURL(`about:blank`);
    await holder.evaluate(() => window.chatWindow.publish(`still-winner`));
    await expect.poll(() => selected(board)).toBe(`still-winner`);
    expect(await board.evaluate(() => window.chatWindow.draws())).toBe(false);
});

test(`a sandbox switch never republishes the previous sandbox's cached strip`, async ({ context }) => {
    const holder = await open(context, true);
    const board = await open(context);
    await holder.evaluate(() => window.chatWindow.publish(`sb1-only`));
    await expect.poll(() => selected(board)).toBe(`sb1-only`);
    await board.evaluate(() => window.chatWindow.select(`sb2`));
    await holder.evaluate(() => window.chatWindow.select(`sb2`));
    await board.evaluate(() => window.dispatchEvent(new Event(`focus`)));
    expect(await selected(board)).toBeUndefined();
    await holder.evaluate(() => window.chatWindow.publish(`sb2-only`));
    await expect.poll(() => selected(board)).toBe(`sb2-only`);
});

test(`a holder that reloads never hands the panel back to the board`, async ({ context }) => {
    const holder = await open(context, true);
    const board = await open(context);
    await expect.poll(() => draws(board)).toBe(false);
    const oldOwner = await board.evaluate(() => window.chatWindow.owner());
    await watchDraws(board);

    await holder.reload();
    await holder.waitForFunction(() => window.chatWindow !== undefined);
    await expect.poll(() => board.evaluate(() => window.chatWindow.owner())).not.toBe(oldOwner);
    // The retired claim's deadline has to fall inside the observation.
    await board.waitForTimeout(3_500);

    expect(await board.evaluate(() => window.drewChat)).toBe(false);
});

test(`a holder that docks hands the panel back at once, and one that closes at its deadline`, async ({ context }) => {
    const holder = await open(context, true);
    const board = await open(context);
    await expect.poll(() => draws(board)).toBe(false);

    await holder.evaluate(() => window.chatWindow.dock());
    // Well inside the 2.5s deadline: this is the hand-back itself, not the claim expiring.
    await expect.poll(() => draws(board), { timeout: 1_000 }).toBe(true);

    const second = await open(context, true);
    await expect.poll(() => draws(board)).toBe(false);
    await second.close();
    await expect.poll(() => draws(board)).toBe(true);
});
