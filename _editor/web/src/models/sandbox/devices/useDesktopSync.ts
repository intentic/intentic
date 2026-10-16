import { roleAtLeast } from "@intentic/sandbox-contract/schemas/shared";
import { syncFolder } from "@intentic/sandbox-contract/ids/hostnames";
import { computed, ref, watch } from "vue";
import { t } from "@intentic/ui/i18n";
import { desktopSyncLink } from "../../../app/environments/desktop";
import type { CommandOs, NoticeModel } from "@intentic/ui";
import { bashCommand, oneLiner, oneLinerHost, psCommand } from "../../../app/environments/scriptCommand";
import { SandboxHttpError } from "../../../client/sandbox/sandboxHttpError";
import { sandboxRaw } from "../../../client/sandbox/sandboxRaw";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { useOperation } from "../../../workbench/operations/operations";
import { useSyncStatus } from "./useSyncStatus";

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
    let body;
    try {
        const mirror = mode === `mirror`;
        body = await sandboxRaw(`POST /system/sync/pair`, { query: mirror ? { mode: `mirror` } : undefined, input: mirror ? {} : sent });
    } catch (caught) {
        if (caught instanceof SandboxHttpError) {
            throw new Error(t(`sandbox.useDesktopSync.startFailed`, { status: String(caught.status) }), { cause: caught });
        }
        throw caught;
    }
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

// A pairing as it was minted: the token, and the folder and takeover it was asked for, since a short code is bound to
// both and the command on screen has to keep saying what the code will do.
interface HeldPairing extends SyncPairing {
    readonly folder: string;
    readonly takeover: boolean;
}

// The command the person still has to paste outlives the dialog that showed it: it sits in the operations ledger
// (kept until they put it away, per sandbox), so closing Add device and opening it again finds the same one-liner
// rather than a fresh Enable that would mint, and strand, a second pairing.
const PAIRING = `devices/desktop-sync/pairing`;

export function useDesktopSync() {
    const { active, daemonUrl } = useSandbox();

    const canOperate = computed(() => roleAtLeast(active.value?.role ?? `owner`, `maintainer`));

    // Whether this sandbox can do desktop sync at all; read from the daemon (the one status read, useSyncStatus) rather
    // than assumed, since an old daemon that can't answer shouldn't offer sync. Unknown until it answers: starting at
    // "no" put the sentence that sync is impossible here on screen first, then offered sync a moment later. An answer
    // that isn't one (an old daemon's 404) is a no; only silence leaves it unknown.
    const { status, failure, error: statusError } = useSyncStatus();
    const available = computed<boolean | undefined>(() => {
        if (status.value !== undefined) {
            return status.value.available === true;
        }
        return failure.value instanceof SandboxHttpError ? false : undefined;
    });
    // The pairing from the last Enable click, with the one it replaces carried as progress while a renewal is minted,
    // so the command stays on screen through Renew instead of blinking back to Enable.
    const pairing = useOperation<HeldPairing, NoticeModel, HeldPairing | undefined>(PAIRING);
    const held = computed(() => pairing.value.value ?? pairing.progress.value);
    // The one-time pairing token; undefined until minted or put away.
    const pairToken = computed(() => held.value?.token);
    // The mode the daemon granted for that token; what the one-liner will actually enroll.
    const pairMode = computed(() => held.value?.mode);
    // The short code minted with it, and when both lapse.
    const pairCode = computed(() => held.value?.code);
    const pairExpiresAt = computed(() => held.value?.expiresAt);
    const minting = pairing.busy;
    // TAKEOVER=1 in the one-liner moves sync here, revoking the other machine's key; only offered when another
    // machine already holds sync.
    const takeover = ref(held.value?.takeover ?? false);

    const defaultFolder = computed(() => syncFolder(active.value?.name ?? `sandbox`, daemonUrl.value));
    // A pairing still held brings back the folder it was minted for: the command it carries was bound to that one.
    const folder = ref(held.value?.folder ?? defaultFolder.value);
    // Re-seeds the folder when the active sandbox changes. That sandbox's own pairing, if it holds one, is its own
    // ledger slot, so nothing is put away here.
    watch(
        () => active.value?.id,
        () => {
            folder.value = held.value?.folder ?? defaultFolder.value;
            takeover.value = held.value?.takeover ?? false;
        },
    );
    // The folder and takeover were sent with the mint and are bound to its code, so changing either retires the command
    // on screen: Enable mints one that carries the new choice.
    watch([folder, takeover], ([dir, over]) => {
        const current = held.value;
        if (current?.code !== undefined && (current.folder !== dir || current.takeover !== over)) {
            forget();
        }
    });

    // Puts the command away: pasted, or no longer wanted. A mint still running is left to finish.
    function forget(): void {
        pairing.dismiss();
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

    // Mints (or re-mints) a pairing token. Quiet: a mint takes a moment, and what it hands back waits in the card.
    const enable = async (mode: SyncMode): Promise<void> => {
        const dir = folder.value;
        const over = takeover.value;
        await pairing.run({
            what: t(`sandbox.useDesktopSync.pairing`),
            failed: t(`sandbox.useDesktopSync.couldntPair`),
            quiet: true,
            keep: true,
            progress: held.value,
            task: async () => ({ ...(await mintSyncPairing(mode, { syncDir: dir, takeover: over })), folder: dir, takeover: over }),
        });
    };

    return {
        canOperate,
        available,
        // Why the status could not be read, in words, while there is none to go by.
        statusError,
        folder,
        defaultFolder,
        pairToken,
        pairMode,
        pairExpiresAt,
        minting,
        mintFailure: pairing.failure,
        takeover,
        command,
        desktopLink,
        enable,
        forget,
    };
}
