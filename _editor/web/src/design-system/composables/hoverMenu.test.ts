import { useHoverMenu } from "@intentic/ui";
import { effectScope, nextTick, ref } from "vue";

// Pins how a hover menu answers the hand: a resting pointer raises it and a crossing one raises nothing, the way to the
// panel keeps it up, a press pins it (even one landing on a menu the pointer already raised), and the keyboard opens it
// on the current row.

const OPEN = 150;
const CLOSE = 200;

let scope: ReturnType<typeof effectScope>;
let trigger: HTMLButtonElement;
let panel: HTMLDivElement;

// The trigger and panel as the rail draws them: a 44px tile at the corner, the panel 8px to its right.
const mount = () => {
    const menu = scope.run(() => useHoverMenu(ref(panel), { open: OPEN, close: CLOSE }))!;
    trigger.addEventListener(`pointerenter`, menu.trigger.pointerenter);
    trigger.addEventListener(`pointerleave`, menu.trigger.pointerleave);
    trigger.addEventListener(`click`, menu.trigger.click);
    trigger.addEventListener(`keydown`, menu.trigger.keydown);
    panel.addEventListener(`pointerenter`, menu.panel.pointerenter);
    panel.addEventListener(`pointerleave`, menu.panel.pointerleave);
    panel.addEventListener(`pointerdown`, menu.panel.pointerdown);
    panel.addEventListener(`keydown`, menu.panel.keydown);
    return menu;
};

const pointer = (target: EventTarget, type: string, init: PointerEventInit = {}): void => {
    target.dispatchEvent(new PointerEvent(type, { pointerType: `mouse`, buttons: 0, ...init }));
};

beforeEach(() => {
    jest.useFakeTimers();
    scope = effectScope();
    trigger = document.createElement(`button`);
    panel = document.createElement(`div`);
    panel.getBoundingClientRect = () => DOMRect.fromRect({ x: 56, y: 4, width: 288, height: 400 });
    panel.innerHTML = `<button data-menu-row>a</button><button data-menu-row data-current>b</button><button data-menu-row>c</button>`;
    document.body.append(trigger, panel);
});
afterEach(() => {
    scope.stop();
    trigger.remove();
    panel.remove();
    jest.useRealTimers();
});

it(`opens for a pointer that rests on the trigger, and a crossing one raises nothing`, () => {
    const menu = mount();
    pointer(trigger, `pointerenter`);
    jest.advanceTimersByTime(OPEN - 50);
    pointer(trigger, `pointerleave`, { clientX: 30, clientY: 60 });
    jest.advanceTimersByTime(1000);
    expect(menu.open.value).toBe(false);

    pointer(trigger, `pointerenter`);
    jest.advanceTimersByTime(OPEN);
    expect([menu.open.value, menu.pressed.value]).toEqual([true, false]);
});

it(`ignores a touch and a drag carried over the trigger`, () => {
    const menu = mount();
    pointer(trigger, `pointerenter`, { pointerType: `touch` });
    pointer(trigger, `pointerenter`, { buttons: 1 });
    jest.advanceTimersByTime(1000);
    expect(menu.open.value).toBe(false);
});

it(`stays up while the pointer heads for the panel, and lets go once it turns away`, () => {
    const menu = mount();
    pointer(trigger, `pointerenter`);
    jest.advanceTimersByTime(OPEN);

    // Out of the tile's bottom edge, then slowly down and right toward a lower row: longer than the grace in all.
    pointer(trigger, `pointerleave`, { clientX: 30, clientY: 48 });
    for (let step = 1; step <= 5; step += 1) {
        jest.advanceTimersByTime(CLOSE - 50);
        pointer(document, `pointermove`, { clientX: 30 + step * 4, clientY: 48 + step * 12 });
    }
    expect(menu.open.value).toBe(true);
    pointer(panel, `pointerenter`);
    jest.advanceTimersByTime(1000);
    expect(menu.open.value).toBe(true);

    // Off the panel and away down the rail: the grace, then gone.
    pointer(panel, `pointerleave`);
    pointer(trigger, `pointerenter`);
    pointer(trigger, `pointerleave`, { clientX: 30, clientY: 48 });
    pointer(document, `pointermove`, { clientX: 30, clientY: 200 });
    jest.advanceTimersByTime(CLOSE);
    expect(menu.open.value).toBe(false);
});

it(`pins on a press, even one on a menu the pointer raised, and closes on the next`, () => {
    const menu = mount();
    pointer(trigger, `pointerenter`);
    jest.advanceTimersByTime(OPEN);
    trigger.dispatchEvent(new MouseEvent(`click`, { detail: 1 }));
    expect([menu.open.value, menu.pressed.value]).toEqual([true, true]);

    pointer(trigger, `pointerleave`, { clientX: 30, clientY: 200 });
    jest.advanceTimersByTime(1000);
    expect(menu.open.value).toBe(true);

    trigger.dispatchEvent(new MouseEvent(`click`, { detail: 1 }));
    expect(menu.open.value).toBe(false);
});

it(`pins a menu the pointer raised once a press lands inside it`, () => {
    const menu = mount();
    pointer(trigger, `pointerenter`);
    jest.advanceTimersByTime(OPEN);
    pointer(panel, `pointerenter`);
    pointer(panel, `pointerdown`, { buttons: 1 });
    pointer(panel, `pointerleave`);
    jest.advanceTimersByTime(1000);
    expect([menu.open.value, menu.pressed.value]).toEqual([true, true]);
});

it(`opens from the keyboard on the current row and walks the rows with the arrows`, async () => {
    const menu = mount();
    trigger.dispatchEvent(new MouseEvent(`click`, { detail: 0 }));
    await nextTick();
    expect(menu.open.value).toBe(true);
    expect(document.activeElement?.textContent).toBe(`b`);

    const press = (key: string): void => void document.activeElement?.dispatchEvent(new KeyboardEvent(`keydown`, { key, bubbles: true }));
    press(`ArrowDown`);
    expect(document.activeElement?.textContent).toBe(`c`);
    press(`ArrowDown`);
    expect(document.activeElement?.textContent).toBe(`a`);
    press(`ArrowUp`);
    expect(document.activeElement?.textContent).toBe(`c`);
    press(`Home`);
    expect(document.activeElement?.textContent).toBe(`a`);
});

it(`opens on ArrowDown from the trigger`, async () => {
    const menu = mount();
    trigger.dispatchEvent(new KeyboardEvent(`keydown`, { key: `ArrowDown` }));
    await nextTick();
    expect([menu.open.value, menu.pressed.value, document.activeElement?.textContent]).toEqual([true, true, `b`]);
});
