import { dirname, join } from "node:path";
import { parseJsonWith } from "@intentic/base/json";
import { queueOnFile, readTextIfExists, writeFileAtomic } from "@intentic/base/fs";
import { writeSecretFile } from "@intentic/local-agent";
import type { DeviceScopes } from "@intentic/sandbox-contract/schemas/capabilities";
import { type RemoteAllow, RemoteAllowSchema } from "@intentic/sandbox-contract/schemas/device-remote";
import { z } from "zod";
import { baseDir } from "../../config.js";

/* WHAT THE AGENT AND intentic-remoted SAY TO EACH OTHER THROUGH FILES (2026-11-20). The agent writes `remoted.json`,
   which remoted re-reads within 500 ms of a change: one uplink per link, what each allows, the person's pause, and the
   moment before which every person is dropped. remoted answers with a status line on its stdout whenever anything in it
   changes, which the agent keeps as `remoted-status.json` for `intentic-machine remote status`. Both live beside the
   agent's own state; the config holds the uplinks' secrets, so it is written 0600, whole, by rename. */

export const remotedConfigPath = join(baseDir, "remoted.json");
export const remotedStatusPath = join(baseDir, "remoted-status.json");

// One link's uplink as remoted reads it. `id` is the link's key here (its sandbox URL); `url` is where that sandbox's
// daemon answers, resolved as the link's own socket resolves it (loopback when the sandbox runs on this machine).
// `generation` grows on every remoteStart, which is what makes remoted dial again an uplink the sandbox withdrew.
const UplinkSchema = z.object({
    id: z.string().min(1),
    url: z.string().min(1),
    device: z.string().min(1),
    uplinkToken: z.string().min(1),
    mediaKey: z.string().min(1),
    allow: RemoteAllowSchema,
    generation: z.int().nonnegative(),
});
export type RemotedUplink = z.infer<typeof UplinkSchema>;

// `paused` mirrors the person's pause (device/indicator.ts, the `paused` file): people's input is refused while it holds.
// `notBefore` (ms since the epoch) drops every person connected before it and refuses every token minted before it:
// `intentic-machine remote end`.
const ConfigSchema = z.object({
    paused: z.boolean(),
    notBefore: z.number().nonnegative(),
    uplinks: z.array(UplinkSchema),
});
export type RemotedConfig = z.infer<typeof ConfigSchema>;

export const EMPTY_REMOTED_CONFIG: RemotedConfig = { paused: false, notBefore: 0, uplinks: [] };

// What people may do over a link's uplink: its three switches, read as `on` or not, so a grant cached before the
// switches existed reads as all off. Pure.
export const allowFrom = (scopes: Partial<Pick<DeviceScopes, "remoteView" | "remoteControl" | "remoteTerminal">>): RemoteAllow => ({
    view: scopes.remoteView === "on",
    control: scopes.remoteControl === "on",
    terminal: scopes.remoteTerminal === "on",
});

export const allowsAnything = (allow: RemoteAllow): boolean => allow.view || allow.control || allow.terminal;

const sameAllow = (a: RemoteAllow, b: RemoteAllow): boolean => a.view === b.view && a.control === b.control && a.terminal === b.terminal;

// The config with this uplink in place of any other of its id. Pure.
export const withUplink = (config: RemotedConfig, uplink: RemotedUplink): RemotedConfig => ({
    ...config,
    uplinks: [...config.uplinks.filter((held) => held.id !== uplink.id), uplink],
});

// The config without the uplinks of these ids. Pure.
export const withoutUplinks = (config: RemotedConfig, ids: ReadonlySet<string>): RemotedConfig => ({
    ...config,
    uplinks: config.uplinks.filter((held) => !ids.has(held.id)),
});

// A link's switches applied to its uplink: what it allows rewritten, or the uplink dropped once it allows nothing.
// Answers the same object when nothing changes, so a caller can skip the write. Pure.
export const withAllow = (config: RemotedConfig, id: string, allow: RemoteAllow): RemotedConfig => {
    const held = config.uplinks.find((uplink) => uplink.id === id);
    if (held === undefined || sameAllow(held.allow, allow)) {
        return config;
    }
    return allowsAnything(allow) ? withUplink(config, { ...held, allow }) : withoutUplinks(config, new Set([id]));
};

// A config file this agent cannot read is no config: the next remoteStart writes a whole one.
export const readRemotedConfig = async (path: string = remotedConfigPath): Promise<RemotedConfig | undefined> => {
    const text = await readTextIfExists(path);
    return text === undefined ? undefined : parseJsonWith(text, ConfigSchema);
};

// Read, changed and written back whole under one queue, so the supervisor's writes never interleave; `remote end` from
// another process writes the same way, and the last rename wins. Answers what was written.
export const updateRemotedConfig = async (
    change: (config: RemotedConfig) => RemotedConfig,
    path: string = remotedConfigPath,
): Promise<RemotedConfig> =>
    await queueOnFile(path, async () => {
        const before = (await readRemotedConfig(path)) ?? EMPTY_REMOTED_CONFIG;
        const after = change(before);
        if (after !== before) {
            await writeSecretFile(path, dirname(path), `${JSON.stringify(after, undefined, 2)}\n`);
        }
        return after;
    });

// --- what remoted says ----------------------------------------------------------------------------------------------

// Loose throughout: a newer remoted adds fields and states, and a line that still says what this agent reads is read.
const UplinkStatusSchema = z.looseObject({
    id: z.string(),
    // connecting | up | down (dropped, redialling) | withdrawn (the sandbox closed it, 4003) | refused (401/403)
    state: z.string(),
    // The config's generation this state is of; absent from no remoted that ships, read as unknown.
    generation: z.number().optional(),
    since: z.number(),
    error: z.string().optional(),
});
const PersonSchema = z.looseObject({
    uplink: z.string(),
    // terminal | view | control
    kind: z.string(),
    session: z.string(),
    readOnly: z.boolean().optional(),
    since: z.number(),
});
const MonitorSchema = z.looseObject({
    id: z.string(),
    name: z.string(),
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    scale: z.number(),
    primary: z.boolean(),
});
const StatusSchema = z.looseObject({
    type: z.literal("status"),
    version: z.string(),
    pid: z.number(),
    uplinks: z.array(UplinkStatusSchema),
    people: z.array(PersonSchema),
    terminals: z.number(),
    environments: z.array(z.string()),
    monitors: z.array(MonitorSchema),
});
export type RemotedStatus = z.infer<typeof StatusSchema>;
export type RemotedPerson = RemotedStatus["people"][number];

// One stdout line of remoted's as its status, or undefined for anything else: a line that is not JSON, or another type.
export const parseStatusLine = (line: string): RemotedStatus | undefined => {
    const trimmed = line.trim();
    return trimmed.startsWith("{") ? parseJsonWith(trimmed, StatusSchema) : undefined;
};

// The latest status, for `remote status`. Best-effort: a status that could not be written costs that command its answer.
export const writeRemotedStatus = async (status: RemotedStatus, path: string = remotedStatusPath): Promise<void> => {
    // allow(silent-catch): the file is a courtesy to another process; the supervisor holds the status itself
    await writeFileAtomic(path, `${JSON.stringify(status)}\n`, 0o600).catch(() => undefined);
};

export const readRemotedStatus = async (path: string = remotedStatusPath): Promise<RemotedStatus | undefined> => {
    const text = await readTextIfExists(path);
    return text === undefined ? undefined : parseStatusLine(text);
};
