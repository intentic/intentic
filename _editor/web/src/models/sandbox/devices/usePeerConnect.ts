import type { HostSummary } from "@intentic/sandbox-contract/schemas/hosts";
import type { PeerPairingAnswer } from "@intentic/sandbox-contract/schemas/short-codes";
import type { PhoneSummary } from "@intentic/sandbox-contract/schemas/phone";
import type { WebExtSummary } from "@intentic/sandbox-contract/schemas/webext";
import { messageOr } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { SandboxHttpError } from "../../../client/sandbox/sandboxHttpError";
import { sandboxRaw } from "../../../client/sandbox/sandboxRaw";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";
import { queryClient } from "../../../lib/queryPersistence";
import { PAIRED_BROWSERS, PAIRED_HOSTS, PAIRED_PHONES, type QueryFamily } from "../../../lib/queryKeys";

// Drives Connect for a peer capability (host, browser or phone) sharing one door shape. Connect mints a single-use
// token bound to this capability; the door pushes a runtime-change event on pairing, which refreshes the roster, so the
// card updates without a timer. The token is shown once and never stored.
//
// The roster is the query cache's: one entry per door and sandbox, read by every dialog, row and badge that names these
// machines, refreshed by the daemon's push of the door's domain (`hosts`, `webext`, `phones`; RUNTIME_DOMAIN_BINDINGS).
// A read that fails is said (`rosterNotice`), not left looking like an empty roster.
interface PeerSummary {
    readonly id: string;
    readonly online: boolean;
}

export interface PeerDoor<Summary extends PeerSummary> {
    readonly noun: `device` | `browser` | `phone`;
    // Where the roster is cached.
    readonly family: QueryFamily;
    // The door's roster, as the daemon lists it.
    readonly read: () => Promise<readonly Summary[]>;
    // Mints the single-use pairing for one id: the token, and the short code the device door adds beside it.
    readonly pair: (id: string) => Promise<PeerPairingAnswer>;
    // Drops the enrollment and cuts the socket.
    readonly revoke: (id: string) => Promise<void>;
}

// Who may connect one, naming the kind of peer; one sentence per kind so each reads whole in every language.
const ownerOnly = (noun: PeerDoor<PeerSummary>[`noun`]): string =>
    noun === `device`
        ? t(`sandbox.usePeerConnect.ownerOnlyDevice`)
        : noun === `browser`
          ? t(`sandbox.usePeerConnect.ownerOnlyBrowser`)
          : t(`sandbox.usePeerConnect.ownerOnlyPhone`);

export function usePeerConnect<Summary extends PeerSummary>(door: PeerDoor<Summary>) {
    const { query, error: readError } = useSandboxQuery({
        queryKey: door.family.of(),
        queryFn: async () => [...(await door.read())],
    });
    const peers = computed<readonly Summary[]>(() => query.data.value ?? []);
    // Why the roster could not be read, as a sentence; undefined while it can. The last good roster stays in `peers`.
    const rosterNotice = computed(() => (readError.value === undefined ? undefined : t(`sandbox.usePeerConnect.rosterUnread`, { reason: readError.value })));
    // The id/token pair the last Connect click minted; cleared on close so a stale command can't be copied.
    const pairId = ref<string | undefined>(undefined);
    const pairToken = ref<string | undefined>(undefined);
    // The single-use short code a newer daemon mints beside a device's token, for the one-liner to carry instead of
    // it, and when both lapse (epoch ms). Undefined from a daemon that predates codes, and on the other doors.
    const pairCode = ref<string | undefined>(undefined);
    const pairExpiresAt = ref<number | undefined>(undefined);
    const minting = ref(false);
    const error = ref<string | undefined>(undefined);

    // Reads it again now. A dialog that is about to show a single-use token calls this on open, so what it confirms the
    // pairing against is the roster of this moment and not whatever was cached when the page loaded.
    const refresh = async (): Promise<void> => {
        await queryClient.invalidateQueries({ queryKey: door.family.of() });
    };

    // Maintainer and up server-side (the daemon's operating gate, `ownerDenied`); a click from below that comes back 403
    // and says so rather than silently doing nothing.
    const connect = async (id: string): Promise<void> => {
        minting.value = true;
        error.value = undefined;
        try {
            const answer = await door.pair(id);
            pairToken.value = answer.token;
            pairCode.value = answer.code;
            pairExpiresAt.value = answer.expiresIn === undefined ? undefined : Date.now() + answer.expiresIn * 1000;
            pairId.value = id;
        } catch (caught) {
            error.value =
                caught instanceof SandboxHttpError
                    ? caught.status === 403
                        ? ownerOnly(door.noun)
                        : t(`sandbox.usePeerConnect.startFailed`, { status: String(caught.status) })
                    : messageOr(caught, ``);
        } finally {
            minting.value = false;
        }
    };

    const close = (): void => {
        pairToken.value = undefined;
        pairCode.value = undefined;
        pairExpiresAt.value = undefined;
        pairId.value = undefined;
        error.value = undefined;
    };

    // Drops the peer's key and cuts its socket; the capability itself stays, so Connect can be offered again
    // as a fresh pairing, not a resume. A refusal throws: a revoke that didn't take leaves the peer able to connect.
    const revoke = async (id: string): Promise<void> => {
        try {
            await door.revoke(id);
        } finally {
            await refresh();
        }
    };

    const peerFor = (id: string): Summary | undefined => peers.value.find((peer) => peer.id === id);

    return { peers, peerFor, rosterNotice, pairId, pairToken, pairCode, pairExpiresAt, minting, error, connect, revoke, refresh, close };
}

export const HOST_DOOR: PeerDoor<HostSummary> = {
    noun: `device`,
    family: PAIRED_HOSTS,
    read: async () => (await sandboxRaw(`GET /system/hosts`)).hosts,
    pair: (id) => sandboxRaw(`POST /system/hosts/pair`, { query: { id } }),
    revoke: async (id) => {
        await sandboxRaw(`DELETE /system/hosts/{id}`, { params: { id } });
    },
};
export const WEBEXT_DOOR: PeerDoor<WebExtSummary> = {
    noun: `browser`,
    family: PAIRED_BROWSERS,
    read: async () => (await sandboxRaw(`GET /system/webext`)).browsers,
    pair: (id) => sandboxRaw(`POST /system/webext/pair`, { query: { id } }),
    revoke: async (id) => {
        await sandboxRaw(`DELETE /system/webext/{id}`, { params: { id } });
    },
};
export const PHONE_DOOR: PeerDoor<PhoneSummary> = {
    noun: `phone`,
    family: PAIRED_PHONES,
    read: async () => (await sandboxRaw(`GET /system/phones`)).phones,
    pair: (id) => sandboxRaw(`POST /system/phones/pair`, { query: { id } }),
    revoke: async (id) => {
        await sandboxRaw(`DELETE /system/phones/{id}`, { params: { id } });
    },
};
