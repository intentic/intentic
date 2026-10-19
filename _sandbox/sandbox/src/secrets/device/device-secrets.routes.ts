import type { KeyringRefusalCode, KeyringTypeResult } from "@intentic/sandbox-contract/schemas/keyring";
import { secretsContract } from "@intentic/sandbox-contract/contracts/secrets.contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../../app-env.js";
import { noteAudit } from "../../audit/audit-http.js";
import { ensureOwner } from "../../auth/owner-gates.js";
import type { Services } from "../../composition.js";
import { opt } from "../../opt.js";
import { sandboxHeld } from "./device-secrets.js";
import { KeyringPairRefused } from "./keyring-sync.js";
import { createPasswordRoutes, type PasswordRoutesDeps } from "./passwords.routes.js";
import { DETAIL_MAX } from "../secret-uses.js";

// The owner's own doors to the keyrings on their computers: Type into… (one secret typed into whatever has focus on one
// of them, after a countdown), the list of keyrings this sandbox reaches, and pairing two of them. Each is the owner's
// alone, never the agent's: a typing goes wherever the cursor is, which only a person at that computer can aim. Beside
// them, Passwords' own (passwords.routes.ts): an agent's need, and the hosted view's reads.

export type DeviceSecretRoutesDeps = PasswordRoutesDeps &
    Pick<Services, "auth" | "deviceSecrets" | "keyringLink" | "keyringSync" | "logger" | "programGuardFor" | "secretRegistry" | "secretUses">;

// How a keyring's refusal reads over HTTP: a person's no or a guard is forbidden, a busy or locked keyring a conflict to
// retry, a keyring nobody can reach unavailable.
const STATUS = {
    "no-keyring": "PRECONDITION_FAILED",
    locked: "CONFLICT",
    declined: "FORBIDDEN",
    unknown: "NOT_FOUND",
    "not-shared": "FORBIDDEN",
    "bad-grant": "FORBIDDEN",
    expired: "FORBIDDEN",
    replayed: "FORBIDDEN",
    guard: "FORBIDDEN",
    unavailable: "SERVICE_UNAVAILABLE",
    busy: "CONFLICT",
    pending: "CONFLICT",
} as const satisfies Readonly<Record<KeyringRefusalCode, string>>;

export const createDeviceSecretRoutes = (services: DeviceSecretRoutesDeps) => {
    const i = implement(secretsContract).$context<OrpcContext>();
    // A sandbox-held value goes sealed to that computer's keyring under the secret's own program guard; a keyring's entry
    // is typed by the keyring that holds it, or released from it sealed straight to the one typing it.
    const typeOne = async (input: { readonly key: string; readonly device: string; readonly countdownSeconds: number }, signal: AbortSignal | undefined): Promise<KeyringTypeResult> => {
        const detail = `The owner's Type into… on ${input.device}`;
        const ours = (await services.secretRegistry()).find((secret) => secret.name === input.key && sandboxHeld(secret));
        if (ours !== undefined) {
            const guard = await services.programGuardFor(input.key);
            return services.keyringLink.type({
                machine: input.device,
                secret: input.key,
                target: { kind: "window", programs: [...guard.programs], anyField: guard.anyField, countdownSeconds: input.countdownSeconds },
                value: ours.value,
                purpose: "owner",
                detail,
                ...opt("signal", signal),
            });
        }
        const kept = (await services.deviceSecrets.listed()).find((entry) => entry.pointer.name === input.key);
        if (kept === undefined) {
            throw new ORPCError("NOT_FOUND", { message: `no secret named "${input.key}"` });
        }
        return services.keyringLink.type({
            machine: input.device,
            secret: input.key,
            target: { kind: "window", programs: [...kept.pointer.programs], anyField: kept.pointer.anyField, countdownSeconds: input.countdownSeconds },
            ...opt("relayFrom", kept.machine === input.device ? undefined : kept.machine),
            purpose: "owner",
            detail,
            ...opt("signal", signal),
        });
    };
    return {
        ...createPasswordRoutes(services),
        typeInto: i.typeInto.handler(async ({ input, context, signal }) => {
            noteAudit({ target: input.key });
            await ensureOwner(services, context.headers);
            const typed = await typeOne(input, signal);
            if (!typed.ok) {
                throw new ORPCError(STATUS[typed.code], { message: typed.refusal });
            }
            // On the ledger like any other use, so the Secrets view says where it last went.
            await services.secretUses
                .record({ name: input.key, lane: "device", detail: `${input.device} · ${typed.program}`.slice(0, DETAIL_MAX), at: Date.now() })
                .catch((error: Error) => services.logger.warn({ err: error, secret: input.key }, "secret use record failed"));
            return { program: typed.program, field: typed.field, asked: typed.asked };
        }),
        keyrings: i.keyrings.handler(async () => ({ keyrings: [...(await services.keyringLink.keyrings())] })),
        keyringPair: i.keyringPair.handler(async ({ input, context, signal }) => {
            await ensureOwner(services, context.headers);
            try {
                return { fingerprints: await services.keyringSync.pair(input.a, input.b, signal) };
            } catch (error) {
                if (error instanceof KeyringPairRefused) {
                    throw new ORPCError("FORBIDDEN", { message: error.message });
                }
                throw error;
            }
        }),
    };
};
