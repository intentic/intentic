import type { WorkerCallRequest, WorkerCallResponse, WorkerPort } from "./lib/workerCall.js";
import { defineComponent, h } from "vue";

// Canonical `Icon` stand-in for component tests, since Icon is registered globally and an unmounted name fails the
// render. Renders `data-icon`/`data-spin`, not a CSS spin class: the real Icon animates via SVG honoring
// prefers-reduced-motion, and reducedMotion.test.ts bans CSS motion in app/kit source.
export const IconStub = defineComponent({
    name: `Icon`,
    props: { name: { type: String, default: `` }, spin: Boolean },
    setup: (props) => () => h(`i`, { "data-icon": props.name, ...(props.spin ? { "data-spin": `` } : {}) }),
});

// The one fake of a `createWorkerCall` worker, for every suite that stands one up.
export class FakeWorker<Args, Result> implements WorkerPort<Args, Result> {
    readonly sent: WorkerCallRequest<Args>[] = [];
    readonly transferred: (Transferable[] | undefined)[] = [];
    terminated = false;
    private message?: (event: MessageEvent<WorkerCallResponse<Result>>) => void;
    private error?: (event: ErrorEvent) => void;

    postMessage(message: WorkerCallRequest<Args>, transfer?: Transferable[]): void {
        this.sent.push(message);
        this.transferred.push(transfer);
    }

    addEventListener(type: `message`, listener: (event: MessageEvent<WorkerCallResponse<Result>>) => void): void;
    addEventListener(type: `error`, listener: (event: ErrorEvent) => void): void;
    addEventListener(type: `message` | `error`, listener: ((event: MessageEvent<WorkerCallResponse<Result>>) => void) | ((event: ErrorEvent) => void)): void {
        if (type === `message`) {
            this.message = listener as (event: MessageEvent<WorkerCallResponse<Result>>) => void;
        } else {
            this.error = listener as (event: ErrorEvent) => void;
        }
    }

    respond(response: WorkerCallResponse<Result>): void {
        this.message?.({ data: response } as MessageEvent<WorkerCallResponse<Result>>);
    }

    crash(message: string): void {
        this.error?.({ error: new Error(message), message } as ErrorEvent);
    }

    terminate(): void {
        this.terminated = true;
    }
}
