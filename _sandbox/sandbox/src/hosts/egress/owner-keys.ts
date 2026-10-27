import type { DeviceSandboxFlow } from "@intentic/sandbox-contract/schemas/devices";
import type { EgressCredentialSchema, EgressOwnerKeys } from "@intentic/sandbox-contract/schemas/egress";
import { ORPCError } from "@orpc/server";
import type { z } from "zod";
import { allowedOriginsOf, originAllowedBy, rpIdOf } from "../../auth/browser-origins.js";
import type { StoredCredential } from "../../auth/passkeys/passkey-store.js";
import type { Services } from "../../composition.js";
import { opt } from "../../opt.js";

/* THE OWNER'S PASSKEYS, AS A MACHINE PINS THEM FOR THE EGRESS FENCE (2026-10-27).

The daemon sits inside the boundary the fence draws, so it must never be able to loosen a fence by itself: a loosening
carries the owner's passkey over the exact change, and the machine agent checks it against the owner keys it pinned for
the sandbox on its first `set-egress`. Those keys come from here, filled by the daemon on every `set-egress` whatever the
caller sent, and the editor reads the very same object (`system.egressOwnerKeys`) to hash into the document it signs.

The relying party is the one the ceremony runs under: the caller's own origin when the daemon admits it, else the
editor's (the first exact https entry of `webOrigin`, as the Android app's statement is read). The origins are the exact
ones the daemon admits for that rpId, plus the Android app's when its statement grants that same rpId. A wildcard entry
names a family of per-session origins, each its own rpId, so none of them can sign for this one and none is listed. */

type Credential = z.infer<typeof EgressCredentialSchema>;

// The rpId a ceremony from `origin` runs under, or undefined when neither it nor the editor names one.
export const egressRelyingParty = (webOrigin: string, origin: string | undefined): string | undefined => {
    const allowed = allowedOriginsOf(webOrigin);
    if (origin !== undefined && origin !== "" && originAllowedBy(allowed)(origin)) {
        return rpIdOf(origin);
    }
    const editor = allowed.find((entry) => entry.startsWith("https://") && !entry.includes("*"));
    return editor === undefined ? undefined : rpIdOf(editor);
};

const sameEmail = (left: string, right: string): boolean => left.toLowerCase() === right.toLowerCase();

// The owner's passkeys for one rpId and where a ceremony with them may run; undefined when no origin answers for it.
export const egressOwnerKeysOf = (input: {
    readonly credentials: readonly StoredCredential[];
    readonly owner: string | undefined;
    readonly rpId: string;
    readonly webOrigins: readonly string[];
    readonly app: { readonly rpId: string; readonly origins: readonly string[] } | undefined;
}): { readonly ownerKeys: EgressOwnerKeys; readonly credentials: readonly Credential[] } | undefined => {
    const web = input.webOrigins.filter((origin) => !origin.includes("*") && rpIdOf(origin) === input.rpId);
    const app = input.app?.rpId === input.rpId ? input.app.origins : [];
    const origins = [...new Set([...web, ...app])].slice(0, 16);
    if (origins.length === 0) {
        return undefined;
    }
    const owned = input.credentials.filter(
        (credential) => input.owner !== undefined && sameEmail(credential.email, input.owner) && credential.rpId === input.rpId,
    );
    return {
        ownerKeys: {
            rpId: input.rpId,
            origins,
            keys: owned.slice(0, 32).map((credential) => ({
                id: credential.id,
                alg: credential.publicKey.alg,
                jwk: credential.publicKey.jwk,
                ...opt("name", credential.label === "" ? undefined : credential.label.slice(0, 200)),
            })),
        },
        credentials: owned.slice(0, 32).map((credential) => ({ id: credential.id, transports: [...credential.transports] })),
    };
};

export type OwnerKeysDeps = Pick<Services, "config" | "passkeys" | "ownerEmail" | "appPasskeys">;

// The IO half: this daemon's passkey store, owner and origins, for a request from `origin`.
export const egressOwnerKeys = async (
    services: OwnerKeysDeps,
    origin: string | undefined,
): Promise<{ readonly ownerKeys: EgressOwnerKeys; readonly credentials: readonly Credential[] } | undefined> => {
    const rpId = egressRelyingParty(services.config.webOrigin, origin);
    if (rpId === undefined) {
        return undefined;
    }
    const [credentials, owner, app] = await Promise.all([services.passkeys.list(), services.ownerEmail(), services.appPasskeys.admitted()]);
    return egressOwnerKeysOf({ credentials, owner, rpId, webOrigins: allowedOriginsOf(services.config.webOrigin), app });
};

// `set-egress` as it leaves for the machine: the owner keys are this daemon's own, filled for the origin the request came
// from, never the caller's. Without an rpId to name there are none, and the machine refuses a loosening it has no pinned
// keys for.
export const withEgressOwnerKeys = async (
    services: OwnerKeysDeps,
    input: DeviceSandboxFlow,
    origin: string | undefined,
): Promise<DeviceSandboxFlow> => {
    if (input.egress === undefined) {
        throw new ORPCError("BAD_REQUEST", { message: "A network fence is set whole: `egress` (the whole policy) is required." });
    }
    const { egressOwnerKeys: _callers, ...rest } = input;
    const keys = await egressOwnerKeys(services, origin);
    return { ...rest, ...opt("egressOwnerKeys", keys?.ownerKeys) };
};
