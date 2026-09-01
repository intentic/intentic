import { type EngineChannel, EngineChannelSchema, type EngineId, ENGINE_IDS } from "@intentic/sandbox-contract";
import { z } from "zod";
import { opt } from "../agent/opt.js";
import { jsonFile } from "../store/json-file.js";
import { statePath } from "../workspace/state-paths.js";

/* THE OWNER'S STANDING ANSWER per engine, one small file in the workspace's config slice.
 *
 * WHY THE WORKSPACE AND NOT THE VOLUME, when the versions themselves are machine state: the policy is a
 * decision about the work, not about the box. "Pin Claude Code to 2.1.240 until the regression closes" and
 * "this repo tracks upstream's newest" are things a team decides once and should not have to rediscover on a
 * fresh sandbox, so the file travels (portability `carry` in the contract's WORKSPACE_STATE_FILES) while the
 * 300 MB binaries it selects stay behind, where they belong.
 *
 * THE DEFAULT IS BLESSED AND IT IS NOT WRITTEN DOWN. An engine with no entry reads as `{ kind: "blessed" }`,
 * so a workspace that has never opened the card has no file at all, and deleting the file is a full reset. */

/* The file is `{ "engines": { "<id>": { "kind": … } } }`, the same shape as the blessed list it answers, so a
 * reader who opens one recognises the other. Keys are read as plain strings and then narrowed to the engines
 * this build knows, so a file written by a NEWER build (naming an engine that does not exist here yet) is READ
 * rather than rejected whole: the unknown entry is dropped, the known ones still apply, and json-file's
 * downgrade guard keeps the original bytes for the build that wrote them. */
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

/* Write one engine's channel. A `pinned` channel without a version is refused rather than stored: it would
 * read as "pin to nothing", and the resolver would have to invent a meaning for it — most likely the blessed
 * version, which is the one thing the owner has just said they do not want. */
export const setEngineChannel = async (root: string, id: EngineId, channel: EngineChannel): Promise<EngineChannel> => {
    if (channel.kind === "pinned" && (channel.version === undefined || channel.version === "")) {
        throw new Error("pinning an engine needs the version to pin it to");
    }
    const stored: EngineChannel = { kind: channel.kind, ...opt("version", channel.kind === "pinned" ? channel.version : undefined) };
    await policyFile(root).update((current) => ({ engines: { ...current.engines, [id]: stored } }));
    return stored;
};
