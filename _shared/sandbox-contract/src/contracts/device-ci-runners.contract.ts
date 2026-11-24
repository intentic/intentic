import { procedure } from "../protocol/route-meta.js";
import {
    CiFleetSchema,
    CiRunnerLogsSchema,
    CiRunnerOpResultSchema,
    DeviceCiFleetInputSchema,
    DeviceCiRunnerLogsInputSchema,
    DeviceCiRunnerOpInputSchema,
    DeviceCiRunnerRegisterInputSchema,
    DeviceCiRunnerRemoveInputSchema,
} from "../schemas/ci-fleet.js";

// THE SELF-HOSTED CI RUNNERS ON A CONNECTED COMPUTER (schemas/ci-fleet.ts): what the Pipelines view's Runners section
// reads and drives. Relayed to the machine's own tools, which check its switches and ask its root fleet service for what
// needs root; the daemon adds GitHub's side, minting the token a registration or a removal takes through the workspace's
// GitHub connection and never keeping it. Part of the system contract (system.contract.ts spreads these in), kept in a
// module of their own as the device boards grow.

// The box itself, as every system route: no control token reaches these whatever the floor.
const systemRoute = procedure.meta({ control: "never" });

export const deviceCiRunnerRoutes = {
    deviceCiFleet: systemRoute
        .route({
            method: "GET",
            path: "/system/devices/{id}/ci-runners",
            summary: "The CI runners on one of your devices",
            description:
                "Every self-hosted GitHub Actions runner on a computer you connected: its systemd unit, whether it is running a job and which, whether it is held down and why, and what it is registered to; with the machine's CI fleet service, its shared caches, the test-memory slots it holds for sandboxes and the last pass of its keeper, janitor and prune. Without the fleet service a computer still lists its runners. Needs that computer's \"Run commands\" switch.",
        })
        .meta({ floor: "maintainer", panel: false })
        .input(DeviceCiFleetInputSchema)
        .output(CiFleetSchema),
    // Start, stop, drain, or restart (a drain, then a start); a runner stopped here is held down until a start.
    deviceCiRunnerOp: systemRoute
        .route({
            method: "POST",
            path: "/system/devices/{id}/ci-runners/{name}/ops/{op}",
            summary: "Start, stop, drain or restart a CI runner on one of your devices",
            description:
                "Drives one runner's systemd unit on a computer you connected: `start` and `stop` act now, and `stop` refuses a runner that is running a job; `drain` stops it the moment its job ends, and `restart` drains it and starts it again. A runner stopped from here stays down until it is started from here: the machine's keeper leaves it. Needs that computer's \"Run commands\" switch.",
        })
        .meta({ panel: false })
        .input(DeviceCiRunnerOpInputSchema)
        .output(CiRunnerOpResultSchema),
    // Floored like the actions, though it only reads: a runner's log names the jobs it ran and what they printed.
    deviceCiRunnerLogs: systemRoute
        .route({
            method: "GET",
            path: "/system/devices/{id}/ci-runners/{name}/logs",
            summary: "The recent log of a CI runner on one of your devices",
            description: "The last lines one runner's service printed, oldest first.",
        })
        .meta({ floor: "maintainer", panel: false })
        .input(DeviceCiRunnerLogsInputSchema)
        .output(CiRunnerLogsSchema),
    // The token is minted here for the repository's GitHub remote, handed to the machine and dropped.
    registerDeviceCiRunner: systemRoute
        .route({
            method: "POST",
            path: "/system/devices/{id}/ci-runners",
            summary: "Add a CI runner to one of your devices",
            description:
                "Registers a new self-hosted GitHub Actions runner on a computer you connected, for the GitHub repository a workspace repository's remote names, with the given name and labels. The registration token is minted through this sandbox's GitHub connection, which needs admin on that repository, and is never kept. The computer downloads the runner release, checks it, configures it as the account its other runners run as and starts its unit; this takes minutes. Needs that computer's \"Run commands\" switch and its CI fleet service.",
        })
        .meta({ panel: false })
        .input(DeviceCiRunnerRegisterInputSchema)
        .output(CiRunnerOpResultSchema),
    // Read off the runner's own registration first, so its removal token is minted for the repository it serves.
    removeDeviceCiRunner: systemRoute
        .route({
            method: "DELETE",
            path: "/system/devices/{id}/ci-runners/{name}",
            summary: "Remove a CI runner from one of your devices",
            description:
                "Takes a runner off GitHub and off a computer you connected: the runner is unregistered and its service removed, with a removal token minted through this sandbox's GitHub connection for the repository or organisation the runner is registered to, never kept. Refused while the runner is running a job. Needs that computer's \"Run commands\" switch and its CI fleet service.",
        })
        .meta({ panel: false })
        .input(DeviceCiRunnerRemoveInputSchema)
        .output(CiRunnerOpResultSchema),
};
