// The tab a sign-in's press holds for the provider's page (signInTab.ts): sent there once the sandbox names it, closed
// when nothing was, and carrying a device code on the clipboard or, where the browser refuses that, drawn in the tab.
import "@intentic/testing/dom";
import { installI18n } from "@intentic/ui/i18n";
import { createApp } from "vue";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { holdSignInTab } from "./signInTab";

installI18n(createApp({}));

interface FakeTab {
    readonly document: Document;
    closed: boolean;
    opener: unknown;
    readonly location: { replace: ReturnType<typeof jest.fn> };
    readonly close: ReturnType<typeof jest.fn>;
}

const fakeTab = (): FakeTab => {
    const tab: FakeTab = {
        document: document.implementation.createHTMLDocument(``),
        closed: false,
        opener: window,
        location: { replace: jest.fn() },
        close: jest.fn(() => {
            tab.closed = true;
        }),
    };
    return tab;
};

const writes: string[] = [];
let refuseWrites = false;
let opened: FakeTab | null;
const open = jest.fn(() => opened);

beforeEach(() => {
    writes.length = 0;
    refuseWrites = false;
    opened = fakeTab();
    open.mockClear();
    Object.defineProperty(window, `open`, { configurable: true, value: open });
    Object.defineProperty(navigator, `clipboard`, {
        configurable: true,
        value: {
            writeText: async (text: string) => {
                if (refuseWrites) {
                    throw new DOMException(`Write is not allowed.`, `NotAllowedError`);
                }
                writes.push(text);
            },
        },
    });
    Object.defineProperty(navigator, `userActivation`, { configurable: true, value: { isActive: true } });
});
afterEach(() => {
    Reflect.deleteProperty(window, `__INTENTIC_DESKTOP__`);
});

it(`holds a tab in the press, says what it waits for, and sends it to the page severed from this one`, async () => {
    const tab = holdSignInTab(`claude.ai`)!;
    expect(open).toHaveBeenCalledWith(``, `_blank`);
    expect(opened!.document.body.textContent).toBe(`Opening claude.ai…`);

    await expect(tab.send(`https://claude.ai/oauth/authorize`, ``)).resolves.toEqual({ sent: true, copied: false });
    expect(opened!.opener).toBeNull();
    expect(opened!.location.replace).toHaveBeenCalledWith(`https://claude.ai/oauth/authorize`);
    tab.release();
    expect(opened!.close, `closed the tab it had just sent`).not.toHaveBeenCalled();
});

it(`closes a tab nothing was sent to`, () => {
    holdSignInTab(`claude.ai`)!.release();
    expect(opened!.close).toHaveBeenCalledTimes(1);
});

it(`holds nothing without a press behind it, or where the browser blocks the tab`, () => {
    Object.defineProperty(navigator, `userActivation`, { configurable: true, value: { isActive: false } });
    expect(holdSignInTab(`claude.ai`)).toBeUndefined();
    expect(open).not.toHaveBeenCalled();

    Object.defineProperty(navigator, `userActivation`, { configurable: true, value: { isActive: true } });
    opened = null;
    expect(holdSignInTab(`claude.ai`)).toBeUndefined();
});

it(`says a tab closed before the address came back went nowhere`, async () => {
    const tab = holdSignInTab(`claude.ai`)!;
    opened!.closed = true;
    await expect(tab.send(`https://claude.ai/oauth/authorize`, ``)).resolves.toEqual({ sent: false, copied: false });
    expect(opened!.location.replace).not.toHaveBeenCalled();
});

it(`carries a device code on the clipboard, then goes`, async () => {
    const tab = holdSignInTab(`auth.openai.com`)!;
    await expect(tab.send(`https://auth.openai.com/codex/device`, `K7QX-2MPD`)).resolves.toEqual({ sent: true, copied: true });
    expect(writes).toEqual([`K7QX-2MPD`]);
    expect(opened!.location.replace).toHaveBeenCalledWith(`https://auth.openai.com/codex/device`);
});

// Firefox and Safari want a press of their own for a clipboard write: the code is drawn in the tab, with the press.
it(`draws a code the browser would not copy in the tab, with one press that copies it and goes on`, async () => {
    refuseWrites = true;
    const tab = holdSignInTab(`auth.openai.com`)!;
    await expect(tab.send(`https://auth.openai.com/codex/device`, `K7QX-2MPD`)).resolves.toEqual({ sent: true, copied: false });
    expect(opened!.location.replace, `left for a page that asks for a code the reader never saw`).not.toHaveBeenCalled();
    expect(opened!.document.body.textContent).toContain(`K7QX-2MPD`);

    refuseWrites = false;
    opened!.document.querySelector(`button`)!.click();
    await new Promise((resolve) => setTimeout(resolve));
    expect(writes).toEqual([`K7QX-2MPD`]);
    expect(opened!.location.replace).toHaveBeenCalledWith(`https://auth.openai.com/codex/device`);
});

// A write left pending (a permission prompt elsewhere holding the clipboard) once left the reader on a blank tab.
it(`draws the code rather than waiting on a clipboard that never answers`, async () => {
    Object.defineProperty(navigator, `clipboard`, { configurable: true, value: { writeText: () => new Promise(() => undefined) } });
    jest.useFakeTimers();
    try {
        const tab = holdSignInTab(`auth.openai.com`)!;
        const answer = tab.send(`https://auth.openai.com/codex/device`, `K7QX-2MPD`);
        await advanceTimersByTimeAsync(1_600);
        await expect(answer).resolves.toEqual({ sent: true, copied: false });
        expect(opened!.document.body.textContent).toContain(`K7QX-2MPD`);
    } finally {
        jest.useRealTimers();
    }
});

// The desktop app sends every window.open to the system browser and has no popup blocker in the way.
it(`in the desktop app, opens the page when the address arrives, the code copied first`, async () => {
    Object.defineProperty(window, `__INTENTIC_DESKTOP__`, { configurable: true, value: { version: `1.0.0` } });
    const tab = holdSignInTab(`auth.openai.com`)!;
    expect(open, `held a blank tab the system browser would have been handed`).not.toHaveBeenCalled();
    await expect(tab.send(`https://auth.openai.com/codex/device`, `K7QX-2MPD`)).resolves.toEqual({ sent: true, copied: true });
    expect(writes).toEqual([`K7QX-2MPD`]);
    expect(open).toHaveBeenCalledWith(`https://auth.openai.com/codex/device`);
});
