#!/usr/bin/env node
/* Finishes a freshly generated iOS project (`cap add ios`) into the shape a store build needs — run by CI
 * right after generation, and by a Mac doing the same flow by hand. Nothing under ios/ is committed, so this
 * is deterministic post-processing of a deterministic generation, not a patch that can drift.
 *
 * Two jobs:
 *
 * 1. WIRE APNs registration into the AppDelegate. Capacitor's app template does NOT do this — the two methods
 *    below are a manual step in @capacitor/push-notifications' own iOS instructions, and the plugin listens for
 *    exactly the two notifications they post. Without them the app registers, iOS hands the device token to the
 *    app delegate, nobody is listening, and the plugin's `registration` event never fires: every install hangs
 *    on "the push service did not answer", pointing everywhere but here. UIKit delivers these callbacks to the
 *    APP delegate and not to the scene's, so this file is the only place they can live.
 *
 * 2. WIRE the push entitlement into the App target alone. The obvious shortcut — CODE_SIGN_ENTITLEMENTS as an
 *    xcodebuild command-line override — applies to every target the workspace builds, Pods frameworks
 *    included, which is exactly where an entitlements file does not belong. So the file is copied beside the
 *    app sources and the setting written into the app project's two build configurations, recognized by the
 *    bundle-identifier line that only the App target carries.
 *
 * Both edits assert their anchor. A Capacitor upgrade that reshapes the template stops the build here, naming
 * what moved — the alternative is a build that succeeds and an app that cannot receive a notification. */
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";

const APP_DELEGATE = "ios/App/App/AppDelegate.swift";
const PBXPROJ = "ios/App/App.xcodeproj/project.pbxproj";
const ENTITLEMENTS_SOURCE = "native/App.entitlements";
const ENTITLEMENTS_TARGET = "ios/App/App/App.entitlements";

// Verbatim from @capacitor/push-notifications' README, indented into the class body.
const REGISTRATION = `    // Added by scripts/prepare-native.mjs: @capacitor/push-notifications' documented iOS step, which the
    // Capacitor template leaves to the app. The plugin observes these two notifications and resolves its
    // \`registration\` / \`registrationError\` events from them.
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }
`;

// 1. Push wiring. The class body's end is the anchor: the template is one class per file, so the file's only
// unindented closing brace is that class's. Two of them would mean the template grew a second declaration and
// the insertion point is no longer obvious — worth stopping over rather than guessing.
const delegate = readFileSync(APP_DELEGATE, "utf8");
if (delegate.includes("capacitorDidRegisterForRemoteNotifications")) {
    console.log("push wiring already present; leaving the AppDelegate alone");
} else {
    const classEnds = delegate.match(/^\}$/gm) ?? [];
    if (classEnds.length !== 1) {
        console.error(
            `${APP_DELEGATE}: expected exactly one top-level closing brace to insert before, found ${classEnds.length} — ` +
                `the generated template's shape changed; re-derive the anchor, or this app can never obtain a device token.`,
        );
        process.exit(1);
    }
    writeFileSync(APP_DELEGATE, delegate.replace(/^\}$/m, `${REGISTRATION}}`));
}

// 2. Entitlements, into the App target's Debug and Release configurations — and exactly those two. Any other
// count means the generated project's shape moved, and guessing would sign the wrong thing quietly.
copyFileSync(ENTITLEMENTS_SOURCE, ENTITLEMENTS_TARGET);
const project = readFileSync(PBXPROJ, "utf8");
const marker = /^(\s*)PRODUCT_BUNDLE_IDENTIFIER = /gm;
const alreadyWired = project.includes("CODE_SIGN_ENTITLEMENTS");
const wired = alreadyWired ? project : project.replace(marker, (line, indent) => `${indent}CODE_SIGN_ENTITLEMENTS = App/App.entitlements;\n${line}`);
const insertions = alreadyWired ? 2 : (wired.match(/CODE_SIGN_ENTITLEMENTS/g) ?? []).length;
if (insertions !== 2) {
    console.error(
        `${PBXPROJ}: expected to wire the entitlements into exactly 2 build configurations, found ${insertions} — ` +
            `the generated project's shape changed; re-derive the anchor this script inserts at.`,
    );
    process.exit(1);
}
writeFileSync(PBXPROJ, wired);
console.log("push registration wired into the AppDelegate; entitlements wired into the App target");
