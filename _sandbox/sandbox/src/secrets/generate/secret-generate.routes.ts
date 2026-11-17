import { secretsContract } from "@intentic/sandbox-contract/contracts/secrets.contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../../app-env.js";
import { noteAudit } from "../../audit/audit-http.js";
import type { Services } from "../../composition.js";
import { randomSecret, type SecretFormat } from "./random-secret.js";

// The two routes that make a random value: `generate` for a new name (the agent's `secrets generate`), `regenerate` for
// one a person set (the Secrets view's fix for a value too short to mask). Both keep it in the sandbox's own store, where
// `set` keeps one, and answer only its name and length. `keptOnDevice` names the computer whose keyring holds a name, if
// one does (secrets.routes.ts).
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
    return {
        // A name any store already holds is refused, since a new value would break whatever reads the old one.
        generate: i.generate.handler(async ({ input }) => {
            noteAudit({ target: input.key });
            if ((await services.secretRegistry()).some((secret) => secret.name === input.key)) {
                throw new ORPCError("CONFLICT", {
                    message: `"${input.key}" is already stored: use it as it is, or pick a name nothing here holds. A new value would break whatever reads the old one.`,
                });
            }
            const machine = await keptOnDevice(input.key);
            if (machine !== undefined) {
                throw new ORPCError("CONFLICT", {
                    message: `"${input.key}" is kept in the keyring on ${machine}: use it as it is, or pick another name. One stored here would be used in its place.`,
                });
            }
            return storeRandom(input.key, input.bytes, input.format);
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
