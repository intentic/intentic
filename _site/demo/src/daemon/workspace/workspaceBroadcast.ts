import type { SystemEvent } from "@intentic/sandbox-contract/events/system-events";
import { listeners } from "../board/roster";

// What the daemon's watchers push after a write, so a view other than the one that made it notices: the tree's paths,
// the repository set, a rendering that landed, or a running thing (a terminal, an app) that moved.

const send = (event: SystemEvent): void => {
    for (const listener of listeners) {
        listener(event);
    }
};

/** Files and folders that changed on disk, root-relative. */
export const pushPaths = (paths: readonly string[]): void => send({ kind: `workspaceChanged`, paths: [...paths] });

/** The whole repository set, after one was cloned or made. */
export const pushRepos = (repos: readonly string[]): void => send({ kind: `reposChanged`, repos: [...repos] });

/** Files whose derived text just landed. */
export const pushDerived = (paths: readonly string[]): void => send({ kind: `derivedChanged`, paths: [...paths] });

/** A running-thing domain that moved: `terminals`, `panels`, `ports`. */
export const pushRuntime = (...domains: string[]): void => send({ kind: `runtimeChanged`, domains });
