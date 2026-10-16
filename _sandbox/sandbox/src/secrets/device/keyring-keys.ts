import { KEYRING_KEY_RE, type KeyringSandboxKeys, KeyringSandboxKeysSchema } from "@intentic/sandbox-contract";
import { type KeyringKeyPair, newSealKeyPair, newSignKeyPair } from "@intentic/sandbox-contract/keyring-seal";
import type { Context } from "hono";
import { z } from "zod";
import { defineDocument } from "../../store/evolution/documents.js";
import { openDocument } from "../../store/open-document.js";

// This sandbox's own keyring keys (schemas/keyring.ts): an Ed25519 pair that signs every grant it sends a keyring, and an
// X25519 pair a released value is sealed to. Minted once and kept under the auth root (0600, sealed at rest where the
// sandbox has an at-rest key), off the workspace: a key an agent could read would let it sign grants of its own. A key
// that changed would strand every share a keyring pinned to the old one, so an unreadable file is refused, never
// replaced. Only the public halves ever leave, at GET /keyring/keys.

const KeyPairSchema = z.object({ publicKey: z.string().regex(KEYRING_KEY_RE), privateKey: z.string().regex(KEYRING_KEY_RE) });

// Each half optional on disk so a first read mints what is missing rather than failing on an empty file.
export const sandboxKeyringKeysDocument = defineDocument({
    root: "auth",
    path: "keyring-keys.json",
    schema: z.object({ sign: KeyPairSchema.optional(), seal: KeyPairSchema.optional() }),
});

type KeptKeys = z.output<typeof sandboxKeyringKeysDocument.schema>;

export interface SandboxKeyringPairs {
    readonly sign: KeyringKeyPair;
    readonly seal: KeyringKeyPair;
}

export interface SandboxKeyringKeys {
    // Both pairs, private halves included: for signing a grant and opening what is sealed to this sandbox.
    readonly pairs: () => Promise<SandboxKeyringPairs>;
    // The public halves, which is all a keyring is ever told.
    readonly publicKeys: () => Promise<KeyringSandboxKeys>;
}

export const fileSandboxKeyringKeys = (path: string): SandboxKeyringKeys => {
    const file = openDocument(sandboxKeyringKeysDocument, path, {
        fallback: (): KeptKeys => ({}),
        mode: 0o600,
        onUnreadable: "refuse",
        atRestPurpose: sandboxKeyringKeysDocument.path,
    });
    // Minted inside the file's own update, which is serialized against every other, so two first reads keep one key.
    const load = async (): Promise<SandboxKeyringPairs> => {
        const kept = await file.update((current) =>
            current.sign !== undefined && current.seal !== undefined ? current : { sign: current.sign ?? newSignKeyPair(), seal: current.seal ?? newSealKeyPair() },
        );
        if (kept.sign === undefined || kept.seal === undefined) {
            throw new Error(`the sandbox's keyring keys at ${path} were not written`);
        }
        return { sign: kept.sign, seal: kept.seal };
    };
    // Read once per process: the keys never change once minted. A failed read is not kept, so the next call tries again.
    let loaded: Promise<SandboxKeyringPairs> | undefined;
    const pairs = async (): Promise<SandboxKeyringPairs> => {
        loaded ??= load();
        try {
            return await loaded;
        } catch (error) {
            loaded = undefined;
            throw error;
        }
    };
    return {
        pairs,
        publicKeys: async () => {
            const { sign, seal } = await pairs();
            return { sign: sign.publicKey, seal: seal.publicKey };
        },
    };
};

// GET /keyring/keys: a door with no credential, since a keyring fetches it before it holds anything of this sandbox's;
// the public halves are all it answers, and they are what a keyring pins when an entry is shared.
export const createKeyringKeysRoute =
    (keys: Pick<SandboxKeyringKeys, "publicKeys">) =>
    async (c: Context): Promise<Response> =>
        c.json(KeyringSandboxKeysSchema.parse(await keys.publicKeys()), 200, { "cache-control": "no-store" });
