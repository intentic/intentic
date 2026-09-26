import { sandboxShallowRef, type ViewBadge } from "@intentic/extension-api";
import type { MainlineStatus } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { mainlineBadge, mainlineSummary } from "./mainlineView";

// THE MAIN LINE'S RAIL TILE. The shell reads the main tree's check once (watchMainline, useMainline.ts) and leaves it
// here, so the tile's badge reads it without owning a query: the registry that asks for the badge is imported whole by a
// suite that runs without a DOM, and the query machinery is not something it can load. Per sandbox, like every badge's
// state: a switch empties it until the next box's read answers.

// The view's id on the rail, and where its tile and the board's status bar lead: a singleton view's path, which names
// no key (registry.ts, extensionPath).
export const MAINLINE_VIEW_ID = `mainline`;
export const MAINLINE_PATH = `/ext/${MAINLINE_VIEW_ID}`;

// The status as the shell last read it; undefined until it answers, and from a daemon that does not serve it.
export const shellMainline = sandboxShallowRef<MainlineStatus | undefined>(() => undefined);

// Recomputed when the read changes, not on every paint of the rail that asks for it.
export const mainlineTileBadge = computed<ViewBadge | undefined>(() => mainlineBadge(mainlineSummary(shellMainline.value)));
