import { randomBytes } from "node:crypto";
import { z } from "zod";
import { defineDocument } from "../../store/evolution/documents.js";
import { openDocument } from "../../store/open-document.js";

// THE WAKE SECRETS (docs/architecture/messages.md, "Waking"): this sandbox's one inbound wake secret, which every contact
// granted `wake` holds and the edge's wake door for /s2s/inbox matches by its digest, and the wake secret each contact
// handed this sandbox, carried as `?wake=` on every delivery to it. In the auth root, mode 0600, out of every agent's
// reach: a turn that read one could start a sleeping sandbox at will.

const SecretSchema = z.string().min(32).max(200);

const S2sSecretsSchema = z.object({
    // Minted on first need; replaced whenever a contact that held it is removed, blocked or loses its `wake` grant.
    inbound: z.object({ secret: SecretSchema, createdAt: z.number().int() }).optional(),
    // By contact id: the secret that contact gave this sandbox to wake it.
    theirs: z.record(z.string(), SecretSchema),
});
type S2sSecrets = z.infer<typeof S2sSecretsSchema>;

export const s2sSecretsDocument = defineDocument({ root: "auth", path: "s2s-secrets.json", schema: S2sSecretsSchema });

export interface WakeSecrets {
    // This sandbox's inbound secret, minted on first ask and the same ever after until rotated.
    readonly inbound: () => Promise<string>;
    // The inbound secret when one was minted, without minting one.
    readonly peekInbound: () => Promise<string | undefined>;
    // A new inbound secret in place of the old one, answered.
    readonly rotateInbound: () => Promise<string>;
    // The secret a contact gave this sandbox, when it gave one.
    readonly theirs: (contactId: string) => Promise<string | undefined>;
    // Keeps (or with undefined, forgets) the secret a contact gave.
    readonly setTheirs: (contactId: string, secret: string | undefined) => Promise<void>;
}

const mint = (): string => randomBytes(32).toString("base64url");

export const fileWakeSecrets = (path: string, now: () => number = Date.now): WakeSecrets => {
    const file = openDocument(s2sSecretsDocument, path, { fallback: (): S2sSecrets => ({ theirs: {} }), mode: 0o600, onUnreadable: "refuse" });
    const inbound = async (): Promise<string> => {
        const written = await file.update((current) => (current.inbound === undefined ? { ...current, inbound: { secret: mint(), createdAt: now() } } : current));
        if (written.inbound === undefined) {
            throw new Error("s2s-secrets.json: no inbound wake secret after minting one");
        }
        return written.inbound.secret;
    };
    return {
        inbound,
        peekInbound: async () => (await file.read()).inbound?.secret,
        rotateInbound: async () => {
            const secret = mint();
            await file.update((current) => ({ ...current, inbound: { secret, createdAt: now() } }));
            return secret;
        },
        theirs: async (contactId) => (await file.read()).theirs[contactId],
        setTheirs: async (contactId, secret) => {
            await file.update((current) => {
                const { [contactId]: _held, ...rest } = current.theirs;
                return { ...current, theirs: secret === undefined ? rest : { ...rest, [contactId]: secret } };
            });
        },
    };
};
