// The web baseline's driver, run in the page ahead of the app (serialised into the script `web.ts` serves): it reports
// when the long chat has drawn rows and, when asked, sends the prompt that starts the streamed turn, then reports when
// that turn ends. It reaches nothing but its argument, the page and `window.SpikeBridge` (WebConversationActivity).



export interface DriverAsk {
    readonly stream: boolean;
    readonly streamDelayMs: number;
    readonly prompt: string;
}

interface Bridge {
    readonly ready: (drawn: number) => void;
    readonly streamDone: (drawn: number) => void;
}

declare global {
    interface Window {
        /** WebConversationActivity's JavaScript interface; absent in a plain browser. */
        SpikeBridge?: Bridge;
    }
}

export function spikeDriver(ask: DriverAsk): void {
    const bridge = window.SpikeBridge;
    const drawn = (): number => document.querySelectorAll(`.chat-message`).length;
    const finished = (): boolean => window.perfChat?.done === true;

    const watchStream = (): void => {
        if (finished()) {
            bridge?.streamDone(drawn());
            return;
        }
        setTimeout(watchStream, 100);
    };

    const send = (): void => {
        const area = document.querySelector(`textarea`);
        if (!(area instanceof HTMLTextAreaElement)) {
            throw new Error(`no composer`);
        }
        // Set through the prototype's setter so the framework's own input listener sees the change.
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, `value`)?.set?.call(area, ask.prompt);
        area.dispatchEvent(new Event(`input`, { bubbles: true }));
        setTimeout(() => {
            const button = [...document.querySelectorAll(`button[aria-label]`)].find((candidate) => /^send/iu.test(candidate.getAttribute(`aria-label`) ?? ``));
            if (!(button instanceof HTMLElement)) {
                throw new Error(`no send button`);
            }
            button.click();
            watchStream();
        }, 100);
    };

    // Ready once a frame with rows in it has been produced: two animation frames after the rows are in the document.
    const waitForRows = (): void => {
        if (drawn() <= 3) {
            requestAnimationFrame(waitForRows);
            return;
        }
        requestAnimationFrame(() =>
            requestAnimationFrame(() => {
                bridge?.ready(drawn());
                if (ask.stream) {
                    setTimeout(send, ask.streamDelayMs);
                }
            }),
        );
    };
    requestAnimationFrame(waitForRows);
}
