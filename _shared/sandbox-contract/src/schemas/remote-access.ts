import { z } from "zod";
import { type RemoteServiceResult, RemoteServiceResultSchema } from "./device-remote.js";

// A PERSON'S REMOTE SCREEN AND TERMINALS ON A CONNECTED COMPUTER (2026-11-20), the editor's `remote.*` procedures. The
// computer's `intentic-remoted` serves both; it dials the sandbox's netd (browser-wire's DEVICE_UPLINK_PATH), and netd
// carries each viewer's socket down that uplink, so neither a picture nor a keystroke crosses the daemon. The daemon
// decides who may, starts remoted through the machine agent on the first open, and mints the token each socket opens
// with, castd's format with `s` naming `media/<session>` or `terminal/<session>`. A screen's socket speaks the media
// socket's protocol and a terminal's the sandbox terminal's, at the `path` handed back with `?token=<token>` after it.

// `[A-Za-z0-9_-]{1,64}`: what netd lets through as a device's or a session's name on the viewer's path.
const SessionNameSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "letters, digits, dash and underscore, at most 64");

// Which computer: the connection key the device list addresses it by (`rog`, `rog::wsl:archlinux`).
const DeviceKeySchema = z.string().min(1).max(200).describe("The device's connection, as the device list names it: `rog`, or `rog::wsl:archlinux`.");

export const RemoteDeviceInputSchema = z.object({ device: DeviceKeySchema });

// Which of the computer's switches allow what, as the computer itself says (or its card, before remoted has run).
export const RemoteAccessAllowSchema = z.object({
    // Watch the screen.
    view: z.boolean(),
    // Drive the pointer and keys.
    control: z.boolean(),
    // Open terminals.
    terminal: z.boolean(),
});
export type RemoteAccessAllow = z.infer<typeof RemoteAccessAllowSchema>;

// One monitor of the computer, in its own desktop's pixels.
export const RemoteAccessMonitorSchema = z.object({
    id: z.string(),
    name: z.string(),
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    scale: z.number(),
    primary: z.boolean(),
});
export type RemoteAccessMonitor = z.infer<typeof RemoteAccessMonitorSchema>;

// One terminal remoted holds, which any entitled viewer can attach to again while remoted runs.
export const RemoteTerminalSchema = z.object({
    session: z.string(),
    title: z.string(),
    // The environment it runs in (`native`, `wsl:archlinux`).
    environment: z.string(),
    // When it was opened, in ms since the epoch.
    createdAt: z.number(),
    // Sockets attached to it now.
    viewers: z.number(),
});
export type RemoteTerminal = z.infer<typeof RemoteTerminalSchema>;

export const RemoteStatusSchema = z.object({
    // Whether a screen or a terminal can be opened now; `reason` says why not, in words for the person.
    available: z.boolean(),
    reason: z.string().optional(),
    allow: RemoteAccessAllowSchema,
    // Empty until remoted has run once since the device connected.
    monitors: z.array(RemoteAccessMonitorSchema),
    // Why a computer that would show its screen here has none to show (no display and nothing to start a virtual desktop
    // with, a Wayland session without PipeWire), in remoted's words naming what to install. Only while monitors is empty.
    screenReason: z.string().optional(),
    // The environments a terminal can open in.
    environments: z.array(z.string()),
    terminals: z.array(RemoteTerminalSchema),
});
export type RemoteStatus = z.infer<typeof RemoteStatusSchema>;

// A STUN (or TURN) server both ends of a screen's peer connection use, as RTCPeerConnection takes it.
export const RemoteIceServerSchema = z.object({
    urls: z.array(z.string().min(1)).min(1),
    username: z.string().optional(),
    credential: z.string().optional(),
});
export type RemoteIceServer = z.infer<typeof RemoteIceServerSchema>;

// Cloudflare's public STUN: reflexive candidates for a direct path when the network allows one.
export const DEFAULT_REMOTE_ICE_SERVERS: readonly RemoteIceServer[] = [{ urls: ["stun:stun.cloudflare.com:3478"] }];

// The sandbox setting (`remoteIceServers`, settings.ts) naming the servers both ends of a screen's peer connection gather
// candidates from: the editor's and the computer's remoted. An empty list leaves only host candidates, a direct path only
// where the two share a network.
export const remoteIceServersSetting = z
    .array(RemoteIceServerSchema)
    .max(8)
    .default(() => DEFAULT_REMOTE_ICE_SERVERS.map((server) => ({ ...server, urls: [...server.urls] })))
    .describe(
        "The STUN servers a remote screen on one of your computers uses to find a direct path between your browser and that computer, as RTCPeerConnection takes them (`urls`, and `username` and `credential` for a TURN server). Cloudflare's public STUN by default. Empty finds a direct path only when both are on the same network; otherwise the picture goes through the sandbox.",
    );

export const RemoteOpenScreenInputSchema = RemoteDeviceInputSchema.extend({
    // A monitor's id from `status`; absent, the primary one.
    monitor: z.string().max(64).optional(),
});

// A socket's token: what it opens with (`?token=`), and when it stops opening anything, in ms since the epoch. An open
// socket outlives it by the media grace; `refresh` hands a fresher one for the socket's `{type: "token"}` message.
export const RemoteTokenSchema = z.object({ token: z.string(), expiresAt: z.number() });
export type RemoteToken = z.infer<typeof RemoteTokenSchema>;

export const RemoteScreenSchema = RemoteTokenSchema.extend({
    // `screen-<monitor id>`.
    session: z.string(),
    // Where the media socket opens on the sandbox's address: `/system/device-media/<device>/<session>`.
    path: z.string(),
    // A viewer who may watch and not drive: remoted ignores its input.
    readOnly: z.boolean(),
    iceServers: z.array(RemoteIceServerSchema),
});
export type RemoteScreen = z.infer<typeof RemoteScreenSchema>;

export const RemoteOpenTerminalInputSchema = RemoteDeviceInputSchema.extend({
    // `native` or a distro (`wsl:archlinux`) from `status`; absent, remoted's own.
    environment: z.string().max(200).optional(),
    shell: z.string().max(400).optional(),
    cwd: z.string().max(4000).optional(),
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
});
export type RemoteOpenTerminalInput = z.infer<typeof RemoteOpenTerminalInputSchema>;

export const RemoteSessionInputSchema = RemoteDeviceInputSchema.extend({ session: SessionNameSchema });

export const RemoteTerminalOpenedSchema = RemoteTokenSchema.extend({
    // `t-<random>`.
    session: z.string(),
    // Where the terminal socket opens on the sandbox's address: `/system/device-terminal/<device>/<session>`.
    path: z.string(),
});
export type RemoteTerminalOpened = z.infer<typeof RemoteTerminalOpenedSchema>;

// Windows' lock screen and administrator prompts (schemas/device-remote.ts has what the service is): the computer's own
// answer, passed on as it came. `remote.service` reads it; `remote.changeService` installs (or updates) or removes it
// through one UAC prompt on that computer, and answers the status read after it, with `declined` or `error` saying why
// nothing changed.
export const RemoteServiceSchema = RemoteServiceResultSchema;
export type RemoteService = RemoteServiceResult;

export const RemoteServiceChangeInputSchema = RemoteDeviceInputSchema.extend({ action: z.enum(["install", "uninstall"]) });
export type RemoteServiceChangeInput = z.infer<typeof RemoteServiceChangeInputSchema>;
