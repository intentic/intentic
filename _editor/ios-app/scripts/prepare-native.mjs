#!/usr/bin/env node
// Post-processes a freshly generated iOS project (`cap add ios`) into a store-buildable shape: wires APNs
// registration into AppDelegate (the Capacitor template doesn't) and the push entitlement into only the App
// target. Both edits assert their anchor and fail loudly if the generated template's shape has moved.
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

// Push wiring anchors on the class's one unindented closing brace; more than one means the template changed.
const delegate = readFileSync(APP_DELEGATE, "utf8");
if (delegate.includes("capacitorDidRegisterForRemoteNotifications")) {
    console.log("push wiring already present; leaving the AppDelegate alone");
} else {
    const classEnds = delegate.match(/^\}$/gm) ?? [];
    if (classEnds.length !== 1) {
        console.error(
            `${APP_DELEGATE}: expected exactly one top-level closing brace to insert before, found ${classEnds.length}, ` +
                `the generated template's shape changed; re-derive the anchor, or this app can never obtain a device token.`,
        );
        process.exit(1);
    }
    writeFileSync(APP_DELEGATE, delegate.replace(/^\}$/m, `${REGISTRATION}}`));
}

// Entitlements go into exactly the App target's Debug and Release configs, never more.
copyFileSync(ENTITLEMENTS_SOURCE, ENTITLEMENTS_TARGET);
const project = readFileSync(PBXPROJ, "utf8");
const marker = /^(\s*)PRODUCT_BUNDLE_IDENTIFIER = /gm;
const alreadyWired = project.includes("CODE_SIGN_ENTITLEMENTS");
const wired = alreadyWired ? project : project.replace(marker, (line, indent) => `${indent}CODE_SIGN_ENTITLEMENTS = App/App.entitlements;\n${line}`);
const insertions = alreadyWired ? 2 : (wired.match(/CODE_SIGN_ENTITLEMENTS/g) ?? []).length;
if (insertions !== 2) {
    console.error(
        `${PBXPROJ}: expected to wire the entitlements into exactly 2 build configurations, found ${insertions}, ` +
            `the generated project's shape changed; re-derive the anchor this script inserts at.`,
    );
    process.exit(1);
}
writeFileSync(PBXPROJ, wired);
console.log("push registration wired into the AppDelegate; entitlements wired into the App target");
