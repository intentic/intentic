import { t } from "@intentic/ui/i18n";
import {
    ACCESS_OF_MODE,
    type ActivityLine,
    categoryOf,
    MODE_OF_ACCESS,
    type PasswordItem,
    type PasswordRequest,
    type PasswordsPort,
    type SandboxRef,
    type VaultStatus,
} from "@intentic/ext-passwords/app";
import { originsOfRules, REMEMBER_NOTHING, titleForOrigin } from "@intentic/sandbox-contract/policy/keyring-origins";
import { deviceStatus } from "../desktop";
import { pollPasswordEvents } from "./tauriEvents";
import {
    type KeyringActivityLine,
    type KeyringEntry,
    KeyringRefusal,
    type KeyringStatus,
    keyringApp,
    keyringList,
    keyringLock,
    keyringRemove,
    keyringSetup,
    keyringShare,
    keyringStatus,
    keyringUnlock,
    keyringUnshare,
    keyringUpgrade,
} from "./keyringCommands";

// THE PASSWORDS APP'S PORT ON THIS COMPUTER: the app (@intentic/ext-passwords/app) over `intentic-machine keyring`,
// through the app's Tauri commands (desktop.ts, src-tauri/src/keyring.rs). Everything is managed here, where the vault
// is: scope "computer". The keyring's own shapes become the app's here and nowhere else: an entry's rules its "Works
// on" places, a share's mode its access level, a link id its sandbox's name.

/** This computer's links to sandboxes, and its name, as the machine agent reports them. Read at most every 30 s. */
interface Here {
    readonly computer: string;
    readonly links: readonly { readonly sandboxUrl: string; readonly id: string }[];
}

const HERE_MS = 30_000;

/**
 * What a person calls a sandbox from its address: its host's first label without the id the platform appends,
 * `intentic-dev` of intentic-dev-2c8eb2c5b3a5.intentic.app.
 */
export const sandboxLabel = (url: string): string => {
    try {
        return (new URL(url).hostname.split(`.`)[0] ?? url).replace(/-[0-9a-f]{12}$/u, ``);
    } catch {
        // allow(silent-catch): a link id or an address out of shape is named as it was written
        return url;
    }
};

/** One entry as the app draws it. Pure. */
export const itemOf = (entry: KeyringEntry, sandboxOf: (sandbox: string) => SandboxRef): PasswordItem => {
    const origins = originsOfRules(entry);
    const first = origins[0];
    return {
        name: entry.name,
        title: entry.title ?? (first === undefined ? entry.name : titleForOrigin(first)),
        kind: entry.kind,
        category: categoryOf(origins, entry.kind),
        username: entry.username,
        origins,
        captured: entry.captured,
        fresh: entry.fresh === true,
        unverified: entry.unverified === true,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        lastUsedAt: entry.lastUsedAt,
        versions: entry.versions ?? 0,
        health: entry.health,
        backend: entry.backend?.backend,
        anyField: entry.anyField,
        note: entry.note,
        access: entry.shares.map((share) => ({ sandbox: sandboxOf(share.sandbox), level: ACCESS_OF_MODE[share.mode], since: share.sharedAt })),
    };
};

/** The machine's status as the app's. Pure, so each state is a test. */
export const vaultOf = (status: KeyringStatus | undefined, computer: string, rememberAsked: boolean): VaultStatus => {
    if (status === undefined) {
        return { kind: `unavailable`, reason: t(`desktop.passwords.noAgent`) };
    }
    if (status.setUp && status.state !== undefined) {
        return {
            kind: `ready`,
            locked: status.state.locked,
            unlockedUntil: status.state.unlockedUntil,
            unlock: status.state.unlock,
            pendingCaptures: status.state.pendingCaptures ?? 0,
            remember: status.state.remember ?? REMEMBER_NOTHING,
            rememberAsked,
            computer,
        };
    }
    if (status.setUp) {
        return { kind: `unavailable`, reason: t(`desktop.passwords.notRunning`) };
    }
    // An agent from before the protected vault says nothing of whether one can be made here: it cannot make one.
    const support = status.support ?? { canSetUp: false, why: t(`desktop.passwords.oldAgent`), hello: false };
    return { kind: `not-set-up`, canSetUp: support.canSetUp, why: support.why, hello: support.hello, computer };
};

// The vault's agents' requests, as the app's Requests view lists them.
const readRequests = async (): Promise<readonly PasswordRequest[]> => {
    const { pending } = await keyringApp(`needs`, {});
    return pending.map((need) => ({
        id: need.id,
        sandbox: { url: need.sandbox, label: sandboxLabel(need.sandbox) },
        origin: need.need.origin,
        username: need.need.username,
        detail: need.need.detail,
        at: need.at,
        matches: need.matches,
    }));
};

const lineOf = (line: KeyringActivityLine): ActivityLine => ({
    at: line.at,
    op: line.op,
    outcome: line.outcome,
    name: line.secret,
    sandbox: line.sandbox === undefined ? undefined : { url: line.sandbox, label: sandboxLabel(line.sandbox) },
    program: line.program,
    target: line.target,
    asked: line.asked,
});

// This computer's name and the sandboxes linked to it, read from the machine agent's status at most once a minute.
const hereReader = (): (() => Promise<Here>) => {
    let here: { at: number; read: Promise<Here> } | undefined;
    return () => {
        if (here === undefined || Date.now() - here.at > HERE_MS) {
            here = {
                at: Date.now(),
                read: deviceStatus().then(
                    (status) => ({ computer: status?.sync.hostname ?? ``, links: status?.device.links ?? [] }),
                    () => ({ computer: ``, links: [] }),
                ),
            };
        }
        return here.read;
    };
};

// A share names its sandbox by address or by link id; either way the app is told its address and its name.
const sandboxOfWith =
    (links: Here[`links`]) =>
    (sandbox: string): SandboxRef => {
        const url = links.find((link) => link.id === sandbox)?.sandboxUrl ?? sandbox;
        return { url, label: sandboxLabel(url) };
    };

const readStatus = async (readHere: () => Promise<Here>): Promise<VaultStatus> => {
    const where = readHere();
    let read: KeyringStatus | undefined;
    try {
        read = await keyringStatus();
    } catch (failure) {
        if (failure instanceof KeyringRefusal && failure.code === `agent-too-old`) {
            return { kind: `unavailable`, reason: failure.message };
        }
        throw failure;
    }
    // The keyring updates only at its person's word, separately from the app and machine agent. Probe the app's
    // protocol before declaring it ready: a pre-Passwords keyring knows `state` and `list`, but rejects `needs`.
    let asked = true;
    if (read?.setUp && read.state !== undefined) {
        try {
            asked = (await keyringApp(`settings`, {})).settings.rememberAskedAt !== undefined;
        } catch (failure) {
            if (failure instanceof KeyringRefusal && failure.code === `bad-grant`) {
                return {
                    kind: `unavailable`,
                    reason: t(`desktop.passwords.needsUpdate`, { version: read.state.version }),
                    fix: { label: t(`desktop.passwords.update`), run: keyringUpgrade },
                };
            }
            throw failure;
        }
    }
    return vaultOf(read, (await where).computer, asked);
};

const revealValue: PasswordsPort[`reveal`] = (name, version) => keyringApp(`reveal`, version === undefined ? { name } : { name, version });

// Only the fields the app changed go to the keyring, and a value only when one was typed.
const editEntry: PasswordsPort[`edit`] = async (name, patch) => {
    const { value, ...rest } = patch;
    const fields = Object.fromEntries(Object.entries(rest).filter(([, given]) => given !== undefined));
    await keyringApp(`edit`, value === undefined ? { name, patch: fields } : { name, patch: fields, value });
};

// Off is no share at all; the other three are the keyring's share modes.
const setAccessFor: PasswordsPort[`setAccess`] = (name, sandbox, level) => (level === `off` ? keyringUnshare(name, sandbox) : keyringShare(name, sandbox, MODE_OF_ACCESS[level]));

const readActivity: PasswordsPort[`activity`] = async (name) => (await keyringApp(`activity`, name === undefined ? {} : { name })).lines.map(lineOf);

export const tauriPasswordsPort = (): PasswordsPort => {
    const readHere = hereReader();
    let titles = new Map<string, string>();
    const list = async (): Promise<readonly PasswordItem[]> => {
        const [entries, { links }] = await Promise.all([keyringList(), readHere()]);
        const items = entries.map((entry) => itemOf(entry, sandboxOfWith(links)));
        titles = new Map(items.map((item) => [item.name, item.title]));
        return items;
    };
    return {
        capabilities: { scope: `computer`, manage: true, reveal: true },
        status: () => readStatus(readHere),
        list,
        sandboxes: async () => (await readHere()).links.map((link) => ({ url: link.sandboxUrl, label: sandboxLabel(link.sandboxUrl) })),
        setUp: async ({ hello }) => ({ recoveryKey: (await keyringSetup(hello)).recoveryKey ?? `` }),
        unlock: (minutes) => keyringUnlock(minutes),
        lock: () => keyringLock(),
        reveal: revealValue,
        copy: (name, field) => keyringApp(`copy`, { name, field }),
        add: async (draft) => ({ name: (await keyringApp(`save`, { title: draft.title, username: draft.username, value: draft.value, kind: draft.kind, origins: draft.origins, note: draft.note })).name }),
        edit: editEntry,
        remove: (name) => keyringRemove(name),
        setAccess: setAccessFor,
        history: async (name) => (await keyringApp(`history`, { name })).versions,
        restore: async (name, version) => {
            await keyringApp(`restore`, { name, version });
        },
        undo: async (name, at) => {
            await keyringApp(`undo`, { name, at });
        },
        seen: async (names) => {
            await keyringApp(`seen`, { names });
        },
        requests: readRequests,
        answer: async (id, answer, options) => {
            await keyringApp(`answer-need`, { id, answer, ...options });
        },
        activity: readActivity,
        settings: async () => (await keyringApp(`settings`, {})).settings,
        updateSettings: async (patch) => (await keyringApp(`set-settings`, { patch })).settings,
        sources: async () => (await keyringApp(`sources`, {})).sources,
        setUpSource: async (source) => {
            await keyringApp(`setup-source`, { source });
        },
        importRows: (rows, from) => keyringApp(`import`, { from, rows }),
        subscribe: (listener) => pollPasswordEvents(listener, { requests: readRequests, titleOf: (name) => titles.get(name) }),
    };
};
