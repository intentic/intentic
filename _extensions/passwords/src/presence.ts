import type { SandboxPasswords } from "@intentic/sandbox-contract/schemas/sandbox-passwords";

// WHETHER THE PASSWORDS TILE IS ON THE RAIL (2026-10-19). A new owner does not meet a password manager: Intentic is an
// agent workspace first, and a tile for a vault nobody has set up asks for trust it has not earned. The tile comes onto
// the rail once Passwords means something here: a computer of the owner's has it set up, a password is shared with this
// sandbox, or an agent's request waits on an answer. Before that, the way in is the desktop app, where the vault is made.

/** What the rail knows of Passwords on this sandbox: `shown` stays undefined until the first read answers. */
export interface PasswordsPresence {
    readonly pending: number;
    readonly shown: boolean | undefined;
}

export const UNREAD_PRESENCE: PasswordsPresence = { pending: 0, shown: undefined };

/**
 * The next presence from one read. Once shown it stays shown for the editor's life on this sandbox: a computer going to
 * sleep is no reason for a tile the owner has been using to leave the rail under them.
 */
export const presenceOf = (previous: PasswordsPresence, passwords: Pick<SandboxPasswords, "items" | "keyrings">, pending: number): PasswordsPresence => ({
    pending,
    shown: previous.shown === true || pending > 0 || passwords.items.length > 0 || passwords.keyrings.some((keyring) => keyring.setUp === true),
});
