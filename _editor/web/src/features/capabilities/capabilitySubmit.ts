import type { CapabilitySummary } from "@intentic/sandbox-contract/schemas/capabilities";
import type { AddCapabilityInput, CapabilityCatalogEntry } from "@intentic/capability-catalog";
import type { NoticeModel } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { getCurrentScope, onScopeDispose, type Ref } from "vue";
import { dismissOperation, operationsUnder, useOperation } from "../../workbench/operations/operations";
import { sshKeyScope } from "../../models/capabilities/sshKey";
import { useTerminalPanel } from "../../models/terminal/useTerminalPanel";
import type { CapabilityForm } from "./capabilityForm";
import { rememberSecrets } from "./model/devSecrets";
import { buildConfig } from "../../models/capabilities/form";
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

// The platform refused the wallet's caps after the daemon took the tile: said apart from a refused add, since the tile
// itself was saved.
class WalletCapsRefused extends Error {
    constructor(readonly reason: unknown) {
        super(`wallet caps refused`);
    }
}

/* THE WALLET'S CAPS ARE THE PLATFORM'S TO ENFORCE, so its tile is two writes (model/walletPolicy.ts). */
const pushWalletCaps = async (entry: CapabilityCatalogEntry, config: Record<string, string>): Promise<void> => {
    if (entry.kind !== `wallet`) {
        return;
    }
    try {
        await pushWalletPolicy(config);
    } catch (caught) {
        throw new WalletCapsRefused(caught);
    }
};

// THE SAVE IS THE TILE'S, NOT THE PAGE'S. An install can take minutes and the daemon refuses a second write over one
// still applying, so the write and how it ended live in the operations ledger under the tile: a reader who opens
// another view mid-install comes back to the button still busy, and to the refusal if it failed. What the form does
// next (hand over a pending step, close an edit, move on) is the page's, and happens only where the page that pressed
// is still showing that tile.
export const saveKey = (entry: string): string => `capabilities/${entry}/save`;

export const useCapabilitySubmit = ({ selected, editing, capabilities, form, add, walk, handOff, stopEditing, error, ownsSandbox }: SubmitHost) => {
    const save = useOperation(() => saveKey(selected.value?.id ?? ``));
    let showing = true;
    if (getCurrentScope() !== undefined) {
        onScopeDispose(() => {
            showing = false;
        });
    }

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
        // Refused before either write, so the tile never shows caps the signer does not enforce.
        if (entry.kind === `wallet` && !ownsSandbox.value) {
            error.value = { tone: `warning`, title: t(`capabilities.capabilitySubmit.walletOwnerOnly`) };
            return;
        }
        error.value = null;
        const config = buildConfig(entry, form.values, form.keptSecrets.value);
        const input: AddCapabilityInput = { id: form.savedName.value, kind: entry.kind, config };
        // Taken at the press: the form may be reseeded or gone by the time the write lands.
        const answered = { ...form.values };
        // Read BEFORE the write: a one-per-sandbox tile connected for the first time becomes an edit the moment it lands.
        const wasEditing = editing.value !== undefined;
        // Decided against the walk's queue before this add removes the tile from it.
        const next = walk.onwardFrom(entry);
        const ended = await save.run({
            what: wasEditing ? t(`capabilities.capabilitySubmit.saving`, { name: input.id }) : t(`capabilities.capabilitySubmit.adding`, { name: input.id }),
            failed: (caught) =>
                caught instanceof WalletCapsRefused
                    ? noticeFrom(caught.reason, t(`capabilities.capabilitySubmit.walletCapsNotSaved`))
                    : noticeFrom(caught, wasEditing ? t(`capabilities.capabilitySubmit.couldNotSave`) : t(`capabilities.capabilitySubmit.couldNotAdd`)),
            task: async () => {
                await add(input, (line) => {
                    // The install's own terminal tab: progress is the real commands, not a separate summary retelling them.
                    if (line[`kind`] === `terminal` && typeof line[`session`] === `string`) {
                        useTerminalPanel().openFocused(line[`session`]);
                    }
                });
                rememberSecrets(entry, answered);
                await pushWalletCaps(entry, config);
            },
        });
        if (ended?.state !== `done`) {
            return;
        }
        // A key made for this form is spent once the connection is saved with it (SshKeyField keeps it until then).
        for (const made of operationsUnder(sshKeyScope(entry.id))) {
            dismissOperation(made.key);
        }
        if (!showing || selected.value?.id !== entry.id) {
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
    };

    return { submit, submitting: save.busy, failure: save.failure };
};
