import { expect, test } from "vitest";
import { whenAborted } from "./abort.js";

test("a signal that aborted before anyone listened still runs the handler", () => {
    const controller = new AbortController();
    controller.abort();
    let ran = 0;
    whenAborted(controller.signal, () => {
        ran += 1;
    });
    // The bare listener this replaces would leave `ran` at 0: the abort event fired before registration and is
    // never replayed, which is how a Stop clicked during a provider's connect handshake used to be dropped.
    expect(ran).toBe(1);
});

test("the handler runs synchronously, so the line after the registration already sees the cancellation", () => {
    const controller = new AbortController();
    controller.abort();
    let killed = false;
    whenAborted(controller.signal, () => {
        killed = true;
    });
    expect(killed).toBe(true);
});

test("a live signal fires the handler once, when it aborts", () => {
    const controller = new AbortController();
    let ran = 0;
    whenAborted(controller.signal, () => {
        ran += 1;
    });
    expect(ran).toBe(0);
    controller.abort();
    controller.abort();
    expect(ran).toBe(1);
});

test("the returned dispose removes a handler that has not fired", () => {
    const controller = new AbortController();
    let ran = 0;
    const dispose = whenAborted(controller.signal, () => {
        ran += 1;
    });
    dispose();
    controller.abort();
    expect(ran).toBe(0);
});

test("dispose is safe after the handler already ran, and safe with no signal at all", () => {
    const controller = new AbortController();
    let ran = 0;
    const dispose = whenAborted(controller.signal, () => {
        ran += 1;
    });
    controller.abort();
    expect(ran).toBe(1);
    expect(() => dispose()).not.toThrow();
    expect(ran).toBe(1);

    let neverRan = 0;
    const disposeNothing = whenAborted(undefined, () => {
        neverRan += 1;
    });
    expect(() => disposeNothing()).not.toThrow();
    expect(neverRan).toBe(0);
});

test("an already-aborted signal still hands back a dispose that does not re-run the handler", () => {
    const controller = new AbortController();
    controller.abort();
    let ran = 0;
    const dispose = whenAborted(controller.signal, () => {
        ran += 1;
    });
    expect(ran).toBe(1);
    dispose();
    expect(ran).toBe(1);
});
