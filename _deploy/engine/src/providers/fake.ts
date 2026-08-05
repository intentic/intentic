import type { ResourceType } from "@intentic/resources";
import { OUTPUTS } from "@intentic/resources";
import type { Observed, Provider, Providers } from "../provider.js";
import type { ResolvedInputs } from "../types.js";

interface WorldEntry {
    readonly type: ResourceType;
    readonly inputs: ResolvedInputs;
}

// An in-memory stand-in for real infrastructure: id -> what was "created". Sharing one world across a
// run (and across runs) is what proves idempotency — a 2nd apply finds everything and reports noop.
export type FakeWorld = Map<string, WorldEntry>;

// Every kind the resolver stack declares — OUTPUTS is the single authority, so the fake map cannot drift
// from the ResourceType union when a kind is added.
const RESOURCE_TYPES = Object.keys(OUTPUTS) as ResourceType[];

// Deterministic outputs from id + OUTPUTS[type] so every downstream $ref resolves and readiness urls
// are stub-probeable. url-ish names get a fake URL; everything else gets a stable "id::name" token.
const fakeOutputs = (id: string, type: ResourceType): Record<string, unknown> => {
    const outputs: Record<string, unknown> = {};
    for (const name of OUTPUTS[type]) {
        outputs[name] = name.toLowerCase().includes("url") ? `https://${id}.fake.test/${name}` : `${id}::${name}`;
    }
    return outputs;
};

const fakeProvider = (type: ResourceType, world: FakeWorld): Provider => ({
    read: async (_inputs, ctx) => {
        if (!world.has(ctx.id)) {
            return undefined;
        }
        return { outputs: fakeOutputs(ctx.id, type) } satisfies Observed;
    },
    diff: () => ({ action: "noop" }),
    apply: async (inputs, _observed, ctx) => {
        world.set(ctx.id, { type, inputs });
        return fakeOutputs(ctx.id, type);
    },
    list: async () => [...world].filter(([, entry]) => entry.type === type).map(([id, entry]) => ({ id, inputs: entry.inputs })),
    delete: async (_inputs, ctx) => {
        world.delete(ctx.id);
    },
});

export const createFakeProviders = (world: FakeWorld = new Map()): { readonly providers: Providers; readonly world: FakeWorld } => {
    const providers: Providers = {};
    for (const type of RESOURCE_TYPES) {
        providers[type] = fakeProvider(type, world);
    }
    return { providers, world };
};
