// Globals the app reads at import time, before any test hook runs: `matchMedia` (@intentic/ui device detection;
// matches:false keeps the desktop form factor), `ResizeObserver` (AnchoredOverlay, a no-op here), `window.env`
// (environment.ts, throws without deploy config). Set with `??=` so a suite can override.
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

// jsdom omits scrollIntoView; calling it async throws an unhandled rejection that fails the run though every assertion
// passed. A no-op is honest: nothing under jsdom can observe scroll position anyway.
if (typeof Element !== "undefined") {
    Element.prototype.scrollIntoView ??= (): void => {};
}

// Only under jsdom: node-environment suites have no window and never read one.
if (typeof window !== "undefined") {
    window.env ??= {
        production: false,
        api: { url: `http://localhost` },
        auth: { googleClientId: `` },
        analytics: { posthogKey: ``, posthogHost: `` },
        afterSignOut: ``,
    };
}
