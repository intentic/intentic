// Where a key landed (eventTarget.ts). One answer to "is the person typing here?" for every keyboard surface: the
// command keymap, the review panel's arrow keys, the on-screen keyboard's detection and the desktop link menu.
import { isTypingTarget } from "@intentic/ui/event-target";

// jsdom does not compute `isContentEditable`; a browser derives it from the attribute, inherited by descendants.
const editable = (element: HTMLElement, value: boolean): HTMLElement => {
    Object.defineProperty(element, `isContentEditable`, { value });
    return element;
};

const mount = (html: string): HTMLElement => {
    const host = document.createElement(`div`);
    host.innerHTML = html;
    document.body.append(host);
    return host;
};

afterEach(() => {
    document.body.innerHTML = ``;
});

it(`counts every native field as typing, a select included`, () => {
    const host = mount(`<input id="i"><textarea id="t"></textarea><select id="s"><option id="o">a</option></select>`);
    expect([`i`, `t`, `s`, `o`].map((id) => isTypingTarget(host.querySelector(`#${id}`)))).toEqual([true, true, true, true]);
});

it(`counts a custom text box and an element editable in place`, () => {
    const host = mount(`<div id="box" role="textbox"><span id="inside">x</span></div><div id="line"></div>`);
    expect(isTypingTarget(host.querySelector(`#box`))).toBe(true);
    expect(isTypingTarget(host.querySelector(`#inside`))).toBe(true);
    expect(isTypingTarget(editable(host.querySelector<HTMLElement>(`#line`)!, true))).toBe(true);
});

it(`counts an SVG drawn inside an editable line, which carries no isContentEditable of its own`, () => {
    const host = mount(`<div id="line" contenteditable="true"><svg><path id="glyph"></path></svg></div>`);
    editable(host.querySelector<HTMLElement>(`#line`)!, true);
    expect(isTypingTarget(host.querySelector(`#glyph`))).toBe(true);
});

it(`leaves buttons, plain text, a read-only region and non-elements to the keymap`, () => {
    const host = mount(`<button id="b">go</button><p id="p">text</p><div id="ro" contenteditable="false"></div>`);
    expect(isTypingTarget(host.querySelector(`#b`))).toBe(false);
    expect(isTypingTarget(host.querySelector(`#p`))).toBe(false);
    expect(isTypingTarget(editable(host.querySelector<HTMLElement>(`#ro`)!, false))).toBe(false);
    expect(isTypingTarget(window)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
});
