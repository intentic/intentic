import type { WorkerCallRequest, WorkerCallResponse, WorkerPort } from "../lib/workerCall";

// The one fake of a workerCall worker, for every suite; never bundled (nothing the app loads imports it).
export class FakeWorker<Args, Result> implements WorkerPort<Args, Result> {
    readonly sent: WorkerCallRequest<Args>[] = [];
    terminated = false;
    private message?: (event: MessageEvent<WorkerCallResponse<Result>>) => void;
    private error?: (event: ErrorEvent) => void;

    postMessage(message: WorkerCallRequest<Args>): void {
        this.sent.push(message);
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
