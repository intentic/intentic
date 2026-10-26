import { type AccessProfile, type AccessProfileEntry, AccessProfileSchema } from "@intentic/sandbox-contract/schemas/access-profiles";
import type { OrgPolicy } from "@intentic/sandbox-contract/schemas/organisation";
import { defineDocument } from "../../store/evolution/documents.js";
import { openIdList } from "../../store/open-document.js";

// THE ACCESS PROFILES (docs/architecture/access.md): the sandbox's own, on the history volume beside the roster, and a
// bound sandbox's organisation's, which arrive with its policy and are read-only here.
// Off the workspace, unlike areas: a profile bounds unattended runs as well as people, and a run that could edit the file
// bounding it would be held to nothing. The roster left the workspace on 2026-10-06 for the same reason.

export const accessProfilesDocument = defineDocument({
    root: "history",
    path: "identity/access-profiles.json",
    // A profile names this sandbox's areas, connections and accounts, and decides what its people may reach: the
    // target's own to decide, like its roster.
    portability: "identity",
    note: "Write the access profiles again on the target's Access page; services and roster rows pointing at them reach nothing until then.",
    schema: AccessProfileSchema,
    granularity: "entries",
});

export interface AccessProfiles {
    // The sandbox's own, then the organisation's; an organisation's profile hides a local one with its id.
    readonly list: () => Promise<AccessProfileEntry[]>;
    readonly get: (id: string) => Promise<AccessProfileEntry | undefined>;
    // The sandbox's own only: an organisation's profile is never written here.
    readonly upsert: (profile: AccessProfile) => Promise<void>;
    readonly remove: (id: string) => Promise<boolean>;
}

export interface AccessProfilesDeps {
    readonly path: string;
    readonly orgPolicy?: { readonly current: () => Promise<OrgPolicy | undefined> } | undefined;
    // An entry that does not parse is left out (and reported), so a holder of it reaches nothing until it is fixed.
    readonly onInvalid?: (id: string, reason: string) => void;
}

export const fileAccessProfiles = (deps: AccessProfilesDeps): AccessProfiles => {
    const local = openIdList(accessProfilesDocument, deps.path, deps.onInvalid);
    const list = async (): Promise<AccessProfileEntry[]> => {
        const [own, policy] = await Promise.all([local.list(), deps.orgPolicy?.current()]);
        const org = (policy?.profiles ?? []).map((profile): AccessProfileEntry => ({ ...profile, origin: "org" }));
        const held = new Set(org.map((profile) => profile.id));
        return [...own.filter((profile) => !held.has(profile.id)).map((profile): AccessProfileEntry => ({ ...profile, origin: "sandbox" })), ...org];
    };
    return {
        list,
        get: async (id) => (await list()).find((profile) => profile.id === id),
        upsert: (profile) => local.upsert(profile),
        remove: (id) => local.remove(id),
    };
};
