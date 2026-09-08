import { type AgentHarness, type AgentProvider, sendableEffort } from "@intentic/sandbox-contract";
import { shallowRef } from "vue";
import { defaultRunSettings, type RunSettingsPatch } from "./pickerRunSettings";
import { modelLabelFor } from "../accounts/providerCatalog";

/* THE SHELL'S MODEL PICKER, OPENED BY SOMETHING THAT IS NOT THE COMPOSER: a run button about to start an agent
 * (useAgentRunPick), an automation rung, a workflow step, or an extension calling `api.models.pick()`
 * (apiImpl.ts), which is the same arrangement `api.terminal` and `api.chat` already have: the caller names what
 * it wants, the host owns the surface.
 *
 * MODULE STATE RATHER THAN A PROP CHAIN, because the caller is outside Vue's tree entirely. An extension holds a
 * plain API object, hands over a trigger element and awaits an answer; the overlay itself is mounted once in
 * App.vue (HostModelPicker.vue) so it is there for both shells and for a view that has not been written yet.
 *
 * IT IS A FORM, AND IT ENDS IN A PRESS. Every caller here is AWAITING an answer, and every one of them may
 * configure more than the model: which account pays, which harness runs it, how hard it thinks. So the panel
 * holds a whole selection and the caller's own verb ends it — "Fix with agent", "Use this model" — instead of a
 * model row settling it the instant it is clicked. That is not a flourish; it is what makes the panel HAVE an
 * end. A row-settles panel can only be left, by clicking away, when your last gesture was a setting rather than
 * a row, and the version of this file that did that had to treat clicking away as an answer to keep the effort
 * meter from looking broken — which in turn meant a user who changed their mind and dismissed had ARMED the tier
 * they were backing out of. Now the two gestures say what they look like: the button commits, and leaving
 * cancels.
 *
 * The composer and the settings page keep the other grammar on purpose (ChatModelPicker, ModelPinPickerBody):
 * they EDIT something that already exists and is on screen behind them, so every row writes straight through
 * and there is nothing to submit.
 *
 * ONE REQUEST AT A TIME. A second ask supersedes the first and settles it as dismissed: the picker still open
 * belongs to a trigger the user has already moved away from, and leaving its promise hanging would strand
 * whatever awaited it. */

export interface ModelChoice {
    readonly provider: AgentProvider;
    readonly model: string;
    // What the app calls this pair; lets a caller's trigger name the choice without its own catalog.
    readonly label: string;
    // The pins the footer adds to the list's answer; absent unless the caller already holds one.
    readonly account?: string;
    readonly harness?: AgentHarness;
    /* HOW THE MODEL ITSELF IS RUN: the tier it thinks at, whether it reasons first, and whether the work is
     * bought at the faster rate. All three are properties of the MODEL rather than of the provider, so they
     * survive a re-point across providers exactly as they do in the settings page's own picker
     * (ModelPinPickerBody), while the account and harness do not.
     * A panel that CARRIED them (`chooseRun`) always answers with all three, because it seeded whatever the
     * caller left out and showed the reader the result. They stay optional for the caller that asked for no
     * run settings at all, whose answer is a pair and an account. */
    readonly effort?: string;
    readonly thinking?: boolean;
    readonly fast?: boolean;
}

/* Everything the panel holds while it is open: the selection, growing as the user edits it, until the commit
 * bar hands it back. The model pair starts as whatever the caller opened on, so a panel dismissed without a
 * single click has changed nothing.
 *
 * The account and harness are `| undefined` rather than merely absent, and that is load-bearing under this
 * repo's `exactOptionalPropertyTypes`: CLEARING one is a patch that names it (`{ account: undefined }` is a
 * provider switch dropping a credential the new provider has never heard of), and without the annotation there
 * would be no way to spell the clear at all. The run settings need no such spelling — no control in the panel
 * can unset one. */
interface StagedPick {
    readonly provider: AgentProvider;
    readonly model: string;
    readonly account?: string | undefined;
    readonly harness?: AgentHarness | undefined;
    readonly effort?: string;
    readonly thinking?: boolean;
    readonly fast?: boolean;
}

/* WHAT A ROW MAY STAGE, and the shape that carries the difference between the two halves of the panel. The
 * account and harness may be CLEARED by naming them: `{ account: undefined }` is a provider switch dropping a
 * credential the new provider has never heard of. The run settings may not, and take `RunSettingsPatch` — the
 * type the control itself emits — so the two halves cannot drift.
 *
 * SAYING IT IS ALL THIS CAN DO. `exactOptionalPropertyTypes` is off for Vue programs (tsconfig.vue.json), so
 * `{ effort: undefined }` type-checks here whatever the annotation says; the file this replaced claimed the
 * flag was enforcing it, and it never was. What actually holds the line is that no control emits an undefined
 * run setting and that a `chooseRun` answer is asserted to name all three (HostPickerBody.test.ts).
 *
 * Spelled out rather than `Partial<StagedPick>` because `Partial` would also make `provider` and `model`
 * optional-and-undefined, and a staged pick with no provider is not a thing any row can mean. */
type StagedPatch = {
    readonly provider?: AgentProvider;
    readonly model?: string;
    readonly account?: string | undefined;
    readonly harness?: AgentHarness | undefined;
} & RunSettingsPatch;

interface ModelRequest extends StagedPick {
    // The element the picker hangs off, and the window it opens in, see AnchoredOverlay.
    readonly anchor: HTMLElement;
    /* THE CALLER'S OWN VERB, on the button that ends the panel. It is the caller's because only the caller knows
     * what the press DOES: "Fix with agent" on a red pipeline, "Run chore", "Use this model" on a form that is
     * merely storing one. A bar that said "OK" would be asking the reader to remember what they opened. */
    readonly action: string;
    /* WHETHER TO OFFER THE MODEL'S OWN RUN SETTINGS — reasoning effort, extended thinking, speed — which is the
     * caller's answer about what it CARRIES, not about what it likes. This picker serves several questions:
     * which model a RUN spends (all three ride onto the turn), which model an automation rung or a settings pin
     * is stored as (a ModelPin holds all three), which model this CHAT is on (whose knobs are in the composer
     * beside it), and which model a workflow step is pinned to (a pair and an account, nothing more). A control
     * whose answer is dropped on the floor is worse than no control, so the rows are drawn on request. */
    readonly chooseRun?: boolean;
    readonly settle: (choice: ModelChoice | undefined) => void;
}

// The open request, or undefined; the body mounts from this, so it is fresh (search, catalogs) on every open.
export const modelRequest = shallowRef<ModelRequest | undefined>(undefined);

/* EVERY ROW IN THE PANEL WRITES HERE, the model list included. Staging rather than settling is what lets the
 * checkmark move, the meter relight and the commit bar re-price the press, all while the panel stays open and
 * the caller keeps waiting.
 *
 * An explicit `undefined` is a real value (the × beside the effort meter, "take the model's own default"; a
 * provider switch clearing an account that belongs to the old one), which is why the patch is spread rather
 * than filtered. */
export const stageModelPick = (patch: StagedPatch): void => {
    const pending = modelRequest.value;
    if (pending === undefined) {
        return;
    }
    modelRequest.value = { ...pending, ...patch };
};

/* THE PRESS. Hand back everything staged, as the caller will send it and as the daemon will read it:
 * `sendableEffort` against this selection's own thinking, so a panel showing Max beside thinking-off answers
 * with the High it will actually run at rather than a rung nothing will honour. An empty tier is dropped
 * rather than sent as `""`, which no scale has a rung for; a panel carrying run settings never produces one. */
export const commitModelPick = (): void => {
    const pending = modelRequest.value;
    if (pending === undefined) {
        return;
    }
    const effort = sendableEffort(pending.effort, pending.thinking);
    settleModelPick({
        provider: pending.provider,
        model: pending.model,
        label: modelLabelFor(pending.provider, pending.model),
        ...(pending.account !== undefined ? { account: pending.account } : {}),
        ...(pending.harness !== undefined ? { harness: pending.harness } : {}),
        ...(effort === undefined || effort === `` ? {} : { effort }),
        ...(pending.thinking !== undefined ? { thinking: pending.thinking } : {}),
        ...(pending.fast !== undefined ? { fast: pending.fast } : {}),
    });
};

/* LEAVING THE PANEL ANY WAY BUT ITS OWN BUTTON — Escape, a pointer outside it, the sheet's backdrop, a second
 * click on the trigger — AND IT IS A CANCEL, whole. Nothing staged is kept and the caller is told nothing was
 * chosen, which is the plain meaning of every one of those gestures and the reason the panel can afford to let
 * the settings rows write through freely: backing out of them is always possible and always complete. */
export const dismissModelPick = (): void => settleModelPick(undefined);

// Answer the open request, with a choice, or with undefined for a dismissal. Cleared BEFORE the promise
// settles, so a continuation that opens the picker again isn't torn down by its own predecessor.
export const settleModelPick = (choice?: ModelChoice): void => {
    const pending = modelRequest.value;
    modelRequest.value = undefined;
    pending?.settle(choice);
};

export const requestModelPick = (
    request: Omit<ModelRequest, "settle" | "action"> & { readonly action?: string | undefined },
): Promise<ModelChoice | undefined> => {
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
        /* THE ONE PLACE THE HARNESS'S OWN ANSWERS ARE READ, and only for a panel that CARRIES run settings.
         * A caller may open this holding no tier and no thinking flag — a run button, an extension calling
         * `api.models.pick()` — and the panel has no "leave it to the model" stop to draw that with, on
         * purpose: a reader has to be able to see what their press will spend. So the defaults fill the
         * selection in as it opens, the controls show them, and the answer carries whatever is on screen.
         * Only the fields the caller left out; anything it named is its own. */
        const seeded = request.chooseRun === true ? defaultRunSettings() : undefined;
        modelRequest.value = {
            ...request,
            ...(seeded === undefined
                ? {}
                : { effort: request.effort ?? seeded.effort, thinking: request.thinking ?? seeded.thinking, fast: request.fast ?? seeded.fast }),
            action: request.action ?? `Use this model`,
            settle: resolve,
        };
    });
};
