import { invalidatePushedQueries } from "../../../../lib/pushInvalidation";
import { roleAtLeast, type SyncStatus, syncFolder } from "@intentic/sandbox-contract";
import { useQueryClient } from "@tanstack/vue-query";
import { computed, ref, watch } from "vue";
import { t } from "@intentic/ui/i18n";
import { desktopSyncLink } from "../../../../app/environments/desktop";
import type { CommandOs } from "@intentic/ui";
import { bashCommand, oneLiner, oneLinerHost, psCommand } from "../../../../app/environments/scriptCommand";
import { onRuntimeChanged } from "../../live/runtimeEvents";
import { rpcKey } from "../../../../lib/queryKeys";
import { sandboxRequest } from "../../../../client/sandbox/sandboxClient";
import { useSandbox } from "../../../../client/sandbox/useSandbox";

// Mints a device pairing and renders the one-liner that spends it (single-use, redeemed once to enroll an SSH
// key). Mode reflects what the daemon granted, never what was requested. Everything else about an existing
// pairing now lives on that device's row in the Devices list. The folder and takeover go to the sandbox with the
// mint, and the command carries only the short code that stands for all of it: `sync/<host>/<code>`.

export type SyncMode = `sync` | `mirror`;

// A pairing token, single-use and expiring (~10 min) server-side, and the mode the daemon granted, which may be less than
// the one asked for (a member's "sync" comes back "mirror"). A newer daemon also mints the short code a command carries
// instead of the token, with the folder and takeover it was asked for bound to it.
export interface SyncPairing {
    readonly token: string;
    readonly mode: SyncMode;
    readonly code?: string | undefined;
    // When the token and its code lapse, epoch ms.
    readonly expiresAt?: number | undefined;
}

// What rides with the code: the local folder as the person chose it, and whether to take sync over from another device.
// To their own sandbox only, never the platform.
export interface SyncPairAsk {
    readonly syncDir?: string;
    readonly takeover?: boolean;
}

// Mints a pairing on the active sandbox: this card's Enable, and the setup page's hand-off of a hosted project's folder
// to the desktop app.
export const mintSyncPairing = async (mode: SyncMode, ask: SyncPairAsk = {}): Promise<SyncPairing> => {
    // A blank folder is no choice at all, and means the device's default folder, as it did before the folder rode with
    // the mint. The sandbox refuses an empty one, so a cleared field is left out rather than sent.
    const { syncDir, ...rest } = ask;
    const sent: SyncPairAsk = syncDir === undefined || syncDir.trim() === `` ? rest : { ...rest, syncDir };
    const response = await sandboxRequest(`/system/sync/pair${mode === `mirror` ? `?mode=mirror` : ``}`, {
        method: `POST`,
        headers: { "content-type": `application/json` },
        body: JSON.stringify(mode === `mirror` ? {} : sent),
    });
    if (!response.ok) {
        throw new Error(t(`sandbox.useDesktopSync.startFailed`, { status: String(response.status) }));
    }
    const body = (await response.json()) as { token: string; mode?: SyncMode; code?: string; expiresIn?: number };
    return {
        token: body.token,
        mode: body.mode ?? `sync`,
        code: body.code,
        expiresAt: body.expiresIn === undefined ? undefined : Date.now() + body.expiresIn * 1000,
    };
};

// SYNC_DIR is quoted, so a leading ~ must become $HOME to expand; Windows also flips separators. Anything past
// the leading ~ is preserved verbatim.
const toShellPath = (path: string): string => path.replace(/^~(?=\/|$)/, `$HOME`);
const toWindowsPath = (path: string): string => path.replace(/^~(?=[\\/]|$)/, `$HOME`).replace(/\//g, `\\`);

export function useDesktopSync() {
    const { active, daemonUrl } = useSandbox();

    const canOperate = computed(() => roleAtLeast(active.value?.role ?? `owner`, `maintainer`));

    // Whether this sandbox can do desktop sync at all; read from the daemon rather than assumed, since an old
    // daemon that can't answer shouldn't offer sync. Unknown until it answers: starting at "no" put the sentence that
    // sync is impossible here on screen first, then offered sync a moment later.
    const available = ref<boolean | undefined>(undefined);
    // The one-time pairing token from the last Enable click; undefined until minted or spent.
    const pairToken = ref<string | undefined>(undefined);
    // The mode the daemon granted for that token; what the one-liner will actually enroll.
    const pairMode = ref<SyncMode | undefined>(undefined);
    // The short code minted with it, and when both lapse.
    const pairCode = ref<string | undefined>(undefined);
    const pairExpiresAt = ref<number | undefined>(undefined);
    const minting = ref(false);
    // TAKEOVER=1 in the one-liner moves sync here, revoking the other machine's key; only offered when another
    // machine already holds sync.
    const takeover = ref(false);

    const defaultFolder = computed(() => syncFolder(active.value?.name ?? `sandbox`, daemonUrl.value));
    const folder = ref(defaultFolder.value);
    // Re-seeds the folder and drops any stale token when the active sandbox changes.
    watch(
        () => active.value?.id,
        () => {
            folder.value = defaultFolder.value;
            forget();
            takeover.value = false;
        },
    );
    // The folder and takeover were sent with the mint and are bound to its code, so changing either retires the command
    // on screen: Enable mints one that carries the new choice.
    watch([folder, takeover], () => {
        if (pairCode.value !== undefined) {
            forget();
        }
    });

    function forget(): void {
        pairToken.value = undefined;
        pairMode.value = undefined;
        pairCode.value = undefined;
        pairExpiresAt.value = undefined;
    }

    const url = computed(() => daemonUrl.value ?? ``);
    // A mirror-only one-liner carries no SYNC_DIR and never TAKEOVER, since mirror enrollments don't contend.
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

    // The command in a shell: the `sync/<host>/<code>` one-liner, or, for a sandbox no one-liner reaches (localhost, in
    // local dev) or a daemon that mints no code, the token and folder as environment variables.
    const command = computed(() => {
        if (pairToken.value === undefined || url.value === ``) {
            return undefined;
        }
        const host = oneLinerHost(url.value);
        const code = pairCode.value;
        if (host !== undefined && code !== undefined) {
            return (os: CommandOs): string => oneLiner(`sync`, [host, code], os);
        }
        return (os: CommandOs): string => (os === `windows` ? windowsCommand.value : linuxCommand.value);
    });

    // The same enrollment as the two shell commands, for the desktop app's own handoff. No folder: the app asks
    // for one in a system dialog instead.
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

    // Mints (or re-mints) a pairing token.
    const enable = async (mode: SyncMode): Promise<void> => {
        minting.value = true;
        try {
            const pairing = await mintSyncPairing(mode, { syncDir: folder.value, takeover: takeover.value });
            pairMode.value = pairing.mode;
            pairToken.value = pairing.token;
            pairCode.value = pairing.code;
            pairExpiresAt.value = pairing.expiresAt;
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
            // An answer that isn't one (an old daemon's 404) is a no; only silence leaves it unknown.
            if (!response.ok) {
                available.value = false;
                return;
            }
            available.value = ((await response.json()) as Partial<SyncStatus>).available === true;
        } catch {
            // Sandbox not reachable yet; leave the last known state.
        }
    };
    // Subscribes only while a one-liner is live, since that's the one window an enrollment can appear out-of-band.
    // Refreshes the Devices list, not this card: the card has nothing left to re-read once it has minted.
    watch(pairToken, (token) => {
        stop();
        if (token !== undefined) {
            unsubscribe = onRuntimeChanged([`hosts`], () => void invalidatePushedQueries(client, { queryKey: rpcKey(`system.devices`) }));
        }
    });
    // One-shot read of whether sync is available; the Devices list above handles steady polling.
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
        pairExpiresAt,
        minting,
        takeover,
        command,
        desktopLink,
        enable,
        start,
        stop,
    };
}
