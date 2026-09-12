import { roleAtLeast, type SyncStatus, syncFolder } from "@intentic/sandbox-contract";
import { useQueryClient } from "@tanstack/vue-query";
import { computed, ref, watch } from "vue";
import { desktopSyncLink } from "../../../../app/environments/desktop";
import { bashCommand, psCommand } from "../../../../app/environments/scriptCommand";
import { onRuntimeChanged } from "../../live/runtimeEvents";
import { DEVICES } from "../../../../lib/queryKeys";
import { sandboxRequest } from "../../client/sandboxClient";
import { useSandbox } from "../../client/useSandbox";

// Mints a device pairing and renders the one-liner that spends it (single-use, redeemed once to enroll an SSH
// key). Mode reflects what the daemon granted, never what was requested. Everything else about an existing
// pairing now lives on that device's row in the Devices list.

type SyncMode = `sync` | `mirror`;

// SYNC_DIR is quoted, so a leading ~ must become $HOME to expand; Windows also flips separators. Anything past
// the leading ~ is preserved verbatim.
const toShellPath = (path: string): string => path.replace(/^~(?=\/|$)/, `$HOME`);
const toWindowsPath = (path: string): string => path.replace(/^~(?=[\\/]|$)/, `$HOME`).replace(/\//g, `\\`);

export function useDesktopSync() {
    const { active, daemonUrl } = useSandbox();

    const canOperate = computed(() => roleAtLeast(active.value?.role ?? `owner`, `maintainer`));

    // Whether this sandbox can do desktop sync at all; read from the daemon rather than assumed, since an old
    // daemon that can't answer shouldn't offer sync.
    const available = ref(false);
    // The one-time pairing token from the last Enable click; undefined until minted or spent.
    const pairToken = ref<string | undefined>(undefined);
    // The mode the daemon granted for that token; what the one-liner will actually enroll.
    const pairMode = ref<SyncMode | undefined>(undefined);
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
            pairToken.value = undefined;
            pairMode.value = undefined;
            takeover.value = false;
        },
    );

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

    // Mints (or re-mints) a pairing token, single-use and expiring (~10 min) server-side. The daemon may grant a
    // lesser mode than requested (a member's "sync" comes back "mirror").
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
            // Sandbox not reachable yet; leave the last known state.
        }
    };
    // Subscribes only while a one-liner is live, since that's the one window an enrollment can appear out-of-band.
    // Refreshes the Devices list, not this card: the card has nothing left to re-read once it has minted.
    watch(pairToken, (token) => {
        stop();
        if (token !== undefined) {
            unsubscribe = onRuntimeChanged([`hosts`], () => void client.invalidateQueries({ queryKey: DEVICES.of() }));
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
