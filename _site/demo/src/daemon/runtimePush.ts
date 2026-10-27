import { listeners } from "./board/roster";

// A `runtimeChanged` frame on every open /events stream, as the daemon pushes when state with no file behind it moves
// (runtime-state.ts names what each domain makes stale), so a second window, or a view that isn't the one that wrote,
// re-reads instead of waiting for its own poll.
export const pushRuntime = (...domains: string[]): void => {
    for (const listener of listeners) {
        listener({ kind: `runtimeChanged`, domains });
    }
};
