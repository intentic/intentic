/* WHAT THE APP READS BEFORE A TEST GETS A WORD IN, stood up once for the whole package.
 *
 * Three globals, all reached at IMPORT rather than from a test body, which is why they live in a setup file
 * and not in a beforeAll: by the time a hook runs, the module that needed them has already thrown.
 *
 * `matchMedia` is the design system barrel's (useDevice), so any suite that touches @intentic/ui needs it
 * before its first import evaluates. matches:false everywhere keeps the device DESKTOP, the form factor whose
 * affordances the component suites assert. `ResizeObserver` is <AnchoredOverlay>'s, the overlay re-places on
 * its panel's own resize, and nothing in a test resizes, so observing is a no-op; without it arm() throws
 * inside a watcher, the panel renders un-armed, and the failure surfaces as "the menu row isn't there" three
 * assertions later. `window.env` is environments/environment.ts, which evaluates readEnvironment() at module
 * scope and throws when the deploy-time config script has not run, as it never has under vitest.
 *
 * These were once copied into every suite that tripped over them: ninety files carrying the same fifteen
 * lines of preamble, each with a `vi.hoisted` wrapper and a deferred `await import()` to make the ordering
 * work. The ordering is this file's job. A suite that wants different values assigns them outright (see
 * useGoogleIdentity.desktop.test.ts), `??=` here yields to nothing, because this runs first. */
globalThis.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
})) as unknown as typeof globalThis.matchMedia;

globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
} as unknown as typeof globalThis.ResizeObserver;

// Only under jsdom: the node-environment suites have no `window`, and nothing they import reads one.
if (typeof window !== "undefined") {
    window.env ??= {
        production: false,
        api: { url: `http://localhost` },
        auth: { googleClientId: `` },
        analytics: { posthogKey: ``, posthogHost: `` },
        afterSignOut: ``,
    };
}
