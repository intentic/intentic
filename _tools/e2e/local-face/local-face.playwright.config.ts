import { defineConfig } from "@playwright/test";

// The desktop app's local face (_editor/desktop-app, `dist/files`) booted the way a window on a folder boots it, with no
// Tauri: the built bundle behind a one-page static server, the real intentic-files sidecar granted a temp folder on its
// stdin, and the window's facts injected before any script runs. Hermetic: nothing it loads leaves loopback.
export default defineConfig({
    testDir: `.`,
    testMatch: `*.spec.ts`,
    globalSetup: `./local-global-setup`,
    workers: 1,
    // A failure here is the editor or the sidecar disagreeing about a route, which a second attempt only hides.
    retries: 0,
    // Hang bounds, not latency: the first paint parses the editor's multi-megabyte chunks on a busy runner.
    timeout: 120_000,
    expect: { timeout: 30_000 },
    reporter: [[`list`]],
    outputDir: `../.cache/local-face-results`,
    use: {
        // The full baked chromium rather than the headless shell; ../playwright.config.ts carries the reasoning.
        channel: `chromium`,
        // The page picks its language from the browser's; the labels the spec finds it by are the English ones.
        locale: `en-US`,
        viewport: { width: 1280, height: 800 },
        trace: `retain-on-failure`,
    },
});
