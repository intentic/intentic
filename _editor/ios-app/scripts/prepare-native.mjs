#!/usr/bin/env node
/* Finishes a freshly generated iOS project (`cap add ios`) into the shape a store build needs — run by CI
 * right after generation, and by a Mac doing the same flow by hand. Nothing under ios/ is committed, so this
 * is deterministic post-processing of a deterministic generation, not a patch that can drift.
 *
 * Two jobs:
 *
 * 1. ASSERT the template still forwards APNs registration to the plugin layer. Capacitor's app template does
 *    this today; the day an upgrade ships one that does not, every build would still succeed — and every
 *    install would time out asking for a device token, surfaced in the web app as "the push service did not
 *    answer", pointing everywhere but here. A red build naming the fix beats that silence.
 *
 * 2. WIRE the push entitlement into the App target alone. The obvious shortcut — CODE_SIGN_ENTITLEMENTS as an
 *    xcodebuild command-line override — applies to every target the workspace builds, Pods frameworks
 *    included, which is exactly where an entitlements file does not belong. So the file is copied beside the
 *    app sources and the setting written into the app project's two build configurations, recognized by the
 *    bundle-identifier line that only the App target carries. */
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";

const APP_DELEGATE = "ios/App/App/AppDelegate.swift";
const PBXPROJ = "ios/App/App.xcodeproj/project.pbxproj";
const ENTITLEMENTS_SOURCE = "native/App.entitlements";
const ENTITLEMENTS_TARGET = "ios/App/App/App.entitlements";

// 1. Push wiring.
const delegate = readFileSync(APP_DELEGATE, "utf8");
const missing = ["capacitorDidRegisterForRemoteNotifications", "capacitorDidFailToRegisterForRemoteNotifications"].filter(
    (marker) => !delegate.includes(marker),
);
if (missing.length > 0) {
    console.error(
        `${APP_DELEGATE} no longer forwards APNs registration to Capacitor (missing: ${missing.join(", ")}).\n` +
            `The generated template changed. Teach this script to add the two application(...) methods from ` +
            `the @capacitor/push-notifications iOS docs, or this app can never obtain a device token.`,
    );
    process.exit(1);
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
console.log("push wiring asserted; entitlements wired into the App target");
