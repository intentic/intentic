import { errorMessage } from "@intentic/base/errors";
import type { ExtensionCaller } from "@intentic/extension-api";
import { type Finding, type FindingAction, FindingActionSchema, FixRequestSchema, type Snapshot, WireRequestSchema } from "../wire.js";
import { ActionRefused } from "./actions.js";
import { FixRefused } from "./fix.js";
import { PostHogError } from "./posthog.js";
import type { Service } from "./service.js";

/* THE VIEW'S DOORS, under /x/<id>: the snapshot is a read anyone who reaches the view may make; a press that changes
   something in PostHog (mark fixed, dismiss, snooze, point its alerts here) is held to a maintainer, since it lands in a
   project other people read; Fix with agent starts the turn as whoever pressed, and the daemon holds that to their own
   access (POST /agent's collaborator floor), as the Pipelines board's Fix does. */

// Everything a door answers.
type Answer = Snapshot | { readonly error: string; readonly conversationId?: string } | { readonly conversationId: string } | { readonly ok: true } | { readonly created: number };
const json = (body: Answer, status = 200): Response => Response.json(body, { status });

// A person at the maintainer floor or above, or nobody on a sandbox that runs without sign-in.
const mayWrite = (caller: ExtensionCaller | undefined): boolean =>
    caller !== undefined && (caller.kind === `local` || (caller.kind === `person` && (caller.tier === `maintainer` || caller.tier === `owner`)));

const FORBIDDEN = `changing what PostHog holds, from here, is for a maintainer of this sandbox`;

// A refusal in the reader's terms: the press's own, PostHog's (a 403 is the key's scopes), or the sandbox's.
const refused = (error: Error): Response => {
    if (error instanceof ActionRefused) {
        return json({ error: error.message }, 409);
    }
    if (error instanceof FixRefused) {
        return json({ error: error.message }, 502);
    }
    if (error instanceof PostHogError) {
        const scopes = error.status === 403 ? ` The PostHog key may lack the write scope for this: the card's guide names the preset that covers it.` : ``;
        return json({ error: `${error.message}${scopes}` }, 502);
    }
    return json({ error: error.message }, 500);
};

const bodyOf = async (request: Request): Promise<Parameters<typeof FixRequestSchema.safeParse>[0]> => request.json().catch(() => ({}));

export const routesOf = (service: Service, callerOf: (request: Request) => ExtensionCaller | undefined) => {
    // One press on a finding the reader may make and the finding takes.
    const press = async (finding: Finding, action: Exclude<FindingAction, `wire`>, request: Request, caller: ExtensionCaller | undefined): Promise<Response> => {
        if (action === `fix`) {
            const input = FixRequestSchema.safeParse(await bodyOf(request));
            if (!input.success) {
                return json({ error: `a fix names an optional pick, mode and booking` }, 400);
            }
            const outcome = await service.fix(finding, input.data, caller);
            return outcome.kind === `busy` ? json({ error: outcome.reason, conversationId: outcome.conversationId }, 409) : json({ conversationId: outcome.conversationId });
        }
        await (action === `resolve` ? service.resolve(finding) : action === `dismiss` ? service.dismiss(finding) : service.snooze(finding));
        return json({ ok: true });
    };

    const findingPress = async (request: Request, id: string, verb: string): Promise<Response> => {
        const action = FindingActionSchema.exclude([`wire`]).safeParse(verb);
        if (!action.success) {
            return json({ error: `no such press` }, 404);
        }
        const caller = callerOf(request);
        if (action.data !== `fix` && !mayWrite(caller)) {
            return json({ error: FORBIDDEN }, 403);
        }
        const finding = await service.finding(id);
        if (finding === undefined) {
            return json({ error: `PostHog no longer reports that; read the board again` }, 404);
        }
        return finding.actions.includes(action.data) ? press(finding, action.data, request, caller) : json({ error: `this finding takes no "${action.data}"` }, 409);
    };

    const wire = async (request: Request, connection: string): Promise<Response> => {
        if (!mayWrite(callerOf(request))) {
            return json({ error: FORBIDDEN }, 403);
        }
        const input = WireRequestSchema.safeParse(await bodyOf(request));
        if (!input.success) {
            return json({ error: `pointing PostHog here needs this sandbox's public address` }, 400);
        }
        return json({ created: await service.wire(connection, input.data.origin) });
    };

    return async (request: Request): Promise<Response | undefined> => {
        const { pathname } = new URL(request.url);
        const [, head, id, verb, extra] = pathname.split(`/`).map((segment) => decodeURIComponent(segment));
        try {
            if (head === `snapshot` && id === undefined && request.method === `GET`) {
                return json(await service.snapshot());
            }
            if (head === `refresh` && id === undefined && request.method === `POST`) {
                await service.refresh();
                return json(await service.snapshot());
            }
            if (head === `findings` && id !== undefined && verb !== undefined && extra === undefined && request.method === `POST`) {
                return await findingPress(request, id, verb);
            }
            if (head === `connections` && id !== undefined && verb === `wire` && request.method === `POST`) {
                return await wire(request, id);
            }
        } catch (error) {
            return refused(error instanceof Error ? error : new Error(errorMessage(error)));
        }
        return undefined;
    };
};
