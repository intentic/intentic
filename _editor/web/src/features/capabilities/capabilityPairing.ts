import { t } from "@intentic/ui/i18n";
import type { CapabilityCatalogEntry } from "@intentic/capability-catalog";
import type { CapabilityKind, CapabilitySummary } from "@intentic/sandbox-contract/schemas/capabilities";
import type { HostSummary } from "@intentic/sandbox-contract/schemas/hosts";
import type { PhoneSummary } from "@intentic/sandbox-contract/schemas/phone";
import type { WebExtSummary } from "@intentic/sandbox-contract/schemas/webext";
import type { NoticeModel } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { computed, type Ref, ref } from "vue";
import { sandboxRpc } from "../../client/sandbox/sandboxRpc";
import type { usePeerConnect } from "../../models/sandbox/devices/usePeerConnect";
import { useTerminalPanel } from "../../models/terminal/useTerminalPanel";
import { isPeerKind, type PeerKind } from "@intentic/sandbox-contract/policy/capabilities/capability-kinds";
import { awaitingLogin, signsInByHand } from "../../models/capabilities/connections";
import { type Bound, slotsOf } from "./kinds/kindSlots";
import type { ContributionOf } from "./model/effects";

// The windows a connection is finished in: a live browser signed into by hand, or the pairing dialog of a peer of the
// user's own (a one-time command run on a device, a one-time code pasted into a browser, a code a phone scans), each
// peer kind's named in kindSlots.ts. This page owns which is open and on what; rosters and revokes live in the shared
// peer composable.

// The step a pending add still waits on, opened at once rather than left for its row to name.
export type HandOff = `pair` | `sign-in`;

export const handOffOf = (kind: CapabilityKind, added: CapabilitySummary, peer: { readonly lastSeen?: number } | undefined): HandOff | undefined => {
    // A peer that's never checked in is waiting on its pairing (the one-liner, the code); one that has is merely asleep.
    if (slotsOf(kind).pairing !== undefined && peer?.lastSeen === undefined) {
        return `pair`;
    }
    // An identity's sign-in is a manual login: open the window immediately, as for a fresh account.
    return signsInByHand(kind) && awaitingLogin(added) ? `sign-in` : undefined;
};

type Peers<Summary extends { readonly id: string; readonly online: boolean }> = Pick<
    ReturnType<typeof usePeerConnect<Summary>>,
    `peerFor` | `revoke` | `refresh`
>;

// Each peer kind's roster, keyed by the kind its card is.
export interface PairingPeers {
    readonly device: Peers<HostSummary>;
    readonly webext: Peers<WebExtSummary>;
    readonly phone: Peers<PhoneSummary>;
}

export interface PairingHost {
    readonly peers: PairingPeers;
    readonly contributionOf: ContributionOf;
    // Re-reads the capability list: a finished pairing or sign-in flips a connection from pending to active.
    readonly refetch: () => unknown;
    readonly error: Ref<NoticeModel | null>;
}

// The one pairing under way: on which connection, of which kind, and what its dialog was opened with.
export interface OpenPairing {
    readonly kind: PeerKind;
    readonly id: string;
    readonly props: object;
}

const peersOf = (peers: PairingPeers, kind: PeerKind): Peers<{ readonly id: string; readonly online: boolean; readonly lastSeen?: number }> =>
    peers[kind];

export const useCapabilityPairing = ({ peers, contributionOf, refetch, error }: PairingHost) => {
    // The live-browser window, a signed-in session rather than a token, opened on one connection: a tile holds several.
    const profileVisible = ref(false);
    const profileCapability = ref(``);
    const profileLabel = ref(``);
    const profileMode = ref<`login` | `browse`>(`login`);
    const openBrowser = (capability: string, label: string, mode: `login` | `browse` = `login`): void => {
        profileCapability.value = capability;
        profileLabel.value = label;
        profileMode.value = mode;
        profileVisible.value = true;
    };

    // A peer of the user's own is unreachable from here, so it pairs through its kind's dialog (kindSlots.ts `pairing`):
    // a command run on a computer, a code pasted into a browser, a code a phone scans. One is open at a time.
    const pairing = ref<OpenPairing | undefined>();
    const openPairing = (instance: CapabilitySummary): void => {
        const slot = slotsOf(instance.kind).pairing;
        if (slot !== undefined && isPeerKind(instance.kind)) {
            pairing.value = { kind: instance.kind, id: instance.id, props: slot.props(instance, { contributionOf }) };
        }
    };
    // A finished pairing flips the connection pending -> active; the roster and the list re-read so the tile follows.
    const paired = (): void => {
        if (pairing.value !== undefined) {
            void peersOf(peers, pairing.value.kind).refresh();
        }
        void refetch();
    };
    // The dialog took the machine's own name: it now watches that id, and the row under it moved, where there is
    // nothing more to mint (the machine reconnects under it by itself).
    const renamed = (to: string): void => {
        if (pairing.value !== undefined) {
            pairing.value = { ...pairing.value, id: to, props: { ...pairing.value.props, unnamed: false, renamed: true } };
        }
        paired();
    };
    const closePairing = (): void => {
        pairing.value = undefined;
    };
    // The dialog under the row whose pairing is under way, bound to answer back here.
    const dialog = computed<(Bound & { readonly id: string }) | undefined>(() => {
        const open = pairing.value;
        const slot = open === undefined ? undefined : slotsOf(open.kind).pairing;
        if (open === undefined || slot === undefined) {
            return undefined;
        }
        const bound = {
            visible: true,
            inline: true,
            id: open.id,
            ...open.props,
            "onUpdate:visible": (visible: boolean) => (visible ? undefined : closePairing()),
            onConnected: paired,
        };
        return { id: open.id, is: slot.dialog, props: slot.renames === true ? { ...bound, onRenamed: renamed } : bound };
    });

    return {
        profileVisible,
        profileCapability,
        profileLabel,
        profileMode,
        openBrowser,
        pairing,
        dialog,
        paired,
        renamed,
        closePairing,
        // An ACP agent's interactive sign-in: starts loginCommand in the capability's job session and opens its terminal.
        startAgentLogin: async (id: string): Promise<void> => {
            try {
                const { session } = await sandboxRpc.capabilities.login({ id });
                useTerminalPanel().openFocused(session);
            } catch (caught) {
                error.value = noticeFrom(caught, t(`capabilities.capabilityPairing.signInCouldNotStart`));
            }
        },
        // The pairing a row's Connect means; the row itself draws one button for every peer kind.
        openPairing: (_entry: CapabilityCatalogEntry, instance: CapabilitySummary): void => openPairing(instance),
        removePairedAccess: async (entry: CapabilityCatalogEntry, id: string): Promise<void> => {
            const { kind } = entry;
            if (!isPeerKind(kind)) {
                return;
            }
            try {
                await peersOf(peers, kind).revoke(id);
            } catch (caught) {
                // A refused revoke leaves the access in place; the row must not read as removed.
                error.value = noticeFrom(caught, t(`capabilities.capabilityPairing.accessNotRemoved`));
            }
            void refetch();
        },
        // A pending add has not finished: the dialog-based steps open at once; a rebuild step only links to the Sandbox
        // screen, from its row.
        handOff: (entry: CapabilityCatalogEntry, added: CapabilitySummary): void => {
            const { kind } = entry;
            const step = handOffOf(kind, added, isPeerKind(kind) ? peersOf(peers, kind).peerFor(added.id) : undefined);
            if (step === `pair`) {
                openPairing(added);
            }
            if (step === `sign-in`) {
                openBrowser(added.id, added.id);
            }
        },
    };
};
