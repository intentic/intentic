import { type AgentHarness, type AgentProvider, sendableEffort } from "@intentic/sandbox-contract";
import { shallowRef } from "vue";
import { modelLabelFor } from "./providerCatalog";

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
    // The pins the footer adds to the list's own answer, absent unless the caller is holding one. See
    // PickedModel (extension-api) for why an unattended run is the surface that needs them.
    readonly account?: string;
    readonly harness?: AgentHarness;
    /* WHICH TIER THE RUN THINKS AT, the footer's third pin and the only one that is a property of the MODEL
     * rather than of the provider: it therefore survives a re-point across providers, exactly as it does in the
     * settings page's own picker (ModelPinPickerBody), while the account and harness do not. Absent ⇒ the
     * model's own default. */
    readonly effort?: string;
}

interface ModelRequest {
    // The element the picker hangs off, and the window it opens in, see AnchoredOverlay.
    readonly anchor: HTMLElement;
    readonly provider: AgentProvider;
    readonly model: string;
    readonly account?: string;
    readonly harness?: AgentHarness;
    readonly effort?: string;
    /* WHETHER TO OFFER THE TIER AT ALL, the caller's own answer. This picker serves several questions: which
     * model a RUN spends (where the tier rides onto the turn), which model this CHAT is on (whose effort is set
     * in the composer beside it), and which model an automation or a workflow step is pinned to (a stored pair
     * with no tier field behind it). Only the first can honour an answer here, and a control whose answer is
     * dropped on the floor is worse than no control, so the row is drawn on request rather than by default. */
    readonly chooseEffort?: boolean;
    /* WHETHER A PIN WAS TOUCHED WHILE THIS PICKER WAS OPEN, which is what turns a dismissal into an answer. Set
     * by stageModelPick, read by dismissModelPick. */
    readonly staged?: boolean;
    readonly settle: (choice: ModelChoice | undefined) => void;
}

// The open request, or undefined. HostModelPicker mounts the picker body from this, so the body is created and
// destroyed per open, which is what resets the search query and refreshes the catalogs (see ModelPicker).
export const modelRequest = shallowRef<ModelRequest | undefined>(undefined);

/* Account, harness and effort rows are settings within the open picker, not its answer. Stage them on the
 * request so the footer updates immediately and the eventual model row carries the complete choice back to the
 * caller. An explicit `undefined` is a real value here (the × beside the effort meter, "take the model's own
 * default"), which is why the patch is spread rather than filtered. */
export const stageModelPick = (patch: Pick<ModelChoice, "account" | "harness" | "effort">): void => {
    const pending = modelRequest.value;
    if (pending === undefined) {
        return;
    }
    modelRequest.value = { ...pending, ...patch, staged: true };
};

/* CLOSING THE PANEL WITHOUT PICKING A ROW STILL KEEPS WHAT WAS SET IN IT. The model row is the answer only when
 * the model is what changed: someone who opens the caret already on the right model, drags the effort meter and
 * clicks away has said everything they meant to say, and dropping it made the meter look broken — the tier only
 * stuck if you afterwards clicked the model you were already on. So a dismissal answers with the model the
 * picker opened on plus whatever pins were staged, and stays a dismissal when nothing was touched.
 *
 * The tier is read the way HostPickerBody reads it and the daemon will read it (sendableEffort over unset
 * thinking, empty ⇒ the model's own default), so the answer a dismissal gives is the answer a model row would
 * have given. */
export const dismissModelPick = (): void => {
    const pending = modelRequest.value;
    if (pending === undefined || pending.staged !== true) {
        settleModelPick(undefined);
        return;
    }
    const effort = sendableEffort(pending.effort, undefined);
    settleModelPick({
        provider: pending.provider,
        model: pending.model,
        label: modelLabelFor(pending.provider, pending.model),
        ...(pending.account !== undefined ? { account: pending.account } : {}),
        ...(pending.harness !== undefined ? { harness: pending.harness } : {}),
        ...(effort === undefined || effort === `` ? {} : { effort }),
    });
};

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
    dismissModelPick();
    if (sameTrigger) {
        return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
        modelRequest.value = { ...request, settle: resolve };
    });
};
