import type { CapabilitySummary } from "@intentic/sandbox-contract";
import type { AddCapabilityInput, CapabilityCatalogEntry } from "@intentic/capability-catalog";
import type { NoticeModel } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { type Ref, ref } from "vue";
import { useTerminalPanel } from "../terminal/useTerminalPanel";
import type { CapabilityForm } from "./capabilityForm";
import { rememberSecrets } from "./model/devSecrets";
import { buildConfig } from "./model/form";
import { pushWalletPolicy } from "./model/walletPolicy";
import type { useSetupWalk } from "./setupWalk";

// The form's submit: adding and editing are one streamed write, because the daemon's is one upsert; the wallet's caps
// are a second write, to the platform; and a saved form either hands over the step it still waits on or moves on.

// What a saved form does next. A pending add has not finished, so the tile stays up and hands over its missing step (an
// add also resets to the next free name, an edit keeps its own); an edit stays so its row can be checked; an add leaves.
export type SubmitOutcome =
    | { readonly kind: `hand-off`; readonly added: CapabilitySummary; readonly startOver: boolean }
    | { readonly kind: `close-edit` }
    | { readonly kind: `leave` };

export const submitOutcome = (added: CapabilitySummary | undefined, wasEditing: boolean): SubmitOutcome => {
    if (added?.status.state === `pending`) {
        return { kind: `hand-off`, added, startOver: !wasEditing };
    }
    return wasEditing ? { kind: `close-edit` } : { kind: `leave` };
};

export interface SubmitHost {
    readonly selected: Readonly<Ref<CapabilityCatalogEntry | undefined>>;
    readonly editing: Readonly<Ref<CapabilitySummary | undefined>>;
    readonly capabilities: Readonly<Ref<readonly CapabilitySummary[]>>;
    readonly form: Pick<CapabilityForm, `values` | `keptSecrets` | `savedName` | `attempted` | `canSubmit` | `touchAll` | `refuse` | `startOver`>;
    // The streamed apply (useCapabilities.add): each frame as it arrives, throwing on an error frame.
    readonly add: (input: AddCapabilityInput, onLine?: (line: Record<string, unknown>) => void) => Promise<void>;
    readonly walk: Pick<ReturnType<typeof useSetupWalk>, `onwardFrom` | `leaveTile`>;
    readonly handOff: (entry: CapabilityCatalogEntry, added: CapabilitySummary) => void;
    readonly stopEditing: () => void;
    readonly error: Ref<NoticeModel | null>;
    // Whether the reader owns this sandbox: the wallet's caps go to the platform as the signed-in account's, and the
    // signer spends the OWNER's wallet, so a member's save would cap a wallet of their own that pays for nothing here.
    readonly ownsSandbox: Readonly<Ref<boolean>>;
}

export const useCapabilitySubmit = ({ selected, editing, capabilities, form, add, walk, handOff, stopEditing, error, ownsSandbox }: SubmitHost) => {
    const submitting = ref(false);

    /* THE WALLET'S CAPS ARE THE PLATFORM'S TO ENFORCE, so its tile is two writes (model/walletPolicy.ts). */
    const pushedWalletPolicy = async (entry: CapabilityCatalogEntry, config: Record<string, string>): Promise<boolean> => {
        if (entry.kind !== `wallet`) {
            return true;
        }
        try {
            await pushWalletPolicy(config);
            return true;
        } catch (caught) {
            error.value = noticeFrom(caught, t(`capabilities.capabilitySubmit.walletCapsNotSaved`));
            return false;
        }
    };

    const submit = async (): Promise<void> => {
        const entry = selected.value;
        if (entry === undefined || submitting.value) {
            return;
        }
        form.touchAll();
        if (!form.canSubmit.value) {
            form.refuse(entry);
            return;
        }
        // Refused before either write, so the tile never shows caps the signer does not enforce.
        if (entry.kind === `wallet` && !ownsSandbox.value) {
            error.value = { tone: `warning`, title: t(`capabilities.capabilitySubmit.walletOwnerOnly`) };
            return;
        }
        submitting.value = true;
        error.value = null;
        const config = buildConfig(entry, form.values, form.keptSecrets.value);
        const input: AddCapabilityInput = { id: form.savedName.value, kind: entry.kind, config };
        // Read BEFORE the write: a one-per-sandbox tile connected for the first time becomes an edit the moment it lands.
        const wasEditing = editing.value !== undefined;
        // Decided against the walk's queue before this add removes the tile from it.
        const next = walk.onwardFrom(entry);
        try {
            await add(input, (line) => {
                // The install's own terminal tab: progress is the real commands, not a separate summary retelling them.
                if (line[`kind`] === `terminal` && typeof line[`session`] === `string`) {
                    useTerminalPanel().openFocused(line[`session`]);
                }
            });
            rememberSecrets(entry, form.values);
            if (!(await pushedWalletPolicy(entry, config))) {
                return;
            }
            form.attempted.value = false;
            const outcome = submitOutcome(
                capabilities.value.find((capability) => capability.id === input.id),
                wasEditing,
            );
            if (outcome.kind === `hand-off`) {
                handOff(entry, outcome.added);
                if (outcome.startOver) {
                    form.startOver(entry);
                }
                return;
            }
            if (outcome.kind === `close-edit`) {
                stopEditing();
                return;
            }
            walk.leaveTile(next);
        } catch (err) {
            error.value = noticeFrom(err, wasEditing ? t(`capabilities.capabilitySubmit.couldNotSave`) : t(`capabilities.capabilitySubmit.couldNotAdd`));
        } finally {
            submitting.value = false;
        }
    };

    return { submit, submitting };
};
