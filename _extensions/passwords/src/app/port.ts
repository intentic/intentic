import type { KeyringNeedAnswer, KeyringOrigin, KeyringRemember, KeyringShareMode } from "@intentic/sandbox-contract/schemas/keyring";

// THE PASSWORDS APP'S ONE DOOR TO THE WORLD. The app (PasswordsApp.vue and everything under src/app) knows nothing of
// Tauri, the sandbox daemon, the keyring's pipe or the extension host: it is handed a PasswordsPort and draws what the
// port says. Two hosts implement it today:
//
//   - the desktop app (`_editor/desktop-app/src/passwords/tauriPort.ts`), over intentic-machine's `keyring` commands,
//     scope "computer": the vault on this computer, managed in full;
//   - the hosted editor (this extension's `src/sandboxPort.ts`), over the sandbox daemon, scope "sandbox": what this
//     sandbox may use from the owner's computers, the requests it is waiting on, and its activity, managed on the computer.
//
// Removing Passwords is deleting this package and its two adapters; making it an application of its own is mounting
// PasswordsApp with tauriPort in a shell of its own. Everything here is a plain value: no class, no Vue ref.

/** Where a password belongs, as the app groups them. */
export type PasswordCategory = "site" | "app" | "terminal" | "phone" | "note";

/** How an agent of one sandbox may use one password: the segmented control on its detail. */
export type AccessLevel = "ask" | "while-here" | "always" | "off";

export const ACCESS_OF_MODE = { "each-use": "ask", "while-here": "while-here", copy: "always" } as const satisfies Readonly<Record<KeyringShareMode, AccessLevel>>;
export const MODE_OF_ACCESS = { ask: "each-use", "while-here": "while-here", always: "copy" } as const satisfies Readonly<Record<Exclude<AccessLevel, "off">, KeyringShareMode>>;

/** A sandbox as the app names it: its address, and what a person calls it (its name in the account, else its host). */
export interface SandboxRef {
    readonly url: string;
    readonly label: string;
}

export interface AgentAccess {
    readonly sandbox: SandboxRef;
    readonly level: Exclude<AccessLevel, "off">;
    readonly since: number;
}

export type CaptureSource = "browser" | "askpass" | "git" | "app" | "phone" | "terminal" | "import" | "agent" | "manual";

export interface PasswordItem {
    /** The `{{secret:NAME}}` an agent writes. Unique per computer. */
    readonly name: string;
    readonly title: string;
    readonly kind: "password" | "text";
    readonly category: PasswordCategory;
    readonly username?: string | undefined;
    /** Where it works: the "Works on" chips. */
    readonly origins: readonly KeyringOrigin[];
    readonly captured?: { readonly source: CaptureSource; readonly via: string; readonly at: number } | undefined;
    /** Saved or changed by a capture and not yet looked at: the `new` pill, the "Just saved" filter. */
    readonly fresh: boolean;
    readonly unverified: boolean;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly lastUsedAt?: number | undefined;
    readonly versions: number;
    readonly health?: { readonly weak: boolean; readonly reused: boolean } | undefined;
    /** Read from a password manager at each use rather than kept. */
    readonly backend?: "1password" | "bitwarden" | "keepassxc" | undefined;
    readonly anyField: boolean;
    readonly note?: string | undefined;
    readonly access: readonly AgentAccess[];
    /** The computer it is kept on, in the sandbox scope where several may answer. */
    readonly computer?: string | undefined;
}

export type UnlockWay = "hello" | "passphrase" | "polkit";

export type VaultStatus =
    | { readonly kind: "unavailable"; readonly reason: string; readonly fix?: { readonly label: string; readonly run: () => Promise<void> } | undefined }
    | {
          readonly kind: "not-set-up";
          /** False where this computer cannot keep a protected vault (no administrator, macOS for now): `why` says so. */
          readonly canSetUp: boolean;
          readonly why?: string | undefined;
          /** Windows Hello is here, so the daily unlock is a tap and the passphrase a recovery key. */
          readonly hello: boolean;
          readonly computer: string;
      }
    | {
          readonly kind: "ready";
          readonly locked: boolean;
          readonly unlockedUntil?: number | undefined;
          readonly unlock: readonly UnlockWay[];
          readonly pendingCaptures: number;
          readonly remember: KeyringRemember;
          /** Whether the one-time "remember the passwords you type" has been answered, either way. */
          readonly rememberAsked: boolean;
          readonly computer: string;
      };

export interface PasswordDraft {
    readonly title: string;
    readonly username?: string | undefined;
    readonly value: string;
    readonly kind: "password" | "text";
    readonly origins: readonly KeyringOrigin[];
    readonly note?: string | undefined;
}

export interface PasswordPatch {
    readonly title?: string | undefined;
    readonly username?: string | undefined;
    readonly value?: string | undefined;
    readonly kind?: "password" | "text" | undefined;
    readonly origins?: readonly KeyringOrigin[] | undefined;
    readonly note?: string | undefined;
    readonly anyField?: boolean | undefined;
}

export interface PasswordVersion {
    readonly version: number;
    readonly at: number;
    readonly captured?: { readonly source: CaptureSource; readonly via: string; readonly at: number } | undefined;
}

export interface PasswordRequest {
    readonly id: string;
    readonly sandbox: SandboxRef;
    readonly origin: KeyringOrigin;
    readonly username?: string | undefined;
    readonly detail: string;
    readonly at: number;
    /** Names that fit, best first; empty when none does yet (the app offers to type it once). */
    readonly matches: readonly string[];
    readonly computer?: string | undefined;
}

export interface ActivityLine {
    readonly at: number;
    /** `release`, `type`, `askpass`, `capture`, `fill`, `need`, `add`, `edit`, `remove`, `share`, … */
    readonly op: string;
    readonly outcome: string;
    readonly name?: string | undefined;
    readonly sandbox?: SandboxRef | undefined;
    readonly program?: string | undefined;
    readonly target?: string | undefined;
    readonly asked?: boolean | undefined;
}

export type RememberSource = keyof KeyringRemember;

/** One source of remembered passwords, as Settings and the first-run step list it. */
export interface SourceStatus {
    readonly source: RememberSource;
    /** Whether remembering is on for it. */
    readonly on: boolean;
    /** Whether what it needs is in place: the extension's permission, askpass, the phone's autofill. */
    readonly ready: boolean;
    /** Whether this computer can have it at all (no Brave/Chrome/Edge, no paired phone): `why` says so. */
    readonly available: boolean;
    readonly why?: string | undefined;
    /** Who it is here: `Brave`, `Pixel 8`. */
    readonly detail?: string | undefined;
    /** What turning it on will ask, said beforehand: "Brave will ask once". */
    readonly asks?: string | undefined;
}

export interface PasswordsSettings {
    readonly remember: KeyringRemember;
    readonly neverSave: readonly KeyringOrigin[];
    readonly autoLockMinutes: number;
    readonly lockOnSleep: boolean;
}

export type PasswordsSettingsPatch = Partial<Omit<PasswordsSettings, "remember">> & { readonly remember?: Partial<KeyringRemember> | undefined };

/** One row of an import, parsed in the app from the file the person picked (src/app/import). Values never logged. */
export interface ImportRow {
    readonly origin: KeyringOrigin;
    readonly title?: string | undefined;
    readonly username?: string | undefined;
    readonly value: string;
    readonly note?: string | undefined;
}

export interface ImportResult {
    readonly saved: number;
    readonly updated: number;
    readonly unchanged: number;
    readonly skipped: number;
}

/** What the app hears without asking: the toasts' "Saved github.com", a request arriving, the lock changing. */
export type PasswordsEvent =
    | { readonly kind: "captured"; readonly outcome: "saved" | "updated"; readonly name: string; readonly title: string; readonly via: string; readonly at: number }
    | { readonly kind: "request"; readonly request: PasswordRequest }
    | { readonly kind: "changed" };

export interface PasswordsCapabilities {
    /** "computer": this computer's vault, in full. "sandbox": what this sandbox may use, read-only, managed on the computer. */
    readonly scope: "computer" | "sandbox";
    /** Adding, editing, removing, access, settings, import, setup. */
    readonly manage: boolean;
    /** Show and Copy of a value (always behind the person's yes at the computer). */
    readonly reveal: boolean;
}

/**
 * Everything the app may ask. A method the scope cannot do rejects with a sentence saying where it can be done; the
 * app does not offer it in the first place (`capabilities`). Every rejection's message is shown as it is, so it is
 * written for the person: what happened and what to do.
 */
export interface PasswordsPort {
    readonly capabilities: PasswordsCapabilities;

    readonly status: () => Promise<VaultStatus>;
    readonly list: () => Promise<readonly PasswordItem[]>;
    readonly sandboxes: () => Promise<readonly SandboxRef[]>;

    /** Sets up the protected vault: one administrator prompt, Windows Hello, and a recovery key shown once. */
    readonly setUp: (options: { readonly hello: boolean }) => Promise<{ readonly recoveryKey: string }>;
    readonly unlock: (minutes?: number) => Promise<void>;
    readonly lock: () => Promise<void>;

    readonly reveal: (name: string, version?: number) => Promise<{ readonly value: string; readonly username?: string | undefined }>;
    /** Put on the clipboard by the keyring itself, and cleared at `clearsAt`. */
    readonly copy: (name: string, field: "password" | "username") => Promise<{ readonly clearsAt: number }>;

    readonly add: (draft: PasswordDraft) => Promise<{ readonly name: string }>;
    readonly edit: (name: string, patch: PasswordPatch) => Promise<void>;
    readonly remove: (name: string) => Promise<void>;
    readonly setAccess: (name: string, sandbox: string, level: AccessLevel) => Promise<void>;

    readonly history: (name: string) => Promise<readonly PasswordVersion[]>;
    readonly restore: (name: string, version: number) => Promise<void>;
    /** The toast's Undo for a capture made at `at`. */
    readonly undo: (name: string, at: number) => Promise<void>;
    /** Looked at: they leave "Just saved". */
    readonly seen: (names: readonly string[]) => Promise<void>;

    readonly requests: () => Promise<readonly PasswordRequest[]>;
    /** `value` when nothing matched and the person typed it once in the app. */
    readonly answer: (id: string, answer: KeyringNeedAnswer, options?: { readonly name?: string; readonly value?: string }) => Promise<void>;

    readonly activity: (name?: string) => Promise<readonly ActivityLine[]>;

    readonly settings: () => Promise<PasswordsSettings>;
    readonly updateSettings: (patch: PasswordsSettingsPatch) => Promise<PasswordsSettings>;
    readonly sources: () => Promise<readonly SourceStatus[]>;
    /** Puts in place what a source needs (askpass and the git helper, the browser's permission, the phone's autofill). */
    readonly setUpSource: (source: RememberSource) => Promise<void>;

    readonly importRows: (rows: readonly ImportRow[], from: string) => Promise<ImportResult>;

    /** The sandbox scope's way to the computer: opens the desktop app on Passwords (on `name`, when given). */
    readonly manageOnComputer?: ((name?: string) => void) | undefined;

    /** Subscribe to what happens without asking; returns the unsubscribe. Absent: the app reads again on focus. */
    readonly subscribe?: ((listener: (event: PasswordsEvent) => void) => () => void) | undefined;
}
