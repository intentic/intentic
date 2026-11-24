import { probeCapability } from "../../models/capabilities/useCapabilities";
import { track } from "../../app/analytics";
import type { CapabilitySummary } from "@intentic/sandbox-contract/schemas/capabilities";
import type { AddCapabilityInput, CapabilityCatalogEntry } from "@intentic/capability-catalog";
import type { NoticeModel } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { getCurrentScope, onScopeDispose, type Ref } from "vue";
import { dismissOperation, operationsUnder, useOperation } from "../../workbench/operations/operations";
import { sshKeyScope } from "../../models/capabilities/sshKey";
import { keyRequestScope } from "../../models/capabilities/keyRequest";
import { useTerminalPanel } from "../../models/terminal/useTerminalPanel";
import type { CapabilityForm } from "./capabilityForm";
import { rememberSecrets } from "./model/devSecrets";
import { buildConfig } from "../../models/capabilities/form";
import { type KindSlots, type SaveContext, slotsOf } from "./kinds/kindSlots";
import type { useSetupWalk } from "./setupWalk";

// The form's submit: adding and editing are one streamed write, because the daemon's is one upsert; a kind's own checks
// and second write (the wallet's caps, to the platform) are its slots (kindSlots.ts); and a saved form either hands over
// the step it still waits on or moves on.

// What a saved form does next. A pending connection has not finished, so it hands over its missing step under its own
// row (an add's new row closes into the row it became, an edit's stays open); a saved edit closes its row; an add
// closes the new row into the list, or walks on to the next tile.
export type SubmitOutcome =
    | { readonly kind: `hand-off`; readonly added: CapabilitySummary; readonly closeRow: boolean }
    | { readonly kind: `close-edit` }
    | { readonly kind: `leave` };

export const submitOutcome = (added: CapabilitySummary | undefined, wasEditing: boolean): SubmitOutcome => {
    if (added?.status.state === `pending`) {
        return { kind: `hand-off`, added, closeRow: !wasEditing };
    }
    return wasEditing ? { kind: `close-edit` } : { kind: `leave` };
};

export interface SubmitHost {
    readonly hosted?: Readonly<Ref<boolean>>;
    readonly preflight?: typeof probeCapability;
    readonly capture?: typeof track;
    readonly selected: Readonly<Ref<CapabilityCatalogEntry | undefined>>;
    readonly editing: Readonly<Ref<CapabilitySummary | undefined>>;
    readonly capabilities: Readonly<Ref<readonly CapabilitySummary[]>>;
    readonly form: Pick<
        CapabilityForm,
        `values` | `keptSecrets` | `savedName` | `attempted` | `canSubmit` | `touchAll` | `refuse` | `pressed` | `unpressed`
    >;
    // The streamed apply (useCapabilities.add): each frame as it arrives, throwing on an error frame.
    readonly add: (input: AddCapabilityInput, onLine?: (line: Record<string, unknown>) => void) => Promise<void>;
    // Inside the walk an add moves on to the next tile; outside it, the tile stays, showing the row the add became.
    readonly walk: Pick<ReturnType<typeof useSetupWalk>, `onwardFrom` | `leaveTile`> & { readonly walking: Readonly<Ref<boolean>> };
    readonly handOff: (entry: CapabilityCatalogEntry, added: CapabilitySummary) => void;
    readonly stopEditing: () => void;
    readonly error: Ref<NoticeModel | null>;
    // Whether the reader owns this sandbox: the wallet's caps go to the platform as the signed-in account's, and the
    // signer spends the OWNER's wallet, so a member's save would cap a wallet of their own that pays for nothing here.
    readonly ownsSandbox: Readonly<Ref<boolean>>;
}

// A kind's second write (the wallet's caps, to the platform) refused after the daemon took the tile: said apart from a
// refused add, since the tile itself was saved.
class AfterSaveRefused extends Error {
    constructor(
        readonly reason: unknown,
        readonly title: string,
    ) {
        super(`a save's second write was refused`);
    }
}

// THE SAVE IS THE TILE'S, NOT THE PAGE'S. An install can take minutes and the daemon refuses a second write over one
// still applying, so the write and how it ended live in the operations ledger under the tile: a reader who opens
// another view mid-install comes back to the button still busy, and to the refusal if it failed. What the form does
// next (hand over a pending step, close an edit, move on) is the page's, and happens only where the page that pressed
// is still showing that tile.
export const saveKey = (entry: string): string => `capabilities/${entry}/save`;

// What a kind's own checks before and after the write read, with the daemon's preflight and the analytics capture
// unless a suite hands its own.
const saveContext = (host: SubmitHost): SaveContext => ({
    hosted: host.hosted?.value ?? false,
    ownsSandbox: host.ownsSandbox.value,
    preflight: host.preflight ?? probeCapability,
    capture: host.capture ?? track,
});

const afterSave = async ({ afterSave: second }: KindSlots, config: Record<string, string>): Promise<void> => {
    if (second === undefined) {
        return;
    }
    try {
        await second.run(config);
    } catch (caught) {
        throw new AfterSaveRefused(caught, second.refused());
    }
};

export const useCapabilitySubmit = (host: SubmitHost) => {
    const { selected, editing, capabilities, form, add, walk, handOff, stopEditing, error } = host;
    const save = useOperation(() => saveKey(selected.value?.id ?? ``));
    let showing = true;
    if (getCurrentScope() !== undefined) {
        onScopeDispose(() => {
            showing = false;
        });
    }

    // What the page that pressed does once the write landed, while it still shows that tile.
    const landed = (entry: CapabilityCatalogEntry, outcome: SubmitOutcome, next: string | undefined): void => {
        if (outcome.kind === `hand-off`) {
            handOff(entry, outcome.added);
            if (outcome.closeRow) {
                stopEditing();
            }
            return;
        }
        if (outcome.kind === `close-edit` || !walk.walking.value) {
            stopEditing();
            return;
        }
        walk.leaveTile(next);
    };

    const submit = async (): Promise<void> => {
        const entry = selected.value;
        if (entry === undefined || save.busy.value) {
            return;
        }
        form.touchAll();
        if (!form.canSubmit.value) {
            form.refuse(entry);
            return;
        }
        const slots = slotsOf(entry.kind);
        const context = saveContext(host);
        // Refused before either write, so the tile never shows caps the signer does not enforce.
        error.value = slots.refuseSave?.(context) ?? null;
        if (error.value !== null) {
            return;
        }
        const config = buildConfig(entry, form.values, form.keptSecrets.value);
        const input: AddCapabilityInput = { id: form.savedName.value, kind: entry.kind, config };
        // Taken at the press: the form may be reseeded or gone by the time the write lands.
        const answered = { ...form.values };
        // Read BEFORE the write: a one-per-sandbox tile connected for the first time becomes an edit the moment it lands.
        const wasEditing = editing.value !== undefined;
        // Decided against the walk's queue before this add removes the tile from it.
        const next = walk.onwardFrom(entry);
        // The daemon lists the connection once it is stored, before the add's stream ends: the form's own name is no
        // collision while it writes, nor after it landed, until the page moves on.
        form.pressed(input.id);
        const ended = await save.run({
            what: wasEditing ? t(`capabilities.capabilitySubmit.saving`, { name: input.id }) : t(`capabilities.capabilitySubmit.adding`, { name: input.id }),
            failed: (caught) =>
                caught instanceof AfterSaveRefused
                    ? noticeFrom(caught.reason, caught.title)
                    : noticeFrom(caught, wasEditing ? t(`capabilities.capabilitySubmit.couldNotSave`) : t(`capabilities.capabilitySubmit.couldNotAdd`)),
            task: async () => {
                // Only a check that may refuse it (a GPU ask on the host) waits: every other add starts its write in the
                // press's own tick.
                const checking = slots.beforeSave?.(input, context);
                if (checking !== undefined) {
                    await checking;
                }
                await add(input, (line) => {
                    // The install's own terminal tab: progress is the real commands, not a separate summary retelling them.
                    if (line[`kind`] === `terminal` && typeof line[`session`] === `string`) {
                        useTerminalPanel().openFocused(line[`session`]);
                    }
                });
                rememberSecrets(entry, answered);
                await afterSave(slots, config);
            },
        });
        if (ended?.state !== `done`) {
            form.unpressed(input.id);
            return;
        }
        // A key made for this form is spent once the connection is saved with it (SshKeyField keeps it until then).
        for (const made of [...operationsUnder(sshKeyScope(entry.id)), ...operationsUnder(keyRequestScope(entry.id))]) {
            dismissOperation(made.key);
        }
        if (!showing || selected.value?.id !== entry.id) {
            return;
        }
        form.attempted.value = false;
        landed(entry, submitOutcome(capabilities.value.find((capability) => capability.id === input.id), wasEditing), next);
    };

    return {
        submit,
        submitting: save.busy,
        failure: save.failure,
        // How far along the write still running is, for the form's <ProgressMeter>: an install takes minutes.
        meter: save.meter,
    };
};
