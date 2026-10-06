import type { Capability } from "@intentic/sandbox-contract";
import type { ParsedKey } from "ssh2";
import { gitHostOf } from "../cli/git-access.js";
import { loadPrivateKey } from "../credentials/ssh-keys.js";
import type { SshKeyStore } from "../ssh-key-store.js";
import type { CredentialDelivery } from "./broker-policy.js";
import type { HeldKey } from "./ssh-agent.js";

// What the ssh agent holds, read live off the key store and the connected cards: which card answers for each key, and
// whether a conversation may sign with it.
//   - A connected machine's key (an `ssh` card, its id the alias): every conversation, through that card's gate.
//   - A git account's key (the alias is the host, e.g. github.com): the owner's terminal only, unless the owner set the
//     card to raw delivery, which hands the agent that card's credential anyway. Otherwise a turn's git goes through
//     the credential gateway, and a signature here would be a way past the card's rules there.
//   - A key no card claims any more: nobody's but the owner's, until whoever removed the card removes it too.

export interface HeldKeysDeps {
    readonly keys: SshKeyStore;
    readonly capabilities: () => Promise<readonly Capability[]>;
    readonly delivery: (capability: string) => Promise<CredentialDelivery>;
    readonly warn: (message: string, error?: unknown) => void;
}

const GIT_PROVIDERS = new Set(["github", "gitlab"]);

// The host a card's git access registers its key under; undefined for a card with no git access.
const gitHostAlias = (capability: Capability): string | undefined => {
    if (capability.kind !== "cli" || !GIT_PROVIDERS.has(capability.config.provider) || capability.config["git"] !== "on") {
        return undefined;
    }
    try {
        return gitHostOf(capability.config).host;
    } catch {
        // allow(silent-catch): a card whose url does not parse has no git host, so it claims no key.
        return undefined;
    }
};

export const heldSshKeys = (deps: HeldKeysDeps): (() => Promise<readonly HeldKey[]>) => {
    // Parsed once per key text: a request lists or signs every time an ssh connects.
    const parsed = new Map<string, { readonly text: string; readonly key: ParsedKey | undefined }>();
    const keyOf = (alias: string, text: string): ParsedKey | undefined => {
        const cached = parsed.get(alias);
        if (cached?.text === text) {
            return cached.key;
        }
        const key = loadPrivateKey(text);
        if (key === undefined) {
            deps.warn(`ssh agent: the key held for "${alias}" could not be loaded, so it is not offered`);
        }
        parsed.set(alias, { text, key });
        return key;
    };
    return async () => {
        const capabilities = await deps.capabilities();
        const held: HeldKey[] = [];
        for (const alias of await deps.keys.aliases()) {
            const text = await deps.keys.get(alias);
            const key = text === undefined ? undefined : keyOf(alias, text);
            if (key === undefined) {
                continue;
            }
            const machine = capabilities.find((capability) => capability.kind === "ssh" && capability.id === alias);
            if (machine !== undefined) {
                held.push({ alias, key, cards: [machine.id], forConversations: true, ledgerName: `${machine.id}/privateKey` });
                continue;
            }
            const accounts = capabilities.filter((capability) => gitHostAlias(capability) === alias);
            // allow(silent-catch): an unreadable policy reads as gateway delivery, which keeps the key the owner's.
            const raw = await Promise.all(accounts.map((account) => deps.delivery(account.id).catch((): CredentialDelivery => "gateway")));
            held.push({ alias, key, cards: accounts.map((account) => account.id), forConversations: raw.includes("raw") });
        }
        return held;
    };
};
