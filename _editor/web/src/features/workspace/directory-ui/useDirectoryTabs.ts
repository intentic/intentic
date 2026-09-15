import { useAudience } from "../../../app/useAudience";
import { type ActiveExtension, detectActivations } from "../../../core-views/registry";
import { directoryTabs } from "./directoryTabs";
import { useCapabilities } from "../../capabilities/connect/useCapabilities";
import { usePanels } from "../../extensions/usePanels";

// A directory's management-panel tabs against live state: for the panel that draws them, and for any surface offering
// a way into one, which must not offer a tab this directory hasn't got. A function rather than a computed, since
// callers ask per directory and a commit list asks for several.
export function useDirectoryTabs() {
    const { panels } = usePanels();
    const { capabilities } = useCapabilities();
    const { maker } = useAudience();
    return {
        tabsFor: (dir: string): readonly ActiveExtension[] => directoryTabs(detectActivations(panels.value, capabilities.value), dir, maker.value),
    };
}
