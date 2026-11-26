import { ISSUE_PAYLOAD_MAX, IssueIngestSchema } from "@intentic/sandbox-contract/schemas/issues";
import { WebchatMessageSchema } from "@intentic/sandbox-contract/schemas/automations";
import {
    PUBLIC_DOOR_CHALLENGE,
    PUBLIC_DOOR_CHALLENGE_PARAM,
    PUBLIC_DOOR_KEY_PARAM,
    PUBLIC_DOOR_POW_CALLER_HEADER,
    PUBLIC_DOOR_POW_HEADER,
} from "@intentic/sandbox-contract/extension-protocol";
import type { Context } from "hono";
import { Hono } from "hono";
import type { AppEnv } from "../../app-env.js";
import { cachedEnabledExtensions } from "../../capabilities/contributions.js";
import type { Services } from "../../composition.js";
import { readBoundedJson } from "../../http/bounded-body.js";
import { defineRawRoutes } from "../../http/raw-route-server.js";
import { createPublicDoorRoute } from "./public-door.routes.js";

// PUBLIC PATHS A FEATURE HAD BEFORE IT MOVED ONTO AN EXTENSION'S DOOR, forwarded there (2026-11-26). Each is out in the
// field, in a customer's page or an app, where nobody re-pastes a snippet because a sandbox updated. A call is translated
// to the extension's own route and handed to the same public door every extension's routes go through, so it meets
// exactly the protections a call on the new path meets, and the backend's answer goes back unchanged. Nothing here holds
// any of the feature's policy. While the extension is not on, the old path says so where its owner looks (the browser
// console), rather than answering as if nothing were there.
//
// The bug intake (`/intake/…`), which left the daemon for the issues extension: the reporter's script, an intake's
// settings, the proof-of-work challenge and the report. An SDK from before the move puts the intake's key and its proof
// of work in the report's body; the door reads them as `?key=` and its two headers, so they are moved there. Remove this
// once no supported SDK speaks the old path: the script tag reloads the SDK from the extension's door on every page load,
// so only an app that bundled an older @intentic/issue-sdk still does.
//
// The Visitor chat (`/webchat/…`), which left the daemon for the visitor-chat extension: the widget's script, a chat's
// settings, the proof-of-work challenge, a message (its answer streamed back through, unbuffered) and the poll for later
// answers. A snippet in a customer's page names /webchat/widget.js for good, so that one stays; the widget it serves
// talks to the extension's door itself, and the other four serve only a widget a page loaded before the update. Its
// proof of work rode in the message's body (`powNonce`), and moves to the door's headers and the route that checks one.

// The issues extension, by the install id its door is served under.
const ISSUES_EXTENSION = "intentic.issues";
const ISSUES_DOOR = `/door/${ISSUES_EXTENSION}`;

const NOT_ON = "bug reports now arrive through the Issues extension, which this sandbox does not have switched on";

// The headers a door call is judged by (who is calling, from where) and what the body is; nothing else is carried.
const CARRIED = ["origin", "cf-connecting-ip", "x-forwarded-for", "if-none-match", "content-type"] as const;

const carried = (from: Headers): Headers => {
    const headers = new Headers();
    for (const name of CARRIED) {
        const value = from.get(name);
        if (value !== null) {
            headers.set(name, value);
        }
    }
    return headers;
};

// The Visitor chat extension, by the install id its door is served under.
const VISITOR_CHAT_EXTENSION = "intentic.visitor-chat";
const VISITOR_CHAT_DOOR = `/door/${VISITOR_CHAT_EXTENSION}`;

const CHAT_NOT_ON = "the Visitor chat is now an extension, which this sandbox does not have switched on";

// A message's body is the widget's, as large as its door takes.
const CHAT_MESSAGE_MAX = 64_000;

const doorOn = async (services: Services, id: string): Promise<boolean> =>
    (await cachedEnabledExtensions(services)).some((extension) => extension.id === id && (extension.manifest.contributes?.publicRoutes ?? []).length > 0);

const issuesOn = (services: Services): Promise<boolean> => doorOn(services, ISSUES_EXTENSION);

// JS, not JSON: a <script> tag's only voice is the console, and it must never break the page.
const consoleScript = (c: Context<AppEnv>, sentence: string): Response => {
    c.header("content-type", "application/javascript; charset=utf-8");
    return c.body(`console.error(${JSON.stringify(`[intentic] ${sentence}`)});`, 404);
};

export const createMovedDoorRoutes = (services: Services) => {
    // The public door as /door/* serves it, reached in-process with the translated request.
    const door = new Hono<AppEnv>().all("/door/*", createPublicDoorRoute(services));
    const through = (c: Context<AppEnv>, path: string, init: RequestInit): Response | Promise<Response> =>
        door.fetch(new Request(new URL(path, c.req.url), { ...init, signal: c.req.raw.signal }), c.env);
    const intakeOf = (c: Context<AppEnv>): string => encodeURIComponent(c.req.param("id") ?? "");

    // The JSON paths answer an embed's own refusal shape, which the SDK shows verbatim.
    const refusedUnlessOn = async (c: Context<AppEnv>): Promise<Response | undefined> => ((await issuesOn(services)) ? undefined : c.json({ error: NOT_ON }, 404));

    return {
        sdk: async (c: Context<AppEnv>): Promise<Response> =>
            (await issuesOn(services)) ? through(c, `${ISSUES_DOOR}/sdk.js`, { headers: carried(c.req.raw.headers) }) : consoleScript(c, NOT_ON),
        config: async (c: Context<AppEnv>): Promise<Response> =>
            (await refusedUnlessOn(c)) ?? through(c, `${ISSUES_DOOR}/${intakeOf(c)}/config`, { headers: carried(c.req.raw.headers) }),
        challenge: async (c: Context<AppEnv>): Promise<Response> => {
            const refused = await refusedUnlessOn(c);
            if (refused !== undefined) {
                return refused;
            }
            const caller = encodeURIComponent(c.req.query("client") ?? "");
            return through(c, `${ISSUES_DOOR}/${PUBLIC_DOOR_CHALLENGE}?${PUBLIC_DOOR_CHALLENGE_PARAM}=${caller}`, { headers: carried(c.req.raw.headers) });
        },
        report: async (c: Context<AppEnv>): Promise<Response> => {
            const refused = await refusedUnlessOn(c);
            if (refused !== undefined) {
                return refused;
            }
            const read = await readBoundedJson(c.req.raw, ISSUE_PAYLOAD_MAX);
            if (read.kind === "tooLarge") {
                return c.json({ error: "payload too large" }, 413);
            }
            const parsed = read.kind === "ok" ? IssueIngestSchema.safeParse(read.value) : undefined;
            if (parsed?.success !== true) {
                return c.json({ error: "invalid report body" }, 400);
            }
            const { key, powNonce, ...body } = parsed.data;
            const headers = carried(c.req.raw.headers);
            headers.set("content-type", "application/json");
            // A proof of work goes to the route that checks one, bound to the browser id it was solved for.
            if (powNonce !== undefined) {
                headers.set(PUBLIC_DOOR_POW_HEADER, powNonce);
                headers.set(PUBLIC_DOOR_POW_CALLER_HEADER, body.clientId);
            }
            const route = new URL(`${ISSUES_DOOR}/${intakeOf(c)}/${powNonce === undefined ? "report" : "written"}`, c.req.url);
            if (key !== undefined) {
                route.searchParams.set(PUBLIC_DOOR_KEY_PARAM, key);
            }
            return through(c, `${route.pathname}${route.search}`, { method: "POST", headers, body: JSON.stringify(body) });
        },
    };
};

// The Visitor chat's old paths, onto the visitor-chat extension's door.
export const createMovedChatRoutes = (services: Services) => {
    const door = new Hono<AppEnv>().all("/door/*", createPublicDoorRoute(services));
    const through = (c: Context<AppEnv>, path: string, init: RequestInit): Response | Promise<Response> =>
        door.fetch(new Request(new URL(path, c.req.url), { ...init, signal: c.req.raw.signal }), c.env);
    const chatOf = (c: Context<AppEnv>): string => `${VISITOR_CHAT_DOOR}/${encodeURIComponent(c.req.param("id") ?? "")}`;
    const chatOn = (): Promise<boolean> => doorOn(services, VISITOR_CHAT_EXTENSION);
    // The widget's own refusal shape, which it shows the visitor.
    const refusedUnlessOn = async (c: Context<AppEnv>): Promise<Response | undefined> => ((await chatOn()) ? undefined : c.json({ error: CHAT_NOT_ON }, 404));
    const get = (c: Context<AppEnv>, path: string): Promise<Response> | Response => through(c, path, { headers: carried(c.req.raw.headers) });

    return {
        widget: async (c: Context<AppEnv>): Promise<Response> => ((await chatOn()) ? get(c, `${VISITOR_CHAT_DOOR}/widget.js`) : consoleScript(c, CHAT_NOT_ON)),
        config: async (c: Context<AppEnv>): Promise<Response> => (await refusedUnlessOn(c)) ?? get(c, `${chatOf(c)}/config`),
        challenge: async (c: Context<AppEnv>): Promise<Response> => {
            const caller = encodeURIComponent(c.req.query("conversation") ?? "");
            return (await refusedUnlessOn(c)) ?? get(c, `${VISITOR_CHAT_DOOR}/${PUBLIC_DOOR_CHALLENGE}?${PUBLIC_DOOR_CHALLENGE_PARAM}=${caller}`);
        },
        messages: async (c: Context<AppEnv>): Promise<Response> => {
            const query = new URL(c.req.url).search;
            return (await refusedUnlessOn(c)) ?? get(c, `${chatOf(c)}/messages${query}`);
        },
        message: async (c: Context<AppEnv>): Promise<Response> => {
            const refused = await refusedUnlessOn(c);
            if (refused !== undefined) {
                return refused;
            }
            const read = await readBoundedJson(c.req.raw, CHAT_MESSAGE_MAX);
            if (read.kind === "tooLarge") {
                return c.json({ error: "payload too large" }, 413);
            }
            const parsed = read.kind === "ok" ? WebchatMessageSchema.safeParse(read.value) : undefined;
            if (parsed?.success !== true) {
                return c.json({ error: "invalid message body" }, 400);
            }
            const { powNonce, ...body } = parsed.data;
            const headers = carried(c.req.raw.headers);
            headers.set("content-type", "application/json");
            // A proof of work goes to the route that checks one, bound to the thread it was solved for.
            if (powNonce !== undefined) {
                headers.set(PUBLIC_DOOR_POW_HEADER, powNonce);
                headers.set(PUBLIC_DOOR_POW_CALLER_HEADER, body.conversationId);
            }
            return through(c, `${chatOf(c)}/${powNonce === undefined ? "message" : "proven"}`, { method: "POST", headers, body: JSON.stringify(body) });
        },
    };
};

// The bug intake's and the Visitor chat's paths before 2026-11-26 (raw-routes.ts keeps them public and embedded, as they
// were).
export const movedDoorRawRoutes = defineRawRoutes((services: Services) => {
    const routes = createMovedDoorRoutes(services);
    const chat = createMovedChatRoutes(services);
    return {
        "GET /intake/sdk.js": routes.sdk,
        "GET /intake/{id}/config": routes.config,
        "GET /intake/{id}/challenge": routes.challenge,
        "POST /intake/{id}/report": routes.report,
        "GET /webchat/widget.js": chat.widget,
        "GET /webchat/{id}/config": chat.config,
        "GET /webchat/{id}/challenge": chat.challenge,
        "POST /webchat/{id}/message": chat.message,
        "GET /webchat/{id}/messages": chat.messages,
    };
});
