import { onScopeDispose, ref, type Ref } from "vue";

// THE REMOTE SCREEN AS THE WHOLE SCREEN, AND THE KEYBOARD AND MOUSE WITH IT. In full screen the Keyboard Lock API
// (Chromium) hands the far computer the keys this one would otherwise act on: Windows/⌘, Alt+Tab, Esc, Ctrl+W. The way
// out stays the browser's own, holding Esc, which it announces itself, and the view's own button, revealed at the top
// edge. Pointer lock keeps the mouse in the picture and reports only how far it moved (remotePointer.ts); Esc lets go.
// A browser without either is offered neither, rather than a button that does nothing.

// The Keyboard Lock API, which TypeScript's DOM types do not carry yet.
interface KeyboardLock {
    readonly lock: (codes?: readonly string[]) => Promise<void>;
    readonly unlock: () => void;
}
const keyboardLock = (): KeyboardLock | undefined =>
    // SAFETY: `keyboard` is read only where the browser defines it, and lock/unlock are the API's whole surface used here.
    `keyboard` in navigator ? (navigator as Navigator & { readonly keyboard: KeyboardLock }).keyboard : undefined;

export interface FullscreenLock {
    readonly fullscreen: Ref<boolean>;
    // Every key goes to the far computer while in full screen.
    readonly keysCaptured: Ref<boolean>;
    readonly pointerLocked: Ref<boolean>;
    readonly canFullscreen: boolean;
    readonly canCaptureKeys: boolean;
    readonly enter: () => Promise<void>;
    readonly exit: () => void;
    readonly lockPointer: () => void;
    readonly unlockPointer: () => void;
}

// Leaves full screen; one already left (the person held Esc) is the state asked for.
const leave = async (): Promise<void> => {
    try {
        await document.exitFullscreen();
    } catch {
        // allow(silent-catch): nothing is in full screen any more, which is what was asked.
    }
};

// Raw movement where the browser has it, so this computer's pointer acceleration is not applied twice; plain where not.
const lockPointer = async (element: HTMLElement | null): Promise<void> => {
    try {
        await element?.requestPointerLock({ unadjustedMovement: true });
    } catch {
        try {
            await element?.requestPointerLock();
        } catch {
            // allow(silent-catch): a refused lock leaves the pointer free, which the button's unpressed state shows.
        }
    }
};

export const useFullscreenLock = (root: Ref<HTMLElement | null>, stage: Ref<HTMLElement | null>): FullscreenLock => {
    const fullscreen = ref(false);
    const keysCaptured = ref(false);
    const pointerLocked = ref(false);

    const onFullscreen = (): void => {
        fullscreen.value = root.value !== null && document.fullscreenElement === root.value;
        if (!fullscreen.value && keysCaptured.value) {
            keyboardLock()?.unlock();
            keysCaptured.value = false;
        }
    };
    const onPointerLock = (): void => {
        pointerLocked.value = stage.value !== null && document.pointerLockElement === stage.value;
    };
    document.addEventListener(`fullscreenchange`, onFullscreen);
    document.addEventListener(`pointerlockchange`, onPointerLock);
    onScopeDispose(() => {
        document.removeEventListener(`fullscreenchange`, onFullscreen);
        document.removeEventListener(`pointerlockchange`, onPointerLock);
        if (fullscreen.value) {
            void leave();
        }
    });

    return {
        fullscreen,
        keysCaptured,
        pointerLocked,
        canFullscreen: document.fullscreenEnabled,
        canCaptureKeys: keyboardLock() !== undefined,
        enter: async () => {
            const element = root.value;
            if (element === null) {
                return;
            }
            await element.requestFullscreen({ navigationUI: `hide` });
            const lock = keyboardLock();
            if (lock === undefined) {
                return;
            }
            try {
                await lock.lock();
                keysCaptured.value = true;
            } catch {
                // allow(silent-catch): a browser that refuses the lock leaves the keys it acts on with this computer, which
                // the full screen's own line says.
            }
        },
        exit: () => void leave(),
        lockPointer: () => void lockPointer(stage.value),
        unlockPointer: () => document.exitPointerLock(),
    };
};
