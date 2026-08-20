import type { ExtensionManifest } from "./manifest.js";

/* WHAT AN UPDATE ASKS FOR, MECHANICALLY. The install dialog renders a manifest's contributions once; an update
 * is judged on what sits BETWEEN two manifests, and "read both and compare" is exactly the job a person will
 * skip on the fifth update. So each manifest is folded to a set of POWERS, the consequential facts an owner
 * approved: which daemon routes it may call, which processes the daemon runs for it, what lands on the agent's
 * PATH, what may interrupt from another screen, each under a stable key (the identity compared) with a plain
 * sentence (what the reader sees). The diff is set arithmetic over the keys.
 *
 * Deliberately NOT here: plain settings (a new knob is config surface, not reach), display marks, category,
 * version. A power's INTERNALS moving (a process's command line, a fragment's contents) keeps its key, the
 * code changed, which is what the sha pin and the agent diff-read answer for; this diff answers only "did the
 * set of things I approved grow". An empty `added` is what makes an update one click. */

export interface PowersDiff {
    // Powers the new manifest declares that the installed one didn't, the reason an update re-asks.
    readonly added: string[];
    readonly removed: string[];
    readonly unchanged: string[];
}

const powersOf = (manifest: ExtensionManifest): Map<string, string> => {
    const powers = new Map<string, string>();
    if (manifest.entry !== undefined) {
        powers.set("entry", "runs a UI bundle in your browser");
    }
    if (manifest.server !== undefined) {
        powers.set("server", "runs a backend bundle inside the daemon's extension host");
    }
    for (const route of manifest.permissions?.sandbox ?? []) {
        powers.set(`sandbox:${route}`, `its UI calls the sandbox route ${route}`);
    }
    for (const route of manifest.permissions?.daemon ?? []) {
        powers.set(`daemon:${route}`, `its backend calls the daemon route ${route}`);
    }
    for (const view of manifest.contributes?.views ?? []) {
        powers.set(`view:${view.id}`, `a ${view.surface} view "${view.label}"`);
        if (view.badge === true) {
            powers.set(`view-badge:${view.id}`, `may badge the "${view.label}" tile from any screen`);
        }
    }
    for (const viewer of manifest.contributes?.viewers ?? []) {
        powers.set(`viewer:${viewer.id}`, `opens .${viewer.extensions.join(", .")} files (${viewer.fetch})`);
    }
    for (const document of manifest.contributes?.documents ?? []) {
        powers.set(`document:${document.id}`, `marks workspace directories ("${document.label}")`);
    }
    for (const command of manifest.contributes?.commands ?? []) {
        powers.set(`command:${command.command}`, `a palette command "${command.title}"`);
        if (command.keybinding !== undefined) {
            powers.set(`keybinding:${command.command}`, `the global shortcut ${command.keybinding} ("${command.title}")`);
        }
    }
    for (const setting of manifest.contributes?.settings ?? []) {
        if (setting.env !== undefined) {
            powers.set(`setting-env:${setting.key}`, `puts the "${setting.key}" setting into the agent's environment as ${setting.env}`);
        }
    }
    for (const process of manifest.contributes?.processes ?? []) {
        powers.set(`process:${process.name}`, `a background process "${process.name}"${process.autoStart === true ? " (starts on boot)" : ""}`);
    }
    for (const file of manifest.contributes?.files ?? []) {
        powers.set(`files:${file.path}`, `is told when ${file.path} changes`);
    }
    if (manifest.contributes?.agent !== undefined) {
        powers.set("agent", "contributes skills, agents and hooks to the agent's turns");
    }
    if (manifest.contributes?.environment !== undefined) {
        powers.set("environment", "bakes an environment fragment into the sandbox image");
    }
    for (const capability of manifest.contributes?.capabilities ?? []) {
        powers.set(`capability:${capability.id}`, `a ${capability.kind} capability card "${capability.catalog.name}"`);
    }
    if (manifest.contributes?.listener !== undefined) {
        powers.set(`listener:${manifest.contributes.listener.provider}`, `a realtime listener provider "${manifest.contributes.listener.provider}"`);
    }
    if (manifest.contributes?.bin !== undefined) {
        powers.set("bin", "puts its shipped tools on the agent's PATH");
    }
    return powers;
};

// `before` absent covers a first install: everything the manifest declares is `added`, which is exactly what
// the install dialog already renders, one vocabulary for both moments.
export const diffPowers = (before: ExtensionManifest | undefined, after: ExtensionManifest): PowersDiff => {
    const from = before === undefined ? new Map<string, string>() : powersOf(before);
    const to = powersOf(after);
    const added: string[] = [];
    const removed: string[] = [];
    const unchanged: string[] = [];
    for (const [key, label] of to) {
        (from.has(key) ? unchanged : added).push(label);
    }
    for (const [key, label] of from) {
        if (!to.has(key)) {
            removed.push(label);
        }
    }
    return { added, removed, unchanged };
};
