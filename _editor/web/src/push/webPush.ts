import type { PushChannel } from "@intentic/sandbox-contract";
import type { Minted, PushDriver } from "./driver.js";

// Web push, from the browser's side: the transport for every real browser, including the Android TWA (Chrome). The
// subscription is per-browser; the endpoint belongs to this browser's push service and is also its id.

const SW_URL = `/sw.js`;

// Push wants the VAPID key as raw bytes; the daemon serves it base64url. Typed as Uint8Array<ArrayBuffer> since
// applicationServerKey needs a non-shared buffer, which the default ArrayBufferLike does not guarantee.
const decodeKey = (base64Url: string): Uint8Array<ArrayBuffer> => {
    const padded = base64Url.padEnd(base64Url.length + ((4 - (base64Url.length % 4)) % 4), `=`);
    const binary = atob(padded.replace(/-/g, `+`).replace(/_/g, `/`));
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
};

// `options.applicationServerKey` is the raw key the subscription was minted with, so comparing it against the daemon's
// current one answers exactly the question that matters: can the daemon still send to this endpoint?
const boundTo = (subscription: PushSubscription, publicKey: string): boolean => {
    const bound = subscription.options.applicationServerKey;
    if (bound === null) {
        return false;
    }
    const current = decodeKey(publicKey);
    const bytes = new Uint8Array(bound);
    return bytes.length === current.length && bytes.every((byte, index) => byte === current[index]);
};

// Brave uniquely exposes this. It ships with Google's push service disabled, so subscribing cannot succeed until that
// setting is on, worth detecting since the fix is a specific toggle to name.
const isBrave = async (): Promise<boolean> => {
    const { brave } = navigator as Navigator & { brave?: { isBrave: () => Promise<boolean> } };
    return brave !== undefined && (await brave.isBrave());
};

// Subscribing fails independently of the permission just granted, and the browser's own message ('push service error')
// names nothing actionable; it also reads as the sandbox breaking, when the browser never reached its push service.
const pushServiceAdvice = async (): Promise<string> =>
    (await isBrave())
        ? `Brave ships with push messaging turned off. Enable "Use Google services for push messaging" in brave://settings/privacy, restart Brave, then try again.`
        : `Your browser's push service refused to register this browser, nothing on the sandbox side can fix it. A VPN or firewall blocking the browser's push connection is the usual cause.`;

const registration = async (): Promise<ServiceWorkerRegistration> => navigator.serviceWorker.register(SW_URL);

// What the browser currently holds, if anything, distinct from what the daemon holds (a sandbox reset drops the server
// row while the subscription lives on); the composable's refresh reconciles them.
const localSubscription = async (): Promise<PushSubscription | null> => (await registration()).pushManager.getSubscription();

// Reuses an existing subscription where possible, since re-subscribing mints a new endpoint and orphans the old row,
// but only when it is still bound to the daemon's key; a mismatched one is dropped and re-minted.
const subscribe = async (manager: PushManager, publicKey: string): Promise<PushSubscription> => {
    const existing = await manager.getSubscription();
    if (existing !== null) {
        if (boundTo(existing, publicKey)) {
            return existing;
        }
        await existing.unsubscribe();
    }
    try {
        // `userVisibleOnly` is mandatory in Chrome, silent push is not permitted.
        return await manager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeKey(publicKey) });
    } catch (cause) {
        throw new Error(await pushServiceAdvice(), { cause });
    }
};

const mint = async (publicKey: () => Promise<string>): Promise<Minted> => {
    // Permission first: the prompt must spend the user's click, not a network round-trip's leftovers.
    const permission = await Notification.requestPermission();
    if (permission !== `granted`) {
        return { outcome: permission === `denied` ? `denied` : `dismissed` };
    }
    const subscription = await subscribe((await registration()).pushManager, await publicKey());
    const { endpoint, keys } = subscription.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
    const channel: PushChannel = { kind: `webpush`, endpoint, keys };
    return { outcome: `granted`, channel };
};

export const webPushDriver: PushDriver = {
    supported: () => `serviceWorker` in navigator && `PushManager` in window && `Notification` in window,
    denied: async () => Notification.permission === `denied`,
    localId: async () => (await localSubscription())?.endpoint ?? null,
    bound: async (publicKey) => {
        const existing = await localSubscription();
        return existing !== null && boundTo(existing, publicKey);
    },
    mint,
    drop: async () => {
        const existing = await localSubscription();
        await existing?.unsubscribe();
    },
};
