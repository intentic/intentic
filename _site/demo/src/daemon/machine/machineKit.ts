import type { RawJsonOutput, RawJsonRouteKey } from "@intentic/sandbox-contract/protocol/raw/raw-json-routes";
import type { RuntimeDomain } from "@intentic/sandbox-contract/state/runtime-state";
import type { IntenticLine } from "@intentic/sandbox-contract/events/system-events";
import { Frames, refuse } from "@intentic/contract-serve";
import { json } from "../../transport";
import { listeners } from "../board/roster";

// What the simulated machine routes share: a JSON answer typed by the contract's schema for its raw route, a wait that
// stands in for the machine doing the work, and the runtime push the real daemon sends when such work moves.

/** A raw route's answer, typed by the contract's own output schema for that key, so a drifted shape is a build error. */
export const answer = <K extends RawJsonRouteKey>(_route: K, body: RawJsonOutput<K>): Response => json(body);

/** The time a machine takes to do something, so a press is watched rather than over before its row has redrawn. */
export const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Tells every open /events stream that these domains moved, as the daemon's publishRuntimeChange does. */
export const pushDomains = (...domains: RuntimeDomain[]): void => {
    for (const listener of listeners) {
        listener({ kind: `runtimeChanged`, domains });
    }
};

// A request's JSON body as fetch reads it, before any schema has looked at it.
type RequestBody = Awaited<ReturnType<Request[`json`]>>;
/** A socket frame's JSON, or undefined for one that is not JSON: the schema it is then parsed with says what it is. */
export const frameJson = (text: string): RequestBody | undefined => {
    try {
        return JSON.parse(text);
    } catch {
        // allow(silent-catch): text that is not JSON is undefined, which the schema it is parsed with then refuses in its own words.
        return undefined;
    }
};

// A picture socket's client frame, read field by field: every field is compared against the values that mean
// something, so one the editor never sends falls through to nothing.
export interface ClientFrame {
    readonly type?: string;
    readonly action?: string;
    readonly driving?: boolean;
    readonly x?: number;
    readonly y?: number;
    readonly text?: string;
    readonly key?: string;
}

/** The frame a `client` event carries, or an empty one for a binary frame or one that is not JSON. */
export const clientFrame = (event: Event): ClientFrame => {
    if (!(event instanceof MessageEvent) || event.data instanceof ArrayBuffer) {
        return {};
    }
    return frameJson(String(event.data)) ?? {};
};

// What a zod schema's safeParse answers, read structurally so this package needs no zod of its own.
interface Parser<T> {
    readonly safeParse: (
        body: RequestBody,
    ) => { readonly success: true; readonly data: T } | { readonly success: false; readonly error: { readonly issues: readonly { readonly message: string }[] } };
}

/** A raw write's JSON body, parsed by the contract's input schema for its route; refused with a 400 as the daemon does. */
export const inputOf = async <T>(schema: Parser<T>, request: Request): Promise<T> => {
    // An empty body is an empty object, as the daemon's routes read one; one that is not JSON fails the schema below.
    const text = await request.text();
    const parsed = schema.safeParse(text === `` ? {} : frameJson(text));
    return parsed.success ? parsed.data : refuse(parsed.error.issues.map((issue) => issue.message).join(`; `), 400);
};

// One step of an `IntenticLine` stream: a line of progress, the closing result, or the error that ends it.
export type PacedLine = { readonly message: string; readonly kind?: `line` | `result` | `error`; readonly after?: () => void };

/**
 * A command's streamed progress, the way `ic` prints it: each line after `stepMs`, the last one closing the stream.
 * `after` runs when its line goes out, so the state the line announces is what the next read sees.
 */
export const pacedLines = (lines: readonly PacedLine[], stepMs: number): Frames<IntenticLine> =>
    new Frames((sink) => {
        let step = 0;
        const timer = setInterval(() => {
            const line = lines[step];
            if (line === undefined) {
                sink.close();
                return;
            }
            line.after?.();
            sink.emit({ kind: line.kind ?? `line`, message: line.message });
            step += 1;
        }, stepMs);
        return () => clearInterval(timer);
    });
