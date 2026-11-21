import { z } from "zod";
import { OkSchema } from "./shared.js";

/* PEOPLE'S REMOTE DESKTOP AND TERMINALS ON A CONNECTED COMPUTER (2026-11-20). A person in the editor (never an agent) sees
   the screen, drives the mouse and keyboard, or opens a terminal on one of the owner's computers. One daemon per
   environment there, intentic-remoted, serves them: it dials this sandbox's `/system/device-uplink` and carries the
   terminals and the view over that uplink. The machine agent starts it only while it is wanted, through the two device
   procedures below, which the daemon alone calls (never a tool), and only on an agent advertising `remote`. What a person
   may do is the computer's own three switches (`remoteView`, `remoteControl`, `remoteTerminal` in DeviceScopesSchema),
   read on the machine from the link's grant, and the person at the computer can pause input or end every session. */

// What `remoteStart` hands the machine: the device's name on this sandbox, the token remoted presents when it dials the
// uplink, and the key the view's frames are sealed with (base64url of 32 bytes, unpadded). Both secrets are the daemon's
// to mint and rotate; the machine only passes them to remoted and never logs them.
// `iceServers` (2026-11-20) are the `remoteIceServers` setting's URLs (`stun:host:port`), which remoted asks for its
// server-reflexive address so a screen's peer connection can find a direct path from outside the computer's network.
// Sent only to an agent advertising `remote-ice` (this schema is strict, so an older agent would refuse the call);
// absent, remoted offers its host candidates alone.
export const RemoteStartInputSchema = z
    .object({
        device: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "a device name: letters, digits, `_` and `-`, at most 64"),
        uplinkToken: z.string().min(1),
        mediaKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "base64url of 32 bytes, unpadded"),
        iceServers: z.array(z.string().min(1).max(512)).max(32).optional(),
    })
    .strict();
export type RemoteStartInput = z.infer<typeof RemoteStartInputSchema>;

// One monitor of the computer as remoted reports it: its place on the desktop in pixels, and its scale factor.
export const RemoteMonitorSchema = z
    .object({
        id: z.string(),
        name: z.string(),
        x: z.int(),
        y: z.int(),
        width: z.int(),
        height: z.int(),
        scale: z.number(),
        primary: z.boolean(),
    })
    .strict();
export type RemoteMonitor = z.infer<typeof RemoteMonitorSchema>;

// What people may do over this link's uplink, read from the link's three switches.
export const RemoteAllowSchema = z
    .object({
        view: z.boolean(),
        control: z.boolean(),
        terminal: z.boolean(),
    })
    .strict();
export type RemoteAllow = z.infer<typeof RemoteAllowSchema>;

// The answer once remoted's uplink to this sandbox is up: remoted's version, what is allowed, the monitors a view can
// show, and the environments a terminal can open in (`native`, `wsl:<distro>`).
export const RemoteStartResultSchema = z
    .object({
        version: z.string(),
        allow: RemoteAllowSchema,
        monitors: z.array(RemoteMonitorSchema),
        environments: z.array(z.string()),
    })
    .strict();
export type RemoteStartResult = z.infer<typeof RemoteStartResultSchema>;

// `remoteStop` takes nothing and answers the plain acknowledgement: this link's uplink is gone.
export const RemoteStopResultSchema = OkSchema;
export type RemoteStopResult = z.infer<typeof RemoteStopResultSchema>;

/* THE LOCK SCREEN AND ADMINISTRATOR PROMPTS, ON WINDOWS (2026-11-20). A process in the person's session cannot see or
   drive the secure desktop (the sign-in and lock screen, Ctrl+Alt+Del, UAC prompts). intentic-remoted can install a
   Windows service of its own that can, and installing it needs an administrator's yes on that computer, once.
   `remoteService` is how the owner asks for it from the editor: `status` reads it unelevated; `install` (also an update:
   it replaces what is there) and `uninstall` show the person at the computer one UAC prompt, then read the status
   again. Only the daemon calls it, never a tool, and only on an agent advertising `remote-service` (Windows alone);
   an agent anywhere else answers `supported: false` without running anything. */
export const RemoteServiceActionSchema = z.enum(["install", "uninstall", "status"]);
export type RemoteServiceAction = z.infer<typeof RemoteServiceActionSchema>;

export const RemoteServiceInputSchema = z.object({ action: RemoteServiceActionSchema }).strict();
export type RemoteServiceInput = z.infer<typeof RemoteServiceInputSchema>;

// The service's helper in the person's session: which Windows session it runs in, and which desktop it is on now
// (`Default`, `Winlogon`, `Screen-saver`; null when it cannot tell).
export const RemoteServiceHelperSchema = z.object({ session: z.int(), desktop: z.string().nullable() });

// Not strict, unlike the inputs: a newer agent saying more of its service is still read by an older daemon.
export const RemoteServiceResultSchema = z.object({
    // Whether this computer can have the service at all (Windows); `reason` says why not.
    supported: z.boolean(),
    reason: z.string().optional(),
    installed: z.boolean(),
    // The Windows service's state as remoted names it: `running`, `stopped`, `starting`, `stopping`.
    state: z.string().optional(),
    // The installed service's version, and the agent's own remoted's, which an install would put there.
    version: z.string().optional(),
    agentVersion: z.string().optional(),
    // Installed, and at another version than the agent's remoted: an install updates it.
    outOfDate: z.boolean(),
    helper: RemoteServiceHelperSchema.nullable().optional(),
    // The administrator's yes was not given, so nothing changed.
    declined: z.boolean().optional(),
    // What went wrong with an install or uninstall, in a sentence for the person; the fields above are read after it.
    error: z.string().optional(),
});
export type RemoteServiceResult = z.infer<typeof RemoteServiceResultSchema>;
