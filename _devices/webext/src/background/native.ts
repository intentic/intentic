import {
    KEYRING_NATIVE_HOST,
    KeyringNativeRequestSchema,
    KeyringNativeResponseSchema,
    type KeyringNativeRequest,
    type KeyringNativeResponse,
} from "@intentic/sandbox-contract/webext";

// One native-messaging port to `intentic-keyring native-host`: lazy connect, idle disconnect, correlated requests.

const IDLE_MS = 60_000;
const TIMEOUT_DEFAULT_MS = 10_000;
const TIMEOUT_FILL_MS = 150_000;

export interface NativePortLike {
    postMessage(message: unknown): void;
    onMessage: { addListener(cb: (message: unknown) => void): void; removeListener(cb: (message: unknown) => void): void };
    onDisconnect: { addListener(cb: () => void): void; removeListener(cb: () => void): void };
    disconnect(): void;
}

export type ConnectNative = (host: string) => NativePortLike;

interface Pending {
    readonly resolve: (response: KeyringNativeResponse) => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
}

let port: NativePortLike | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
const pending = new Map<string, Pending>();
let connectNativeFn: ConnectNative = (host) => chrome.runtime.connectNative(host) as unknown as NativePortLike;

const bumpIdle = (): void => {
    if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(() => {
        closeNativePort();
    }, IDLE_MS);
};

const onPortMessage = (raw: unknown): void => {
    const parsed = KeyringNativeResponseSchema.safeParse(raw);
    if (!parsed.success) {
        return;
    }
    const msg = parsed.data;
    const wait = pending.get(msg.id);
    if (wait === undefined) {
        return;
    }
    clearTimeout(wait.timer);
    pending.delete(msg.id);
    wait.resolve(msg);
    bumpIdle();
};

const onPortDisconnect = (): void => {
    port = undefined;
    for (const [id, wait] of pending) {
        clearTimeout(wait.timer);
        wait.reject(new Error(chrome.runtime.lastError?.message ?? "Native host disconnected"));
        pending.delete(id);
    }
};

export const closeNativePort = (): void => {
    if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
    }
    if (port !== undefined) {
        port.disconnect();
        port = undefined;
    }
};

export const setConnectNativeForTests = (fn: ConnectNative | undefined): void => {
    connectNativeFn = fn ?? ((host) => chrome.runtime.connectNative(host) as unknown as NativePortLike);
};

const ensurePort = (): NativePortLike => {
    if (port !== undefined) {
        return port;
    }
    const next = connectNativeFn(KEYRING_NATIVE_HOST);
    port = next;
    next.onMessage.addListener(onPortMessage);
    next.onDisconnect.addListener(onPortDisconnect);
    bumpIdle();
    return next;
};

export const nativeRequest = async (
    body: KeyringNativeRequest | (Record<string, unknown> & Pick<KeyringNativeRequest, "type">),
    options?: { timeoutMs?: number },
): Promise<KeyringNativeResponse> => {
    const id = typeof (body as { id?: string }).id === "string" ? (body as { id: string }).id : crypto.randomUUID().slice(0, 32);
    const request = KeyringNativeRequestSchema.parse({ ...body, id });
    const timeoutMs = options?.timeoutMs ?? (request.type === "fill" ? TIMEOUT_FILL_MS : TIMEOUT_DEFAULT_MS);
    const p = ensurePort();
    return await new Promise<KeyringNativeResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`Native host did not answer in ${timeoutMs / 1000}s`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a native-messaging port's postMessage takes no target origin; the rule is about window.postMessage
        p.postMessage(request);
        bumpIdle();
    });
};

/** Whether the last disconnect looked like a missing host manifest. */
export const nativeHostMissing = (): boolean => {
    const err = chrome.runtime.lastError?.message ?? "";
    return /native host|not found|specified native messaging host/i.test(err);
};
