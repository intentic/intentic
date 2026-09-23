import type { CapabilitySummary } from "@intentic/api-contract";
import type { CapabilityCatalogEntry } from "@intentic/capability-catalog";
import type { CapabilityKind, HostSummary, WebExtSummary } from "@intentic/sandbox-contract";
import type { NoticeModel } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { type Ref, ref } from "vue";
import { sandboxRpc } from "../sandbox/client/sandboxRpc";
import type { usePeerConnect } from "../sandbox/devices/usePeerConnect";
import { useTerminalPanel } from "../terminal/useTerminalPanel";
import { awaitingLogin, browserGrants, machineGrants, signsInByHand } from "./model/connections";
import { type ContributionOf, contributionFor } from "./model/effects";
import { isDefaultName } from "./model/tiles";

// The windows a connection is finished in: a live browser signed into by hand, a one-time command run on a device of
// the user's own, a one-time code pasted into a browser of theirs. This page owns which is open and on what; rosters
// and revokes live in the shared peer composable.

// The step a pending add still waits on, opened at once rather than left for its row to name.
export type HandOff = `pair-device` | `pair-browser` | `sign-in`;

export const handOffOf = (
    kind: CapabilityKind,
    added: CapabilitySummary,
    host: HostSummary | undefined,
    browser: WebExtSummary | undefined,
): HandOff | undefined => {
    // A machine that's never checked in is waiting on the one-liner; one that has is merely asleep.
    if (kind === `device` && host?.lastSeen === undefined) {
        return `pair-device`;
    }
    // A browser that's never checked in is waiting on the pairing code.
    if (kind === `webext` && browser?.lastSeen === undefined) {
        return `pair-browser`;
    }
    // An identity's sign-in is a manual login: open the window immediately, as for a fresh account.
    return signsInByHand(kind) && awaitingLogin(added) ? `sign-in` : undefined;
};

type Peers<Summary extends { readonly id: string; readonly online: boolean }> = Pick<
    ReturnType<typeof usePeerConnect<Summary>>,
    `peerFor` | `revoke` | `refresh`
>;

export interface PairingHost {
    readonly hosts: Peers<HostSummary>;
    readonly browsers: Peers<WebExtSummary>;
    readonly contributionOf: ContributionOf;
    // Re-reads the capability list: a finished pairing or sign-in flips a connection from pending to active.
    readonly refetch: () => unknown;
    readonly error: Ref<NoticeModel | null>;
}

export const useCapabilityPairing = ({ hosts, browsers, contributionOf, refetch, error }: PairingHost) => {
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

    // A device of the user's own is unreachable from here, so connecting it is a one-time command run on that machine.
    const connectVisible = ref(false);
    const connectId = ref(``);
    const connectPlatform = ref(``);
    const connectPermissions = ref(``);
    // Still wearing its tile's name (`linux`, `linux-2`): the dialog may then offer the machine's own hostname instead.
    const connectUnnamed = ref(false);
    const openConnect = (instance: CapabilitySummary): void => {
        connectId.value = instance.id;
        connectPlatform.value = String(instance.config[`platform`] ?? `linux`);
        connectUnnamed.value = isDefaultName(connectPlatform.value, instance.id);
        // In the machine's own words, shared with the Devices tab, which opens this dialog on a machine gone quiet.
        connectPermissions.value = machineGrants(instance);
        connectVisible.value = true;
    };

    // A browser of the user's own may be another browser at the far end, so it pairs by a pasted code, not a command.
    const browserConnectVisible = ref(false);
    const browserConnectId = ref(``);
    const browserInstall = ref(``);
    const browserPermissions = ref(``);
    const openBrowserConnect = (instance: CapabilitySummary): void => {
        const contribution = contributionFor(contributionOf, instance.kind, instance.config);
        browserConnectId.value = instance.id;
        // The install link comes off the tile that declared this browser family; empty while it has no listing yet.
        browserInstall.value = (contribution?.kind === `webext` ? contribution.install : undefined) ?? ``;
        browserPermissions.value = browserGrants(instance);
        browserConnectVisible.value = true;
    };

    return {
        profileVisible,
        profileCapability,
        profileLabel,
        profileMode,
        openBrowser,
        connectVisible,
        connectId,
        connectPlatform,
        connectPermissions,
        connectUnnamed,
        browserConnectVisible,
        browserConnectId,
        browserInstall,
        browserPermissions,
        // An ACP agent's interactive sign-in: starts loginCommand in the capability's job session and opens its terminal.
        startAgentLogin: async (id: string): Promise<void> => {
            try {
                const { session } = await sandboxRpc.capabilities.login({ id });
                useTerminalPanel().openFocused(session);
            } catch (caught) {
                error.value = noticeFrom(caught, `Sign-in could not start.`);
            }
        },
        // Which of the two pairing dialogs a row's Connect means; the row itself draws one button for both kinds.
        openPairing: (entry: CapabilityCatalogEntry, instance: CapabilitySummary): void =>
            entry.kind === `webext` ? openBrowserConnect(instance) : openConnect(instance),
        removePairedAccess: async (entry: CapabilityCatalogEntry, id: string): Promise<void> => {
            await (entry.kind === `webext` ? browsers.revoke(id) : hosts.revoke(id));
            void refetch();
        },
        onBrowserExtConnected: (): void => {
            void browsers.refresh();
            void refetch();
        },
        // A machine coming online flips the capability pending -> active; refetch so the tile follows.
        onHostConnected: (): void => {
            void hosts.refresh();
            void refetch();
        },
        // The dialog took the machine's hostname as the name: the dialog now watches that id, and the row under it moved.
        onHostRenamed: (to: string): void => {
            connectId.value = to;
            connectUnnamed.value = false;
            void hosts.refresh();
            void refetch();
        },
        // A pending add has not finished: the dialog-based steps open at once; a rebuild step only links to the Sandbox
        // screen, from its row.
        handOff: (entry: CapabilityCatalogEntry, added: CapabilitySummary): void => {
            const step = handOffOf(entry.kind, added, hosts.peerFor(added.id), browsers.peerFor(added.id));
            if (step === `pair-device`) {
                openConnect(added);
            }
            if (step === `pair-browser`) {
                openBrowserConnect(added);
            }
            if (step === `sign-in`) {
                openBrowser(added.id, added.id);
            }
        },
    };
};
