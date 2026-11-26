import { errorMessage } from "@intentic/base/errors";
import type { ApprovedActionOutcome, ServerApiSlots } from "@intentic/extension-api/runtime";
import { approvalIn } from "./backend-approvals.js";
import { watchAnswerBody, watchCheckIn } from "./backend-checks.js";
import { extensionFireIn } from "./backend-fires.js";
import { answerToolMessage, type ToolRequest } from "./backend-tools.js";

// The daemon's own doors into one extension's code on the backend host (backend-host.ts), each reached with the host
// token alone, from one place in the daemon, and never under /x, which a person's, a panel's or an agent's bearer
// reaches. Runs in the child process: imports nothing of the daemon's services, store or logger.

type Door = (slots: ServerApiSlots | undefined, id: string, request: Request) => Promise<Response>;

// What a door answers: why it took nothing, or what it was asked for.
type DoorBody =
    | { readonly error: string }
    | { readonly ok: true }
    | { readonly answer: Awaited<ReturnType<typeof answerToolMessage>> | null }
    | ApprovedActionOutcome;

const json = (body: DoorBody, status: number): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// POST /tools/<id>: an extension's tools, reached only from the daemon's MCP door with the card it resolved: one
// JSON-RPC message in, its answer out.
const answerTools: Door = async (slots, id, request) => {
    // SAFETY: a JSON body or undefined, from the daemon's MCP door; its one required field is checked just below.
    // allow(silent-catch): a body that is not JSON is answered as the 400 just below
    const body = (await request.json().catch(() => undefined)) as ToolRequest | undefined;
    if (body?.message === undefined) {
        return json({ error: "a tools request carries { card?, conversationId?, message }" }, 400);
    }
    const answer = await answerToolMessage({ id, source: slots?.tools() }, body, request.signal);
    return json({ answer: answer ?? null }, 200);
};

// The call to make once a handler is registered; undefined when none is.
const withHandler = <Handler>(handler: Handler | undefined, call: (handler: Handler) => Promise<ApprovedActionOutcome>): (() => Promise<ApprovedActionOutcome>) | undefined =>
    handler === undefined ? undefined : () => call(handler);

// POST /approvals/<id>: an approved action the extension carries out itself (`api.approvals.perform`), reached only from
// the daemon's approvals executor after it matched and spent the person's yes (approvals/approval-performers.ts): what
// arrives here is already authorised. 404 and 400 mean the handler never ran; a handler that throws answers 500, which
// the executor reads as an outcome it cannot know, since the handler may have reached the outside world before it threw.
// (2026-11-26) The same door takes an approved post for a platform the extension's card publishes on
// (`api.approvals.publish`), reached the same way.
const answerApproval: Door = async (slots, id, request) => {
    const asked = await approvalIn(request);
    if (asked === undefined) {
        return json(
            { error: "an approval request carries { action: { id, digest, summary, details, approvedAt, actionRules } } or { post: { id, platform, content, target, approvedAt, actionRules } }" },
            400,
        );
    }
    const handled =
        "action" in asked
            ? withHandler(slots?.performer(), (performer) => performer(asked.action, { signal: request.signal }))
            : withHandler(slots?.publisher(), (publisher) => publisher(asked.post, { signal: request.signal }));
    if (handled === undefined) {
        return json({ error: `the "${id}" backend ${"action" in asked ? "carries out no approved actions" : "publishes no approved posts"}` }, 404);
    }
    try {
        return json(await handled(), 200);
    } catch (error) {
        return json({ error: errorMessage(error) }, 500);
    }
};

// POST /fires/<id> (2026-11-26): an automation's fire for the handler its target names (`api.automations.onFire`),
// reached only from the daemon's automations engine once the fire passed its admission and holds
// (automations/fire/run-fire.ts, extension-fires.ts). 404 means no handler took it (not registered yet, or not at all),
// which the engine tries again later; a handler that throws answers 500, which the engine records and does not repeat.
const answerFire: Door = async (slots, id, request) => {
    const fire = await extensionFireIn(request);
    if (fire === undefined) {
        return json({ error: "a fire carries { fire: { id, automationId, handler, firedAt, coalesced, prompt } }" }, 400);
    }
    const handler = slots?.fireHandler(fire.handler);
    if (handler === undefined) {
        return json({ error: `the "${id}" backend has registered no "${fire.handler}" handler` }, 404);
    }
    try {
        await handler(fire, { signal: request.signal });
        return json({ ok: true }, 200);
    } catch (error) {
        return json({ error: errorMessage(error) }, 500);
    }
};

// POST /checks/<id> (2026-11-26): one check of a watch kind the extension serves (`api.checks.serve`), reached only from
// the daemon's automations engine (automations/watch/contributed-check.ts). 404 means nothing serves the kind (not
// registered yet, or not at all); a handler that throws answers 500 with its message, which the engine reads as a check
// that did not pass, and so does an answer that is neither a pass nor a miss.
const answerCheck: Door = async (slots, id, request) => {
    const check = await watchCheckIn(request);
    if (check === undefined) {
        return json({ error: "a check carries { check: { kind, params, reach } }" }, 400);
    }
    const handler = slots?.checkHandler(check.kind);
    if (handler === undefined) {
        return json({ error: `the "${id}" backend serves no "${check.kind}" watch kind` }, 404);
    }
    try {
        const body = watchAnswerBody(await handler(check, { signal: request.signal }));
        return body === undefined
            ? json({ error: `its "${check.kind}" check answered neither { pass: true, output } nor { pass: false, detail }` }, 500)
            : new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    } catch (error) {
        return json({ error: errorMessage(error) }, 500);
    }
};

const DOORS = { tools: answerTools, approvals: answerApproval, fires: answerFire, checks: answerCheck } as const satisfies Record<string, Door>;
const isDoor = (name: string): name is keyof typeof DOORS => Object.hasOwn(DOORS, name);

/**
 * The answer of the door a request is for, or undefined for a request that is for none of them. `loadedOr` names the
 * extension's loaded code, or the refusal a reloading or absent backend answers with.
 */
export const answerHostDoor = (
    request: Request,
    pathname: string,
    loadedOr: (id: string) => { readonly slots?: ServerApiSlots | undefined } | Response,
): Promise<Response> | undefined => {
    const [, name = "", encoded = ""] = /^\/(tools|approvals|fires|checks)\/([^/]+)$/.exec(pathname) ?? [];
    if (request.method !== "POST" || !isDoor(name)) {
        return undefined;
    }
    const id = decodeURIComponent(encoded);
    const extension = loadedOr(id);
    return extension instanceof Response ? Promise.resolve(extension) : DOORS[name](extension.slots, id, request);
};
