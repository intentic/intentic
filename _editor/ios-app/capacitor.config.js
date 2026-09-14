/* The iOS shell's whole configuration: there is deliberately almost nothing here, because the shell's whole design is "the hosted SPA. */

/** @type {import("@capacitor/cli").CapacitorConfig} */
module.exports = {
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
