// A runner view's socket: the view's own query (its one-shot ticket) with the view's parameters added, on this sandbox's
// base as ws(s); nothing asked while there is nowhere to dial.
import "@intentic/testing/dom";
import type { RunnerOpenViewInput } from "@intentic/sandbox-contract/schemas/runner-views";
import { runnerSocketUrl, viewQuery, viewSocketUrl } from "./runnerViews";

const VIEW = { runner: `rog`, path: `/system/runner-view/rog/system/desktop-view`, query: `ticket=abc&window=0x1a` };

it("adds the view's parameters to its ticket, leaving an absent one out", () => {
    expect(viewQuery(VIEW, { media: `1`, away: undefined })).toBe(`ticket=abc&window=0x1a&media=1`);
    expect(viewQuery({ query: `ticket=abc` })).toBe(`ticket=abc`);
});

it("opens the socket on this sandbox's base, by the same way in", () => {
    expect(viewSocketUrl(`https://sbx.example.test`, VIEW)).toBe(`wss://sbx.example.test/system/runner-view/rog/system/desktop-view?ticket=abc&window=0x1a`);
    expect(viewSocketUrl(`http://127.0.0.1:28123`, VIEW, { media: `1` })).toBe(`ws://127.0.0.1:28123/system/runner-view/rog/system/desktop-view?ticket=abc&window=0x1a&media=1`);
});

it("asks for a ticket only when there is somewhere to dial", async () => {
    const openView = jest.fn(async (_input: RunnerOpenViewInput) => VIEW);
    await expect(runnerSocketUrl({ conversationId: `c`, kind: `desktop-view` }, {}, { base: () => undefined, openView })).resolves.toBeUndefined();
    expect(openView).not.toHaveBeenCalled();
    await expect(runnerSocketUrl({ conversationId: `c`, kind: `desktop-view` }, {}, { base: () => `https://sbx.example.test`, openView })).resolves.toBe(
        `wss://sbx.example.test/system/runner-view/rog/system/desktop-view?ticket=abc&window=0x1a`,
    );
    expect(openView.mock.calls).toEqual([[{ conversationId: `c`, kind: `desktop-view` }]]);
});
