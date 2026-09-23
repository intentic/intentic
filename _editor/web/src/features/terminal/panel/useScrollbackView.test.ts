import "@intentic/testing/dom";
import type { TerminalScrollback } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { type EffectScope, effectScope } from "vue";
import type { TerminalSession } from "../terminalSession";
import { useScrollbackView } from "./useScrollbackView";

// Pins the terminal's own right-click and the history it opens: the menu answers only over a live session's cell,
// samples the selection as it opens, offers a split only where the strip can split; the history is pending until read,
// never shows one terminal's text under another's name, and says so when the read fails.

const history = (name: string): TerminalScrollback => ({ name, text: `$ pnpm build\ndone`, lines: 2, truncated: false });
const scopes: EffectScope[] = [];

const stage = (over: { split?: boolean } = {}) => {
    const term = { hasSelection: jest.fn(() => true), focus: jest.fn() };
    const session = unstubbed<TerminalSession>(`session`, { name: `web-1`, term: unstubbed<TerminalSession[`term`]>(`term`, term) });
    const read = jest.fn(async (name: string) => history(name));
    const splitTab = jest.fn((_name: string) => undefined);
    const scope = effectScope();
    scopes.push(scope);
    const view = scope.run(() =>
        useScrollbackView({
            sessionOf: (name) => (name === `web-1` ? session : undefined),
            read,
            splitTab: over.split === false ? undefined : splitTab,
        }),
    )!;
    const show = jest.fn((_event: Event) => undefined);
    view.gridMenu.value = { show };
    return { term, read, splitTab, show, view };
};

// A right-click landing on a cell of the named session's pane.
const rightClickOn = (session: string): MouseEvent => {
    const cell = document.createElement(`div`);
    cell.className = `term-cell`;
    cell.dataset[`session`] = session;
    const inner = document.createElement(`span`);
    cell.append(inner);
    document.body.append(cell);
    const event = new MouseEvent(`contextmenu`, { bubbles: true, cancelable: true });
    inner.dispatchEvent(event);
    return event;
};

afterEach(() => {
    for (const scope of scopes.splice(0)) {
        scope.stop();
    }
    document.body.replaceChildren();
});

describe(`a right-click inside a terminal`, () => {
    it(`opens over a live session's cell, with the selection sampled as it opens`, () => {
        const { show, view } = stage();
        const event = rightClickOn(`web-1`);
        view.onGridContextMenu(event);
        expect([event.defaultPrevented, show.mock.calls.length]).toEqual([true, 1]);
        expect(view.gridItems.value.map((item) => item.label ?? `—`)).toEqual([`Copy`, `Paste`, `—`, `Full scrollback…`, `—`, `Split terminal`]);
        expect(view.gridItems.value[0]?.disabled).toBe(false);
    });

    it(`leaves the browser's own menu to anything that is not a live session`, () => {
        const { show, view } = stage();
        const event = rightClickOn(`gone`);
        view.onGridContextMenu(event);
        expect([event.defaultPrevented, show.mock.calls.length, view.gridItems.value.length]).toEqual([false, 0, 0]);
    });

    it(`offers no split where the strip cannot split`, () => {
        const { view } = stage({ split: false });
        view.onGridContextMenu(rightClickOn(`web-1`));
        expect(view.gridItems.value.map((item) => item.label ?? `—`)).toEqual([`Copy`, `Paste`, `—`, `Full scrollback…`]);
    });
});

describe(`the full history`, () => {
    it(`is pending until read, then shows that terminal's text`, async () => {
        const { read, view } = stage();
        view.onGridContextMenu(rightClickOn(`web-1`));
        view.gridItems.value[3]?.command?.({ originalEvent: new Event(`click`), item: {} });
        expect([view.scrollbackName.value, view.scrollbackPending.value]).toEqual([`web-1`, true]);
        await read.mock.results[0]?.value;
        expect(view.scrollback.value).toEqual(history(`web-1`));
        expect(view.scrollbackPending.value).toBe(false);
    });

    it(`never shows a read that lands after the dialog closed`, async () => {
        const { read, view } = stage();
        const slow = Promise.withResolvers<TerminalScrollback>();
        read.mockReturnValueOnce(slow.promise);
        view.onGridContextMenu(rightClickOn(`web-1`));
        view.gridItems.value[3]?.command?.({ originalEvent: new Event(`click`), item: {} });
        view.closeScrollback();
        slow.resolve(history(`web-1`));
        await slow.promise;
        expect([view.scrollbackName.value, view.scrollback.value]).toEqual([undefined, undefined]);
    });

    it(`says the read failed rather than spinning`, async () => {
        const { read, view } = stage();
        read.mockRejectedValueOnce(new Error(`session ended`));
        view.onGridContextMenu(rightClickOn(`web-1`));
        view.gridItems.value[3]?.command?.({ originalEvent: new Event(`click`), item: {} });
        await Promise.resolve();
        await Promise.resolve();
        expect({ failed: view.scrollbackFailed.value, pending: view.scrollbackPending.value }).toEqual({ failed: true, pending: false });
    });
});
