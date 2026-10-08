import { computed, type ComputedRef, type Ref } from "vue";
import { useRoute } from "vue-router";
import { useAudience } from "../../app/useAudience";
import { useRole } from "../../client/sandbox/useRole";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { useBrowsersQuery } from "../../features/browsers/browsersQuery";
import { browsersFront } from "../../workbench/browsers/browsersSurface";
import type { LiveTab } from "../../workbench/browsers/browsersPaths";
import { useDesktopQuery } from "../../features/desktop/desktopQuery";
import { usePanels } from "../../features/extensions/usePanels";
import { previewHealthyCount } from "../../features/preview/previewModel";
import { useLiveLinks } from "../../features/sandbox/devices/useLiveLinks";
import { usePorts } from "../../features/sandbox/environment/usePorts";
import { useTerminalActivity } from "../../features/terminal/useTerminalActivity";
import { useTerminalPanel } from "../../features/terminal/useTerminalPanel";
import { usePublicOutbox } from "../../features/workspace/push/usePublicOutbox";
import { commandShortcut } from "../../workbench/commands/useCommands";
import { sectionReachable } from "../../workbench/views/registry";
import { useVocabulary } from "../../workbench/views/vocabulary";
import { browsersChip, desktopChip, portsChip, previewChip, type RuntimeChip, terminalChip, vpnChip } from "./runtimeChips";

// The facts behind the status bar's runtime chips (runtimeChips.ts), read once for the desktop shell. Always-on and
// loosely polled like the rail tiles they replace, so a chip arrives mid-turn.

export interface RuntimeChips {
    /** Left to right: the terminal first, which stays, so the chips that come and go never move it. */
    readonly chips: ComputedRef<readonly RuntimeChip[]>;
    readonly toggleTerminal: () => void;
    /** A stalled sandbox has no shell to open; the terminal's chip goes inert until it answers. */
    readonly reachable: Ref<boolean>;
}

export function useRuntimeChips(): RuntimeChips {
    const route = useRoute();
    const here = (to: string): boolean => route.path === to || route.path.startsWith(`${to}/`);
    // The live app, the web windows and the desktop are tabs of one view: each chip is lit while its kind is in front.
    const inFront = (...kinds: readonly LiveTab[`kind`][]): boolean => here(`/browsers`) && kinds.includes(browsersFront.value.kind);

    const { canShip } = useRole();
    const { maker } = useAudience();
    const { reachable } = useSandbox();
    const words = useVocabulary();
    const terminal = useTerminalPanel();
    const activity = useTerminalActivity();
    const { sessions: browsers } = useBrowsersQuery();
    const { windows } = useDesktopQuery();
    const { panels } = usePanels();
    const { forwarded } = usePorts();
    const { files: publicFiles } = usePublicOutbox();
    const { links: vpnLinks } = useLiveLinks(`vpn`);

    const chips = computed<readonly RuntimeChip[]>(() =>
        [
            // A PTY is the whole sandbox, so ship-tier only; and a maker never asked for a shell.
            canShip.value && !maker.value
                ? terminalChip({
                      count: activity.count.value,
                      summary: activity.summary.value,
                      open: terminal.open.value,
                      keys: commandShortcut(`terminal.toggle`),
                  })
                : undefined,
            previewChip({
                healthy: previewHealthyCount(panels.value, forwarded.value, publicFiles.value),
                here: inFront(`preview`),
                label: words.value.preview,
            }),
            browsersChip({ sessions: browsers.value, here: inFront(`web`) }),
            // The daemon lets nobody below maintainer drive the desktop.
            canShip.value ? desktopChip({ windows: windows.value ?? 0, here: inFront(`desktop`, `app`) }) : undefined,
            portsChip({ ports: forwarded.value.map((entry) => entry.port), here: here(`/sandbox/ports`) }),
            vpnChip({
                names: vpnLinks.value.filter((link) => link.state === `connected`).map((link) => link.id),
                here: here(`/capabilities/vpn`),
            }),
        ]
            .filter((chip) => chip !== undefined)
            // A chip whose page this reader cannot open (a guest's fence) would only answer with a bounce.
            .filter((chip) => chip.to === undefined || sectionReachable(chip.to)),
    );

    return { chips, toggleTerminal: () => terminal.toggle(), reachable };
}
