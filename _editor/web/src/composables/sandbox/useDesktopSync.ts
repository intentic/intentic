import { roleAtLeast, type SyncStatus, syncFolder } from "@intentic/sandbox-contract";
import { useQueryClient } from "@tanstack/vue-query";
import { computed, ref, watch } from "vue";
import { desktopSyncLink } from "../../environments/desktop";
import { bashCommand, psCommand } from "../../environments/scriptCommand";
import { onRuntimeChanged } from "./runtimeEvents";
import { DEVICES } from "../queryKeys";
import { sandboxRequest } from "./sandboxClient";
import { useSandbox } from "./useSandbox";

/* ADDING A DEVICE TO THIS SANDBOX: minting a pairing, and rendering the one-liner that spends it.
 *
 * "Enable" mints a short-lived, single-use pairing token from the daemon; the copy-paste one-liner carries it,
 * and the agent redeems it once to enroll its SSH key. No Google sign-in on the laptop.
 *
 * Pairings carry a MODE: "sync" (file sync + port mirroring, single holder) or "mirror" (ports only, unlimited
 * machines). The daemon grants full sync to the operating tier and mirror-only below it, so pairMode reflects
 * the daemon's ANSWER, and the one-liner/copy follow it, never the request.
 *
 * WHAT THIS NO LONGER DOES IS THE POINT. It used to carry the whole subject: which machine holds sync, the
 * folder on it, whether that machine had gone quiet, who was mirroring, and one Disable that revoked every
 * paired device at once. All of it read from /system/sync, which flattened a LIST of enrolled machines into
 * one holder plus some names, because the card it fed presented desktop sync as a property of the sandbox. It
 * is a property of each DEVICE, so every one of those facts now rides on that device's row in the Devices
 * list (DeviceSync), beside the switches that change it. What is left here is the one job that genuinely
 * belongs to the sandbox: handing out a pairing.
 *
 * `available` is still read rather than assumed: the card branches on it, and a daemon too old to answer is one
 * that should not be offered sync at all. */

type SyncMode = `sync` | `mirror`;

// In the shell command SYNC_DIR is double-quoted so a leading ~ must become $HOME to expand; Windows also flips
// separators. Anything the user types past the leading ~ is preserved verbatim.
const toShellPath = (path: string): string => path.replace(/^~(?=\/|$)/, `$HOME`);
const toWindowsPath = (path: string): string => path.replace(/^~(?=[\\/]|$)/, `$HOME`).replace(/\//g, `\\`);

export function useDesktopSync() {
    const { active, daemonUrl } = useSandbox();

    const canOperate = computed(() => roleAtLeast(active.value?.role ?? `owner`, `maintainer`));

    // Whether this sandbox can do desktop sync at all. The daemon carries the transport on its own HTTPS
    // surface now, so a sandbox that answers this read can also sync; it used to depend on whether that
    // sandbox's reachability could carry TCP, which the platform's own path cannot. Still read rather than
    // assumed: it is the daemon's answer, and a daemon too old to give one is a card that should stay quiet.
    const available = ref(false);
    // The one-time pairing token from the last "Enable" click; undefined until minted (or after it's used up).
    const pairToken = ref<string | undefined>(undefined);
    // The mode the daemon GRANTED for that token, what the revealed one-liner will actually enroll.
    const pairMode = ref<SyncMode | undefined>(undefined);
    const minting = ref(false);
    // When set, the generated one-liner carries TAKEOVER=1 so the agent moves sync here, revoking the other
    // machine's key. The user opts in explicitly (the card only offers it when another machine holds sync).
    const takeover = ref(false);

    const defaultFolder = computed(() => syncFolder(active.value?.name ?? `sandbox`, daemonUrl.value));
    const folder = ref(defaultFolder.value);
    // Re-seed the folder + drop any stale token when the active sandbox changes (a new context).
    watch(
        () => active.value?.id,
        () => {
            folder.value = defaultFolder.value;
            pairToken.value = undefined;
            pairMode.value = undefined;
            takeover.value = false;
        },
    );

    const url = computed(() => daemonUrl.value ?? ``);
    // A mirror-only one-liner carries no SYNC_DIR (nothing to sync) and never TAKEOVER (mirror enrollments
    // don't contend, the daemon accepts any number).
    const linuxCommand = computed(() =>
        url.value === `` || pairToken.value === undefined
            ? ``
            : bashCommand(
                  `desktopSh`,
                  `env SANDBOX_URL='${url.value}' PAIR_TOKEN='${pairToken.value}'${
                      pairMode.value === `mirror` ? `` : ` SYNC_DIR="${toShellPath(folder.value)}"${takeover.value ? ` TAKEOVER='1'` : ``}`
                  } `,
                  ``,
              ),
    );
    const windowsCommand = computed(() =>
        url.value === `` || pairToken.value === undefined
            ? ``
            : psCommand(
                  `desktopPs1`,
                  `$env:SANDBOX_URL='${url.value}'; $env:PAIR_TOKEN='${pairToken.value}';${
                      pairMode.value === `mirror`
                          ? ``
                          : ` $env:SYNC_DIR="${toWindowsPath(folder.value)}";${takeover.value ? ` $env:TAKEOVER='1';` : ``}`
                  } `,
              ),
    );

    /* The same enrollment as the two commands above, spelled as the handoff the desktop app intercepts
     * (environments/desktop.ts). No folder rides it: the app asks for one in a system dialog, which is the
     * point — the card's reader inside the app chose a no-terminal product, and `folder` here is a text
     * field guessing at a path on a machine this page cannot see. The card decides whether to SHOW it (only
     * inside the app); building it belongs here with its siblings so the three can never disagree on what
     * an enrollment carries. */
    const desktopLink = computed(() =>
        url.value === `` || pairToken.value === undefined
            ? undefined
            : desktopSyncLink({
                  url: url.value,
                  pair: pairToken.value,
                  ...(active.value?.name === undefined ? {} : { name: active.value.name }),
                  takeover: takeover.value && pairMode.value !== `mirror`,
                  mirror: pairMode.value === `mirror`,
              }),
    );

    // Mint (or re-mint) a pairing token so the card can reveal the one-liner. Authorized by the browser's Google
    // session, sandboxRequest attaches it. The token is single-use and expires (~10 min) server-side. The
    // daemon answers with the mode it actually granted (a member's "sync" request comes back "mirror").
    const enable = async (mode: SyncMode): Promise<void> => {
        minting.value = true;
        try {
            const response = await sandboxRequest(`/system/sync/pair${mode === `mirror` ? `?mode=mirror` : ``}`, { method: `POST` });
            if (!response.ok) {
                throw new Error(`Couldn't start desktop sync (${response.status}).`);
            }
            const body = (await response.json()) as { token: string; mode?: SyncMode };
            pairMode.value = body.mode ?? `sync`;
            pairToken.value = body.token;
        } finally {
            minting.value = false;
        }
    };

    const client = useQueryClient();
    let unsubscribe: (() => void) | undefined;
    const stop = (): void => {
        unsubscribe?.();
        unsubscribe = undefined;
    };
    const refresh = async (): Promise<void> => {
        try {
            const response = await sandboxRequest(`/system/sync`);
            if (!response.ok) {
                return;
            }
            available.value = ((await response.json()) as Partial<SyncStatus>).available === true;
        } catch {
            // Sandbox not reachable yet, leave the last known state.
        }
    };
    /* Listen ONLY while a pairing one-liner is live (Enable clicked): that is the one window where an enrollment
     * appears out-of-band, as the agent on the other machine redeems the token. Just viewing the card (no
     * pairToken, the common /sandbox case) subscribes to nothing.
     *
     * WHAT IT REFRESHES IS THE DEVICES LIST, not this card, and that is the whole shape of the change: the new
     * machine is a ROW, so the moment it enrolls it has to appear in the list above with its folder, its ports
     * and its switches. The card has nothing left to re-read — it knows what it minted.
     *
     * The redemption is a POST the daemon serves (/system/authorized-key → platform/sync.ts persist), so it can
     * and does announce itself on the `hosts` domain. That replaces a three-second poll whose entire purpose was
     * to eventually notice something the daemon had already done. */
    watch(pairToken, (token) => {
        stop();
        if (token !== undefined) {
            unsubscribe = onRuntimeChanged([`hosts`], () => void client.invalidateQueries({ queryKey: DEVICES.of() }));
        }
    });
    // Mount: one-shot read of whether this sandbox can carry sync at all (no steady polling; the list above
    // does the polling this tab needs).
    const start = (): void => {
        void refresh();
    };

    return {
        canOperate,
        available,
        folder,
        defaultFolder,
        pairToken,
        pairMode,
        minting,
        takeover,
        linuxCommand,
        windowsCommand,
        desktopLink,
        enable,
        start,
        stop,
    };
}
