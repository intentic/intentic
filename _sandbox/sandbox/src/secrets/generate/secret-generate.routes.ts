import { secretsContract } from "@intentic/sandbox-contract/contracts/secrets.contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../../app-env.js";
import { noteAudit } from "../../audit/audit-http.js";
import type { Services } from "../../composition.js";
import { randomSecret, type SecretFormat } from "./random-secret.js";

// The two routes that make a random value, `generate` for a new name (the agent's `secrets generate`) and `regenerate` for
// one a person set (the Secrets view's fix for a value too short to mask), and `importValue`, a value the agent pipes in
// under a new name (`secrets import`). Each keeps it in the sandbox's own store, where `set` keeps one, and answers only
// its name and length. `keptOnDevice` names the computer whose keyring holds a name, if one does (secrets.routes.ts).
export const createSecretGenerateRoutes = (
    services: Pick<Services, "secretRegistry" | "sandboxSecrets">,
    keptOnDevice: (key: string) => Promise<string | undefined>,
) => {
    const i = implement(secretsContract).$context<OrpcContext>();
    const storeRandom = async (key: string, bytes: number, format: SecretFormat) => {
        const value = randomSecret(bytes, format);
        await services.sandboxSecrets.set(key, value);
        return { key, length: value.length, stored: "sandbox" as const };
    };
    // A name any store already holds is refused, since a new value would break whatever reads the old one.
    const refuseHeld = async (key: string): Promise<void> => {
        if ((await services.secretRegistry()).some((secret) => secret.name === key)) {
            throw new ORPCError("CONFLICT", {
                message: `"${key}" is already stored: use it as it is, or pick a name nothing here holds. A new value would break whatever reads the old one.`,
            });
        }
        const machine = await keptOnDevice(key);
        if (machine !== undefined) {
            throw new ORPCError("CONFLICT", {
                message: `"${key}" is kept in the keyring on ${machine}: use it as it is, or pick another name. One stored here would be used in its place.`,
            });
        }
    };
    return {
        generate: i.generate.handler(async ({ input }) => {
            noteAudit({ target: input.key });
            await refuseHeld(input.key);
            return storeRandom(input.key, input.bytes, input.format);
        }),
        // (2026-11-25) `secrets import NAME --stdin`, on the agent token: a value piped from where it lives now, under a
        // name nothing here holds, so the agent can add a credential and never replace one. Answers the name and length.
        importValue: i.importValue.handler(async ({ input }) => {
            noteAudit({ target: input.key });
            await refuseHeld(input.key);
            await services.sandboxSecrets.set(input.key, input.value);
            return { key: input.key, length: input.value.length, stored: "sandbox" as const };
        }),
        // Only a name a person set here, in the sandbox's own store: a connection's password and a keyring's
        // entry must match what the account or the computer holds, so they change there first. Not on the agent's token.
        regenerate: i.regenerate.handler(async ({ input }) => {
            noteAudit({ target: input.key });
            if ((await services.sandboxSecrets.get(input.key)) === undefined) {
                throw new ORPCError("NOT_FOUND", {
                    message: `"${input.key}" is not a secret set here: only one you set can be replaced with a random value. A connection's password changes on its site first, then here.`,
                });
            }
            return storeRandom(input.key, input.bytes, input.format);
        }),
    };
};
