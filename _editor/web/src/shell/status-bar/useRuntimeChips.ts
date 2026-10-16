import { computed, type ComputedRef, type Ref } from "vue";
import { useRoute } from "vue-router";
import { useAudience } from "../../app/useAudience";
import { useRole } from "../../client/sandbox/useRole";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { useBrowsersQuery } from "../../features/browsers/browsersQuery";
import { useDesktopQuery } from "../../features/desktop/desktopQuery";
import { usePanels } from "../../models/extensions/usePanels";
import { previewHealthyCount } from "../../models/preview/previewModel";
import { useLiveLinks } from "../../models/sandbox/devices/useLiveLinks";
import { usePorts } from "../../models/sandbox/environment/usePorts";
import { useTerminalActivity } from "../../features/terminal/useTerminalActivity";
import { useTerminalPanel } from "../../models/terminal/useTerminalPanel";
import { usePublicOutbox } from "../../models/workspace/push/usePublicOutbox";
import { commandShortcut } from "../../workbench/commands/useCommands";
import { sectionReachable } from "../../workbench/views/registry";
import { useVocabulary } from "../../workbench/views/vocabulary";
import { browsersChip, portsChip, type RuntimeChip, terminalChip, vpnChip } from "./runtimeChips";

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
            browsersChip({
                sessions: browsers.value,
                apps: previewHealthyCount(panels.value, forwarded.value, publicFiles.value),
                // The daemon lets nobody below maintainer drive the desktop.
                desktopWindows: canShip.value ? (windows.value ?? 0) : undefined,
                appsLabel: words.value.preview,
                here: here(`/browsers`),
            }),
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
