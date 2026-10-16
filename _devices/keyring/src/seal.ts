import type { SealedBox } from "@intentic/sandbox-contract";
import { seal } from "@intentic/sandbox-contract/keyring-seal";

// A value this computer's own programs hand the keyring (`intentic-machine keyring add`, the desktop app) is sealed to
// the vault's inbox key first: a process squatting the pipe, or reading what crosses it, holds only ciphertext. The
// inbox key is in `state.keys.inbox`.
export const sealForKeyring = (inboxKey: string, name: string, value: string): SealedBox => seal(inboxKey, value, { kind: "inbox", sandbox: "local", secret: name });
