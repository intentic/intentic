import type { SandboxNeed, SandboxPassword, SandboxPasswords, SandboxPasswordsKeyring } from "@intentic/sandbox-contract/schemas/sandbox-passwords";
import { categoryOf } from "./app/model.js";
import { ACCESS_OF_MODE, type ActivityLine, type PasswordItem, type PasswordRequest, type PasswordsPort, type SandboxRef, type VaultStatus } from "./app/port.js";
import { t } from "./i18n.js";

// THE HOSTED EDITOR'S PASSWORDS PORT: what this sandbox may use from the owner's computers, the credentials it asked for
// that wait on an answer, and its own uses of them, read from the daemon's three /secrets/passwords routes. Nothing is
// managed here: the vault is on the computer, so every method that would change it rejects with a sentence saying so,
// and the app does not offer them in the first place (`capabilities`). Pure over the reads it is handed, so the mapping
// is tested without a host.

export interface SandboxPortReads {
    readonly passwords: () => Promise<SandboxPasswords>;
    readonly needs: () => Promise<{ readonly needs: readonly SandboxNeed[] }>;
    readonly activity: () => Promise<{ readonly lines: readonly { readonly at: number; readonly name: string; readonly lane: string; readonly detail?: string | undefined }[] }>;
    // Hands an `intentic://` link to the desktop app, which opens Passwords on the computer.
    readonly openLink: (link: string) => void;
}

/** A sandbox as a person names it: its host's first label, `intentic-dev`. */
const sandboxRefOf = (url: string): SandboxRef => {
    try {
        return { url, label: new URL(url).hostname.split(`.`)[0] ?? url };
    } catch {
        // allow(silent-catch): an address that does not parse is still the best name there is for it
        return { url, label: url };
    }
};

const passwordItemOf = (item: SandboxPassword, sandbox: SandboxRef): PasswordItem => ({
    name: item.name,
    title: item.title,
    kind: item.kind,
    category: categoryOf(item.origins, item.kind),
    origins: item.origins,
    fresh: false,
    unverified: false,
    createdAt: item.updatedAt,
    updatedAt: item.updatedAt,
    lastUsedAt: item.lastUsedAt,
    versions: 1,
    anyField: item.anyField,
    access: [{ sandbox, level: ACCESS_OF_MODE[item.mode], since: item.updatedAt }],
    computer: item.machine,
});

const requestOf = (need: SandboxNeed, sandbox: SandboxRef): PasswordRequest => ({
    id: need.id,
    sandbox,
    origin: need.origin,
    username: need.username,
    detail: need.detail,
    at: need.at,
    matches: [],
    computer: need.machine,
});

const computersOf = (keyrings: readonly SandboxPasswordsKeyring[]): string => (keyrings.length === 0 ? t(`hosted.noComputer`) : keyrings.map((keyring) => keyring.machine).join(`, `));

/** Ready while any computer has Passwords set up; otherwise a pointer to the desktop app, where it is set up. */
export const statusOf = (keyrings: readonly SandboxPasswordsKeyring[]): VaultStatus => {
    const ready = keyrings.filter((keyring) => keyring.setUp);
    const first = ready[0];
    if (first === undefined) {
        return { kind: `not-set-up`, canSetUp: false, why: t(`hosted.notSetUp`), hello: false, computer: computersOf(keyrings) };
    }
    return {
        kind: `ready`,
        locked: ready.every((keyring) => keyring.locked === true),
        unlock: [],
        pendingCaptures: 0,
        remember: first.remember ?? { browser: false, terminal: false, apps: false, phone: false, sandbox: false },
        rememberAsked: true,
        computer: computersOf(ready),
    };
};

const activityLineOf = (line: { readonly at: number; readonly name: string; readonly detail?: string | undefined }): ActivityLine => ({
    at: line.at,
    op: `use`,
    outcome: `ok`,
    name: line.name,
    target: line.detail,
});

/** The link that opens Passwords in the desktop app, on one entry when named. */
export const manageLink = (name?: string): string => (name === undefined ? `intentic://passwords` : `intentic://passwords?entry=${encodeURIComponent(name)}`);

export const createSandboxPort = (reads: SandboxPortReads): PasswordsPort => {
    const elsewhere = async (): Promise<never> => {
        throw new Error(t(`hosted.manageOnComputer`));
    };
    return {
        capabilities: { scope: `sandbox`, manage: false, reveal: false },
        status: async () => statusOf((await reads.passwords()).keyrings),
        list: async () => {
            const read = await reads.passwords();
            const sandbox = sandboxRefOf(read.sandbox);
            return read.items.map((item) => passwordItemOf(item, sandbox));
        },
        sandboxes: async () => [sandboxRefOf((await reads.passwords()).sandbox)],
        setUp: elsewhere,
        unlock: elsewhere,
        lock: elsewhere,
        reveal: elsewhere,
        copy: elsewhere,
        add: elsewhere,
        edit: elsewhere,
        remove: elsewhere,
        setAccess: elsewhere,
        history: elsewhere,
        restore: elsewhere,
        undo: elsewhere,
        // Nothing here is ever "just saved": a capture is the computer's to show.
        seen: async () => {},
        requests: async () => {
            const [read, { needs }] = await Promise.all([reads.passwords(), reads.needs()]);
            const sandbox = sandboxRefOf(read.sandbox);
            return needs.filter((need) => need.state === `pending`).map((need) => requestOf(need, sandbox));
        },
        answer: elsewhere,
        activity: async (name) => {
            const { lines } = await reads.activity();
            return lines.filter((line) => name === undefined || line.name === name).map(activityLineOf);
        },
        settings: elsewhere,
        updateSettings: elsewhere,
        sources: elsewhere,
        setUpSource: elsewhere,
        importRows: elsewhere,
        manageOnComputer: (name) => reads.openLink(manageLink(name)),
    };
};
