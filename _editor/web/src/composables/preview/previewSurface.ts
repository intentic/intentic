import { ref } from "vue";
import type { Router } from "vue-router";
import { storedValue, storeValue } from "../browserStorage";
import { useSandbox } from "../sandbox/useSandbox";
import { ADDRESS_TARGET_ID } from "./previewModel";

/* THE ONE PREVIEW PANEL'S OWN STATE, which target it shows and whether it exists at all, as a module-level
 * singleton like useChat/useLayout, because the panel is mounted above the router (shell/PoppablePanels) and
 * has no route to keep state in: the same panel serves the /preview area and its pop-out window.
 *
 * `opened` IS THE PANEL'S EXISTENCE. Nothing mounts until the user first looks (the /preview area, a pop-out,
 * a tree row's eye), an iframe quietly loading a dev server nobody asked to see would be requests into the
 * user's app from a surface they never opened. Once opened it STAYS mounted, parked offscreen behind the rail
 * tile while other areas are up (PoppablePanels' stage): moving back and forth between the code and the app is
 * the whole workflow on one screen, and an iframe rebuilt on every trip would lose the app's own state, the
 * route its SPA is on, a form half filled, to every glance at a file. */

const opened = ref(false);
const selectedId = ref<string | undefined>(undefined);
const address = ref<string | undefined>(undefined);

/* Which target this SANDBOX was left showing, and the address it was last pointed at by hand, facts about the
 * box (its repos, its apps, the staging URL its owner keeps checking), so both are keyed by sandbox and come
 * back on a reload. The id is re-validated against the live target list on every read (previewModel.pickTarget),
 * so a stored id naming a deleted repo simply falls back to the best evidence. */
const targetKey = (sandboxId: string | undefined): string => `intentic-preview-target:${sandboxId ?? ``}`;
const addressKey = (sandboxId: string | undefined): string => `intentic-preview-address:${sandboxId ?? ``}`;

const restore = (): void => {
    const sandboxId = useSandbox().activeSandboxId.value;
    selectedId.value = storedValue(targetKey(sandboxId));
    address.value = storedValue(addressKey(sandboxId));
};
restore();

// Re-scope to the incoming sandbox (called from sandboxScope): its own last target comes back, and the parked
// panel goes away rather than keeping the outgoing sandbox's app loaded, a popped-out preview re-marks itself
// opened immediately (PoppablePanels watches the window), so a floating window survives the switch.
export const resetPreviewSurface = (): void => {
    opened.value = false;
    restore();
};

export const previewOpened = opened;
export const previewSelectedId = selectedId;
// The address the user typed, as text, turned into a target (or refused) by previewModel.addressTarget.
export const previewAddress = address;

export const selectPreviewTarget = (id: string): void => {
    selectedId.value = id;
    storeValue(targetKey(useSandbox().activeSandboxId.value), id);
};

/* POINT THE PREVIEW SOMEWHERE OF YOUR OWN, a staging URL, another route of the app, a page on a different
 * box. Storing the raw text rather than a parsed URL keeps what the user typed in the field they typed it in;
 * whether it names anything is addressTarget's judgement, and an empty box simply retires the row. Selecting
 * it here too, because typing an address IS asking to see it. */
export const setPreviewAddress = (typed: string): void => {
    const trimmed = typed.trim();
    address.value = trimmed === `` ? undefined : trimmed;
    storeValue(addressKey(useSandbox().activeSandboxId.value), address.value ?? ``);
    if (address.value !== undefined) {
        selectPreviewTarget(ADDRESS_TARGET_ID);
    }
};

export const markPreviewOpened = (): void => {
    opened.value = true;
};

/* The one move behind every door into the preview, the rail tile leads to the route anyway, but the tree
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
