import type { ViewBadge } from "@intentic/extension-api";
import type { IconName } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, type ComputedRef } from "vue";
import { useRole } from "../../client/sandbox/useRole";
import { extensionsLoaded } from "../../extension-host/loader";
import { devicesWorking } from "../../features/sandbox/devices/runners/deviceWork";
import { pushBadge } from "../../features/workspace/push/pushBadge";
import { usePushFlow } from "../../features/workspace/push/usePushFlow";
import { useCapabilities } from "../../models/capabilities/useCapabilities";
import { useChanges } from "../../models/changes/useChanges";
import { usePanels } from "../../models/extensions/usePanels";
import { agentsBadge, agentsScopeNote } from "../../models/fleet/board/agentsTile";
import { DEVICES_PATH } from "../../models/sandbox/devices/deviceLinks";
import { useSyncHealth } from "../../models/sandbox/devices/useDevices";
import { outgoingMark, outgoingSummary } from "../../models/workspace/push/outgoingWork";
import {
    type ActiveExtension,
    activationBadge,
    DEVICES_VIEW_ID,
    detectActivations,
    extensionPath,
    railRank,
    sectionReachable,
} from "../../workbench/views/registry";
import { useVocabulary } from "../../workbench/views/vocabulary";
import type { RailTile } from "./railMemory";

// THE RAIL'S TILES, for both rails that draw them: the desktop's (ShellDesktop.vue) and the phone's on its board
// (MobileRail.vue). One derivation per tile and per badge, so a count the desktop tile wears is the count the phone's
// wears, and neither shell can learn a new rule the other misses.

// RailTile supplies id, route, label and icon: RAIL_GROUPS ranks the id; repository tiles render initials without an icon.
export interface SectionTile extends RailTile {
    // Same shape core sections and extensions both fill, so the rail renders one badge element.
    readonly badge?: ViewBadge;
    // A standing fact about the tile (not news); today only the Agents tile's cross-sandbox scope uses it.
    readonly note?: { readonly icon: IconName; readonly text: string };
    // Set on a held tile for a tile not yet loaded: dim, inert, never badged (railMemory.ts).
    readonly ghost?: boolean;
}

// One tile tooltip combines badge, running work and standing facts; nested badge tooltips would overlap it.
export const tileParts = (tile: SectionTile): string[] =>
    [tile.badge?.tooltip, tile.badge?.running, tile.note?.text].flatMap((part) => (part === undefined || part === `` ? [] : [part]));
// The accessible name: the only place a phone, which has no hover, spells out what the corner marks say.
export const tileLabel = (tile: SectionTile): string => [tile.label, ...tileParts(tile)].join(` · `);

// One tile per extension activation, each part added only when the activation states it.
const extensionTile = (active: ActiveExtension): SectionTile => {
    const { extension, activation } = active;
    let tile: SectionTile = { id: extension.id, to: extensionPath(extension, activation), label: activation.title };
    if (activation.icon !== undefined) {
        // SAFETY: Activation.icon is an open string in the extension API, trusted to name an app icon; RailIcon
        // validates it (sectionIcon) and falls back to initials before drawing.
        tile = { ...tile, icon: activation.icon as IconName };
    }
    if (activation.monogram !== undefined) {
        tile = { ...tile, monogram: activation.monogram };
    }
    const badge = activationBadge(active);
    return badge === undefined ? tile : { ...tile, badge };
};

// The Workspace tile's badge, mirroring the panel's own priority: uncommitted count (size matters) before an outgoing
// push (a glyph, since size doesn't); a push in flight comes first, being this tile's only sign of it outside the panel.
function useWorkspaceBadge(): ComputedRef<ViewBadge | undefined> {
    const changes = useChanges();
    const pushFlow = usePushFlow();
    const words = useVocabulary();
    return computed<ViewBadge | undefined>(() => {
        // Orthogonal to whatever the badge SAYS: a running mark is drawn beside the tile, so a land rides whichever badge
        // wins below and stands alone when none does — the count is still 0 until the patch is in the tree.
        const landing: Pick<ViewBadge, `running`> = changes.landing.value === undefined ? {} : { running: changes.landing.value };
        const push = pushBadge(pushFlow.running.value, pushFlow.question.value, pushFlow.held.value);
        if (push !== undefined) {
            return { ...push, ...landing };
        }
        if (changes.count.value > 0) {
            return {
                count: changes.count.value,
                tooltip: words.value.pendingChanges(changes.count.value),
                ...landing,
            };
        }
        const work = changes.outgoing.value;
        if (work === undefined) {
            return changes.landing.value === undefined ? undefined : landing;
        }
        return { mark: outgoingMark(work), tooltip: outgoingSummary(work), ...landing };
    });
}

// THE MACHINES THIS SANDBOX REACHES, tiled like This computer in a local window (the same glyph and the same corners):
// a place to go, the count of ports another of your sandboxes took, and the turning mark while one of them is being
// worked on. A signal tile (registry.ts): kept by a pin, and on the rail by itself while it badges, since an agent
// update outlives the page that pressed it by a minute or more (devices/runners/deviceWork.ts).
function useDevicesTile(): ComputedRef<SectionTile> {
    const t = useT();
    const { heldPorts } = useSyncHealth();
    const devicesBadge = (held: number, running: string | undefined): ViewBadge | undefined => {
        if (held === 0) {
            return running === undefined ? undefined : { running };
        }
        const count: ViewBadge = { count: held, tone: `info`, tooltip: t(`shell.shellDesktop.portsTaken`, { count: held }, held) };
        return running === undefined ? count : { ...count, running };
    };
    return computed<SectionTile>(() => {
        const tile: SectionTile = { id: DEVICES_VIEW_ID, to: DEVICES_PATH, label: t(`sandbox.words.devicesSection`), icon: `desktop` };
        const badge = devicesBadge(heldPorts.value.length, devicesWorking());
        return badge === undefined ? tile : { ...tile, badge };
    });
}

// EVERY SECTION TILE, ranked by RAIL_GROUPS: the core sections (Agents, the Workspace, Devices for a shipping tier), then
// one tile per rail-surface extension activation, less whatever this reader cannot open. `leading` is a shell's own
// extra (the desktop's docked Chat tile), ranked with the rest. Which of these a rail draws is the rail's business: the
// desktop's keeps only what is pinned, permanent or badging (onRail), a phone's draws them all.
export function useSectionTiles(leading: () => readonly SectionTile[] = () => []) {
    const { panels, settled: panelsSettled } = usePanels();
    const { capabilities, settled: capabilitiesSettled } = useCapabilities();
    // Devices is ship-tier only: the hub withholds the section below maintainer, where the daemon refuses what it is for.
    const { canShip } = useRole();
    // The audience's words for the core tiles that have maker names (Files); Agents keeps its own.
    const words = useVocabulary();
    const workspaceBadge = useWorkspaceBadge();
    const devicesTile = useDevicesTile();
    const tiles = computed<readonly SectionTile[]>(() => {
        // Both from agentsTile.ts; the note names the scope when it's wide. RailIcon draws by section identity; these
        // generic names remain the fallback vocabulary.
        let agents: SectionTile = { id: `agents`, to: `/agents`, label: words.value.agents, icon: `robot` };
        if (agentsBadge.value !== undefined) {
            agents = { ...agents, badge: agentsBadge.value };
        }
        if (agentsScopeNote.value !== undefined) {
            agents = { ...agents, note: { icon: `boxes`, text: agentsScopeNote.value } };
        }
        const workspace: SectionTile = { id: `workspace`, to: `/workspace`, label: words.value.workspace, icon: `file-tree` };
        return (
            [
                ...leading(),
                agents,
                workspaceBadge.value === undefined ? workspace : { ...workspace, badge: workspaceBadge.value },
                ...(canShip.value ? [devicesTile.value] : []),
                ...detectActivations(panels.value, capabilities.value)
                    // Only rail-surface extensions get a tile; per-repo panels open from the Workspace tree instead.
                    .filter(({ extension }) => extension.surface === `rail`)
                    .map(extensionTile),
            ]
                // A section this reader cannot open belongs on no rail and in no menu.
                .filter((tile) => sectionReachable(tile.to))
                .toSorted((left, right) => railRank(left.id) - railRank(right.id))
        );
    });
    // True once extensions, panels, and capabilities have all loaded; before that a missing tile is only late.
    const settled = computed(() => extensionsLoaded.value && panelsSettled.value && capabilitiesSettled.value);
    return { tiles, settled };
}
