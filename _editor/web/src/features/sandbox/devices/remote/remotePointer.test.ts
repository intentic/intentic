// A mouse on a remote computer: measured in the picture's pixels with its buttons and press count, and, with the pointer
// locked, moved by how far the hand moved, from where it last was, held inside the picture.
import "@intentic/testing/dom";
import { remotePointer } from "./remotePointer";

const SIZE = { width: 1920, height: 1080 };

// A picture drawn at half size at the page's top-left: one CSS px is two picture pixels.
const picture = (): HTMLElement => {
    const element = document.createElement(`canvas`);
    element.getBoundingClientRect = () => ({ left: 0, top: 0, right: 960, bottom: 540, width: 960, height: 540, x: 0, y: 0, toJSON: () => ({}) });
    return element;
};

const mouse = (type: string, init: MouseEventInit & { movementX?: number; movementY?: number }): MouseEvent => {
    const event = new MouseEvent(type, init);
    Object.defineProperty(event, `movementX`, { value: init.movementX ?? 0 });
    Object.defineProperty(event, `movementY`, { value: init.movementY ?? 0 });
    return event;
};

it("measures a press in the picture's own pixels, with the button, what is held and the press count", () => {
    const pointer = remotePointer();
    expect(pointer.at(`down`, mouse(`pointerdown`, { clientX: 100, clientY: 50, button: 0, buttons: 1, detail: 2 }), picture(), SIZE)).toEqual({
        type: `mouse`,
        action: `down`,
        x: 200,
        y: 100,
        button: 0,
        buttons: 1,
        clickCount: 2,
    });
    expect(pointer.at(`move`, mouse(`pointermove`, { clientX: 101, clientY: 50, buttons: 1 }), picture(), SIZE)).toEqual({
        type: `mouse`,
        action: `move`,
        x: 202,
        y: 100,
        buttons: 1,
    });
});

it("locked, moves a cursor kept here by the hand's movement, from where the pointer was, never out of the picture", () => {
    const pointer = remotePointer();
    pointer.at(`move`, mouse(`pointermove`, { clientX: 100, clientY: 50 }), picture(), SIZE);
    pointer.locked(true);
    expect(pointer.at(`move`, mouse(`pointermove`, { movementX: 10, movementY: -5 }), picture(), SIZE)).toMatchObject({ x: 220, y: 90 });
    expect(pointer.at(`move`, mouse(`pointermove`, { movementX: -5000, movementY: 9000 }), picture(), SIZE)).toMatchObject({ x: 0, y: 1079 });
    expect(pointer.cursor()).toEqual({ x: 0, y: 1079 });
});
