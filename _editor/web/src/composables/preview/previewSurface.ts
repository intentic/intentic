import { ref } from "vue";
import type { Router } from "vue-router";
import { storedValue, storeValue } from "../browserStorage";
import { useSandbox } from "../sandbox/useSandbox";

/* THE ONE PREVIEW PANEL'S OWN STATE — which target it shows and whether it exists at all — as a module-level
 * singleton like useChat/useLayout, because the panel is mounted above the router (shell/PoppablePanels) and
 * has no route to keep state in: the same panel serves the /preview area and its pop-out window.
 *
 * `opened` IS THE PANEL'S EXISTENCE. Nothing mounts until the user first looks (the /preview area, a pop-out,
 * a tree row's eye) — an iframe quietly loading a dev server nobody asked to see would be requests into the
 * user's app from a surface they never opened. Once opened it STAYS mounted, parked offscreen behind the rail
 * tile while other areas are up (PoppablePanels' stage): moving back and forth between the code and the app is
 * the whole workflow on one screen, and an iframe rebuilt on every trip would lose the app's own state — the
 * route its SPA is on, a form half filled — to every glance at a file. */

const opened = ref(false);
const selectedId = ref<string | undefined>(undefined);

/* Which target this SANDBOX was left showing — a fact about the box (its repos, its apps), so it is keyed by
 * sandbox and comes back on a reload. The id is re-validated against the live target list on every read
 * (previewTargets.pickTarget), so a stored id naming a deleted repo simply falls back to the best evidence. */
const storageKey = (sandboxId: string | undefined): string => `intentic-preview-target:${sandboxId ?? ``}`;

const restore = (): void => {
    selectedId.value = storedValue(storageKey(useSandbox().activeSandboxId.value));
};
restore();

// Re-scope to the incoming sandbox (called from sandboxScope): its own last target comes back, and the parked
// panel goes away rather than keeping the outgoing sandbox's app loaded — a popped-out preview re-marks itself
// opened immediately (PoppablePanels watches the window), so a floating window survives the switch.
export const resetPreviewSurface = (): void => {
    opened.value = false;
    restore();
};

export const previewOpened = opened;
export const previewSelectedId = selectedId;

export const selectPreviewTarget = (id: string): void => {
    selectedId.value = id;
    storeValue(storageKey(useSandbox().activeSandboxId.value), id);
};

export const markPreviewOpened = (): void => {
    opened.value = true;
};

/* The one move behind every door into the preview — the rail tile leads to the route anyway, but the tree
 * row's eye and the palette command land here: name a target (or a repo, whose first target pickTarget
 * resolves), make the panel exist, and go where it shows. */
export const openPreview = (router: Router, targetId?: string): void => {
    if (targetId !== undefined) {
        selectPreviewTarget(targetId);
    }
    markPreviewOpened();
    void router.push(`/preview`);
};

/* The pop-out toggle lives in usePreviewPopout.ts rather than here: this module is imported by sandboxScope
 * (whose tests run without a DOM), and the pop-out machinery installs its window hook at module scope. */
