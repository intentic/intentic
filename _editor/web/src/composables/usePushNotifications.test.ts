import { beforeEach, expect, test, vi } from "vitest";
import { ref } from "vue";
import { usePushNotifications } from "./usePushNotifications";

/* The two ways enabling notifications fails without saying anything true.
 *
 * Both are invisible from the UI: one leaves a toggle reading "on" for a device that can never be reached
 * again, the other blames the sandbox for a decision the browser made, so they are worth pinning down. */

const reachable = ref(true);
vi.mock(`./sandbox/useSandbox`, () => ({ useSandbox: () => ({ reachable }) }));

const sandboxJson = vi.fn();
vi.mock(`./sandbox/sandboxClient`, () => ({ sandboxJson: (path: string, init?: RequestInit) => sandboxJson(path, init) }));

// Two valid uncompressed P-256 points (0x04 || X || Y), base64url: only their bytes matter here.
const KEY_A = `B${`A`.repeat(85)}Q`;
const KEY_B = `B${`B`.repeat(85)}Q`;

const rawKey = (base64Url: string): ArrayBuffer => {
    const binary = atob(`${base64Url}=`.replace(/-/g, `+`).replace(/_/g, `/`));
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes.buffer;
};

// A PushSubscription as the browser hands it back: `options.applicationServerKey` records the VAPID key it was
// minted with, which is the whole basis for deciding whether the daemon can still send to it.
const subscription = (endpoint: string, key: string) => ({
    endpoint,
    options: { applicationServerKey: rawKey(key) },
    unsubscribe: vi.fn(async () => true),
    toJSON: () => ({ endpoint, keys: { p256dh: `p256dh`, auth: `auth` } }),
});

const manager = { getSubscription: vi.fn(), subscribe: vi.fn() };

// Tests run in the node environment, so the browser surface the composable feature-detects has to be stood up
// by hand: including `window`, which `supported()` probes for PushManager and Notification.
const stubBrowser = (permission: NotificationPermission, brave: boolean): void => {
    const notification = { permission, requestPermission: async () => permission };
    vi.stubGlobal(`navigator`, {
        serviceWorker: { register: vi.fn(async () => ({ pushManager: manager })) },
        ...(brave ? { brave: { isBrave: async () => true } } : {}),
    });
    vi.stubGlobal(`Notification`, notification);
    // `supported()` only probes for the names, so a placeholder value is enough for PushManager.
    vi.stubGlobal(`window`, { PushManager: {}, Notification: notification });
};

beforeEach(() => {
    vi.clearAllMocks();
    reachable.value = true;
    manager.getSubscription.mockResolvedValue(null);
    sandboxJson.mockImplementation(async (path: string) =>
        path.startsWith(`/push/config`) ? { publicKey: KEY_A, subscribed: false } : { ok: true },
    );
});

test(`a subscription minted for a key the daemon no longer holds is replaced, not reused`, async () => {
    // A recreated sandbox generates a fresh VAPID pair. The browser still holds the old endpoint, and every
    // send to it is refused (403) while the toggle claims to be on, so it must be dropped and re-minted.
    const stale = subscription(`https://push.example/stale`, KEY_B);
    stubBrowser(`granted`, false);
    manager.getSubscription.mockResolvedValue(stale);
    manager.subscribe.mockResolvedValue(subscription(`https://push.example/fresh`, KEY_A));

    const push = usePushNotifications();
    await push.enable();

    expect(stale.unsubscribe).toHaveBeenCalled();
    expect(manager.subscribe).toHaveBeenCalled();
    expect(sandboxJson).toHaveBeenCalledWith(`/push/subscribe`, expect.objectContaining({ body: expect.stringContaining(`/fresh`) }));
    expect(push.state.value).toBe(`on`);
});

test(`a subscription still bound to the daemon's key is reused: re-subscribing would orphan its row`, async () => {
    const live = subscription(`https://push.example/live`, KEY_A);
    stubBrowser(`granted`, false);
    manager.getSubscription.mockResolvedValue(live);

    await usePushNotifications().enable();

    expect(live.unsubscribe).not.toHaveBeenCalled();
    expect(manager.subscribe).not.toHaveBeenCalled();
});

test(`a push service that refuses to register names the browser, not the sandbox`, async () => {
    // Brave's is the message users actually hit: it ships with push messaging off, and the browser's own
    // wording ("Registration failed - push service error") reads like the daemon broke.
    stubBrowser(`granted`, true);
    manager.subscribe.mockRejectedValue(new Error(`Registration failed - push service error`));

    const push = usePushNotifications();
    await push.enable();

    expect(push.error.value).toContain(`brave://settings/privacy`);
    expect(push.error.value).not.toContain(`Registration failed`);
    expect(push.state.value).toBe(`off`);
});

test(`the same failure in a non-Brave browser points at the push connection instead of guessing`, async () => {
    stubBrowser(`granted`, false);
    manager.subscribe.mockRejectedValue(new Error(`Registration failed - push service error`));

    const push = usePushNotifications();
    await push.enable();

    expect(push.error.value).toContain(`VPN or firewall`);
    expect(push.error.value).not.toContain(`brave://`);
});

test(`the state is read again once the daemon comes online, not only on mount`, async () => {
    // This page can mount before the daemon answers: the shell paints a hydrated workspace rather than the
    // connecting gate for a sandbox that is merely slow, and a read that lands in that window has nobody to
    // ask. Mounting was the only trigger, so the toggle stayed at its initial `off` for a browser that was in
    // fact subscribed: every reload looked like the setting had been forgotten.
    stubBrowser(`granted`, false);
    manager.getSubscription.mockResolvedValue(subscription(`https://push.example/live`, KEY_A));
    sandboxJson.mockResolvedValue({ publicKey: KEY_A, subscribed: true });
    reachable.value = false;

    const push = usePushNotifications();
    await vi.waitFor(() => expect(sandboxJson).not.toHaveBeenCalled());
    expect(push.state.value).toBe(`off`);

    reachable.value = true;

    await vi.waitFor(() => expect(push.state.value).toBe(`on`));
});

test(`a stale read cannot overwrite the toggle the user just moved`, async () => {
    // The read above now fires exactly when someone is reaching for the toggle. It is the slower of the two
    // (a service-worker lookup plus a daemon round-trip), so without a guard it lands last and reports the
    // world as it was before the click: the same "it forgot my setting" from the other direction.
    stubBrowser(`granted`, false);
    manager.getSubscription.mockResolvedValue(null);
    manager.subscribe.mockResolvedValue(subscription(`https://push.example/fresh`, KEY_A));
    sandboxJson.mockImplementation(async (path: string) =>
        path.startsWith(`/push/config`) ? { publicKey: KEY_A, subscribed: false } : { ok: true },
    );

    const push = usePushNotifications();
    // The mount-time read is still in flight: deliberately not awaited, when the user turns it on.
    await push.enable();
    expect(push.state.value).toBe(`on`);

    await vi.waitFor(() => expect(push.state.value).toBe(`on`));
});

test(`refresh reports "off" for a subscription bound to a superseded key`, async () => {
    // Both halves exist: the browser has a subscription and the daemon has its row, but the key moved on.
    // Reporting that as "on" is the silent failure the whole state machine exists to prevent.
    stubBrowser(`granted`, false);
    manager.getSubscription.mockResolvedValue(subscription(`https://push.example/stale`, KEY_B));
    sandboxJson.mockResolvedValue({ publicKey: KEY_A, subscribed: true });

    const push = usePushNotifications();
    await push.refresh();

    expect(push.state.value).toBe(`off`);
});
