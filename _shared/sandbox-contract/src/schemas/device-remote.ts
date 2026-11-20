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
export const RemoteStartInputSchema = z
    .object({
        device: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "a device name: letters, digits, `_` and `-`, at most 64"),
        uplinkToken: z.string().min(1),
        mediaKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "base64url of 32 bytes, unpadded"),
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
