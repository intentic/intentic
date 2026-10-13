import { type DeviceConfig, HOST_NATIVE_ENVIRONMENT, parseHostConnection } from "@intentic/sandbox-contract";
import { revokeSyncEnrollmentsOf } from "../../peers/desktop-sync.js";
import type { CapabilityCtx } from "../capability.js";
import { HOST_TOOLS_NOTE, hostToolsNote } from "./host-skills.js";
import { peerHandler, type PeerHandlerSpec, refreshPeerSkill } from "./peer.handler.js";

/* A device of the user's OWN, one capability per machine, the id being its name: the peer handler (peers/) over the host door. */
const DEVICE: PeerHandlerSpec<DeviceConfig> = {
    kind: "device",
    noun: "device",
    where: "on that device",
    note: HOST_TOOLS_NOTE,
    // What the machine's native side said of itself at its last connect: on Intentic OS the skill says so too.
    noteFor: (ctx, id) => hostToolsNote(ctx.hostHub.state(id).facts),
    pairHint: "click Connect and run the one-liner on that device",
    awayHint: "the device is offline",
    added: (id) => `Added "${id}". Run the one-time command its entry is offering on that device, the agent can work on it from the next turn.`,
    store: (ctx) => ctx.hosts,
    hub: (ctx) => ctx.hostHub,
    // (2026-10-05) The card's computers sync with this sandbox through a key of their own (peers/desktop-sync.ts), which
    // removing the card left authorized for good. Each OS install the card held is read off its enrollment before the
    // card goes, and that same computer and environment's sync key goes after it.
    // A list that cannot be read costs only this: the card still goes, as it did before, and the keys stay.
    alsoRevoke: async (ctx, card) => {
        const listed = await (async () => await ctx.hosts.list())().catch((err: unknown) => {
            ctx.logger.warn({ err, card }, "device card removal: its enrollments could not be read, so its desktop-sync keys are left as they are");
            return [];
        });
        const installs = listed.filter((held) => held.card === card).map((held) => ({ machineId: held.machineId, environment: held.environment }));
        return async () => {
            const revoked = await revokeSyncEnrollmentsOf(ctx.historyRoot, installs);
            if (revoked > 0) {
                ctx.logger.info({ card, revoked }, "device card removed: its computers' desktop-sync keys were revoked with it");
            }
        };
    },
    // One card holds every OS install on the machine; the enrollment store knows which (each record names its card),
    // so removing or renaming the card takes all of them in one write.
    echo: (host) => ({
        platform: host.platform,
        shell: host.shell,
        write: host.write,
        screen: host.screen,
        control: host.control,
        sandboxes: host.sandboxes,
        destructive: host.destructive,
        programs: host.programs,
        ...(host.roots !== undefined ? { roots: host.roots } : {}),
    }),
};
export const deviceHandler = peerHandler<DeviceConfig>(DEVICE);

/**
 * Brings a device's skill up to date with what its machine said as it connected (`connection` is the connection key):
 * the skill is written when the card is applied, usually before the machine has ever connected, so this is where an
 * Intentic OS box's section arrives. Only the native side speaks for the card; a card never applied is left alone.
 */
export const refreshDeviceSkill = async (ctx: CapabilityCtx, connection: string): Promise<boolean> => {
    const { card, environment } = parseHostConnection(connection);
    if (environment !== HOST_NATIVE_ENVIRONMENT) {
        return false;
    }
    const capability = (await ctx.capabilities.list()).find((entry) => entry.kind === "device" && entry.id === card);
    return capability?.kind === "device" ? await refreshPeerSkill(DEVICE, ctx, card, capability.config) : false;
};
