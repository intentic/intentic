import type { HostSummary } from "@intentic/sandbox-contract";
import { computed, ref } from "vue";
import { bashCommand, psCommand } from "../../environments/scriptCommand";
import { onRuntimeChanged } from "./runtimeEvents";
import { sandboxRequest } from "./sandboxClient";
import { useSandbox } from "./useSandbox";

/* Drives the "Connect this computer" flow on a host capability's card, the desktop-sync card's shape, narrowed
 * to one machine.
 *
 * Connect mints a single-use pairing token BOUND TO THIS CAPABILITY, so the one-liner it produces can only ever
 * connect the computer the user is looking at. The machine coming online is the thing the user is waiting for
 * and it happens out-of-band, so the daemon pushes it: the moment they paste the command into their laptop and
 * its socket lands, the `hosts` domain frame arrives and this card re-reads itself, without a refresh and
 * without a timer.
 *
 * The token is shown once and never stored: a re-click mints a fresh one, which is cheaper than keeping a live
 * credential in a browser tab for ten minutes. */
export function useHostConnect() {
    const { daemonUrl } = useSandbox();

    const hosts = ref<readonly HostSummary[]>([]);
    // The capability id the last Connect click minted for, and its token, the pair the one-liners are built
    // from. Cleared when the dialog closes, so a stale command can never be copied from a reopened card.
    const pairId = ref<string | undefined>(undefined);
    const pairToken = ref<string | undefined>(undefined);
    const minting = ref(false);
    const error = ref<string | undefined>(undefined);

    const url = computed(() => daemonUrl.value ?? ``);
    const linuxCommand = computed(() =>
        url.value === `` || pairToken.value === undefined
            ? ``
            : bashCommand(`computerSh`, `env SANDBOX_URL='${url.value}' PAIR_TOKEN='${pairToken.value}' `, ``),
    );
    const windowsCommand = computed(() =>
        url.value === `` || pairToken.value === undefined
            ? ``
            : psCommand(`computerPs1`, `$env:SANDBOX_URL='${url.value}'; $env:PAIR_TOKEN='${pairToken.value}'; `),
    );

    const refresh = async (): Promise<void> => {
        try {
            const response = await sandboxRequest(`/system/hosts`);
            if (!response.ok) {
                return;
            }
            hosts.value = ((await response.json()) as { hosts?: HostSummary[] }).hosts ?? [];
        } catch {
            // Sandbox not reachable, leave the last known state rather than blanking the card.
        }
    };

    // Owner-only server-side; a member's click comes back 403 and says so rather than silently doing nothing.
    const connect = async (id: string): Promise<void> => {
        minting.value = true;
        error.value = undefined;
        try {
            const response = await sandboxRequest(`/system/hosts/pair?id=${encodeURIComponent(id)}`, { method: `POST` });
            if (!response.ok) {
                error.value =
                    response.status === 403
                        ? `Only the sandbox's owner can connect a computer.`
                        : `Couldn't start the connection (${response.status}).`;
                return;
            }
            pairToken.value = ((await response.json()) as { token: string }).token;
            pairId.value = id;
        } finally {
            minting.value = false;
        }
    };

    let unsubscribe: (() => void) | undefined;
    /* PUSHED, not polled, and the difference is the whole of this card's job. "Is that computer up" is a socket
     * in the daemon (hosts/host-hub.ts) and nothing else, so the daemon knows the instant the laptop answers and
     * says so on the `hosts` domain. What stood here was a three-second timer, which meant a machine that came
     * up promptly still looked absent for up to three seconds, on the one screen whose entire content is
     * whether it came up.
     *
     * One read on open for the state as it already stands, then nothing at all until something moves. */
    const start = (): void => {
        void refresh();
        unsubscribe ??= onRuntimeChanged([`hosts`], () => void refresh());
    };
    const stop = (): void => {
        unsubscribe?.();
        unsubscribe = undefined;
    };

    const close = (): void => {
        pairToken.value = undefined;
        pairId.value = undefined;
        error.value = undefined;
    };

    // Revoke: the machine's key is dropped and its socket cut. The capability stays, so the card can offer
    // Connect again, reconnecting is a fresh pairing, not a recovered one.
    const revoke = async (id: string): Promise<void> => {
        await sandboxRequest(`/system/hosts/${encodeURIComponent(id)}`, { method: `DELETE` });
        await refresh();
    };

    const hostFor = (id: string): HostSummary | undefined => hosts.value.find((host) => host.id === id);

    return { hosts, hostFor, pairId, pairToken, minting, error, linuxCommand, windowsCommand, connect, revoke, refresh, start, stop, close };
}
