import type { SystemEvent } from "@intentic/sandbox-contract/events/system-events";
import { subscribeDerived } from "../derived/derived-text.js";
import { subscribeCheckoutChanges } from "../workspace/watch/checkout-follow.js";
import { subscribeRepoChanges } from "../workspace/watch/repo-watch.js";
import { subscribeTreeChanges, subscribeUnwatchedWrites, subscribeWorkspaceChanges } from "../workspace/watch/workspace-watch.js";

// The /events frames that say files or repositories moved on disk, one subscription each, handed to one connection's
// `send`; returns their releases. Apart from system.routes.ts, which frames them per reader (framedEvent) like the rest.
// A repository's refs moving is subscribed there, not here: this module reaching git would close a cycle through push.
export const subscribeFileFrames = (send: (event: SystemEvent) => void): (() => void)[] => [
    subscribeWorkspaceChanges((paths) => send({ kind: "workspaceChanged", paths })),
    // What each batch moved in the shared tree, so a tab patches the tree it holds instead of fetching it again.
    subscribeTreeChanges((delta) => send({ kind: "treeChanged", ...delta })),
    // The unnamed batch for a write the watcher could not see: a check's build rewrites tracked files under `dist/`,
    // which is pruned, so without this a review read mid-build stands as the answer until something remounts the
    // panel.
    subscribeUnwatchedWrites(() => send({ kind: "workspaceChanged", paths: [] })),
    // Renderings land under the state directory the watcher ignores on purpose, so no workspaceChanged batch can
    // ever carry them; without this frame a second reader of the same file waits for text that already arrived.
    subscribeDerived((paths) => send({ kind: "derivedChanged", paths })),
    // What changed in a conversation's own copy, in the folders readers follow there (watch/checkout-follow.ts); a
    // checkout is outside /work, so no workspaceChanged batch carries it.
    subscribeCheckoutChanges((agent, paths) => send({ kind: "checkoutChanged", agent, paths })),
    // Repo-set snapshots: a clone, scaffold, or delete under /work re-frames the discovered list.
    subscribeRepoChanges((repos) => send({ kind: "reposChanged", repos })),
];
