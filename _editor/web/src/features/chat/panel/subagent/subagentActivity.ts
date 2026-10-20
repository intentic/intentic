import { watch, type WatchStopHandle } from "vue";

// When an in-process subagent's transcript is worth reading again: the daemon has no stream of its own for it, but it
// stamps the child's roster record (`activityAt`) on every progress tick it files and pushes the `subagents` domain,
// which re-reads the roster the pane draws its bar from. A moved stamp while the child works and the window is on
// screen is that signal (2026-10-20); the pane's slow poll stays as the fallback for growth no tick announced.
export const onSubagentActivity = (
    activityAt: () => number,
    live: () => boolean,
    visible: () => boolean,
    read: () => void,
): WatchStopHandle =>
    watch(activityAt, (now, before) => {
        if (live() && visible() && now !== before) {
            read();
        }
    });
