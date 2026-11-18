import type { Role } from "@intentic/sandbox-contract/schemas/roles";
import type { Area } from "@intentic/sandbox-contract/schemas/areas";
import type { Automation } from "@intentic/sandbox-contract/schemas/automations";
import { type Member, type MembersStore, memberRow } from "../auth/auth.js";
import type { AutomationRecord } from "../automations/automations-store.js";
import type { RolesStore } from "../roles/roles-store.js";
import type { AreasStore } from "../areas/areas-store.js";
import type { SshKeyStore } from "../capabilities/ssh-key-store.js";
import type { AccessProfile, AccessProfileEntry } from "@intentic/sandbox-contract/schemas/access-profiles";
import type { Service } from "@intentic/sandbox-contract/schemas/services";
import type { AccessProfiles } from "../auth/principals/access-profiles-store.js";
import type { ServicesStore } from "../auth/principals/services-store.js";

// In-memory stores, one real implementation per persistence seam the routes and the turn read, so a suite can seed
// state and read back what a route wrote without touching the filesystem. A store a slice holds lives beside that
// slice's fake instead (`<slice>.testing.ts`); these are the rest.

// An in-memory roles store, the sandbox's named roles, without the fs.
export const memoryRolesStore = (initial: Role[] = []): RolesStore => {
    let roles = [...initial];
    return {
        list: async () => roles,
        get: async (id) => roles.find((role) => role.id === id),
        upsert: async (role) => {
            roles = [...roles.filter((existing) => existing.id !== role.id), role];
        },
        remove: async (id) => {
            const next = roles.filter((role) => role.id !== id);
            const existed = next.length !== roles.length;
            roles = next;
            return existed;
        },
    };
};

// In-memory services (access/services-store.ts): who unattended work runs as.
export const memoryServicesStore = (initial: Service[] = []): ServicesStore => {
    let services = [...initial];
    return {
        list: async () => services,
        get: async (id) => services.find((service) => service.id === id),
        upsert: async (service) => {
            services = [...services.filter((existing) => existing.id !== service.id), service];
        },
        remove: async (id) => {
            const next = services.filter((service) => service.id !== id);
            const existed = next.length !== services.length;
            services = next;
            return existed;
        },
    };
};

// In-memory access profiles (access/access-profiles-store.ts): the sandbox's own, then `org` ones an organisation's
// policy would bring, which read as read-only and hide a local one with their id.
export const memoryAccessProfiles = (initial: AccessProfile[] = [], org: AccessProfile[] = []): AccessProfiles => {
    let own = [...initial];
    const list = async (): Promise<AccessProfileEntry[]> => {
        const held = new Set(org.map((profile) => profile.id));
        return [
            ...own.filter((profile) => !held.has(profile.id)).map((profile): AccessProfileEntry => ({ ...profile, origin: "sandbox" })),
            ...org.map((profile): AccessProfileEntry => ({ ...profile, origin: "org" })),
        ];
    };
    return {
        list,
        get: async (id) => (await list()).find((profile) => profile.id === id),
        upsert: async (profile) => {
            own = [...own.filter((existing) => existing.id !== profile.id), profile];
        },
        remove: async (id) => {
            const next = own.filter((profile) => profile.id !== id);
            const existed = next.length !== own.length;
            own = next;
            return existed;
        },
    };
};

// An in-memory area manifest. Empty by default, which is the unfenced workspace: every member row is written without
// areas, so every caller reaches the whole tree exactly as before areas existed.
export const memoryAreasStore = (initial: Area[] = []): AreasStore => {
    let areas = [...initial];
    return {
        list: async () => areas,
        get: async (id) => areas.find((area) => area.id === id),
        upsert: async (area) => {
            areas = [...areas.filter((existing) => existing.id !== area.id), area];
        },
        remove: async (id) => {
            const next = areas.filter((area) => area.id !== id);
            const existed = next.length !== areas.length;
            areas = next;
            return existed;
        },
    };
};

// An in-memory roster, the identities allowed besides the owner and what each was granted, without the fs.
export const memoryMembersStore = (initial: Member[] = []): MembersStore => {
    let members = [...initial];
    return {
        list: async () => members,
        add: async (email, grant) => {
            members = [...members.filter((member) => member.email !== email), memberRow(email, grant)];
        },
        remove: async (email) => {
            members = members.filter((member) => member.email !== email);
        },
    };
};

/* One automation as the store is handed it, every required field answered, so a case names only what it is about. */
export const automationConfig = (id: string, extra: Partial<Automation> = {}): Automation => ({
    id,
    trigger: { kind: "schedule", cron: "* * * * *" },
    prompt: `wake:${id}`,
    models: [{ provider: "claude", model: "claude-sonnet-4-6" }],
    enabled: true,
    ...extra,
});

// The same automation as the store hands it BACK: with its run history, empty until something fires it.
export const automationRecord = (id: string, extra: Partial<AutomationRecord> = {}): AutomationRecord => ({
    ...automationConfig(id),
    runs: [],
    ...extra,
});


// An in-memory ssh key store: the route suites' sandbox holds whatever keys a test files, and none to begin with.
export const memorySshKeyStore = (initial: Record<string, string> = {}): SshKeyStore => {
    const keys = new Map(Object.entries(initial));
    return {
        dir: "/nonexistent/ssh-keys",
        pathOf: (alias) => `/nonexistent/ssh-keys/${alias}`,
        put: async (alias, privateKey) => {
            keys.set(alias, privateKey);
        },
        get: async (alias) => keys.get(alias),
        has: async (alias) => keys.has(alias),
        remove: async (alias) => {
            keys.delete(alias);
        },
        aliases: async () => [...keys.keys()].toSorted(),
    };
};
