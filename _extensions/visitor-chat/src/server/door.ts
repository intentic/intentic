import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PublicRouteVerification } from "@intentic/extension-api";
import type { ListenerMessage } from "@intentic/sandbox-contract/protocol/doors/listener-protocol";
import { WEBCHAT_DAILY_MAX_DEFAULT, WebchatConversationIdSchema, type WebchatMessage, WebchatMessageSchema } from "@intentic/sandbox-contract/schemas/automations";
import type { Chat, Chats } from "./chats.js";
import { resolveVisitor, SignInRequired, type VerifyIdToken, type VisitorIdentity } from "./identity.js";
import type { InstallsStore } from "./installs.js";
import { type Outbox, outboxKeyOf } from "./outbox.js";
import { publicConfigOf, usableAntiBot } from "./public-config.js";
import { type Threads, type ThreadState, threadKeyOf, threadTtlOf } from "./threads.js";
import type { TurnstileVerify } from "./turnstile.js";
import { listenerMessageOf, sseFromFrames } from "./wake.js";

// THE PUBLIC ROUTES (2026-11-26, the daemon's webchat/webchat.routes.ts until then): the widget's script, a chat's
// settings for it, a visitor's message with its answer streamed back, and the poll for answers written after that
// stream closed, served at this extension's public door (/door/intentic.visitor-chat/…, the manifest's
// `contributes.publicRoutes`). Only a call the daemon's own protections passed reaches here: the chat exists, listens on
// this extension's source and is on; a message's or a poll's browser Origin is on the chat's allowed sites; the caller's
// minute and the body's size; on `*/proven` a solved proof of work. What is left is the chat's own policy, cheapest
// refusal first: who may write (its sign-in), the bot check once per thread, the thread's and the day's ceilings.

export type Dispatch = (message: ListenerMessage) => Promise<Response>;

export interface DoorDeps {
    readonly chats: Chats;
    readonly threads: Threads;
    readonly outbox: Outbox;
    readonly installs: InstallsStore;
    readonly verifyIdToken: VerifyIdToken;
    readonly verifyTurnstile: TurnstileVerify;
    // The listener door, streamed: POST /listeners/webchat/dispatch?stream=1 with the message.
    readonly dispatch: Dispatch;
    readonly log: (message: string) => void;
    readonly now: () => number;
    // This extension's checkout, where the widget's bundle sits.
    readonly extensionDir: string;
}

// One shape for every refusal, which the widget shows the visitor as it is.
const refused = (error: string, status: number): Response => Response.json({ error }, { status });

// The widget's bundle, read once and kept; a failed read is not kept, so a checkout built later heals by itself.
const widgetServer = (extensionDir: string) => {
    let cached: { readonly body: string; readonly etag: string } | undefined;
    return async (request: Request): Promise<Response> => {
        try {
            if (cached === undefined) {
                const body = await readFile(join(extensionDir, `dist`, `widget.js`), `utf8`);
                cached = { body, etag: `"${createHash(`sha256`).update(body).digest(`hex`).slice(0, 32)}"` };
            }
        } catch {
            // JS, not a 404, so the site's console says what is wrong; never a throw, since this must not break the page.
            return new Response(`console.error("[intentic] the Visitor chat widget bundle is missing from this sandbox");`, {
                status: 500,
                headers: { "content-type": `application/javascript; charset=utf-8` },
            });
        }
        // Revalidated on every load: the URL carries no version, so a long max-age would pin visitors to a stale widget.
        const headers = { "cache-control": `no-cache`, etag: cached.etag };
        if (request.headers.get(`if-none-match`) === cached.etag) {
            return new Response(null, { status: 304, headers });
        }
        return new Response(cached.body, { headers: { ...headers, "content-type": `application/javascript; charset=utf-8` } });
    };
};

// Each chat's day, per UTC day and in memory, as the daemon counted it: a restart forgets it. The door's own ceiling is
// coarser and the same for every chat; this one is the owner's `dailyMessageMax`.
const dailyLimits = (now: () => number) => {
    const days = new Map<string, { readonly utcDay: string; count: number }>();
    return (chatId: string, max: number): boolean => {
        const utcDay = new Date(now()).toISOString().slice(0, 10);
        const current = days.get(chatId);
        const counted = current?.utcDay === utcDay ? current : { utcDay, count: 0 };
        if (counted.count >= max) {
            return true;
        }
        counted.count += 1;
        days.set(chatId, counted);
        return false;
    };
};

// The body as the message route takes it, or the answer refusing it.
const messageOf = async (request: Request): Promise<WebchatMessage | Response> => {
    // allow(silent-catch): a body that is not JSON is refused below as an invalid message, which is all it says
    const raw: unknown = await request.json().catch(() => undefined);
    const parsed = WebchatMessageSchema.safeParse(raw);
    return parsed.success ? parsed.data : refused(`invalid message body`, 400);
};

// A chat's settings for its widget; also the install probe, since every page load asks for them. The door checks no Origin
// on this route, so the probe hears a site that is not on the list too, the panel's most useful case.
const configOf = (deps: DoorDeps, chat: Chat, verified: PublicRouteVerification): Response => {
    const { origin } = verified;
    const allowed = origin !== undefined && chat.allowedOrigins.includes(origin);
    if (origin !== undefined) {
        deps.installs.record(chat.id, origin, allowed, deps.now());
    }
    return allowed ? Response.json(publicConfigOf(chat)) : refused(`origin not allowed`, 403);
};

// Whether a thread's first message clears the chat's bot check: a proof of work the door verified, signed to this very
// thread, or a Turnstile token Cloudflare accepts for the chat's own site.
const botCheckPassed = async (deps: DoorDeps, chat: Chat, body: WebchatMessage, verified: PublicRouteVerification): Promise<boolean> => {
    switch (usableAntiBot(chat.config)) {
        case `off`:
            return true;
        case `pow`:
            return verified.proofOfWork?.caller === body.conversationId;
        case `turnstile`: {
            const secret = chat.config.turnstileSecret;
            if (body.turnstileToken === undefined || secret === undefined) {
                return false;
            }
            return deps.verifyTurnstile(secret, body.turnstileToken, verified.remoteIp).catch((error: Error) => {
                // Cloudflare not answering is no proof the visitor is a person: refused, and said for the owner.
                deps.log(`a visitor's Turnstile check did not answer: ${error.message}`);
                return false;
            });
        }
    }
};

// The thread's ceiling, then the day's, in that order: the day is spent only by a message that gets through.
const ceilingRefusal = (chat: Chat, thread: ThreadState, overDaily: (chatId: string, max: number) => boolean): Response | undefined => {
    const perConversation = chat.config.conversationMessageMax;
    if (thread.live && perConversation !== undefined && thread.messages >= perConversation) {
        return refused(`this conversation has reached its message limit`, 429);
    }
    if (overDaily(chat.id, chat.config.dailyMessageMax ?? WEBCHAT_DAILY_MAX_DEFAULT)) {
        return refused(`this chat has reached today's limit, try again tomorrow`, 429);
    }
    return undefined;
};

const visitorOf = async (deps: DoorDeps, chat: Chat, body: WebchatMessage): Promise<VisitorIdentity | Response> => {
    try {
        return await resolveVisitor(deps.verifyIdToken, chat.config, body);
    } catch (error) {
        if (error instanceof SignInRequired) {
            return refused(`sign in to continue`, 401);
        }
        throw error;
    }
};

// One visitor's message: who is writing, the thread's check and ceilings, then the wake, its answer streamed back.
const messageRoute =
    (deps: DoorDeps, overDaily: (chatId: string, max: number) => boolean) =>
    async (chat: Chat, request: Request, verified: PublicRouteVerification): Promise<Response> => {
        const body = await messageOf(request);
        if (body instanceof Response) {
            return body;
        }
        const visitor = await visitorOf(deps, chat, body);
        if (visitor instanceof Response) {
            return visitor;
        }
        const now = deps.now();
        const key = threadKeyOf(chat.id, body.conversationId);
        const thread = await deps.threads.state(key, threadTtlOf(chat.config), now);
        // A live thread already passed its check; a new one (or one past its time) clears it once, here.
        if (!thread.live && !(await botCheckPassed(deps, chat, body, verified))) {
            return refused(`bot check failed`, 403);
        }
        const over = ceilingRefusal(chat, thread, overDaily);
        if (over !== undefined) {
            return over;
        }
        await deps.threads.note(key, thread.generation, now);
        const dispatched = await deps.dispatch(
            listenerMessageOf({
                automationId: chat.id,
                conversationId: body.conversationId,
                generation: thread.generation,
                visitor,
                content: body.content,
                // The widget sends its transcript with every message after the first; only a conversation starting needs it.
                history: thread.live ? undefined : body.history,
                now,
            }),
        );
        if (!dispatched.ok) {
            deps.log(`the sandbox refused a visitor's message for ${chat.id} (${dispatched.status}): ${(await dispatched.text()).slice(0, 200)}`);
            return refused(`this chat could not reach its agent right now`, 502);
        }
        return sseFromFrames(dispatched, chat.id);
    };

// Replies queued since the visitor's `after` cursor: an approved wake's, or a person's written as the agent. Spends no
// check and starts nothing, so a thread nobody wrote to is simply empty.
const messagesOf = async (deps: DoorDeps, chat: Chat, request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const conversation = WebchatConversationIdSchema.safeParse(url.searchParams.get(`conversation`));
    if (!conversation.success) {
        return refused(`conversation required`, 400);
    }
    // A cursor that is not a number reads as the start of the thread, which over-delivers at worst.
    const after = Math.max(0, Number(url.searchParams.get(`after`) ?? 0) || 0);
    return Response.json(await deps.outbox.since(outboxKeyOf(chat.id, conversation.data), after, deps.now()));
};

/** The public routes' handler: what the daemon's door let through, by the declared route it landed on. */
export const doorRoutes = (deps: DoorDeps) => {
    const widget = widgetServer(deps.extensionDir);
    const message = messageRoute(deps, dailyLimits(deps.now));
    return async (request: Request, verified: PublicRouteVerification): Promise<Response | undefined> => {
        if (verified.route === `widget.js`) {
            return widget(request);
        }
        const chat = verified.automationId === undefined ? undefined : await deps.chats.get(verified.automationId);
        if (chat === undefined) {
            return refused(`no web-chat automation with that id`, 404);
        }
        switch (verified.route) {
            case `*/config`:
                return configOf(deps, chat, verified);
            case `*/message`:
            case `*/proven`:
                return message(chat, request, verified);
            case `*/messages`:
                return messagesOf(deps, chat, request);
            default:
                return undefined;
        }
    };
};
