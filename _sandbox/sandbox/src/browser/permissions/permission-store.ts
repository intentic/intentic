import { z } from "zod";
import type { BrowserPermission, PermissionSetting } from "@intentic/sandbox-contract/schemas/browser-tools";
import { defineDocument } from "../../store/evolution/documents.js";
import { openDocument } from "../../store/open-document.js";
import { stateRelPath, statePath } from "../../state-paths.js";

// What a person decided each site may do in one browser profile: the answers to the asks this browser showed them
// (page-asks.ts) and the switches they flipped in a site's info. Chromium's own record of these lives in the profile's
// content settings, which only its own prompts write; DevTools grants (Browser.setPermission) are overrides that last as
// long as the session that set them. So the decisions are kept here, beside the profile, and set again on Chromium each
// time a window of the profile starts (window-permissions.ts). Only a standing answer is written: "ask" is the absence
// of one.

// Keyed by the permission's name as a string, so a permission a later build answers reads back here too.
const SitePermissionsSchema = z.record(z.string(), z.enum(["allow", "block"]));
const PermissionsFileSchema = z.object({ sites: z.record(z.string(), SitePermissionsSchema) });
type PermissionsFile = z.infer<typeof PermissionsFileSchema>;

export const browserPermissionsDocument = defineDocument({
    path: stateRelPath(".intentic/local/browser/", "<owner>.permissions.json"),
    boot: false,
    schema: PermissionsFileSchema,
});

export const permissionsPath = (root: string, profile: string): string => statePath(root, ".intentic/local/browser/", `${profile}.permissions.json`);

export type SiteDecisions = Readonly<Record<string, Readonly<Record<string, "allow" | "block">>>>;

export interface PermissionStore {
    // Every site with a standing answer, by origin.
    readonly sites: () => Promise<SiteDecisions>;
    readonly settingOf: (origin: string, permission: BrowserPermission) => Promise<PermissionSetting>;
    // "ask" forgets the standing answer.
    readonly set: (origin: string, permission: BrowserPermission, setting: PermissionSetting) => Promise<void>;
}

// The file with one decision changed, a site with none left dropped from it.
export const withDecision = (file: PermissionsFile, origin: string, permission: BrowserPermission, setting: PermissionSetting): PermissionsFile => {
    const kept = Object.entries(file.sites[origin] ?? {}).filter(([name]) => name !== permission);
    const site = Object.fromEntries(setting === "ask" ? kept : [...kept, [permission, setting] as const]);
    const others = Object.entries(file.sites).filter(([name]) => name !== origin);
    return { sites: Object.fromEntries(Object.keys(site).length === 0 ? others : [...others, [origin, site] as const]) };
};

const settingIn = (sites: SiteDecisions, origin: string, permission: BrowserPermission): PermissionSetting => sites[origin]?.[permission] ?? "ask";

/** The store of one profile's decisions, in its file. */
export const filePermissionStore = (path: string): PermissionStore => {
    const file = openDocument(browserPermissionsDocument, path, { fallback: (): PermissionsFile => ({ sites: {} }), mode: 0o600 });
    return {
        sites: async () => (await file.read()).sites,
        settingOf: async (origin, permission) => settingIn((await file.read()).sites, origin, permission),
        set: async (origin, permission, setting) => {
            await file.update((current) => withDecision(current, origin, permission, setting));
        },
    };
};

/** The same, held in memory: for a window whose profile has nowhere to keep it (a test, a daemon not yet configured). */
export const memoryPermissionStore = (): PermissionStore => {
    let current: PermissionsFile = { sites: {} };
    return {
        sites: async () => current.sites,
        settingOf: async (origin, permission) => settingIn(current.sites, origin, permission),
        set: async (origin, permission, setting) => {
            current = withDecision(current, origin, permission, setting);
        },
    };
};
