import { MANIFESTS } from "@intentic/workspace-setup";
import { desktopApp } from "../../../../app/environments/desktop";
import { useEndpoint } from "../../../../client/endpoint/useEndpoint";
import { currentSandboxTarget } from "../../../../client/sandbox/sandboxTarget";
import { DROP_SKIP } from "../../explorer/transfer/dropEntries";

// A big drop handed to the desktop app, which copies it into a sandbox on this same computer itself: it walks the
// dropped folders on disk and streams them into the sandbox's container (the app's drop_copy.rs), where the page would
// read every file and upload it over HTTP. The page posts the drop's files to the app through WebView2, which hands
// the app each one's place on disk, and hears how far the copy has got as `intentic:drop-copy` events.
//
// Asked only where it can work: the app's window on Windows (the only WebView that says where a dropped file is), a
// sandbox reached on this computer's loopback, and the uploads going to that same sandbox. Anything the app will not
// take (no Docker, a drop too small to be worth it, a file with no place on disk) comes back declined, and the drop is
// uploaded the way it always is.

// The smallest drop the app copies: below it the upload is quick anyway, and keeps what only it does (skipping files
// the sandbox already has, a row per file as it lands).
const AT_LEAST = { files: 1000, bytes: 1024 ** 3 } as const;
// How long the app has to say it heard the drop before the browser takes it instead.
const ANSWER_MS = 5000;

export const NATIVE_COPY_EVENT = `intentic:drop-copy`;

// WebView2's bridge, as far as this uses it. Messages go as objects: Tauri's own IPC reads only strings, so it never
// sees these.
interface WebviewBridge {
    postMessage(message: unknown): void;
    postMessageWithAdditionalObjects?(message: unknown, additionalObjects: ArrayLike<unknown>): void;
}

const webviewBridge = (): WebviewBridge | undefined => (globalThis as { chrome?: { webview?: WebviewBridge } }).chrome?.webview;

export interface NativeDrop {
    readonly files: readonly File[];
    readonly port: number;
}

// The loopback port of the sandbox the uploads go to, when that is where this page reaches it.
const localPort = (): number | undefined => {
    const { daemonBase, usingLocal } = useEndpoint();
    const base = daemonBase.value;
    const target = currentSandboxTarget();
    if (!usingLocal.value || base === undefined || target === undefined) {
        return undefined;
    }
    try {
        const reached = new URL(base);
        const port = Number(reached.port);
        return reached.origin === new URL(target.base).origin && port > 0 ? port : undefined;
        // allow(silent-catch): an address that does not parse is not one the app could find a container by.
    } catch {
        return undefined;
    }
};

// The drop's files, taken inside the drop event (the drag-data store empties once it returns), when the app could
// copy them; undefined to upload as usual.
export const captureNativeDrop = (dataTransfer: DataTransfer): NativeDrop | undefined => {
    if (desktopApp()?.nativeCopy !== true || webviewBridge()?.postMessageWithAdditionalObjects === undefined) {
        return undefined;
    }
    const port = localPort();
    const files = Array.from(dataTransfer.files);
    return port === undefined || files.length === 0 ? undefined : { files, port };
};

export interface NativeRoot {
    readonly name: string;
    readonly dir: boolean;
    readonly files: number;
    readonly bytes: number;
}

export interface NativeProgress {
    readonly done: number;
    // Bytes of the files done, and of those plus the one going now.
    readonly doneBytes: number;
    readonly sentBytes: number;
    readonly failed: number;
    readonly current?: string;
    // Per dropped item, in the order `copying` named them.
    readonly roots?: readonly { readonly done: number; readonly failed: number }[];
}

export type NativeEvent =
    | { readonly kind: "received" }
    | { readonly kind: "scanning"; readonly files: number; readonly bytes: number; readonly current: string }
    | {
          readonly kind: "copying";
          readonly files: number;
          readonly bytes: number;
          readonly unreadable: number;
          // Drop-relative paths of project manifests, for the install offer.
          readonly manifests: readonly string[];
          readonly roots: readonly NativeRoot[];
      }
    | ({ readonly kind: "progress" } & NativeProgress)
    | ({
          readonly kind: "finished";
          // The first failures by name (paths below /work); `failed` counts them all.
          readonly failures?: readonly { readonly path: string; readonly error: string }[];
          readonly cancelled?: boolean;
          // Why the copy as a whole stopped short; what landed before it stays.
          readonly error?: string;
      } & NativeProgress);

// Runs one drop through the app. "declined": the app will not take it, and the caller uploads it as usual. "handled":
// it finished, or was cancelled through `signal`. `onEvent` hears every step the app reports.
export const copyNatively = (drop: NativeDrop, target: string, signal: AbortSignal, onEvent: (event: NativeEvent) => void): Promise<"declined" | "handled"> =>
    new Promise((resolve) => {
        const bridge = webviewBridge();
        const id = crypto.randomUUID();
        let heard = false;
        let settled = false;
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- WebView2's bridge posts to the app, not to a window
        const cancel = (): void => bridge?.postMessage({ intentic: `drop-copy-cancel`, id });
        const settle = (outcome: "declined" | "handled"): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(deadline);
            window.removeEventListener(NATIVE_COPY_EVENT, listen);
            signal.removeEventListener(`abort`, abort);
            resolve(outcome);
        };
        const listen = (event: Event): void => {
            const detail = (event as CustomEvent<(NativeEvent | { readonly kind: "declined"; readonly reason: string }) & { readonly id?: string }>).detail;
            if (detail?.id !== id) {
                return;
            }
            heard = true;
            if (detail.kind === `declined`) {
                settle(`declined`);
                return;
            }
            onEvent(detail);
            if (detail.kind === `finished`) {
                settle(`handled`);
            }
        };
        const abort = (): void => {
            cancel();
            settle(`handled`);
        };
        // An app that never answers must not hold the drop: the browser takes it, and the app is told to let go, in
        // case its answer is only late.
        const deadline = setTimeout(() => {
            if (!heard) {
                cancel();
                settle(`declined`);
            }
        }, ANSWER_MS);
        window.addEventListener(NATIVE_COPY_EVENT, listen);
        signal.addEventListener(`abort`, abort, { once: true });
        try {
            bridge?.postMessageWithAdditionalObjects?.(
                { intentic: `drop-copy`, id, port: drop.port, target, skip: DROP_SKIP, manifests: [...MANIFESTS], atLeast: AT_LEAST },
                drop.files,
            );
        } catch (error) {
            console.warn(`The desktop app could not be handed the drop; uploading it instead`, error);
            settle(`declined`);
        }
    });
