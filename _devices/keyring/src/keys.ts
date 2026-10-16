import { readFile } from "node:fs/promises";
import { isMissing } from "@intentic/base/errors";
import { writeSecretFile } from "@intentic/local-agent";
import { KeyringPublicKeySchema } from "@intentic/sandbox-contract/schemas/keyring";
import { newSealKeyPair } from "@intentic/sandbox-contract/keyring-seal";
import { z } from "zod";
import { KeyPairSchema, SandboxPinSchema, type SandboxPin } from "./vault.js";

// `keys.json`: what the keyring needs while its vault is locked. Its `seal` key pair, for a value a sandbox sends it to
// type (sealed to it, so only this keyring opens it, and typed under the sandbox's own guard); the PUBLIC halves of the
// inbox and sync keys, so a value or a change can be sealed to them while the private halves sit in the vault; and each
// sandbox's keys as pinned when an entry was first shared with it, to verify a grant before anyone is asked. The vault
// keeps its own copy of every pin, and a value is handed out only when the two agree (core.ts), so a pin rewritten
// here by another process of this user stops releases instead of redirecting them.

export const KeysFileSchema = z
    .object({
        v: z.literal(1),
        seal: KeyPairSchema,
        inbox: KeyringPublicKeySchema.optional(),
        sync: KeyringPublicKeySchema.optional(),
        sandboxes: z.record(z.string(), SandboxPinSchema),
    })
    .strict();
export type KeysFile = z.infer<typeof KeysFileSchema>;

export class KeysError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "KeysError";
    }
}

const writeKeys = async (path: string, dir: string, keys: KeysFile): Promise<void> => {
    await writeSecretFile(path, dir, `${JSON.stringify(KeysFileSchema.parse(keys))}\n`);
};

// The keys file, made with a fresh seal key pair the first time.
export const loadKeys = async (path: string, dir: string): Promise<KeysFile> => {
    let raw: string;
    try {
        raw = await readFile(path, "utf8");
    } catch (error) {
        if (!isMissing(error)) {
            throw error;
        }
        const fresh: KeysFile = { v: 1, seal: newSealKeyPair(), sandboxes: {} };
        await writeKeys(path, dir, fresh);
        return fresh;
    }
    let json: unknown;
    try {
        json = JSON.parse(raw);
    } catch (error) {
        throw new KeysError(`${path} is not JSON: move it aside and restart the keyring, then share each entry with its sandbox again.`, { cause: error });
    }
    const parsed = KeysFileSchema.safeParse(json);
    if (!parsed.success) {
        throw new KeysError(`${path} is not a keys file this keyring reads: move it aside and restart the keyring, then share each entry with its sandbox again.`);
    }
    return parsed.data;
};

export const saveKeys = writeKeys;

export const pinOf = (keys: KeysFile, sandbox: string): SandboxPin | undefined => keys.sandboxes[sandbox];

export const samePin = (a: SandboxPin | undefined, b: SandboxPin | undefined): boolean => a !== undefined && b !== undefined && a.sign === b.sign && a.seal === b.seal;
