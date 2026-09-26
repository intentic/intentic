import type { Persona, Area, Automation } from "@intentic/sandbox-contract";
import { type Member, type MembersStore, memberRow } from "../auth/auth.js";
import type { AutomationRecord } from "../automations/automations-store.js";
import type { PersonasStore } from "../personas/personas-store.js";
import type { AreasStore } from "../areas/areas-store.js";

// In-memory stores, one real implementation per persistence seam the routes and the turn read, so a suite can seed
// state and read back what a route wrote without touching the filesystem. A store a slice holds lives beside that
// slice's fake instead (`<slice>.testing.ts`); these are the rest.

// An in-memory personas store, the sandbox's named personas, without the fs.
export const memoryPersonasStore = (initial: Persona[] = []): PersonasStore => {
    let personas = [...initial];
    return {
        list: async () => personas,
        get: async (id) => personas.find((persona) => persona.id === id),
        upsert: async (persona) => {
            personas = [...personas.filter((existing) => existing.id !== persona.id), persona];
        },
        remove: async (id) => {
            const next = personas.filter((persona) => persona.id !== id);
            const existed = next.length !== personas.length;
            personas = next;
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

