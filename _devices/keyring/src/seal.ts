import type { SealedBox } from "@intentic/sandbox-contract/schemas/keyring";
import { seal } from "@intentic/sandbox-contract/keyring-seal";

// A value this computer's own programs hand the keyring (`intentic-machine keyring add`, the desktop app) is sealed to
// the vault's inbox key first: a process squatting the pipe, or reading what crosses it, holds only ciphertext. The
// inbox key is in `state.keys.inbox`.
export const sealForKeyring = (inboxKey: string, name: string, value: string): SealedBox => seal(inboxKey, value, { kind: "inbox", sandbox: "local", secret: name });

// A master password on its way to `set-master-password`: sealed the same way, for a purpose no entry's value can have
// (an entry's name is never `master-password`, and its inbox box says `local`), so neither box can stand in for the other.
export const MASTER_PASSWORD_PURPOSE = { kind: "inbox", sandbox: "unlock", secret: "master-password" } as const;
export const sealMasterPassword = (inboxKey: string, password: string): SealedBox => seal(inboxKey, password, MASTER_PASSWORD_PURPOSE);
