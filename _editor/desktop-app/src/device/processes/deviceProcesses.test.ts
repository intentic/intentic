import "@intentic/testing/dom";

// This computer's own work as the processes both faces draw (2026-10-26): a Docker start and a move between engines.

// The kit's device readout (reached through ./machine) asks media queries at import; nothing here is about the screen.
Object.defineProperty(window, `matchMedia`, {
    value: (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }),
    configurable: true,
});

const { dockerProcessOf, moveProcessOf } = await import("./deviceProcesses");

describe(`this computer's own work, as processes`, () => {
    it(`is a Docker start while it runs, and a start that did not bring the engine up until it is put away`, () => {
        expect(dockerProcessOf(true, undefined)?.state).toBe(`running`);
        expect(dockerProcessOf(false, `Docker would not start`)).toMatchObject({ state: `failed`, failure: `Docker would not start`, actions: [`retry`, `dismiss`] });
        expect(dockerProcessOf(false, undefined)).toBeUndefined();
    });

    it(`is a move between engines while it runs, and how it ended`, () => {
        expect(moveProcessOf(true, undefined, undefined)?.state).toBe(`running`);
        expect(moveProcessOf(false, `moved`, undefined)?.state).toBe(`done`);
        expect(moveProcessOf(false, `failed`, undefined)?.state).toBe(`failed`);
        expect(moveProcessOf(false, undefined, `no ic`)).toMatchObject({ state: `failed`, failure: `no ic` });
        expect(moveProcessOf(false, undefined, undefined)).toBeUndefined();
    });
});
