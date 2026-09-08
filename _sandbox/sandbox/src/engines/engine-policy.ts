import { type EngineChannel, EngineChannelSchema, type EngineId, ENGINE_IDS } from "@intentic/sandbox-contract";
import { z } from "zod";
import { opt } from "../agent/run/opt.js";
import { jsonFile } from "../store/json-file.js";
import { statePath } from "../workspace/layout/state-paths.js";

// The owner's standing channel choice per engine, one file in the workspace's config slice: a decision about the work,
// not the machine, so it travels with the workspace (portability `carry`) while the binaries stay behind. Default is `{
// kind: "blessed" }` and is never written down, so no file means every engine tracks blessed and deleting it is a full
// reset.

// Same shape as the blessed list; an unknown engine key from a newer build is dropped, not the file rejected.
const EnginePolicyFileSchema = z.object({ engines: z.record(z.string(), EngineChannelSchema).optional() });

interface EnginePolicyFile {
    readonly engines: Partial<Record<EngineId, EngineChannel>>;
}

const isEngineId = (id: string): id is EngineId => (ENGINE_IDS as readonly string[]).includes(id);

export const DEFAULT_CHANNEL: EngineChannel = { kind: "blessed" };

const policyFile = (root: string) =>
    jsonFile<EnginePolicyFile>(statePath(root, ".intentic/config/engines.json"), {
        parse: (raw) => {
            const parsed = EnginePolicyFileSchema.safeParse(raw).data;
            return parsed === undefined ? undefined : { engines: Object.fromEntries(Object.entries(parsed.engines ?? {}).filter(([id]) => isEngineId(id))) };
        },
        fallback: () => ({ engines: {} }),
    });

export const readEngineChannels = async (root: string): Promise<Partial<Record<EngineId, EngineChannel>>> => (await policyFile(root).read()).engines;

export const engineChannel = async (root: string, id: EngineId): Promise<EngineChannel> => (await readEngineChannels(root))[id] ?? DEFAULT_CHANNEL;

// A `pinned` channel with no version is refused, not stored; it would read as "pin to nothing" and force the resolver
// to invent a meaning for it.
export const setEngineChannel = async (root: string, id: EngineId, channel: EngineChannel): Promise<EngineChannel> => {
    if (channel.kind === "pinned" && (channel.version === undefined || channel.version === "")) {
        throw new Error("pinning an engine needs the version to pin it to");
    }
    const stored: EngineChannel = { kind: channel.kind, ...opt("version", channel.kind === "pinned" ? channel.version : undefined) };
    await policyFile(root).update((current) => ({ engines: { ...current.engines, [id]: stored } }));
    return stored;
};
