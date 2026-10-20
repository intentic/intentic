import { instancesOf } from "@intentic/capability-catalog";
import type { InviteRecord } from "@intentic/api-contract";
import type { CapabilitySummary } from "@intentic/sandbox-contract/schemas/capabilities";
import type { Tone } from "@intentic/ui";
import { allLoaded } from "@intentic/extension-api";
import { useQuery } from "@tanstack/vue-query";
import { computed } from "vue";
import { useAuth } from "../../../client/auth/useAuth";
import { sandboxRaw } from "../../../client/sandbox/sandboxRaw";
import { useMembers } from "../../../client/sandbox/useMembers";
import { useRole } from "../../../client/sandbox/useRole";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { rpcQuery } from "../../../client/sandbox/rpcQuery";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";
import { useInboundLinks } from "../../../models/sandbox/useInboundLinks";
import { CONTROL_TOKENS, SANDBOX_INVITES } from "../../../lib/queryKeys";
import { queryClient } from "../../../lib/queryPersistence";
import { apiClient } from "../../../lib/useApi";
import { type ConnectionSources, connectionRow } from "../../capabilities/model/connectionRows";
import { connectionState } from "../../../models/capabilities/connections";
import { catalogEntries } from "../../../models/capabilities/tiles";
import { useCapabilities } from "../../../models/capabilities/useCapabilities";
import { useSecretInventory } from "../../../models/capabilities/useSecrets";
import { useExtensions } from "../../../models/extensions/useExtensions";
import { usePublicOutbox } from "../../../models/workspace/push/usePublicOutbox";
import { useLiveLinks } from "../../../models/sandbox/devices/useLiveLinks";
import { HOST_DOOR, PHONE_DOOR, usePeerConnect, WEBEXT_DOOR } from "../../../models/sandbox/devices/usePeerConnect";
import { useDevices } from "../../../models/sandbox/devices/useDevices";
import { usePorts } from "../../../models/sandbox/environment/usePorts";
import type { ModelSource, ModelSourceStanding } from "../models/modelSources";
import { usePersonas } from "../../../models/sandbox/personas/usePersonas";
import { buildReachMap, type NodeTone, type ReachCapability, type ReachInput, type ReachModelSource } from "./reachModel";

// EVERY READ THE MAP IS DRAWN FROM, gathered into the one input reachModel.ts works over. Each is a cache entry its own
// page already holds (the capabilities board, Access, Areas, Personas, Secrets, Models, Browsers), so opening the map
// costs the reads nobody made yet and nothing else; the three of its own (tokens, links, invites) are keyed apart from
// the Access tab's lists, which that tab mints into and revokes from.
//
// What the reader may read is what they see: the roster and invites are the owner's, tokens and links a maintainer's, and
// a read the reader is refused is never asked rather than drawn as empty.

const TONES = { success: `success`, warning: `warning`, danger: `danger`, info: `info`, neutral: `neutral`, primary: `info` } as const satisfies Record<Tone, NodeTone>;

// A connection with no tile to draw it is marked by what kind of thing it is, and named by what its card was added as.
const KIND_MARKS = new Map<CapabilitySummary[`kind`], string>([
    [`browser`, `globe`],
    [`identity`, `user`],
    [`device`, `desktop`],
    [`phone`, `mobile`],
    [`webext`, `browsers`],
    [`link`, `link`],
]);
const markOfKind = (kind: CapabilitySummary[`kind`]): string => KIND_MARKS.get(kind) ?? `bolt`;
const addedAs = (instance: CapabilitySummary): string | undefined => {
    const named = String(instance.config[`provider`] ?? instance.config[`platform`] ?? ``);
    return named === `` || named === instance.id ? undefined : named;
};

const STANDING_TONES = { ready: `success`, attention: `warning`, blocked: `danger`, waiting: `neutral` } as const satisfies Record<ModelSourceStanding, NodeTone>;

// The identity a site account was born in; the board's own reading of a config field (tiles.ts capabilityTile).
const identityOf = (instance: CapabilitySummary): string | undefined => {
    const identity = instance.kind === `browser` ? String(instance.config[`identity`] ?? ``) : ``;
    return identity === `` ? undefined : identity;
};

// The capabilities board's own rows, so a connection is named, marked and judged here exactly as it is there. A connection
// whose tile is not loaded (its extension switched off, a kind this build does not know) still stands on the map under
// its own id: it still holds whatever it was connected with, and a map of reach that dropped it would be lying.
const reachCapabilities = (
    capabilities: readonly CapabilitySummary[],
    entries: ReturnType<typeof catalogEntries>,
    sources: ConnectionSources,
): ReachCapability[] =>
    capabilities.map((instance) => {
        const entry = entries.find((candidate) => instancesOf(candidate, [instance]).length > 0);
        if (entry === undefined) {
            const state = connectionState(instance.kind, instance, undefined);
            return {
                id: instance.id,
                kind: instance.kind,
                title: instance.id,
                tile: addedAs(instance),
                icon: markOfKind(instance.kind),
                state: state.label,
                tone: TONES[state.tone],
                identity: identityOf(instance),
            };
        }
        const row = connectionRow({ entry, instances: [instance], connected: 1, recommendation: undefined }, instance, sources);
        return {
            id: instance.id,
            kind: instance.kind,
            title: row.title,
            tile: row.tile,
            logo: row.logo,
            icon: row.icon,
            state: row.state,
            tone: TONES[row.tone],
            identity: identityOf(instance),
        };
    });

// `models` comes from the hub, which already holds them for its Models row: reading them here would tie this section to
// the Models section, and through it back to the hub.
export function useReachMap(models: () => readonly ModelSource[]) {
    const { isOwner, canShip, role } = useRole();
    const { user } = useAuth();
    const { activeSandboxId } = useSandbox();

    // The areas procedure's own cache entry, the one Sandbox ▸ Areas reads and writes.
    const areas = useSandboxQuery({ ...rpcQuery(`areas.list`), select: (answer) => answer.areas });
    const { personas } = usePersonas();
    const { capabilities, loaded: capabilitiesRead } = useCapabilities();
    const { enabled: enabledExtensions } = useExtensions();
    const { inventory } = useSecretInventory();
    const { roster } = useMembers({ enabled: isOwner });
    // The live browser windows, read as the procedure's own cache entry (the one Browsers keeps fresh by push), not through
    // the Browsers feature, which itself reads the sandbox's features: importing it here would close a loop between them.
    const windows = useSandboxQuery({ ...rpcQuery(`system.browsers`), select: (answer) => answer.sessions });
    const { forwarded } = usePorts();
    const { files: outbox } = usePublicOutbox();

    // The live half of a connection's state (a computer online, a tunnel up), read as the capabilities board reads it.
    const hosts = usePeerConnect(HOST_DOOR);
    const browsers = usePeerConnect(WEBEXT_DOOR);
    const phones = usePeerConnect(PHONE_DOOR);
    const { links: vpn } = useLiveLinks(`vpn`);
    const { links: netdisk } = useLiveLinks(`netdisk`);
    const { devices } = useDevices({ poll: false });

    const tokens = useSandboxQuery({
        queryKey: CONTROL_TOKENS.of(),
        queryFn: async () => (await sandboxRaw(`GET /system/control/tokens`)).tokens,
        enabled: canShip,
    });
    const inbound = useInboundLinks(canShip);
    const invites = useQuery(
        {
            queryKey: computed(() => SANDBOX_INVITES.of()),
            queryFn: async (): Promise<InviteRecord[]> => (await apiClient.invite.list({ sandboxId: activeSandboxId.value ?? `` })).members,
            enabled: computed(() => isOwner.value && activeSandboxId.value !== undefined),
        },
        queryClient,
    );

    const input = computed<ReachInput>(() => {
        const sources: ConnectionSources = {
            host: hosts.peerFor,
            browser: browsers.peerFor,
            phone: phones.peerFor,
            vpn: vpn.value,
            netdisk: netdisk.value,
            devices: devices.value,
        };
        const connections = reachCapabilities(capabilities.value, catalogEntries(enabledExtensions.value, capabilities.value), sources);
        const running = (windows.query.data.value ?? []).filter((session) => session.running);
        const known = new Set(capabilities.value.map((capability) => capability.id));
        const records = invites.data.value ?? [];
        const email = user.value?.email;
        return {
            areas: areas.query.data.value ?? [],
            personas: personas.value,
            capabilities: connections,
            secrets: inventory.value.filter((entry) => (entry.kind === `env` || entry.kind === `generated`) && entry.status === `set`).map((entry) => entry.key),
            // Subscriptions and the trial; an endpoint or a local model is a connection, and stands as one.
            models: models()
                .filter((source) => source.kind === `account` || source.kind === `trial`)
                .map(
                    (source): ReachModelSource => ({
                        id: `model:${source.provider}:${source.kind}`,
                        provider: source.provider,
                        label: source.label,
                        detail: source.summary,
                        tone: STANDING_TONES[source.standing],
                    }),
                ),
            roster: isOwner.value ? roster.value : undefined,
            invited: new Set(records.filter((record) => record.status === `pending`).map((record) => record.email.toLowerCase())),
            expired: new Set(records.filter((record) => record.status === `expired`).map((record) => record.email.toLowerCase())),
            tokens: canShip.value ? tokens.query.data.value : undefined,
            inbound: canShip.value ? inbound.query.data.value : undefined,
            self: email === undefined ? undefined : { email, role: role.value },
            liveAccounts: new Set(running.map((session) => session.server).filter((server) => known.has(server))),
            anonymousBrowser: running.some((session) => !known.has(session.server)),
            publicPorts: forwarded.value.map((port) => ({ port: port.port, title: port.title })),
            outboxFiles: outbox.value.length,
            now: Date.now(),
        };
    });

    return {
        input,
        map: computed(() => buildReachMap(input.value)),
        // Where the reads the drawing stands on stand: its connections and its areas. Only their answer can draw "nothing
        // connected yet"; a failure of either is said as one (the map drew an empty sandbox under failing reads).
        drawnFrom: computed(() => allLoaded([capabilitiesRead.value, areas.loaded.value])),
    };
}
