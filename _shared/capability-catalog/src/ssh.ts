// The SSH tile: one remote machine the agent operates, its card id the ssh-config alias. Its own module since the admin
// fields grew it past what the catalog file holds.
import type { CapabilityCatalogEntry } from "./index.js";

export const SSH_ENTRY: CapabilityCatalogEntry = {
    id: "ssh",
    name: "SSH",
    kind: "ssh",
    category: "servers",
    icon: "server",
    description: "Operate a remote machine over SSH.",
    fields: [
        { key: "host", label: "Host", placeholder: "1.2.3.4 or box.example.com" },
        { key: "port", label: "Port", default: "22" },
        { key: "user", label: "User", placeholder: "root" },
        // The default is the one that never puts a private key in the browser: the sandbox generates the pair.
        {
            key: "auth",
            label: "Authentication",
            default: "generated",
            options: [
                { value: "generated", label: "Generate a key for me" },
                { value: "key", label: "Paste my own key" },
                { value: "password", label: "Password" },
            ],
        },
        // Answered by the form's key generator, not typed: it holds the token for a key the sandbox keeps.
        { key: "privateKey", label: "Key", secret: true, when: "auth == 'generated'" },
        { key: "privateKey", label: "Private key", secret: true, multiline: true, when: "auth == 'key'" },
        { key: "password", label: "Password", secret: true, when: "auth == 'password'" },
        // For the commands that need root. Kept in the vault and spent by reference, never written to a file.
        {
            key: "adminPassword",
            label: "Admin password",
            secret: true,
            optional: true,
            advanced: true,
            hint: "Lets the agent run commands as root on this machine. Leave it empty if it never needs to.",
        },
        {
            key: "adminPasswordOf",
            label: "Admin password is",
            default: "user",
            advanced: true,
            options: [
                { value: "user", label: "This user's own password (sudo)" },
                { value: "root", label: "The root account's password (su)" },
            ],
        },
    ],
    hint: 'The name is the alias the agent uses (ssh <name> "…").',
    guide: {
        steps: [
            "Keep `Generate a key for me`: the sandbox makes the key pair and keeps its private half. Only the public half is shown.",
            "Run the command shown on the server, signed in as the user above, to add the key to its `authorized_keys`.",
            "Already have a key for it? Pick `Paste my own key` and paste the unencrypted private key, or switch to `Password`.",
        ],
    },
};
