import { dom } from "./dom.js";

test("window events work through both jsdom's window and the shared globals", () => {
    const received: string[] = [];
    const listener = (event: Event): void => {
        received.push(event.type);
    };
    dom.window.addEventListener("dom-probe", listener);
    window.dispatchEvent(new Event("dom-probe"));
    window.removeEventListener("dom-probe", listener);
    dom.window.dispatchEvent(new Event("dom-probe"));
    expect(received).toEqual(["dom-probe"]);
});

test("a runtime AbortSignal removes a DOM event listener when aborted", () => {
    const controller = new AbortController();
    const button = document.createElement("button");
    let clicks = 0;
    button.addEventListener("click", () => clicks++, { signal: controller.signal });
    button.click();
    controller.abort();
    button.click();
    expect(clicks).toBe(1);
});

test("inline DOM handlers execute in the window realm", () => {
    const button = document.createElement("button");
    button.setAttribute("onclick", "this.dataset.clicked = 'yes'");
    button.click();
    expect(button.dataset["clicked"]).toBe("yes");
});

test("document method spies observe changing focus through its prototype", () => {
    // jsdom 30 wraps document in a proxy; Bun cannot install a method spy directly on that proxy.
    let focused = false;
    const focus = jest.spyOn(Document.prototype, "hasFocus").mockImplementation(() => focused);
    try {
        expect(document.hasFocus()).toBe(false);
        focused = true;
        expect(document.hasFocus()).toBe(true);
        focused = false;
        expect(document.hasFocus()).toBe(false);
        expect(focus).toHaveBeenCalledTimes(3);
    } finally {
        focus.mockRestore();
    }
});
