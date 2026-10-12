import type { PhoneSummary, PhoneWakeRegistration } from "@intentic/sandbox-contract";
import { sandboxRaw } from "../../../client/sandbox/sandboxRaw";

// Making a phone wakeable, the editor's half. The sandbox wakes a sleeping phone through the platform's push relay,
// and registering a phone there needs the owner signed in to the platform, which only this page is. So when the
// roster says a phone has a push token nobody registered (`wake: "register"`), this registers it with the relay and
// hands the channel to the sandbox. The phone's token is not a credential; the channel's secret goes from the platform
// straight to the sandbox and is never shown.

// Loaded on use: the platform client reads window.env on import, which exists only in a real page.
const platformApi = async () => (await import("../../../lib/useApi.js")).apiClient;

export type WakeOutcome = `ready` | `unavailable` | `failed`;

// What the relay answered, as the sandbox stores it; the platform's grant is the channel's address and its secret.
const registrationOf = (
    token: string,
    grant: { readonly deviceId: string; readonly secret: string; readonly url: string },
): PhoneWakeRegistration => ({
    token,
    channel: { kind: `relay`, url: grant.url, deviceId: grant.deviceId, secret: grant.secret },
});

// Registers one phone's current token, once; `unavailable` when the platform has no relay for Android (a self-hosted
// platform without a Firebase key), which leaves the phone answering only while its app is open.
export const registerPhoneWake = async (
    phone: Pick<PhoneSummary, `id` | `wake` | `facts`>,
    deps: {
        readonly register?: (token: string) => Promise<{ readonly deviceId: string; readonly secret: string; readonly url: string }>;
        // Hands the sandbox the channel; rejects when it refuses or cannot be reached.
        readonly hand?: (id: string, registration: PhoneWakeRegistration) => Promise<void>;
    } = {},
): Promise<WakeOutcome | undefined> => {
    const token = phone.facts?.wake?.fcm;
    if (phone.wake !== `register` || token === undefined) {
        return undefined;
    }
    let grant: { readonly deviceId: string; readonly secret: string; readonly url: string };
    try {
        grant = await (deps.register ?? (async (fcm: string) => (await platformApi()).push.register({ platform: `android`, token: fcm })))(token);
    } catch (caught) {
        return (caught as { status?: unknown; code?: unknown } | undefined)?.code === `NOT_FOUND` ? `unavailable` : `failed`;
    }
    const hand =
        deps.hand ??
        (async (id: string, input: PhoneWakeRegistration): Promise<void> => {
            await sandboxRaw(`POST /system/phones/{id}/wake`, { params: { id }, input });
        });
    try {
        await hand(phone.id, registrationOf(token, grant));
        return `ready`;
        // allow(silent-catch): a sandbox that cannot be reached leaves the phone as unwakeable as one that refused, which `failed` tells the caller.
    } catch {
        return `failed`;
    }
};

// One attempt per phone and token per page load: a failure is shown, not retried in a loop against the platform.
const attempted = new Set<string>();

export const registerWakeOnce = async (phone: Pick<PhoneSummary, `id` | `wake` | `facts`>): Promise<WakeOutcome | undefined> => {
    const key = `${phone.id}\u0000${phone.facts?.wake?.fcm ?? ``}`;
    if (phone.wake !== `register` || attempted.has(key)) {
        return undefined;
    }
    attempted.add(key);
    return registerPhoneWake(phone);
};
