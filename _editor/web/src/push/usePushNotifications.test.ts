import { waitFor, stubGlobal } from "@intentic/testing/bun";
import { ref } from "vue";
import { fakeSandboxRpc } from "../testing/sandboxRpcFake";
import { usePushNotifications } from "./usePushNotifications";

// The two ways enabling notifications fails without saying anything true: a toggle stuck 'on' for a device that can
// never be reached again, or blaming the sandbox for a decision the browser made.

const reachable = ref(true);
const activeSandboxId = ref<string | undefined>(`box`);
jest.mock(`../features/sandbox/client/useSandbox`, () => ({ useSandbox: () => ({ reachable, activeSandboxId }) }));

// The daemon's push routes: what a device needs to subscribe, and the registration writes.
const config = jest.fn();
const subscribe = jest.fn();
const unsubscribe = jest.fn();
jest.mock(`../features/sandbox/client/sandboxRpc`, () => ({ sandboxRpc: fakeSandboxRpc({ push: { config, subscribe, unsubscribe } }) }));

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

// A PushSubscription as the browser hands it back: `options.applicationServerKey` records the VAPID key it was minted
// with, the whole basis for deciding whether the daemon can still send to it.
const subscription = (endpoint: string, key: string) => ({
    endpoint,
    options: { applicationServerKey: rawKey(key) },
    unsubscribe: jest.fn(async () => true),
    toJSON: () => ({ endpoint, keys: { p256dh: `p256dh`, auth: `auth` } }),
});

const manager = { getSubscription: jest.fn(), subscribe: jest.fn() };

// Tests run in the node environment, so the browser surface the composable feature-detects has to be stood up by hand,
// including `window`, which `supported()` probes for PushManager and Notification.
const register = jest.fn(async () => ({ pushManager: manager }));
const stubBrowser = (permission: NotificationPermission, brave: boolean, desktop = false): void => {
    const notification = { permission, requestPermission: async () => permission };
    stubGlobal(`navigator`, {
        serviceWorker: { register },
        ...(brave ? { brave: { isBrave: async () => true } } : {}),
    });
    stubGlobal(`Notification`, notification);
    // `supported()` only probes for the names, so a placeholder value is enough for PushManager.
    const shell: Pick<Window, `__INTENTIC_DESKTOP__`> & { readonly PushManager: object; readonly Notification: typeof notification } = {
        PushManager: {},
        Notification: notification,
    };
    if (desktop) {
        // The desktop app's window, marked the way Tauri injects it (desktop.ts).
        shell.__INTENTIC_DESKTOP__ = { version: `1.322.0`, installId: `install`, update: null, notices: true };
    }
    stubGlobal(`window`, shell);
};

beforeEach(() => {
    jest.clearAllMocks();
    reachable.value = true;
    manager.getSubscription.mockResolvedValue(null);
    config.mockResolvedValue({ publicKey: KEY_A, subscribed: false });
    subscribe.mockResolvedValue({ ok: true });
    unsubscribe.mockResolvedValue({ ok: true });
});

test(`the desktop app's window is not offered push, though its webview has every API for it`, async () => {
    // WebView2 exposes the service worker, PushManager and Notification, has no push service behind them, and blocks the
    // permission without a prompt: offered the switch, the reader got a "blocked" nobody chose.
    stubBrowser(`denied`, false, true);
    const push = usePushNotifications();
    expect(push.state.value).toBe(`unsupported`);
    expect(push.canToggle.value).toBe(false);

    await push.refresh();
    expect(push.state.value).toBe(`unsupported`);
    // Nothing is set up in the window on the way to that answer: no worker registered, the daemon not asked.
    expect(register).not.toHaveBeenCalled();
    expect(config).not.toHaveBeenCalled();
});

test(`does not call notifications off before checking the registration`, async () => {
    stubBrowser(`granted`, false);
    const live = subscription(`https://push.example/live`, KEY_A);
    manager.getSubscription.mockResolvedValue(live);
    config.mockResolvedValue({ publicKey: KEY_A, subscribed: true });
    const push = usePushNotifications();
    expect(push.state.value).toBe(`checking`);
    await waitFor(() => expect(push.state.value).toBe(`on`));
});

// localStorage as the browser keeps it, for the one test that reads what an earlier visit confirmed.
const memoryStorage = (): Storage => {
    const items = new Map<string, string>();
    return {
        getItem: (key) => items.get(key) ?? null,
        setItem: (key, value) => void items.set(key, value),
        removeItem: (key) => void items.delete(key),
        clear: () => items.clear(),
        key: (index) => [...items.keys()][index] ?? null,
        get length() {
            return items.size;
        },
    };
};

test(`opens on what the daemon last confirmed for this device, so the Menu has no false "off" to take back`, async () => {
    stubBrowser(`granted`, false);
    stubGlobal(`localStorage`, memoryStorage());
    try {
        manager.getSubscription.mockResolvedValue(subscription(`https://push.example/live`, KEY_A));
        config.mockResolvedValue({ publicKey: KEY_A, subscribed: true });
        const first = usePushNotifications();
        await waitFor(() => expect(first.state.value).toBe(`on`));

        // The next open, before the daemon has answered it: already on.
        reachable.value = false;
        expect(usePushNotifications().state.value).toBe(`on`);
        // Another sandbox has confirmed nothing on this device yet.
        activeSandboxId.value = `other`;
        expect(usePushNotifications().state.value).toBe(`checking`);
    } finally {
        activeSandboxId.value = `box`;
        stubGlobal(`localStorage`, undefined);
    }
});

test(`a subscription minted for a key the daemon no longer holds is replaced, not reused`, async () => {
    // A recreated sandbox mints a fresh VAPID pair; the old endpoint is refused (403) though the toggle claims on.
    const stale = subscription(`https://push.example/stale`, KEY_B);
    stubBrowser(`granted`, false);
    manager.getSubscription.mockResolvedValue(stale);
    manager.subscribe.mockResolvedValue(subscription(`https://push.example/fresh`, KEY_A));

    const push = usePushNotifications();
    await push.enable();

    expect(stale.unsubscribe).toHaveBeenCalledTimes(1);
    expect(manager.subscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledWith({ kind: `webpush`, endpoint: `https://push.example/fresh`, keys: { p256dh: `p256dh`, auth: `auth` } });
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
    // Brave ships with push messaging off; its own wording ("push service error") reads like the daemon broke.
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

    expect(push.error.value).not.toContain(`brave://`);
    expect(push.error.value).not.toContain(`Registration failed`);
    expect(push.error.value?.length).toBeGreaterThan(0);
});

test(`the state is read again once the daemon comes online, not only on mount`, async () => {
    // The page can mount before the daemon answers; a read landing in that window has nobody to ask.
    stubBrowser(`granted`, false);
    manager.getSubscription.mockResolvedValue(subscription(`https://push.example/live`, KEY_A));
    config.mockResolvedValue({ publicKey: KEY_A, subscribed: true });
    reachable.value = false;

    const push = usePushNotifications();
    await waitFor(() => expect(config).not.toHaveBeenCalled());
    expect(push.state.value).toBe(`checking`);

    reachable.value = true;

    await waitFor(() => expect(push.state.value).toBe(`on`));
    // Asked about this device by its own id, not about the sandbox as a whole.
    expect(config).toHaveBeenCalledWith({ id: `https://push.example/live` });
});

test(`a stale read cannot overwrite the toggle the user just moved`, async () => {
    // The mount-time read is slower, so without a guard it can land after a click and overwrite it.
    stubBrowser(`granted`, false);
    manager.getSubscription.mockResolvedValue(null);
    manager.subscribe.mockResolvedValue(subscription(`https://push.example/fresh`, KEY_A));
    config.mockResolvedValue({ publicKey: KEY_A, subscribed: false });

    const push = usePushNotifications();
    // The mount-time read is still in flight, deliberately not awaited, when the user turns it on.
    await push.enable();
    expect(push.state.value).toBe(`on`);

    await waitFor(() => expect(push.state.value).toBe(`on`));
});

test(`refresh reports "off" for a subscription bound to a superseded key`, async () => {
    // Both halves exist (subscription, daemon row) but the key moved; reporting on would hide that.
    stubBrowser(`granted`, false);
    manager.getSubscription.mockResolvedValue(subscription(`https://push.example/stale`, KEY_B));
    config.mockResolvedValue({ publicKey: KEY_A, subscribed: true });

    const push = usePushNotifications();
    await push.refresh();

    expect(push.state.value).toBe(`off`);
});
