import { ref, watch, type Ref } from "vue";
import type { LineStat } from "./codeStat";

/* THE OPEN DIFF'S OWN COUNTS, as its panes report them (DiffView emits `stat`), what the bar above a workspace
 * diff tab shows in place of git's numbers while the comments are hidden.
 *
 * Taken from the viewer rather than worked out here for two reasons, and the second is the important one: the
 * viewer has already stripped both sides to render them, so this costs nothing, and a bar that counted for
 * itself could reach a different answer than the panes it is labelling, which is the exact fault the code-only
 * counts exist to fix.
 *
 * Cleared the moment a different file takes over, so the previous file's numbers cannot sit over the new one's
 * diff for the frame it takes the viewer to remount and report. */
export function useDiffStat(id: Ref<string | undefined>) {
    const stat = ref<LineStat>();
    watch(id, () => (stat.value = undefined));
    return { stat, onStat: (next: LineStat | undefined): void => void (stat.value = next) };
}
