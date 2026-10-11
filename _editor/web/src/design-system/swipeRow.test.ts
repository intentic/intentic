import "@intentic/testing/dom";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { type App, createApp, h, nextTick } from "vue";
import { SwipeRow } from "@intentic/ui";
import { useMotion } from "@intentic/ui/motion";

// Pins what a thumb does to a SwipeRow: a swipe left past the line takes the row's action and swallows the tap the
// release would turn into; one short of it puts the row back; a scroll, a swipe right, a mouse and a row with no action
// do nothing at all. Motion is off, so every settle lands at once and the test reads where the row ends up.

const WIDTH = 300;

describe(`a swipeable row`, () => {
    let app: App | undefined;
    let host: HTMLElement;
    let committed = 0;
    let clicked = 0;

    const mount = (action: { label: string; icon: `box` } | null = { label: `Archive`, icon: `box` }): HTMLElement => {
        host = document.createElement(`div`);
        document.body.append(host);
        app = createApp({
            render: () =>
                h(SwipeRow, { action: action ?? undefined, onCommit: () => (committed += 1) }, () =>
                    h(`button`, { type: `button`, onClick: () => (clicked += 1) }, `A card`),
                ),
        });
        app.mount(host);
        return host.firstElementChild as HTMLElement;
    };

    const press = (el: Element, type: string, x: number, y = 100, pointerType = `touch`): void => {
        el.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1, pointerType, isPrimary: true, button: 0 }));
    };

    // A drag from (280, 100) to (280 + dx, 100 + dy), in steps, ending in a release and the click a tap would make.
    const drag = (row: HTMLElement, dx: number, dy = 0, pointerType = `touch`): void => {
        const card = row.querySelector(`button`)!;
        press(card, `pointerdown`, 280, 100, pointerType);
        for (let step = 1; step <= 4; step += 1) {
            press(card, `pointermove`, 280 + (dx * step) / 4, 100 + (dy * step) / 4, pointerType);
        }
        press(card, `pointerup`, 280 + dx, 100 + dy, pointerType);
        card.click();
    };

    const body = (row: HTMLElement): HTMLElement => row.lastElementChild as HTMLElement;

    beforeEach(() => {
        committed = 0;
        clicked = 0;
        useMotion().setMotion(`off`);
        stubGlobal(`requestAnimationFrame`, (callback: FrameRequestCallback) => {
            // Drawn at once: the row's frame is asked for and painted inside the same move.
            callback(0);
            return 0;
        });
        Object.defineProperty(HTMLElement.prototype, `offsetWidth`, { configurable: true, get: () => WIDTH });
    });

    afterEach(() => {
        app?.unmount();
        app = undefined;
        host.remove();
        unstubAllGlobals();
        useMotion().setMotion(`system`);
        Reflect.deleteProperty(HTMLElement.prototype, `offsetWidth`);
    });

    it(`takes its action past the line, and the release is not a tap on the card`, async () => {
        const row = mount();
        drag(row, -160);
        await nextTick();
        expect(committed).toBe(1);
        expect(clicked).toBe(0);
        // Gone off its own edge, where it stays until whoever owns it takes it away.
        expect(body(row).style.transform).toBe(`translate3d(-${WIDTH + 24}px, 0, 0)`);
    });

    it(`springs back short of the line, and floods the action's colour only past it`, async () => {
        const row = mount();
        const card = row.querySelector(`button`)!;
        const pane = row.querySelector(`.swipe-pane`)!;
        press(card, `pointerdown`, 280);
        press(card, `pointermove`, 240);
        expect(body(row).style.transform).toBe(`translate3d(-40px, 0, 0)`);
        expect(pane.hasAttribute(`data-armed`)).toBe(false);
        press(card, `pointermove`, 150);
        expect(pane.hasAttribute(`data-armed`)).toBe(true);
        press(card, `pointermove`, 200);
        expect(pane.hasAttribute(`data-armed`)).toBe(false);
        // Held there before letting go: a release with no speed in it, decided by distance alone.
        await new Promise((resolve) => setTimeout(resolve, 80));
        press(card, `pointerup`, 200);
        await nextTick();
        expect(committed).toBe(0);
        expect(body(row).style.transform).toBe(``);
    });

    it(`leaves a scroll, a swipe right, a mouse and a row with no action alone`, async () => {
        const row = mount();
        drag(row, -10, 120);
        drag(row, 160);
        drag(row, -200, 0, `mouse`);
        await nextTick();
        expect(committed).toBe(0);
        expect(body(row).style.transform).toBe(``);
        expect(clicked).toBe(3);
        app?.unmount();
        host.remove();
        const plain = mount(null);
        drag(plain, -200);
        expect(committed).toBe(0);
        expect(plain.querySelector(`.swipe-pane`)).toBeNull();
    });

    it(`never treats a browser-cancelled touch as a commit`, async () => {
        const row = mount();
        const card = row.querySelector(`button`)!;
        press(card, `pointerdown`, 280);
        press(card, `pointermove`, 100);
        press(card, `pointercancel`, 100);
        await nextTick();
        expect(committed).toBe(0);
        expect(body(row).style.transform).toBe(``);
    });
});
