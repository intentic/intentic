import type { RawRoutes } from "@intentic/contract-serve";
import { PasskeyAssertRequestSchema, PasskeyPolicySchema, PasskeyRecoverRequestSchema, PasskeyRegisterRequestSchema } from "@intentic/sandbox-contract/schemas/system";
import { type RelinkAnswer, RelinkRequestSchema } from "@intentic/sandbox-contract/schemas/platform-link";
import { json } from "../../transport";
import { answer, inputOf, pause } from "../machine/machineKit";
import {
    assertionOptions,
    assertPasskey,
    passkeysList,
    recoverSession,
    registerPasskey,
    registrationOptions,
    removePasskey,
    renewRecoveryCodes,
    setPasskeyPolicy,
} from "./passkeys";

// Sign-in and access on the daemon itself: passkeys, sessions, recovery, leaving, and relinking to the platform.
// Spread into daemon/raw.ts's table; a route answered here is taken out of unserved.ts.

// Waiting on the platform twice (adopt, then announce), as a Reconnect does.
const RELINK_MS = 2_400;

export const signInRoutes = {
    // Read by the Access tab on first render: one passkey the owner added from a laptop that syncs it (daemon/passkeys.ts).
    "GET /system/passkeys": () => answer(`GET /system/passkeys`, passkeysList()),
    "POST /system/passkeys/register/options": () => answer(`POST /system/passkeys/register/options`, registrationOptions()),
    "POST /system/passkeys/register": async ({ request }) => {
        const { response, label } = await inputOf(PasskeyRegisterRequestSchema, request);
        return answer(`POST /system/passkeys/register`, registerPasskey(response.id, label, response.authenticatorAttachment));
    },
    "POST /system/passkeys/policy": async ({ request }) =>
        answer(`POST /system/passkeys/policy`, setPasskeyPolicy((await inputOf(PasskeyPolicySchema, request)).required)),
    "POST /system/passkeys/recovery": () => answer(`POST /system/passkeys/recovery`, renewRecoveryCodes()),
    "DELETE /system/passkeys/{id}": ({ param }) => answer(`DELETE /system/passkeys/{id}`, removePasskey(param(`id`))),
    "POST /system/passkeys/assert/options": () => answer(`POST /system/passkeys/assert/options`, assertionOptions()),
    "POST /system/passkeys/assert": async ({ request }) =>
        answer(`POST /system/passkeys/assert`, assertPasskey((await inputOf(PasskeyAssertRequestSchema, request)).response.id)),
    "POST /system/session/recover": async ({ request }) =>
        answer(`POST /system/session/recover`, recoverSession((await inputOf(PasskeyRecoverRequestSchema, request)).code)),
    // Every browser signed out, this one included; the editor signs straight back in, as it does from Google's credential.
    "POST /system/sessions/revoke": () => answer(`POST /system/sessions/revoke`, { ok: true }),
    // Retiring access for good: the owner's door closed (an account deleted), or a member giving their grant up. The
    // page's own row is the platform's to drop, which the editor asks it next.
    "POST /system/access/disable": () => json({ ok: true }),
    "DELETE /members/self": () => answer(`DELETE /members/self`, { ok: true }),
    // A sandbox the platform lost, adopted again by the ticket the recovery screen holds and announced.
    "POST /platform/relink": async ({ request }) => {
        const { ticket } = await inputOf(RelinkRequestSchema, request);
        await pause(RELINK_MS);
        const relinked: RelinkAnswer = {
            announce: { state: `registered`, identity: `sbx_acme_shop`, at: Date.now() },
            adoption: ticket === undefined ? undefined : { status: 200, detail: `adopted into the account` },
        };
        return json(relinked);
    },
} satisfies RawRoutes;
