import type { CapabilityCatalogEntry } from "@intentic/capability-catalog";
import type { CapabilityField } from "@intentic/extension-manifest";
import type { FormValues } from "./form";

// The one field the key generator stands in for: an ssh tile's private key while the sandbox is to make it. The same key
// under "Paste my own key" stays a box, since there the person already holds the key.
export const generatesKey = (entry: CapabilityCatalogEntry, field: CapabilityField, values: Readonly<FormValues>): boolean =>
    entry.kind === `ssh` && field.key === `privateKey` && values[`auth`] === `generated`;

// The line that authorizes a public key for whoever runs it on the server. It creates ~/.ssh first, which a fresh
// account lacks; the key is single-quoted, and a quote inside it (a pasted key's comment can hold one) is closed,
// escaped and reopened, the one way a POSIX shell allows.
export const authorizeCommand = (publicKey: string): string =>
    `mkdir -p ~/.ssh && echo '${publicKey.trim().replaceAll(`'`, `'\\''`)}' >> ~/.ssh/authorized_keys`;

// Where a key made for one form is kept in the operations ledger: by tile and by the connection being edited (`new` for
// one being added), so a key made for one is never offered to another. Without a connection, every key made on the tile.
export const sshKeyScope = (entry: string, connection?: string): string =>
    connection === undefined ? `capabilities/${entry}/ssh-key` : `capabilities/${entry}/ssh-key/${connection}`;
