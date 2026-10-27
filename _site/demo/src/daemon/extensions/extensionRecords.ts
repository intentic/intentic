import { STATE_DIR } from "@intentic/constants";
import type { ExtensionRemovalPlan, ExtensionSummary } from "@intentic/sandbox-contract/schemas/extension-updates";
import type { SandboxHandlerOutput } from "@intentic/sandbox-contract/protocol/procedure-types";
import { refuse } from "@intentic/contract-serve";
import { automationsList } from "../../fixture/automations";
import { bundleOf, demoExtensions, removeDemoExtension } from "./extensionList";
import { demoQuiet } from "../../mode";
import { pushWorkspaceChanged } from "../broadcast";
import { runningProcesses, stopAllOf } from "./extensionProcesses";
import { forgetUpdates } from "./extensionUpdates";
import { workspaceDirOf } from "./extensionWorkspace";
import { okAfter } from "../doors";

// What the daemon keeps about each extension besides its code: the settings the owner entered, the powers it has been
// seen using, whether it runs from a source checkout, and what removing it would take with it.

type Value = string | number | boolean;
type Readiness = SandboxHandlerOutput<`extensions`, `readiness`>[`checks`][number];

const SETTINGS_FILE = `${STATE_DIR}/config/extension-settings.json`;
const USAGE_FILE = `${STATE_DIR}/records/extension-usage.json`;
const DEV_FILE = `${STATE_DIR}/local/extension-dev.json`;
// Removing deletes a checkout and tears connections down; long enough for the dialog's held button to be read.
const REMOVE_MS = 1_200;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const find = (id: string): ExtensionSummary => demoExtensions().find((extension) => extension.id === id) ?? refuse(`no extension with that id is installed`, 404);

// Settings, by extension id. Only declared keys are kept, the honesty rule the daemon holds every write to.
const settingsNow = new Map<string, Record<string, Value>>();

export const settingsOf = (id: string): SandboxHandlerOutput<`extensions`, `settings`> => {
    const declared = find(id).manifest.contributes?.settings ?? [];
    const secret = new Set(declared.filter((setting) => setting.secret === true).map((setting) => setting.key));
    const stored = settingsNow.get(id) ?? {};
    return {
        settings: Object.fromEntries(Object.entries(stored).filter(([key]) => !secret.has(key))),
        secretsSet: Object.entries(stored)
            .filter(([key, value]) => secret.has(key) && value !== ``)
            .map(([key]) => key),
    };
};

export const saveSettings = (id: string, settings: Record<string, Value>) => {
    const declared = new Set((find(id).manifest.contributes?.settings ?? []).map((setting) => setting.key));
    const undeclared = Object.keys(settings).filter((key) => !declared.has(key));
    if (undeclared.length > 0) {
        refuse(`undeclared setting keys: ${undeclared.join(`, `)}`, 400);
    }
    return okAfter(() => {
        // Merged like the daemon's: a secret left out of the form keeps what it held.
        settingsNow.set(id, { ...settingsNow.get(id), ...settings });
        pushWorkspaceChanged(SETTINGS_FILE);
    });
};

// One batch from the browser's permission gate: counts against declared routes only, a removed extension's ignored.
export const recordUsage = (reports: Record<string, Record<string, number>>) =>
    okAfter(() => {
        const at = new Date().toISOString();
        for (const [id, used] of Object.entries(reports)) {
            const extension = demoExtensions().find((candidate) => candidate.id === id);
            const declared = new Set(extension?.manifest.permissions?.sandbox ?? []);
            for (const [route, calls] of Object.entries(used)) {
                if (extension !== undefined && declared.has(route)) {
                    const usage = (extension.usage ??= {});
                    usage[route] = { calls: (usage[route]?.calls ?? 0) + calls, last: at };
                }
            }
        }
    });

// The import specifiers a bundle names, as the registry scanner lists them.
const importsOf = (source: string): string[] => [...new Set([...source.matchAll(/\b(?:from|import)\s*["']([^"'./][^"']*)["']/gu)].map((match) => match[1] ?? ``))];

const bundleCheck = (extension: ExtensionSummary): Readiness => {
    const check = { id: `bundle`, label: `The bundle imports only what the host publishes` };
    if (extension.manifest.entry === undefined) {
        return { ...check, status: `pass`, detail: `No UI bundle, nothing is loaded in the browser.` };
    }
    const source = bundleOf(extension.id);
    if (source === undefined) {
        // A compiled-in extension's bundle is part of the app itself, so there is no separate file to read.
        return { ...check, status: `pass`, detail: `Compiled into this app, so it imports what the app does.` };
    }
    const imports = importsOf(source);
    return { ...check, status: `pass`, detail: imports.length === 0 ? `Imports nothing.` : `Imports ${imports.join(`, `)}.` };
};

const permissionsCheck = (extension: ExtensionSummary): Readiness => {
    const check = { id: `permissions`, label: `It asks only for the reach it uses` };
    const declared = extension.manifest.permissions?.sandbox ?? [];
    if (declared.length === 0) {
        return { ...check, status: `pass`, detail: `It asks for no daemon routes at all.` };
    }
    if (extension.usage === undefined) {
        return { ...check, status: `warn`, detail: `Declares ${declared.length}, and none has been observed being called yet, use it, then check again.` };
    }
    const unused = declared.filter((route) => (extension.usage?.[route]?.calls ?? 0) === 0);
    return unused.length > 0
        ? { ...check, status: `warn`, detail: `${unused.length} of ${declared.length} have never been called: ${unused.join(`, `)}. Each is reach every future owner is asked to approve.` }
        : { ...check, status: `pass`, detail: `All ${declared.length} have been used.` };
};

export const readinessOf = (id: string): SandboxHandlerOutput<`extensions`, `readiness`> => {
    const extension = find(id);
    const promised = [extension.manifest.entry, extension.manifest.server].filter((path) => path !== undefined).length;
    return {
        checks: [
            bundleCheck(extension),
            { id: `paths`, label: `Every file the manifest promises is there`, status: `pass`, detail: promised === 0 ? `It promises no files.` : `All ${promised} present.` },
            { id: `engines`, label: `It runs on this version of the app`, status: `pass`, detail: `Asks for ${extension.manifest.engines.intentic}, which this app satisfies.` },
            permissionsCheck(extension),
        ],
    };
};

// The loud recording has one install running from a source checkout an agent is changing, so the way back is drawn.
let devSeeded = false;
const seedDev = (): void => {
    if (devSeeded) {
        return;
    }
    devSeeded = true;
    const working = demoQuiet() ? undefined : demoExtensions().find((extension) => extension.id === `intentic.documentation`);
    if (working !== undefined) {
        working.dev = { path: `extensions/documentation`, uncommitted: 3, revision: `d41c9e07` };
    }
};

/** The rows with their dev-mode line, as the list sends them. */
export const withDev = (rows: ExtensionSummary[]): ExtensionSummary[] => {
    seedDev();
    return rows;
};

export const clearDev = (id: string): SandboxHandlerOutput<`extensions`, `devClear`> => {
    seedDev();
    const extension = demoExtensions().find((candidate) => candidate.id === id || candidate.manifest.name === id) ?? refuse(`no extension with that id is installed`, 404);
    const cleared = extension.dev !== undefined;
    delete extension.dev;
    if (cleared) {
        pushWorkspaceChanged(DEV_FILE);
    }
    return { id: extension.id, name: `${extension.manifest.publisher}.${extension.manifest.name}`, cleared };
};

const blockedOf = (extension: ExtensionSummary): string | undefined =>
    extension.essential === true
        ? `This is the only window onto work the sandbox does on its own, which carries on whether the page is here or not. Removing it would hide the work, not stop it.`
        : extension.source === `builtin`
          ? `This one is built into the sandbox image, so there is nothing here to delete. Its switch already stops everything it contributes; a different image is the only thing that removes it.`
          : undefined;

const filesOf = (extension: ExtensionSummary): ExtensionRemovalPlan[`files`] => {
    if (extension.source === `workspace`) {
        return [{ path: workspaceDirOf(extension), detail: `its source, authored here; the deletion lands as a tracked change you can review or undo` }];
    }
    if (extension.source !== `installed`) {
        return [];
    }
    const kept = extension.previous;
    return [
        { path: `${STATE_DIR}/local/extensions/${extension.id}`, detail: `the checkout at ${extension.manifest.version}, re-clonable from its source` },
        ...(kept === undefined
            ? []
            : [{ path: `${STATE_DIR}/local/extensions/.${extension.id}.previous`, detail: `version ${kept.version ?? kept.ref.slice(0, 12)}, kept one step back; reverting stops being possible` }]),
    ];
};

const keepsOf = (extension: ExtensionSummary, stranded: number): string[] => [
    `anything it wrote in your workspace outside its own directories stays where it is`,
    ...(stranded > 0 || extension.manifest.contributes?.automationTemplates !== undefined ? [`automations you built with it stay; a template is a starting point, not a dependency`] : []),
    ...(extension.source === `installed` ? [`its source repository is untouched, so installing it again is one paste of the same address`] : []),
    ...(extension.dev === undefined ? [] : [`the source checkout it was pointed at (${extension.dev.path}) stays as it is`]),
];

export const removalPlanOf = (id: string): ExtensionRemovalPlan => {
    const extension = find(id);
    const provider = extension.manifest.contributes?.listener?.provider;
    const automations =
        provider === undefined
            ? []
            : automationsList(Date.now())
                  .filter((automation) => automation.trigger.kind === `listener` && automation.trigger.provider === provider)
                  .map((automation) => automation.id);
    const plan: ExtensionRemovalPlan = {
        id: extension.id,
        name: `${extension.manifest.publisher}.${extension.manifest.name}`,
        version: extension.manifest.version,
        source: extension.source,
        files: filesOf(extension),
        connections: [],
        settings: Object.entries(settingsNow.get(id) ?? {})
            .filter(([, value]) => value !== ``)
            .map(([key]) => ({ key, secret: (extension.manifest.contributes?.settings ?? []).some((setting) => setting.key === key && setting.secret === true) })),
        processes: runningProcesses(id),
        automations,
        rebuildNeeded: extension.manifest.contributes?.environment !== undefined && extension.enabled,
        keeps: keepsOf(extension, automations.length),
    };
    const blocked = blockedOf(extension);
    if (blocked !== undefined) {
        plan.blocked = blocked;
    }
    return plan;
};

export const removeExtension = async (id: string): Promise<SandboxHandlerOutput<`extensions`, `remove`>> => {
    const plan = removalPlanOf(id);
    if (plan.blocked !== undefined) {
        refuse(plan.blocked, 412);
    }
    await wait(REMOVE_MS);
    stopAllOf(id);
    settingsNow.delete(id);
    forgetUpdates(id);
    const extension = find(id);
    removeDemoExtension(id);
    pushWorkspaceChanged(extension.source === `workspace` ? `${workspaceDirOf(extension)}/` : `${STATE_DIR}/config/capabilities.json`, USAGE_FILE);
    const removed: SandboxHandlerOutput<`extensions`, `remove`> = { ok: true, connections: [] };
    if (plan.rebuildNeeded) {
        removed.rebuildNeeded = true;
    }
    return removed;
};
