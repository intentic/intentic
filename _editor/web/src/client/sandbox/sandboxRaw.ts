import {
    fillRoutePath,
    RAW_JSON_ROUTES,
    type RawJsonInput,
    type RawJsonOutput,
    type RawJsonRouteKey,
    type RawRouteParams,
    rawRoutePath,
} from "@intentic/sandbox-contract";
import { jsonBody } from "./jsonBody";
import { sandboxJson } from "./sandboxClient";
import { staleDaemonReason } from "./useDaemonRoutes";

// One of the daemon's plain-JSON raw routes, called by its contract key: the path from the route table (its `{param}`
// segments filled and encoded), the body from the route's input (JSON, the document a `text` route takes, or the
// bytes a `bytes` route takes), and the answer parsed with the route's own output schema, so a hand-written route reads
// as typed as a procedure. The only door to these routes: nothing outside this client spells a daemon path to
// `sandboxJson` or `sandboxRequest` (_tools/checks/daemon-doors.mjs). Its own module, not sandboxClient, since tests
// stub that module whole: this goes through its `sandboxJson`, so a stubbed one still sees every call.
interface SandboxRawOptions<Key extends RawJsonRouteKey> {
    // The body: JSON, a document, or bytes, as the route's entry in RAW_JSON_ROUTES says. A Blob, an ArrayBuffer and a
    // string need no `duplex`, which only a stream body does.
    readonly input?: RawJsonInput<Key>;
    // Appended as the query string: `{ refresh: "" }` asks /environment/contents to probe again, `{ id }` names the peer
    // a pairing is for.
    readonly query?: Readonly<Record<string, string>>;
    // Request headers the daemon reads by name, beside the content type the body brings: a save's base hash.
    readonly headers?: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
}

// The routes whose path is fixed, and the ones with `{param}` segments, whose values the caller must supply.
type Fixed = { [Key in RawJsonRouteKey]: keyof RawRouteParams<Key> extends never ? Key : never }[RawJsonRouteKey];
type Parameterised = Exclude<RawJsonRouteKey, Fixed>;

export type SandboxRawCall<Key extends RawJsonRouteKey> = SandboxRawOptions<Key> & { readonly params?: RawRouteParams<Key> };

// What the call looks like once the key is no longer a type parameter: the route's own entry decides the body's kind.
interface Resolved {
    readonly method: string;
    readonly body: `json` | `document` | `bytes`;
    readonly input: unknown;
    readonly headers: Readonly<Record<string, string>> | undefined;
    readonly signal: AbortSignal | undefined;
}

// The body as its route takes it, with the method: JSON under its content type, a document or bytes as they are.
const bodyInit = ({ method, body, input, headers }: Resolved): RequestInit => {
    if (method === `GET`) {
        return {};
    }
    if (input === undefined) {
        return { method };
    }
    if (body === `json`) {
        return jsonBody(method as `POST` | `DELETE`, input, headers);
    }
    // SAFETY: a `text` or `bytes` route's input is typed as the string or RawBytes the browser takes as a body (RawJsonInput).
    return { method, body: input as BodyInit };
};

const requestInit = (call: Resolved): RequestInit | undefined => {
    if (call.method === `GET` && call.headers === undefined && call.signal === undefined) {
        return undefined;
    }
    const init = bodyInit(call);
    // jsonBody has already put them beside its content type.
    if (call.headers !== undefined && init.headers === undefined) {
        init.headers = call.headers;
    }
    if (call.signal !== undefined) {
        init.signal = call.signal;
    }
    return init;
};

// The values a route's `{param}` segments need are required exactly when it has some.
export function sandboxRaw<Key extends Fixed>(key: Key, call?: SandboxRawCall<Key>): Promise<RawJsonOutput<Key>>;
export function sandboxRaw<Key extends Parameterised>(key: Key, call: SandboxRawCall<Key> & { readonly params: RawRouteParams<Key> }): Promise<RawJsonOutput<Key>>;
export async function sandboxRaw<Key extends RawJsonRouteKey>(key: Key, call?: SandboxRawCall<Key>): Promise<RawJsonOutput<Key>> {
    // A daemon that predates this route answers 404, which on its own reaches the reader as "the request failed (404)"
    // and sends them looking for a fault in their own sandbox. The hello says which raw routes this one serves, so the
    // gap is named here instead, in the same words a missing procedure gets.
    const stale = staleDaemonReason(key);
    if (stale !== undefined) {
        throw new Error(stale);
    }
    const route: { readonly text?: true; readonly bytes?: true; readonly output: (typeof RAW_JSON_ROUTES)[RawJsonRouteKey][`output`] } = RAW_JSON_ROUTES[key];
    const query = call?.query === undefined ? `` : `?${new URLSearchParams(call.query).toString()}`;
    const path = fillRoutePath(rawRoutePath(key), call?.params);
    const init = requestInit({
        method: key.slice(0, key.indexOf(` `)),
        body: route.text === true ? `document` : route.bytes === true ? `bytes` : `json`,
        input: call?.input,
        headers: call?.headers,
        signal: call?.signal,
    });
    // SAFETY: the route's own output schema parsed the answer, and RawJsonOutput is that schema's output for this key.
    const answer = init === undefined ? await sandboxJson<unknown>(`${path}${query}`) : await sandboxJson<unknown>(`${path}${query}`, init);
    return route.output.parse(answer) as RawJsonOutput<Key>;
}
