import { roleAtLeast, type SyncStatus, syncFolder } from "@intentic/sandbox-contract";
import { timeAgo } from "@intentic/ui";
import { computed, ref, watch } from "vue";
import { desktopSyncLink } from "../../environments/desktop";
import { bashCommand, psCommand } from "../../environments/scriptCommand";
import { sandboxRequest } from "./sandboxClient";
import { useSandbox } from "./useSandbox";

/* Drives the Desktop sync card. "Enable" mints a short-lived, single-use pairing token from the daemon; the
 * copy-paste one-liner carries it, and the agent redeems it once to enroll its SSH key. We poll /system/sync
 * for `enrolled`, the "enabled" signal. No Google sign-in on the laptop.
 *
 * Pairings carry a MODE: "sync" (file sync + port mirroring, single holder) or "mirror" (ports only, unlimited
 * machines). The daemon grants full sync to the operating tier and mirror-only below it, so pairMode reflects
 * the daemon's ANSWER, and the one-liner/copy follow it, never the request. */

type SyncMode = `sync` | `mirror`;

/* How long since the holder's last poll before its sync counts as STOPPED. The daemon refreshes seenAt at most
 * once a minute while the agent is polling (every 5s), so a live holder is always well inside this; anything older
 * means the agent stopped polling, the machine is asleep or offline, or its pairing was taken over by another
 * sandbox's setup on the same computer. Enrollment alone used to be the signal, so the card claimed "Syncing from
 * X" for as long as the record existed, whether or not anything was syncing. */
const SYNC_STALE_MS = 5 * 60 * 1000;

// In the shell command SYNC_DIR is double-quoted so a leading ~ must become $HOME to expand; Windows also flips
// separators. Anything the user types past the leading ~ is preserved verbatim.
const toShellPath = (path: string): string => path.replace(/^~(?=\/|$)/, `$HOME`);
const toWindowsPath = (path: string): string => path.replace(/^~(?=[\\/]|$)/, `$HOME`).replace(/\//g, `\\`);

export function useDesktopSync() {
    const { active, daemonUrl } = useSandbox();

    const canOperate = computed(() => roleAtLeast(active.value?.role ?? `owner`, `maintainer`));

    const enrolled = ref(false);
    // The machine currently holding sync (the enrolled key's comment), or undefined when none, for the
    // "Syncing from X" line and the takeover prompt.
    const syncingFrom = ref<string | undefined>(undefined);
    // When that machine last used its enrollment; undefined for one that never has. The agent's ports poll is the
    // heartbeat behind it (the daemon stamps it on verify).
    const syncSeenAt = ref<number | undefined>(undefined);
    /* WHICH FOLDER ON THAT MACHINE IS THIS SANDBOX'S /work, the one thing "Syncing from radarsu-rog" never said,
     * and the first thing anyone asks of it. The daemon cannot derive it: SYNC_DIR is the agent's own local state,
     * so it arrives only inside the machine's report, and only on a "sync" pairing (a mirror enrollment carries no
     * folder at all, see scopedReport's disclosure rule). At most one machine holds sync, so the first reported
     * localDir IS the holder's folder. Undefined while an enrolled machine has yet to post a report, which the
     * card says out loud rather than filling in with the default path it would have guessed. */
    const syncingPath = ref<string | undefined>(undefined);
    // Machines with a mirror-only enrollment (collaborators forwarding ports to their own localhost), shown so
    // an active localhost mirror is never invisible in the card.
    const mirroredBy = ref<readonly string[]>([]);
    // Set when the owner just clicked Disable: names the machine that was cut off so the card can point at the
    // local cleanup, revoking stops the agent's ACCESS (its mirror watcher tears itself down within a few
    // polls), not its installation.
    const revokedFrom = ref<string | undefined>(undefined);
    // Whether this sandbox can do desktop sync at all. The daemon carries the transport on its own HTTPS
    // surface now, so a sandbox that answers this read can also sync, it used to depend on whether that
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

    // Whether the holder has gone quiet: enrolled, but its agent hasn't polled in long enough that nothing is
    // reaching the folder any more. An enrollment that has NEVER been used (no seenAt) counts as stopped too,
    // that is a setup that didn't finish.
    const syncStopped = computed(
        () => syncingFrom.value !== undefined && (syncSeenAt.value === undefined || Date.now() - syncSeenAt.value > SYNC_STALE_MS),
    );
    // "just now" / "12m ago" / an absolute timestamp once it's old, per the shared formatter.
    const syncLastSeen = computed(() => (syncSeenAt.value === undefined ? undefined : timeAgo(syncSeenAt.value)));

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
            revokedFrom.value = undefined;
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
        revokedFrom.value = undefined;
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
            const body = (await response.json()) as Partial<SyncStatus>;
            enrolled.value = body.enrolled === true;
            available.value = body.available === true;
            syncingFrom.value = body.syncingFrom;
            syncSeenAt.value = body.syncSeenAt;
            mirroredBy.value = body.mirroredBy ?? [];
            syncingPath.value = (body.machines ?? [])
                .flatMap((machine) => machine.pairings)
                .find((pairing) => pairing.localDir !== undefined)?.localDir;
        } catch {
            // Sandbox not reachable yet, leave the last known state.
        }
    };
    // Poll every 3s ONLY while a pairing one-liner is live (Enable clicked, fresh enroll OR takeover): that's the
    // only window where enrolled/syncingFrom flip out-of-band as the agent redeems the token, so the card must
    // catch up fast. Just viewing the card (no pairToken, the common /sandbox case) polls zero times; mount does
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

    // Disable: revoke EVERY enrollment on the daemon (the owner kill switch). Mutagen's SSH transport dies and
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
        canOperate,
        enrolled,
        syncingFrom,
        syncingPath,
        syncStopped,
        syncLastSeen,
        mirroredBy,
        revokedFrom,
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
        disable,
    };
}
