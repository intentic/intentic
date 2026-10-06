import {
    CONNECT_TOKEN_HEADER,
    type IngressBody,
    type IngressError,
    type IngressOutput,
    type IngressRouteName,
    PLATFORM_INGRESS,
} from "@intentic/api-contract";
import type { Context, Env, Hono, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";

/* THE ONE WAY A ROUTE MACHINES CALL IS SERVED: under its entry in PLATFORM_INGRESS (api-contract's ingress), which
 * carries its method, its path and the schemas of its body and answer. A handler reads its body through that schema
 * and nowhere else, answers a success in the route's declared shape, and refuses in the one shape every ingress
 * refusal has, `{ "error": … }`. A `{param}` is spelled Hono's way, `:param`, on the way in. */

export interface IngressKit<K extends IngressRouteName> {
    // The request body as the route's schema reads it, or undefined when it does not parse. A body that is missing or
    // not JSON reads as `{}`, so a route whose fields are all optional takes it the way it always has.
    readonly body: () => Promise<IngressBody<K> | undefined>;
    // The sandbox's connect token, from CONNECT_TOKEN_HEADER; undefined when absent or empty.
    readonly connectToken: string | undefined;
    readonly answer: (data: IngressOutput<K>, status?: ContentfulStatusCode) => Response;
    readonly refuse: (status: ContentfulStatusCode, error: string) => Response;
}

export type IngressHandler<E extends Env, K extends IngressRouteName> = (c: Context<E>, kit: IngressKit<K>) => Response | Promise<Response>;

const readBody = async <K extends IngressRouteName>(c: Context, name: K): Promise<IngressBody<K> | undefined> => {
    const route: { readonly body: string; readonly input?: z.ZodType } = PLATFORM_INGRESS[name];
    if (route.input === undefined) {
        return undefined;
    }
    // allow(silent-catch): a body that is not JSON is read as an empty one, which the schema then judges.
    const raw: unknown = route.body === `form` ? await c.req.parseBody() : await c.req.json().catch(() => undefined);
    const parsed = route.input.safeParse(raw ?? {});
    // SAFETY: the schema parsed is the route's own `input`, whose output IngressBody<K> names.
    return parsed.success ? (parsed.data as IngressBody<K>) : undefined;
};

// Registers routes on `app`, which is mounted at `mount` (a sub-app's prefix, or "" for the root app); a route outside
// the mount is a wiring mistake and throws at startup.
export const ingressServer =
    <E extends Env>(app: Hono<E>, mount = ``) =>
    <K extends IngressRouteName>(name: K, handler: IngressHandler<E, K>, ...before: MiddlewareHandler<E>[]): void => {
        const route = PLATFORM_INGRESS[name];
        if (route.path !== mount && !route.path.startsWith(`${mount}/`)) {
            throw new Error(`ingress route ${name} (${route.path}) is not under ${mount}`);
        }
        const path = route.path.slice(mount.length).replace(/\{([^}]+)\}/gu, `:$1`) || `/`;
        // Hono runs every handler matched for a request in the order registered: the route's own middleware, then it.
        for (const middleware of before) {
            app.on(route.method, path, middleware);
        }
        app.on(route.method, path, (c: Context<E>) => {
            const token = c.req.header(CONNECT_TOKEN_HEADER);
            return handler(c, {
                body: () => readBody(c as Context, name),
                connectToken: token === undefined || token === `` ? undefined : token,
                answer: (data, status = 200) => c.json(data as object, status),
                refuse: (status, error) => c.json({ error } satisfies IngressError, status),
            });
        });
    };
