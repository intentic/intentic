import type { CapacitorConfig } from "@capacitor/cli";

/* The iOS shell's whole configuration — there is deliberately almost nothing here, because the shell's whole
 * design is "the hosted SPA, in a native frame" (README.md has the full argument; the desktop app made the
 * same choice first). `server.url` is what makes it so: the webview loads app.intentic.dev itself, the bridge
 * is injected into that page, and every product change ships the moment the web deploy does — no App Store
 * release, no second UI codebase, no bundle drifting out of date on someone's phone.
 *
 * INTENTIC_APP_URL overrides the target at sync time (a dev pointing a debug build at a local SPA), matching
 * the desktop shell's override of the same name. */

const config: CapacitorConfig = {
    appId: "dev.intentic.app",
    appName: "intentic",
    // Required by Capacitor but almost never shown: www/ holds only the offline fallback page the webview
    // lands on when the hosted app is unreachable at launch.
    webDir: "www",
    server: {
        url: process.env["INTENTIC_APP_URL"] ?? "https://app.intentic.dev",
    },
    ios: {
        // The page is a workspace, not an article: rubber-banding the whole viewport reads as broken.
        scrollEnabled: false,
    },
};

export default config;
