// SPDX-License-Identifier: AGPL-3.0-only
// After ranuts/document lib/onlyoffice/open-failure.ts at 1301bb8b (AGPL-3.0); see editor/NOTICE. Kept: routing the
// failure into the SDK's own error path. Left out: the in-page retry, which here is the viewer's "Try again".

// The offline controller awaits AscCommon.x2t.convertToBin inside loadDocument with no catch, so a document x2t cannot
// import is nothing but an unhandled rejection in the editor frame: no error event, and the loading mask stays up
// forever. Routed into the SDK's own error path, the editor shows its open-error dialog and ends the mask. Once the
// document is open, the same failure is a failed export, and the save that asked for it is told.

const CONVERSION_FAILURE = /Document conversion failed|Conversion failed with code|X2T module/i;

export interface OpenFailureHooks {
    // Whether the document has opened (the editor reported it ready).
    readonly opened: () => boolean;
    readonly openFailed: (detail: string) => void;
    readonly exportFailed: (detail: string) => void;
}

interface ErrorAsc {
    editor?: { sendEvent?: (name: string, ...args: unknown[]) => void };
    c_oAscError?: { ID?: { ConvertationOpenError?: number }; Level?: { Critical?: number } };
    c_oAscAsyncActionType?: { BlockInteraction?: number };
    c_oAscAsyncAction?: { Open?: number };
}

// Frames the guard listens in, by document: the frame's window outlives its first, blank document.
const guarded = new WeakSet<Document>();

// A rejection's message: its own when it has one, else what it reads as.
const messageOf = (event: PromiseRejectionEvent): string => {
    // SAFETY: a rejection reason is whatever was thrown; only its `message`, when present, is read.
    const reason = event.reason as { message?: unknown } | null | undefined;
    return String(reason?.message ?? reason);
};

// Tells the SDK its open failed, so it shows its own dialog and ends the loading mask.
const reportOpenFailure = (asc: ErrorAsc | undefined): void => {
    const send = asc?.editor?.sendEvent?.bind(asc.editor);
    if (send === undefined) {
        return;
    }
    send(`asc_onError`, asc?.c_oAscError?.ID?.ConvertationOpenError ?? -82, asc?.c_oAscError?.Level?.Critical ?? -1);
    const block = asc?.c_oAscAsyncActionType?.BlockInteraction;
    const open = asc?.c_oAscAsyncAction?.Open;
    if (block !== undefined && open !== undefined) {
        send(`asc_onEndAction`, block, open);
    }
};

export const installOpenFailureGuard = (frame: Window, hooks: OpenFailureHooks): void => {
    if (guarded.has(frame.document)) {
        return;
    }
    guarded.add(frame.document);
    // The vendor leaves both the conversion's promise and loadDocument's own unhandled: every failure arrives twice.
    let reported = false;
    frame.addEventListener(`unhandledrejection`, (event: PromiseRejectionEvent) => {
        const message = messageOf(event);
        if (!CONVERSION_FAILURE.test(message)) {
            return;
        }
        if (hooks.opened()) {
            hooks.exportFailed(message);
            return;
        }
        if (reported) {
            return;
        }
        reported = true;
        hooks.openFailed(message);
        // SAFETY: the frame's globals are the vendor's; ErrorAsc declares every member read as optional.
        reportOpenFailure((frame as Window & { Asc?: ErrorAsc }).Asc);
    });
};
