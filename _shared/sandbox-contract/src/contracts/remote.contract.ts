import { procedure } from "../protocol/route-meta.js";
import { OkSchema } from "../schemas/shared.js";
import {
    RemoteDeviceInputSchema,
    RemoteOpenScreenInputSchema,
    RemoteOpenTerminalInputSchema,
    RemoteScreenSchema,
    RemoteServiceChangeInputSchema,
    RemoteServiceSchema,
    RemoteSessionInputSchema,
    RemoteStatusSchema,
    RemoteTerminalOpenedSchema,
    RemoteTokenSchema,
} from "../schemas/remote-access.js";

// A person's remote screen and terminals on one of the owner's connected computers (schemas/remote-access.ts). Each
// answer is a socket's path and the token it opens with; the socket itself is netd's to carry and the computer's
// remoted to answer. Withheld from the panel and control tokens: a person opens these, never a program.
const remoteRoute = procedure.meta({ panel: false, control: "never" });

// Watching, which a member below Full access may do, read-only: floored at viewer, the handler deciding how far.
const watchRoute = procedure.meta({ panel: false, control: "never", floor: "viewer" });

export const remoteContract = {
    status: watchRoute
        .route({
            method: "GET",
            path: "/system/devices/{device}/remote",
            summary: "Whether a remote screen or terminal can be opened on a device",
            description:
                "What the device's switches allow, its monitors and terminal environments, and the terminals open there now. Starts nothing: a device whose remote access has not run since it connected names no monitors yet.",
        })
        .input(RemoteDeviceInputSchema)
        .output(RemoteStatusSchema),
    openScreen: watchRoute
        .route({
            method: "POST",
            path: "/system/devices/{device}/remote/screen",
            summary: "Open a device's screen",
            description:
                "Starts the device's remote access if it is not running and answers where its media socket opens, with a token. Read-only unless the caller has Full access and the device allows control. Recorded in the audit log.",
        })
        .input(RemoteOpenScreenInputSchema)
        .output(RemoteScreenSchema),
    openTerminal: remoteRoute
        .route({
            method: "POST",
            path: "/system/devices/{device}/remote/terminals",
            summary: "Open a terminal on a device",
            description:
                "Starts the device's remote access if it is not running, opens a new terminal there and answers where its socket opens, with a token. Full access only, and only where the device allows terminals. Recorded in the audit log.",
        })
        .input(RemoteOpenTerminalInputSchema)
        .output(RemoteTerminalOpenedSchema),
    attachTerminal: remoteRoute
        .route({
            method: "POST",
            path: "/system/devices/{device}/remote/terminals/{session}/attach",
            summary: "Attach to a terminal open on a device",
            description: "A fresh token for a terminal the device still holds. Not found once the terminal or the device's remote access has ended.",
        })
        .input(RemoteSessionInputSchema)
        .output(RemoteTerminalOpenedSchema),
    refresh: watchRoute
        .route({
            method: "POST",
            path: "/system/devices/{device}/remote/sessions/{session}/token",
            summary: "A fresher token for an open screen or terminal",
            description: "For the open socket's `token` message, before the one it holds lapses. Read-only as the caller's first token was.",
        })
        .input(RemoteSessionInputSchema)
        .output(RemoteTokenSchema),
    closeTerminal: remoteRoute
        .route({
            method: "DELETE",
            path: "/system/devices/{device}/remote/terminals/{session}",
            summary: "Close a terminal on a device",
            description: "Ends the terminal and every socket attached to it. Recorded in the audit log.",
        })
        .input(RemoteSessionInputSchema)
        .output(OkSchema),
    // Windows' lock screen and administrator prompts (schemas/device-remote.ts): read by anyone who can see the device,
    // changed only with Full access.
    service: watchRoute
        .route({
            method: "GET",
            path: "/system/devices/{device}/remote/service",
            summary: "Whether a Windows computer's lock screen and administrator prompts can be reached remotely",
            description:
                "Whether remote access's own Windows service is installed on the computer, its state and version, and whether it is older than the computer's agent. Without it a remote screen cannot show or use the sign-in and lock screen, Ctrl+Alt+Del or administrator prompts. Changes nothing.",
        })
        .input(RemoteDeviceInputSchema)
        .output(RemoteServiceSchema),
    changeService: remoteRoute
        .route({
            method: "POST",
            path: "/system/devices/{device}/remote/service",
            summary: "Set up, update or remove a Windows computer's lock-screen service",
            description:
                "Installs (or updates) or removes remote access's own Windows service on the computer. Windows asks the person at that computer for an administrator's yes, and this waits for the answer, up to ten minutes; a no comes back as `declined` with nothing changed. Full access only. Recorded in the audit log.",
        })
        .input(RemoteServiceChangeInputSchema)
        .output(RemoteServiceSchema),
};
