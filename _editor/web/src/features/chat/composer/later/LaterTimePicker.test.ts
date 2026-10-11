// Mounts the send-later picker and holds it to the one promise that replaced its Set button: a pick is kept the moment
// the reader leaves it, and dropped only by going back. Leaving is focus moving out, the panel closing under it, or
// Enter in the time; going back is its own button or Escape. Opening it and leaving again books nothing, and neither
// does a time the sandbox would not hold.
import "@intentic/testing/dom";
import { type App, createApp, h, nextTick } from "vue";
import LaterTimePicker from "./LaterTimePicker.vue";

const at = (month: number, day: number, hour = 0, minute = 0): number => new Date(2026, month - 1, day, hour, minute).getTime();
// A Sunday afternoon: the window runs from today to Tuesday, November 10.
const NOW = at(10, 11, 14, 20);

let app: App | undefined;
let outside: HTMLButtonElement | undefined;

// The mounted picker: its host element, and what it emitted.
interface Mounted {
    readonly host: HTMLElement;
    readonly commit: ReturnType<typeof jest.fn>;
    readonly back: ReturnType<typeof jest.fn>;
}

const mount = (initial?: number): Mounted => {
    const commit = jest.fn();
    const back = jest.fn();
    const host = document.createElement(`div`);
    outside = document.createElement(`button`);
    document.body.append(host, outside);
    app = createApp({ render: () => h(LaterTimePicker, { now: NOW, initial, onCommit: commit, onBack: back }) });
    app.mount(host);
    return { host, commit, back };
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.replaceChildren();
});

const dayButton = (host: HTMLElement, day: number): HTMLButtonElement => {
    const button = host.querySelector<HTMLButtonElement>(`[data-day="${day}"]`);
    if (button === null) {
        throw new Error(`no cell for ${new Date(day).toDateString()}`);
    }
    return button;
};
const timeField = (host: HTMLElement): HTMLInputElement => {
    const field = host.querySelector<HTMLInputElement>(`input`);
    if (field === null) {
        throw new Error(`no time field`);
    }
    return field;
};
const type = async (field: HTMLInputElement, text: string): Promise<void> => {
    field.value = text;
    field.dispatchEvent(new Event(`input`));
    await nextTick();
};
// Focus leaving the picker for the page beyond it, as a Tab out of the panel or a press on the composer does.
const leave = async (from: HTMLElement): Promise<void> => {
    from.dispatchEvent(new FocusEvent(`focusout`, { bubbles: true, relatedTarget: outside }));
    await nextTick();
};
const summary = (host: HTMLElement): string => host.querySelector(`[aria-live]`)?.textContent?.trim() ?? ``;

describe(`the send-later picker`, () => {
    it(`keeps a day and a typed time when focus leaves it, with nothing to press`, async () => {
        const { host, commit } = mount();
        dayButton(host, at(10, 14)).click();
        await type(timeField(host), `1530`);
        expect(summary(host)).toContain(`15:30`);
        expect(commit).not.toHaveBeenCalled();

        await leave(timeField(host));
        expect(commit.mock.calls).toEqual([[at(10, 14, 15, 30)]]);
    });

    it(`keeps a day alone at nine in the morning, and a chip's time on a picked day`, async () => {
        const { host, commit } = mount();
        dayButton(host, at(10, 20)).click();
        await nextTick();
        const nine = [...host.querySelectorAll<HTMLButtonElement>(`.ui-chip`)].find((chip) => chip.textContent?.trim() === `09:00`);
        expect(nine?.classList.contains(`ui-chip-on`)).toBe(true);
        [...host.querySelectorAll<HTMLButtonElement>(`.ui-chip`)].find((chip) => chip.textContent?.trim() === `18:00`)?.click();
        await leave(dayButton(host, at(10, 20)));
        expect(commit.mock.calls).toEqual([[at(10, 20, 18)]]);
    });

    it(`keeps the pick when the panel closes under it`, async () => {
        const { host, commit } = mount();
        dayButton(host, at(10, 16)).click();
        await nextTick();
        app?.unmount();
        app = undefined;
        expect(commit.mock.calls).toEqual([[at(10, 16, 9)]]);
    });

    it(`keeps it on Enter in the time, once, however the panel then closes`, async () => {
        const { host, commit } = mount();
        await type(timeField(host), `9pm`);
        timeField(host).dispatchEvent(new KeyboardEvent(`keydown`, { key: `Enter`, bubbles: true }));
        await nextTick();
        app?.unmount();
        app = undefined;
        expect(commit.mock.calls).toEqual([[at(10, 11, 21)]]);
    });

    it(`drops the pick on Escape and on Back, and the close that follows keeps nothing`, async () => {
        for (const how of [`escape`, `back`] as const) {
            const { host, commit, back } = mount();
            dayButton(host, at(10, 22)).click();
            await nextTick();
            if (how === `escape`) {
                host.firstElementChild?.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Escape`, bubbles: true }));
            } else {
                host.querySelector<HTMLButtonElement>(`button[aria-label="Back"]`)?.click();
            }
            await nextTick();
            app?.unmount();
            app = undefined;
            expect(back).toHaveBeenCalledTimes(1);
            expect(commit).not.toHaveBeenCalled();
            document.body.replaceChildren();
        }
    });

    it(`books nothing when the reader only looked, or left the time it already had`, async () => {
        const looked = mount(at(10, 14, 15, 30));
        await leave(dayButton(looked.host, at(10, 14)));
        app?.unmount();
        app = undefined;
        expect(looked.commit).not.toHaveBeenCalled();

        const same = mount(at(10, 14, 15, 30));
        dayButton(same.host, at(10, 14)).click();
        await leave(timeField(same.host));
        expect(same.commit).not.toHaveBeenCalled();
    });

    it(`keeps nothing the sandbox would not hold, and says why`, async () => {
        const { host, commit } = mount();
        dayButton(host, at(10, 11)).click();
        await type(timeField(host), `13:00`);
        expect(summary(host)).toContain(`passed`);
        await type(timeField(host), `25:00`);
        expect(summary(host)).toContain(`09:30`);
        await leave(timeField(host));
        expect(commit).not.toHaveBeenCalled();
        expect(dayButton(host, at(11, 11)).disabled).toBe(true);
    });

    it(`walks the days with the arrow keys, never past the window`, async () => {
        const { host } = mount();
        const grid = host.querySelector<HTMLElement>(`[role=grid]`);
        const press = async (key: string): Promise<void> => {
            grid?.dispatchEvent(new KeyboardEvent(`keydown`, { key, bubbles: true }));
            await nextTick();
            await nextTick();
        };
        await press(`ArrowDown`);
        expect(document.activeElement).toBe(dayButton(host, at(10, 18)));
        await press(`ArrowRight`);
        expect(document.activeElement).toBe(dayButton(host, at(10, 19)));
        await press(`ArrowUp`);
        await press(`ArrowUp`);
        expect(document.activeElement).toBe(dayButton(host, at(10, 11)));
    });
});
