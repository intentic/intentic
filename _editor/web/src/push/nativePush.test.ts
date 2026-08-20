import { beforeEach, expect, test, vi } from "vitest";
import type { PushNotificationsPlugin } from "../shell/capacitor";
import { nativePushDriver } from "./nativePush";

/* The native driver's own seams: the APNs token arrives as an EVENT the register() call does not answer, and
 * the relay's grant — not anything local — is what becomes the daemon's channel. Everything else (permission
 * states, the daemon round-trips) is the composable's flow and is tested there over the web driver. */

const listeners = new Map<string, (payload: never) => void>();

const plugin = (overrides?: Partial<PushNotificationsPlugin>): PushNotificationsPlugin =>
    ({
        checkPermissions: vi.fn(async () => ({ receive: `granted` as const })),
        requestPermissions: vi.fn(async () => ({ receive: `granted` as const })),
        // The token is delivered through the `registration` listener AFTER register() resolves — the shape
        // that makes the promise-wrapping worth testing.
        register: vi.fn(async () => {
            const handler = listeners.get(`registration`);
            setTimeout(() => handler?.({ value: `apns-token-1` } as never), 0);
        }),
        addListener: vi.fn(async (event: string, handler: (payload: never) => void) => {
            listeners.set(event, handler);
            return { remove: async () => undefined };
        }),
        ...overrides,
    }) as PushNotificationsPlugin;

const shell = { current: undefined as PushNotificationsPlugin | undefined };
vi.mock(`../shell/capacitor`, () => ({
    inNativeShell: () => shell.current !== undefined,
    pushPlugin: () => shell.current,
}));

const register = vi.fn();
const unregister = vi.fn();
vi.mock(`../composables/useApi`, () => ({ apiClient: { push: { register, unregister } } }));

const storage = new Map<string, string>();

beforeEach(() => {
    vi.clearAllMocks();
    listeners.clear();
    storage.clear();
    shell.current = plugin();
    register.mockResolvedValue({ deviceId: `d1`, secret: `s1`, url: `https://platform.example/rpc/push/send` });
    unregister.mockResolvedValue({ ok: true });
    vi.stubGlobal(`localStorage`, {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
    });
});

test(`minting registers the APNs token with the relay and hands the daemon the grant verbatim`, async () => {
    const minted = await nativePushDriver.mint(async () => `unused-vapid-key`);

    expect(register).toHaveBeenCalledWith({ platform: `ios`, token: `apns-token-1` });
    // The channel IS the grant: url, deviceId and secret pass through untouched, because the daemon stores
    // them verbatim and the relay minted them to be presented back.
    expect(minted).toEqual({
        outcome: `granted`,
        channel: { kind: `relay`, url: `https://platform.example/rpc/push/send`, deviceId: `d1`, secret: `s1` },
    });
    // The remembered id is what the settings toggle answers "is THIS phone registered" from.
    expect(await nativePushDriver.localId()).toBe(`d1`);
});

test(`a declined native prompt is terminal — iOS only asks once`, async () => {
    shell.current = plugin({ requestPermissions: vi.fn(async () => ({ receive: `denied` as const })) });

    await expect(nativePushDriver.mint(async () => ``)).resolves.toEqual({ outcome: `denied` });
    expect(register).not.toHaveBeenCalled();
});

test(`a push service that never answers surfaces advice instead of spinning forever`, async () => {
    vi.useFakeTimers();
    try {
        shell.current = plugin({ register: vi.fn(async () => undefined) }); // no registration event will fire
        const minting = nativePushDriver.mint(async () => ``);
        const failure = expect(minting).rejects.toThrow(/did not answer/);
        await vi.advanceTimersByTimeAsync(10_500);
        await failure;
    } finally {
        vi.useRealTimers();
    }
});

test(`a platform with no relay is named as the cause — not the sandbox, not the phone`, async () => {
    const { ORPCError } = await import(`@orpc/client`);
    register.mockRejectedValue(new ORPCError(`NOT_FOUND`, { status: 404 }));

    await expect(nativePushDriver.mint(async () => ``)).rejects.toThrow(/no push relay/);
});

test(`dropping forgets the device locally and releases the relay row`, async () => {
    storage.set(`intentic:push-device`, `d1`);

    await nativePushDriver.drop();

    expect(await nativePushDriver.localId()).toBe(null);
    expect(unregister).toHaveBeenCalledWith({ deviceId: `d1` });
});
