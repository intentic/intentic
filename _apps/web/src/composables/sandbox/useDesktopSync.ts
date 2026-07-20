import { computed, ref, watch } from "vue";
import { bashCommand, psCommand } from "../../environments/scriptCommand";
import { sandboxRequest } from "./sandboxClient";
import { syncFolder } from "./syncFolder";
import { useSandbox } from "./useSandbox";

/* Drives the Desktop sync card. "Enable" mints a short-lived, single-use pairing token from the daemon (the
 * browser is already the owner); the copy-paste one-liner carries it, and the agent redeems it once to enroll
 * its SSH key. We poll /system/sync for `enrolled` — the "enabled" signal. No Google sign-in on the laptop. */

// In the shell command SYNC_DIR is double-quoted so a leading ~ must become $HOME to expand; Windows also flips
// separators. Anything the user types past the leading ~ is preserved verbatim.
const toShellPath = (path: string): string => path.replace(/^~(?=\/|$)/, `$HOME`);
const toWindowsPath = (path: string): string => path.replace(/^~(?=[\\/]|$)/, `$HOME`).replace(/\//g, `\\`);

export function useDesktopSync() {
    const { active, daemonUrl } = useSandbox();

    const enrolled = ref(false);
    // The machine currently holding sync (the enrolled key's comment), or undefined when none — for the
    // "Syncing from X" line and the takeover prompt.
    const syncingFrom = ref<string | undefined>(undefined);
    // Machines with a mirror-only enrollment (collaborators forwarding ports to their own localhost) — shown so
    // an active localhost mirror is never invisible in the card.
    const mirroredBy = ref<readonly string[]>([]);
    // Set when the owner just clicked Disable: names the machine that was cut off so the card can point at the
    // local cleanup — revoking stops the agent's ACCESS (its mirror watcher tears itself down within a few
    // polls), not its installation.
    const revokedFrom = ref<string | undefined>(undefined);
    // Whether this sandbox even exposes an SSH tunnel for sync (false ⇒ loopback/preview: sync unavailable).
    const available = ref(false);
    // The one-time pairing token from the last "Enable" click; undefined until minted (or after it's used up).
    const pairToken = ref<string | undefined>(undefined);
    const minting = ref(false);
    // When set, the generated one-liner carries TAKEOVER=1 so the agent moves sync here, revoking the other
    // machine's key. The user opts in explicitly (the card only offers it when another machine holds sync).
    const takeover = ref(false);

    const defaultFolder = computed(() => syncFolder(active.value?.name ?? `sandbox`, active.value?.id ?? ``));
    const folder = ref(defaultFolder.value);
    // Re-seed the folder + drop any stale token when the active sandbox changes (a new context).
    watch(
        () => active.value?.id,
        () => {
            folder.value = defaultFolder.value;
            pairToken.value = undefined;
            takeover.value = false;
            revokedFrom.value = undefined;
        },
    );

    const url = computed(() => daemonUrl.value ?? ``);
    const linuxCommand = computed(() =>
        url.value === `` || pairToken.value === undefined
            ? ``
            : bashCommand(
                  `desktopSh`,
                  `env SANDBOX_URL='${url.value}' PAIR_TOKEN='${pairToken.value}' SYNC_DIR="${toShellPath(folder.value)}"${takeover.value ? ` TAKEOVER='1'` : ``} `,
                  ``,
              ),
    );
    const windowsCommand = computed(() =>
        url.value === `` || pairToken.value === undefined
            ? ``
            : psCommand(
                  `desktopPs1`,
                  `$env:SANDBOX_URL='${url.value}'; $env:PAIR_TOKEN='${pairToken.value}'; $env:SYNC_DIR="${toWindowsPath(folder.value)}";${takeover.value ? ` $env:TAKEOVER='1';` : ``} `,
              ),
    );

    // Mint (or re-mint) a pairing token so the card can reveal the one-liner. Authorized by the browser's Google
    // session (owner) — sandboxRequest attaches it. The token is single-use and expires (~10 min) server-side.
    const enable = async (): Promise<void> => {
        minting.value = true;
        revokedFrom.value = undefined;
        try {
            const response = await sandboxRequest(`/system/sync/pair`, { method: `POST` });
            if (!response.ok) {
                throw new Error(`Couldn't start desktop sync (${response.status}).`);
            }
            pairToken.value = ((await response.json()) as { token: string }).token;
        } finally {
            minting.value = false;
        }
    };

    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = (): void => {
        if (timer !== undefined) {
            clearInterval(timer);
            timer = undefined;
        }
    };
    const refresh = async (): Promise<void> => {
        try {
            const response = await sandboxRequest(`/system/sync`);
            if (!response.ok) {
                return;
            }
            const body = (await response.json()) as { enrolled?: boolean; sshHostname?: string; syncingFrom?: string; mirroredBy?: string[] };
            enrolled.value = body.enrolled === true;
            available.value = typeof body.sshHostname === `string`;
            syncingFrom.value = body.syncingFrom;
            mirroredBy.value = body.mirroredBy ?? [];
        } catch {
            // Sandbox not reachable yet — leave the last known state.
        }
    };
    // Poll every 3s ONLY while a pairing one-liner is live (Enable clicked — fresh enroll OR takeover): that's the
    // only window where enrolled/syncingFrom flip out-of-band as the agent redeems the token, so the card must
    // catch up fast. Just viewing the card (no pairToken — the common /sandbox case) polls zero times; mount does
    // a single refresh for the current state. Replaces the unconditional 3s poll that ran the whole time the card
    // was open. disable() clears pairToken, so it also stops the poll.
    watch(pairToken, (token) => {
        stop();
        if (token !== undefined) {
            timer = setInterval(() => void refresh(), 3000);
        }
    });
    // Mount: one-shot read of the current enrollment state (no steady polling until a pairing starts).
    const start = (): void => {
        void refresh();
    };

    // Disable: revoke EVERY enrollment on the daemon (the owner kill switch) — Mutagen's SSH transport dies and
    // each machine's mirror watcher notices the rejected token and tears itself down. The installed agent stays
    // until `intentic-sync uninstall` runs there; revokedFrom lets the card say so.
    const disable = async (): Promise<void> => {
        revokedFrom.value = syncingFrom.value ?? `the enrolled computer`;
        await sandboxRequest(`/system/authorized-key`, { method: `DELETE` });
        pairToken.value = undefined;
        takeover.value = false;
        await refresh();
    };

    return {
        enrolled,
        syncingFrom,
        mirroredBy,
        revokedFrom,
        available,
        folder,
        defaultFolder,
        pairToken,
        minting,
        takeover,
        linuxCommand,
        windowsCommand,
        enable,
        start,
        stop,
        disable,
    };
}
