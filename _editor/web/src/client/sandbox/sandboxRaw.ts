import { RAW_JSON_ROUTES, type RawJsonInput, type RawJsonOutput, type RawJsonRouteKey, rawRoutePath } from "@intentic/sandbox-contract";
import { jsonBody } from "./jsonBody";
import { sandboxJson } from "./sandboxClient";

// One of the daemon's plain-JSON raw routes, called by its contract key: the path from the route table, the body from
// the route's input (JSON, or the document a `text` route takes), and the answer parsed with the route's own output
// schema, so a hand-written route reads as typed as a procedure. Its own module, not sandboxClient, since tests stub
// that module whole: this goes through its `sandboxJson`, so a stubbed one still sees every call.
export interface SandboxRawCall<Key extends RawJsonRouteKey> {
    readonly input?: RawJsonInput<Key>;
    // Appended as the query string: `{ refresh: "" }` asks /environment/contents to probe again.
    readonly query?: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
}

const requestInit = (method: string, text: boolean, input: unknown, signal: AbortSignal | undefined): RequestInit | undefined => {
    const withSignal = signal === undefined ? {} : { signal };
    if (method === `GET`) {
        return signal === undefined ? undefined : withSignal;
    }
    if (text) {
        return { method, body: input as string, ...withSignal };
    }
    return { ...(input === undefined ? { method } : jsonBody(method as `POST` | `DELETE`, input)), ...withSignal };
};

export async function sandboxRaw<Key extends RawJsonRouteKey>(key: Key, call: SandboxRawCall<Key> = {}): Promise<RawJsonOutput<Key>> {
    const route = RAW_JSON_ROUTES[key];
    const method = key.slice(0, key.indexOf(` `));
    const query = call.query === undefined ? `` : `?${new URLSearchParams(call.query).toString()}`;
    const init = requestInit(method, `text` in route, call.input, call.signal);
    return route.output.parse(await sandboxJson<unknown>(`${rawRoutePath(key)}${query}`, init)) as RawJsonOutput<Key>;
}
