import {
    RAW_ROUTES,
    type RawRouteKey,
    sandboxContract,
    sandboxRouteFor,
    type SandboxGroup,
    type SandboxHandlerInput,
    type SandboxHandlerOutput,
    type SandboxProcedure,
} from "@intentic/sandbox-contract";
import { eventStream, type StreamSink } from "./sse";
import { json } from "./transport";

// The demo's stand-in for the daemon's OpenAPI handler: a request resolves to its route by the contract's own matcher,
// a procedure's input is decoded and parsed as oRPC's handler does it, and every answer is typed by the contract. The
// routes the daemon serves outside oRPC are answered by hand, keyed by the contract's declaration of each.

// Thrown by any handler to refuse: answered as the daemon's own `{ error }` body, with its status.
export class Refusal extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
    }
}

export const refuse = (message: string, status = 403): never => {
    throw new Refusal(message, status);
};

// A streamed procedure's answer: frames pushed into a sink until either end lets go, then `start`'s teardown, once.
export class Frames<T> {
    constructor(readonly start: (sink: StreamSink<T>) => () => void) {}
}

// A handler's answer: its procedure's output, with a stream's frames pushed rather than iterated.
type Answer<T> = T extends AsyncIteratorObject<infer F, unknown, void> ? Frames<F> : T;

export type ProcedureHandler<G extends SandboxGroup, P extends SandboxProcedure<G>> = (
    input: SandboxHandlerInput<G, P>,
) => Answer<SandboxHandlerOutput<G, P>> | Promise<Answer<SandboxHandlerOutput<G, P>>>;

// The fixture's half of the contract: a handler for each procedure it serves, held to that procedure's types.
export type FixtureRouter = { readonly [G in SandboxGroup]?: { readonly [P in SandboxProcedure<G>]?: ProcedureHandler<G, P> } };

export interface RawContext {
    readonly request: Request;
    readonly url: URL;
    // One `{name}` segment of the matched route's path, decoded.
    readonly param: (name: string) => string;
}

// A raw route's answer, or undefined for "not mine" (a path in an extension's namespace the fixture has no answer for).
export type RawRoutes = { readonly [K in RawRouteKey]?: (context: RawContext) => Response | undefined | Promise<Response | undefined> };

// A schema read the way oRPC's handler validates with one: Standard Schema, whichever library wrote it.
type Validation = { readonly value: unknown; readonly issues?: undefined } | { readonly issues: readonly { readonly message: string }[] };
interface InputSchema {
    readonly "~standard": { readonly validate: (value: unknown) => Validation | Promise<Validation> };
}

// Read structurally, like the contract's own route tables do, since `~orpc` is oRPC's internal metadata.
const inputSchemaOf = (group: string, name: string): InputSchema | undefined =>
    (sandboxContract as Readonly<Record<string, Readonly<Record<string, { readonly "~orpc": { readonly inputSchema?: InputSchema } }>>>>)[group]?.[
        name
    ]?.[`~orpc`].inputSchema;

const isRawRoute = (name: string): name is RawRouteKey => Object.hasOwn(RAW_ROUTES, name);

// A route's `{param}` segments off the request path, decoded, as oRPC and Hono both hand them to a handler.
const paramsOf = (template: string, path: string): Readonly<Record<string, string>> => {
    const actual = path.split(`/`);
    return Object.fromEntries(
        template.split(`/`).flatMap((segment, index) => (segment.startsWith(`{`) ? [[segment.slice(1, -1), decodeURIComponent(actual[index] ?? ``)]] : [])),
    );
};

// The editor's OpenAPILink sends an object as JSON and sends no body at all for a call with nothing past its path.
const bodyOf = async (request: Request): Promise<unknown> => {
    const text = await request.text();
    return text === `` ? undefined : JSON.parse(text);
};

// oRPC's compact input: the path's params overlaid by the query's keys for a GET, by the JSON body otherwise, then the
// procedure's input schema over the whole. Flat keys only: no GET input in the contract carries an array or an object.
const inputOf = async (group: string, name: string, request: Request, url: URL, params: Readonly<Record<string, string>>): Promise<unknown> => {
    const data = request.method === `GET` ? Object.fromEntries(url.searchParams) : await bodyOf(request);
    const merged = data === undefined ? params : typeof data === `object` && data !== null && !Array.isArray(data) ? { ...params, ...data } : data;
    const schema = inputSchemaOf(group, name);
    if (schema === undefined) {
        return merged;
    }
    const checked = await schema[`~standard`].validate(merged);
    return checked.issues === undefined ? checked.value : refuse(`Input validation failed: ${checked.issues.map((issue) => issue.message).join(`; `)}`, 400);
};

// The one untyped seam: a handler found by the route's name, its input already parsed by the schema its type names.
const handlerOf = (procedures: FixtureRouter, group: string, name: string): ((input: never) => unknown) | undefined =>
    (procedures as Readonly<Record<string, Readonly<Record<string, ((input: never) => unknown) | undefined>> | undefined>>)[group]?.[name];

const answerOf = async (procedures: FixtureRouter, raw: RawRoutes, request: Request, url: URL): Promise<Response | undefined> => {
    const route = sandboxRouteFor(request.method, url.pathname);
    if (route === undefined) {
        return undefined;
    }
    const params = paramsOf(route.path, url.pathname);
    if (isRawRoute(route.name)) {
        return raw[route.name]?.({ request, url, param: (name) => params[name] ?? `` });
    }
    const [group = ``, name = ``] = route.name.split(`.`);
    const handler = handlerOf(procedures, group, name);
    if (handler === undefined) {
        return undefined;
    }
    const answer = await handler((await inputOf(group, name, request, url, params)) as never);
    return answer instanceof Frames ? eventStream(request, answer.start) : json(answer);
};

// The console line for a request nothing answered, carrying the reason when `unserved` lists its route.
const unansweredLine = (request: Request, url: URL, unserved: Readonly<Record<string, string>>): string => {
    const reason = unserved[sandboxRouteFor(request.method, url.pathname)?.name ?? ``];
    return reason === undefined
        ? `[demo] no fixture route for ${request.method} ${url.pathname}`
        : `[demo] ${request.method} ${url.pathname} is left out of the demo: ${reason}`;
};

// The fixture daemon as a fetch handler. Anything it does not serve answers 404 and logs one line naming the method and
// path, with the reason `unserved` gives when the request is a contract route it lists.
export const serve =
    (procedures: FixtureRouter, raw: RawRoutes, unserved: Readonly<Record<string, string>>) =>
    async (request: Request, url: URL): Promise<Response> => {
        try {
            const answer = await answerOf(procedures, raw, request, url);
            if (answer !== undefined) {
                return answer;
            }
        } catch (error) {
            if (error instanceof Refusal) {
                return json({ error: error.message }, error.status);
            }
            throw error;
        }
        console.info(unansweredLine(request, url, unserved));
        return json({ error: `The demo fixture doesn't serve ${request.method} ${url.pathname}.` }, 404);
    };

// Every procedure a router serves, by the contract's name for it (`git.log`).
export const servedProcedures = (procedures: FixtureRouter): string[] =>
    Object.entries(procedures).flatMap(([group, handlers]) => Object.keys(handlers ?? {}).map((name) => `${group}.${name}`));
