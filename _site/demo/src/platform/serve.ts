import { apiContract } from "@intentic/api-contract";
import { json } from "../transport";

// THE PLATFORM'S DISPATCHER, the api contract's counterpart of `@intentic/contract-serve` for the daemon: a request to
// `/rpc/<path>` resolves to its procedure by the contract's own route table, its input is decoded the way the editor's
// OpenAPILink encodes it (a GET's query, any other method's JSON body) and parsed by the procedure's own input schema,
// and each handler is held by its types to that procedure's input and output. A handler may refuse with `refusePlatform`,
// which answers in oRPC's error shape, the one the editor's client reads a refusal's message from.

type Api = typeof apiContract;

// A Standard Schema's parsed type, read off `~standard.types` whichever library wrote the schema.
type Parsed<S> = S extends { readonly "~standard": { readonly types?: infer T } } ? (NonNullable<T> extends { readonly output: infer O } ? O : never) : undefined;

// What a procedure is handed and must answer, read off its oRPC metadata.
type InputOf<C> = C extends { readonly "~orpc": { readonly inputSchema?: infer S } } ? Parsed<S> : never;
type OutputOf<C> = C extends { readonly "~orpc": { readonly outputSchema?: infer S } } ? Parsed<S> : never;

export type PlatformHandler<C> = (input: InputOf<C>) => OutputOf<C> | Promise<OutputOf<C>>;

/** The platform's half of the contract the demo answers: a handler per procedure it serves, held to that procedure's types. */
export type PlatformRouter = { readonly [G in keyof Api]?: { readonly [P in keyof Api[G]]?: PlatformHandler<Api[G][P]> } };

/** Every procedure of the api contract, by the name `<group>.<procedure>`. */
export type PlatformRoute = { readonly [G in keyof Api]: `${G & string}.${keyof Api[G] & string}` }[keyof Api];

// Thrown by a handler to refuse: answered as oRPC answers an ORPCError, `{ code, status, message }`.
class PlatformRefusal extends Error {
    constructor(
        message: string,
        readonly status: number,
    ) {
        super(message);
    }
}

// oRPC's code for each status a handler here refuses with.
const codeOf = (status: number): string => {
    switch (status) {
        case 403:
            return `FORBIDDEN`;
        case 404:
            return `NOT_FOUND`;
        case 409:
            return `CONFLICT`;
        default:
            return `BAD_REQUEST`;
    }
};

export const refusePlatform = (message: string, status = 400): never => {
    throw new PlatformRefusal(message, status);
};

// What a request's input is on the wire: a query's strings, or a JSON body.
type Wire = string | number | boolean | null | readonly Wire[] | { readonly [key: string]: Wire };

// What a procedure's input schema made of what it was sent: the parsed value, or why it would not parse.
interface Checked {
    readonly value?: object | string | number | boolean | null;
    readonly issues?: readonly { readonly message: string }[];
}
interface Found {
    readonly route: string;
    readonly parse: (wire: Wire | undefined) => Checked | Promise<Checked>;
}

// Every procedure, by `<METHOD> /rpc<path>`, with its own input schema to parse what it is sent.
const ROUTES = new Map<string, Found>();
for (const [group, procedures] of Object.entries(apiContract)) {
    for (const [name, procedure] of Object.entries(procedures)) {
        const { route, inputSchema } = procedure[`~orpc`];
        const key: string = `${route.method ?? `POST`} /rpc${route.path ?? ``}`;
        ROUTES.set(key, { route: `${group}.${name}`, parse: (wire) => (inputSchema === undefined ? { value: wire } : inputSchema[`~standard`].validate(wire)) });
    }
}

// The editor's OpenAPILink sends a GET's input as its query and anything else's as a JSON body, and nothing at all for a
// call that carries none.
const wireInputOf = async (request: Request, url: URL): Promise<Wire | undefined> => {
    if (request.method === `GET`) {
        return url.search === `` ? undefined : Object.fromEntries(url.searchParams);
    }
    const text = await request.text();
    // SAFETY: JSON.parse yields only JSON values, which is what `Wire` spells.
    return text === `` ? undefined : (JSON.parse(text) as Wire);
};

/** The procedure a request names, by the contract's name for it, or undefined for a path the contract does not route. */
export const platformRouteOf = (request: Request, url: URL): string | undefined => ROUTES.get(`${request.method} ${url.pathname}`)?.route;

// The one untyped seam, as contract-serve has it: a handler found by its procedure's name, handed the input that
// procedure's own schema parsed.
type FoundHandler = (input: never) => object | null | Promise<object | null>;
const handlerOf = (handlers: PlatformRouter, route: string): FoundHandler | undefined => {
    const [group = ``, name = ``] = route.split(`.`);
    // SAFETY: PlatformRouter's groups and names are the contract's, and each handler is typed by its own procedure.
    return (handlers as Readonly<Record<string, Readonly<Record<string, FoundHandler | undefined>> | undefined>>)[group]?.[name];
};

/** The handler table as a fetch handler for `/rpc/*`; undefined for a request no handler in it answers. */
export const servePlatform =
    (handlers: PlatformRouter) =>
    async (request: Request, url: URL): Promise<Response | undefined> => {
        const found = ROUTES.get(`${request.method} ${url.pathname}`);
        const handler = found === undefined ? undefined : handlerOf(handlers, found.route);
        if (found === undefined || handler === undefined) {
            return undefined;
        }
        try {
            const checked = await found.parse(await wireInputOf(request, url));
            if (checked.issues !== undefined) {
                return refusePlatform(`Input validation failed: ${checked.issues.map((issue) => issue.message).join(`; `)}`);
            }
            // SAFETY: the value is what this procedure's own input schema parsed, the type its handler is declared with.
            const answer = await handler(checked.value as never);
            // A procedure whose output is nullable (me.get signed out) answers JSON null.
            return json(answer);
        } catch (error) {
            if (error instanceof PlatformRefusal) {
                return json({ defined: false, code: codeOf(error.status), status: error.status, message: error.message }, error.status);
            }
            throw error;
        }
    };
