import { ref } from "vue";
import { storedValue } from "../browserStorage";

/* WHICH SANDBOX THE BROWSER IS POINTED AT, and the one rule that scopes cached server state to it.
 *
 * Split out of useSandbox so that naming a cache key costs nothing. The registry (composables/queryKeys) is
 * imported by nearly every composable in the app, and useSandbox reaches the platform API client and the build
 * environment — so while `sandboxKey` lived there, importing the registry dragged that whole chain in behind
 * it, and two composable tests that had deliberately mocked their way clear of it stopped loading at all.
 *
 * Nothing here reaches further than vue and localStorage, which is what makes it safe to depend on from
 * anywhere. useSandbox owns everything else about a sandbox — the list, the connection, selecting one — and
 * writes `activeSandboxId` through its own persistence. */

// The key the active sandbox id is persisted under, so a reload keeps the same one selected.
export const ACTIVE_KEY = `intentic.activeSandboxId`;

// Which sandbox the workspace is pointed at right now.
export const activeSandboxId = ref<string | undefined>(storedValue(ACTIVE_KEY));

/* Append the active sandbox id to a vue-query key so each sandbox's cached server state is independent
 * (switching never serves another sandbox's data). Appended, not prepended, so a bare family prefix still
 * matches every sandbox's entry — which is the difference `queryKeys` exposes as `.of()` versus `.every`.
 * vue-query deep-unrefs the id ref, so the query refetches under a fresh key the moment the active sandbox
 * changes.
 *
 * Reach for this through a family in composables/queryKeys rather than calling it directly; queryKeys.guard
 * enforces that. */
export const sandboxKey = (...parts: readonly unknown[]): unknown[] => [...parts, activeSandboxId];
