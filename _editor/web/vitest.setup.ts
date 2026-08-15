/* THE TWO BROWSER APIS JSDOM DOES NOT SHIP, stubbed once for the whole package.
 *
 * `matchMedia` is reached at IMPORT by the design system's barrel (useDevice), so any suite that touches
 * @intentic/ui needs it before its first import runs — which is why this is a setup file rather than a
 * beforeAll. `ResizeObserver` is <AnchoredOverlay>'s: the overlay re-places on its panel's own resize, and
 * nothing in a test resizes, so observing is a no-op.
 *
 * They lived in the one suite that mounted an overlay directly (anchoredOverlay.test.ts, which still declares
 * them itself and documents why) until the app's menus stopped being PrimeVue Popovers. Six more surfaces now
 * render an <AnchoredOverlay> somewhere in their subtree — the account panel, the sandbox switcher, the
 * terminal panel's two toolbars, the session menu, and every <Picker> in the app — and a component test that
 * mounts one has no reason to know that. Without the stub the overlay's arm() throws inside a watcher, the
 * panel renders un-armed, and the failure surfaces as "the menu row isn't there" three assertions later.
 *
 * `??=`, so a suite that wants a REAL fake (one that fires) still installs its own. */
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
