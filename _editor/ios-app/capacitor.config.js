/* The iOS shell's whole configuration: there is deliberately almost nothing here, because the shell's whole
 * design is "the hosted SPA, in a native frame" (README.md has the full argument; the desktop app made the
 * same choice first). `server.url` is what makes it so: the webview loads app.intentic.dev itself, the bridge
 * is injected into that page, and every product change ships the moment the web deploy does: no App Store
 * release, no second UI codebase, no bundle drifting out of date on someone's phone.
 *
 * INTENTIC_APP_URL overrides the target at sync time (a dev pointing a debug build at a local SPA), matching
 * the desktop shell's override of the same name.
 *
 * COMMONJS, AND TYPED BY JSDOC, rather than the capacitor.config.ts the Capacitor docs reach for first. The
 * `.ts` loader treats an installed TypeScript as a precondition: it resolves the compiler out of this folder
 * and refuses the file when there is none, so a typed config would mean shipping a compiler into a folder
 * that has no other TypeScript in it, to read twenty lines. The annotation below gives an editor the same
 * completion and the same error on a typo, and the file loads on any Node the runners hand us. */

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
