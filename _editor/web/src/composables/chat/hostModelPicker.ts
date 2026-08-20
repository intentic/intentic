import type { AgentHarness, AgentProvider } from "@intentic/sandbox-contract";
import { shallowRef } from "vue";

/* THE SHELL'S MODEL PICKER, OPENED BY SOMETHING THAT IS NOT THE COMPOSER, an extension calling
 * `api.models.pick()` (apiImpl.ts), which is the same arrangement `api.terminal` and `api.chat` already have:
 * the caller names what it wants, the host owns the surface.
 *
 * MODULE STATE RATHER THAN A PROP CHAIN, because the caller is outside Vue's tree entirely. An extension holds a
 * plain API object, hands over a trigger element and awaits an answer; the overlay itself is mounted once in
 * App.vue (HostModelPicker.vue) so it is there for both shells and for a view that has not been written yet.
 *
 * ONE REQUEST AT A TIME. A second ask supersedes the first and settles it as dismissed, the picker still open
 * belongs to a trigger the user has already moved away from, and leaving its promise hanging would strand
 * whatever awaited it. */

export interface ModelChoice {
    readonly provider: AgentProvider;
    readonly model: string;
    // What the app calls this pair (modelLabelFor), so a caller's own trigger can name the choice without
    // holding a catalog of its own.
    readonly label: string;
    // The two pins the footer adds to the list's own answer, absent unless the caller is holding one. See
    // PickedModel (extension-api) for why an unattended run is the surface that needs them.
    readonly account?: string;
    readonly harness?: AgentHarness;
}

interface ModelRequest {
    // The element the picker hangs off, and the window it opens in, see AnchoredOverlay.
    readonly anchor: HTMLElement;
    readonly provider: AgentProvider;
    readonly model: string;
    readonly account?: string;
    readonly harness?: AgentHarness;
    readonly settle: (choice: ModelChoice | undefined) => void;
}

// The open request, or undefined. HostModelPicker mounts the picker body from this, so the body is created and
// destroyed per open, which is what resets the search query and refreshes the catalogs (see ModelPicker).
export const modelRequest = shallowRef<ModelRequest | undefined>(undefined);

// Answer the open request, with a choice, or with undefined for a dismissal. Cleared BEFORE the promise
// settles, so a continuation that opens the picker again isn't torn down by its own predecessor.
export const settleModelPick = (choice?: ModelChoice): void => {
    const pending = modelRequest.value;
    modelRequest.value = undefined;
    pending?.settle(choice);
};

export const requestModelPick = (request: Omit<ModelRequest, "settle">): Promise<ModelChoice | undefined> => {
    /* Asking again from the SAME trigger is the user clicking the chip they just opened, and that has to CLOSE
     * the picker rather than blink it. The toggle belongs here because AnchoredOverlay deliberately does not
     * dismiss on a pointerdown on its own anchor, that click would otherwise land inside the box covering it,
     * which is the dismissal bug that component exists to avoid. A DIFFERENT trigger still supersedes and
     * reopens, which is what someone moving between two chips means. */
    const sameTrigger = modelRequest.value?.anchor === request.anchor;
    settleModelPick(undefined);
    if (sameTrigger) {
        return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
        modelRequest.value = { ...request, settle: resolve };
    });
};
