import { ref, watch, type Ref } from "vue";
import type { LineStat } from "@intentic/code-read";

// Counts as the diff viewer reports them (DiffView emits `stat`), not recomputed here, so the bar can't disagree
// with the panes it labels. Cleared whenever the file id changes, so stale counts don't linger over a remount.
export function useDiffStat(id: Ref<string | undefined>) {
    const stat = ref<LineStat>();
    watch(id, () => (stat.value = undefined));
    return { stat, onStat: (next: LineStat | undefined): void => void (stat.value = next) };
}
