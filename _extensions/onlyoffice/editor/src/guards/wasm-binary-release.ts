// SPDX-License-Identifier: AGPL-3.0-only
// Ported from ranuts/document lib/onlyoffice/guards/wasm-binary-release.ts at 1301bb8b (AGPL-3.0); see editor/NOTICE.

// Drops the x2t binary once emscripten has compiled it. Where the converter loads in the frame itself (an engine that
// cannot stream it), the 40 MB inflated module is parked on `Module.wasmBinary` and on x2t.js's own top-level
// `wasmBinary`, read once in createWasm and never again, but kept for the frame's life. `calledRun` is set strictly
// after createWasm, so that is the moment to let both go. The converter can load long after any polling has stopped
// (a blank document loads none until its first save), so this watches the properties instead of polling for them.

interface X2tModule {
    wasmBinary?: ArrayBuffer | null;
    calledRun?: boolean;
}

type GuardWindow = Window & {
    Module?: X2tModule;
    wasmBinary?: ArrayBuffer | null;
};

// Frames whose `Module` is watched, by document: the frame's window outlives its first, blank document.
const watched = new WeakSet<Document>();

const release = (win: GuardWindow, module: X2tModule): void => {
    module.wasmBinary = undefined;
    // A `var`-declared global is writable, just not configurable: this assignment is what returns the memory.
    win.wasmBinary = undefined;
};

const watchCalledRun = (win: GuardWindow, module: X2tModule): void => {
    if (module.calledRun === true) {
        release(win, module);
        return;
    }
    let value: boolean | undefined = module.calledRun;
    Object.defineProperty(module, `calledRun`, {
        configurable: true,
        enumerable: true,
        get: () => value,
        set: (next: boolean) => {
            value = next;
            if (next) {
                release(win, module);
            }
        },
    });
};

// Answers whether the caller's polling can stop: a watcher is in place that drops the buffer whenever x2t has run.
export const releaseWasmBinary = (frame: Window): boolean => {
    if (watched.has(frame.document)) {
        return true;
    }
    // SAFETY: the frame's globals are the vendor's; Module and wasmBinary are read as optional.
    const win = frame as GuardWindow;
    try {
        // x2t_helper publishes `window.Module` as a fresh object, more than once: watch the property that carries them.
        let current = win.Module;
        Object.defineProperty(win, `Module`, {
            configurable: true,
            enumerable: true,
            get: () => current,
            set: (next: X2tModule | undefined) => {
                current = next;
                if (next !== undefined) {
                    watchCalledRun(win, next);
                }
            },
        });
        if (current !== undefined) {
            watchCalledRun(win, current);
        }
        watched.add(frame.document);
        return true;
    } catch {
        // allow(silent-catch): a frame that refuses the accessors keeps the 40 MB, as it always did; polling stops asking.
        return false;
    }
};
