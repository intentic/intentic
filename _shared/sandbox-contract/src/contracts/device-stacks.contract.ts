import { procedure } from "../protocol/route-meta.js";
import {
    DeviceHostStatsInputSchema,
    DeviceStackDeployInputSchema,
    DeviceStackDeployResultSchema,
    DeviceStackLogsInputSchema,
    DeviceStackManagedDeployInputSchema,
    DeviceStackManagedDeployResultSchema,
    DeviceStackOpInputSchema,
    DeviceStacksInputSchema,
    DeviceStacksSchema,
    HostStatsSchema,
    StackLogsSchema,
    StackOpResultSchema,
} from "../schemas/device-stacks.js";

// DOCKER COMPOSE STACKS ON A CONNECTED COMPUTER (schemas/device-stacks.ts): what the Deployments board reads and drives
// where no Komodo stands between, and the managed deploy its engine stands on. Part of the system contract
// (system.contract.ts spreads these in), kept in a module of their own as the device boards grow.

// The box itself, as every system route: no control token reaches these whatever the floor.
const systemRoute = procedure.meta({ control: "never" });

export const deviceStackRoutes = {
    deviceStacks: systemRoute
        .route({
            method: "GET",
            path: "/system/devices/{id}/stacks",
            summary: "The Docker compose stacks on one of your devices",
            description:
                "Every Docker compose project on a computer you connected, with each service's container, image and state, and the folder this sandbox deploys stacks into there. Intentic's own sandboxes are marked rather than left out. Needs that computer's \"Run commands\" switch.",
        })
        .meta({ floor: "maintainer", panel: false })
        .input(DeviceStacksInputSchema)
        .output(DeviceStacksSchema),
    // Up, restart, start, stop, or pull-then-up; nothing here removes a stack or a volume.
    deviceStackOp: systemRoute
        .route({
            method: "POST",
            path: "/system/devices/{id}/stacks/{name}/ops/{op}",
            summary: "Start, stop, restart or update a stack on one of your devices",
            description:
                "Runs `docker compose` for one stack on a computer you connected: `up` applies its files, `pull` fetches newer images and then applies, and `restart`, `start` and `stop` do what they say. Nothing here removes a stack or its volumes. Needs that computer's \"Run commands\" switch.",
        })
        .meta({ panel: false })
        .input(DeviceStackOpInputSchema)
        .output(StackOpResultSchema),
    // Floored like the actions, though it only reads: a log can hold anything the service printed.
    deviceStackLogs: systemRoute
        .route({
            method: "GET",
            path: "/system/devices/{id}/stacks/{name}/logs",
            summary: "The recent log of a stack on one of your devices",
            description: "The last lines every service of one compose stack printed, oldest first, as `docker compose logs` gives them.",
        })
        .meta({ floor: "maintainer", panel: false })
        .input(DeviceStackLogsInputSchema)
        .output(StackLogsSchema),
    // The repository's committed tree, packed here, carried over the device link and brought up there with `--build`.
    deployDeviceStack: systemRoute
        .route({
            method: "POST",
            path: "/system/devices/{id}/stacks/{name}/deploy",
            summary: "Deploy a workspace repository to one of your devices",
            description:
                "Packs the committed tree (HEAD) of a workspace repository, carries it to a computer you connected and runs it there as a Docker compose stack of the given name, building its images on that computer. Uncommitted changes are not deployed. A `.env` already in the stack's folder there is kept: secrets are placed into it by an agent, never sent with a deploy. Needs that computer's \"Run commands\" and \"Run programs this sandbox sends\" switches.",
        })
        .meta({ panel: false })
        .input(DeviceStackDeployInputSchema)
        .output(DeviceStackDeployResultSchema),
    // (2026-11-25) A MANAGED deploy (schemas/device-stacks.ts): the Deployments extension's engine sends the stack's
    // definition with `{{secret:…}}` references, and the daemon fills them under the stack's grant (stack-grants.ts),
    // packs the repository at the commit and relays the machine's deploy. The one door through which a secret's value
    // reaches a server unattended; no value comes back.
    deployManagedDeviceStack: systemRoute
        .route({
            method: "POST",
            path: "/system/devices/{id}/stacks/{name}/deploy-managed",
            summary: "Deploy a managed stack to one of your devices",
            description:
                "Deploys a workspace repository at a commit to a computer you connected as a Docker compose stack, writing its `.env` and registry logins there with the secret values the stack was granted, and waits for it to come up healthy. Refused, naming the secrets, when the stack's grant does not cover one it reads. Needs that computer's \"Run commands\" and \"Run programs this sandbox sends\" switches and an agent that manages stacks.",
        })
        .meta({ floor: "maintainer", panel: false })
        .input(DeviceStackManagedDeployInputSchema)
        .output(DeviceStackManagedDeployResultSchema),
    // Disk, memory and load of a connected computer, for the Deployments monitor's alerts.
    deviceHostStats: systemRoute
        .route({
            method: "GET",
            path: "/system/devices/{id}/host-stats",
            summary: "Disk, memory and load on one of your devices",
            description: "Free space under Docker's data root and the stacks folder, available memory, load and CPU count. Needs that computer's \"Run commands\" switch.",
        })
        .meta({ floor: "maintainer", panel: false })
        .input(DeviceHostStatsInputSchema)
        .output(HostStatsSchema),
};
