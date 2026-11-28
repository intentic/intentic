import type { ExtensionCaller } from "@intentic/extension-api";
import { AddSourceSchema, type DiscoverHitView, PublishRequestSchema, RefreshSchema, type Snapshot, SourceToggleSchema } from "../wire.js";
import type { NetworkService } from "./service.js";

/* THE VIEW'S DOORS, under /x/<id>: the snapshot is a read anyone who reaches the view may make; adding, removing or
   switching a source, reading now and starting the curator change what the sandbox fetches and spends, so they are held
   to a maintainer or the owner (or nobody signed in, on a sandbox that runs without sign-in). */

type Answer = Snapshot | { readonly error: string } | { readonly conversationId: string } | { readonly approval: string } | { readonly hits: readonly DiscoverHitView[] };
const json = (body: Answer, status = 200): Response => Response.json(body, { status });

const mayWrite = (caller: ExtensionCaller | undefined): boolean =>
    caller !== undefined && (caller.kind === `local` || (caller.kind === `person` && (caller.tier === `maintainer` || caller.tier === `owner`)));

const FORBIDDEN = `changing what this sandbox reads from the network is for a maintainer of this sandbox`;

type Body = Record<string, string | number | boolean | null>;
const bodyOf = async (request: Request): Promise<Body> => {
    try {
        return await request.json();
    } catch {
        // allow(silent-catch): a body that is not JSON is an empty request, which each schema refuses
        return {};
    }
};

interface Press {
    readonly request: Request;
    readonly id: string | undefined;
    readonly caller: ExtensionCaller | undefined;
}

// Each press a maintainer may make, by its path: `<head>` or `<head>/<id>/<verb>`, POST unless named.
type Handler = (press: Press) => Promise<Response>;
const pressesOf = (service: NetworkService) =>
    ({
    "POST refresh": async ({ request }) => {
        const input = RefreshSchema.safeParse(await bodyOf(request));
        if (!input.success) {
            return json({ error: `a refresh names at most one source` }, 400);
        }
        await service.refresh(input.data.source, request.signal);
        return json(await service.snapshot(true));
    },
    "POST sources": async ({ request }) => {
        const input = AddSourceSchema.safeParse(await bodyOf(request));
        if (!input.success) {
            return json({ error: input.error.issues[0]?.message ?? `not a source` }, 400);
        }
        await service.addSource(input.data);
        return json(await service.snapshot(true));
    },
    "POST sources/enable": async ({ request, id }) => {
        const input = SourceToggleSchema.safeParse(await bodyOf(request));
        if (!input.success || id === undefined) {
            return json({ error: `say { enabled: true | false }` }, 400);
        }
        service.enableSource(id, input.data.enabled);
        return json(await service.snapshot(true));
    },
    "DELETE sources/": async ({ id }) => {
        if (id !== undefined) {
            service.removeSource(id);
        }
        return json(await service.snapshot(true));
    },
    "POST curate": async ({ caller }) => json({ conversationId: await service.curateNow(caller) }),
        // Files the draft in the approvals queue and answers its id: the person approves it there.
        "POST publish": async ({ request }) => {
            const input = PublishRequestSchema.safeParse(await bodyOf(request));
            if (!input.success) {
                return json({ error: input.error.issues[0]?.message ?? `not a publication` }, 400);
            }
            return json({ approval: (await service.draftPublish(input.data)).id });
        },
        "POST peers/release": async ({ id }) => {
            if (id !== undefined) {
                service.releasePeer(id);
            }
            return json(await service.snapshot(true));
        },
        "POST withdraw/": async ({ id }) => {
            const seq = Number(id);
            return Number.isSafeInteger(seq) && seq >= 0 ? json({ approval: (await service.draftWithdraw(seq)).id }) : json({ error: `name an entry by its number` }, 400);
        },
    }) satisfies Record<string, Handler>;

// The press's key: its method, its first segment, and its verb when an id sits between (`sources/<id>/enable`).
const keyOf = (method: string, segments: readonly string[]): string => {
    const [head = ``, , verb] = segments;
    if (segments.length === 1) {
        return `${method} ${head}`;
    }
    return segments.length === 2 ? `${method} ${head}/` : `${method} ${head}/${verb ?? ``}`;
};

export const routesOf = (service: NetworkService, callerOf: (request: Request) => ExtensionCaller | undefined) => {
    const presses = new Map<string, Handler>(Object.entries(pressesOf(service)));
    return async (request: Request): Promise<Response | undefined> => {
        const segments = new URL(request.url).pathname
            .split(`/`)
            .slice(1)
            .map((segment) => decodeURIComponent(segment));
        const caller = callerOf(request);
        if (request.method === `GET` && segments.length === 1 && segments[0] === `snapshot`) {
            return json(await service.snapshot(mayWrite(caller)));
        }
        if (request.method === `GET` && segments.length === 1 && segments[0] === `discover`) {
            const params = new URL(request.url).searchParams;
            return json({ hits: await service.discover({ type: params.get(`type`) ?? undefined, keyword: params.get(`keyword`) ?? undefined }, request.signal) });
        }
        const press = presses.get(keyOf(request.method, segments));
        if (press === undefined || segments.length > 3) {
            return undefined;
        }
        if (!mayWrite(caller)) {
            return json({ error: FORBIDDEN }, 403);
        }
        try {
            return await press({ request, id: segments[1], caller });
        } catch (error) {
            return json({ error: error instanceof Error ? error.message : `that did not work` }, 500);
        }
    };
};
