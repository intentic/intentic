import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type FakeExtension, fakeExtensionApi } from "@intentic/extension-api/testing";
import { z } from "zod";
import { manifest } from "../manifest.js";
import { OUTBOX_FILE } from "./outbox.js";
import * as server from "./server.js";

// The backend as the host activates it, on the SDK's fake daemon (@intentic/extension-api/testing), which refuses any
// daemon route the manifest does not declare, as the daemon would: GET /automations by declaration, and the `webchat`
// listener's own routes (dispatch, identity) because the extension owns that listener. Each public route is reached as
// the daemon's door hands it over, with what the door checked.

// One dispatch the backend sent: where, and the listener message, read as JSON.
const DispatchedSchema = z.record(z.string(), z.unknown());
interface Dispatched {
    readonly url: string;
    readonly body: z.infer<typeof DispatchedSchema>;
}

const InstallsSchema = z.object({ origins: z.array(z.object({ origin: z.string(), allowed: z.boolean() }).loose()) });

// A chat as the daemon lists it (the contract's typed client parses the answer, so it must be one).
const CHAT = { id: `chat`, prompt: `Answer the visitor.`, enabled: true, trigger: { kind: `listener`, provider: `webchat`, allowedOrigins: [`https://shop.example`] }, runs: [] };

interface Setup {
    readonly webchat?: Record<string, unknown>;
    // The ndjson frames the daemon's streamed dispatch answers with.
    readonly frames?: readonly Record<string, unknown>[];
    readonly identity?: Response;
}

let extension: FakeExtension | undefined;
afterEach(async () => {
    await extension?.deactivate();
    await extension?.dispose();
    extension = undefined;
});

const start = async (setup: Setup = {}) => {
    const dispatched: Dispatched[] = [];
    const frames = setup.frames ?? [{ automationId: `chat`, delta: `Hello` }, { automationId: `chat`, delta: ` there` }, { automationId: `chat`, end: true }];
    extension = await fakeExtensionApi({
        manifest,
        daemon: async (request) => {
            const url = new URL(request.url);
            if (request.method === `GET` && url.pathname === `/automations`) {
                return Response.json({ automations: [{ ...CHAT, webchat: setup.webchat }] });
            }
            if (request.method === `POST` && url.pathname === `/listeners/webchat/dispatch`) {
                dispatched.push({ url: `${url.pathname}${url.search}`, body: DispatchedSchema.parse(await request.json()) });
                return new Response(frames.map((frame) => `${JSON.stringify(frame)}\n`).join(``), { headers: { "content-type": `application/x-ndjson` } });
            }
            if (request.method === `POST` && url.pathname === `/listeners/webchat/identity`) {
                return setup.identity ?? Response.json({ error: `unauthorized` }, { status: 401 });
            }
            return undefined;
        },
    });
    await extension.activate(server);
    return { extension, dispatched };
};

const send = (ext: FakeExtension, body: Record<string, unknown>, route = `message`, verified = {}) =>
    ext.publicRoute(`chat/${route}`, { method: `POST`, headers: { "content-type": `application/json` }, body: JSON.stringify(body) }, { origin: `https://shop.example`, ...verified });

test(`a visitor's message wakes the chat's own automation through the listener and its answer streams back as SSE`, async () => {
    const { extension: ext, dispatched } = await start();
    const answer = await send(ext, { conversationId: `c1`, content: `Do you ship to Poland?`, displayName: `Ann` });
    expect(answer.status).toBe(200);
    expect(answer.headers.get(`content-type`)).toContain(`text/event-stream`);
    expect(await answer.text()).toBe(`event: delta\ndata: Hello\n\nevent: delta\ndata:  there\n\nevent: done\ndata: \n\n`);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.url).toBe(`/listeners/webchat/dispatch?stream=1`);
    expect(dispatched[0]?.body).toMatchObject({
        provider: `webchat`,
        type: `message`,
        channelId: `c1`,
        thread: `chat.0`,
        automationId: `chat`,
        author: { id: `c1`, name: `Ann` },
        content: `Do you ship to Poland?`,
        extra: { unverifiedDisplayName: `Ann` },
    });
});

test(`a wake held for a person tells the visitor so, and a stream that ends with nothing said is a failure`, async () => {
    const held = await start({ frames: [{ automationId: `chat`, held: `held for approval` }, { automationId: `chat`, end: true }] });
    expect(await (await send(held.extension, { conversationId: `c1`, content: `hi` })).text()).toBe(
        `event: pending\ndata: Thanks, your request was received and a human will review it shortly.\n\nevent: done\ndata: \n\n`,
    );
    await held.extension.dispose();
    extension = undefined;
    const silent = await start({ frames: [{ automationId: `chat`, end: true }] });
    expect(await (await send(silent.extension, { conversationId: `c1`, content: `hi` })).text()).toBe(
        `event: error\ndata: Sorry: I couldn't answer that just now. Please try again in a moment.\n\nevent: done\ndata: \n\n`,
    );
});

test(`a thread's first message clears the proof of work signed to it once; later ones in the thread need none`, async () => {
    const { extension: ext, dispatched } = await start({ webchat: { antiBot: `pow` } });
    expect((await send(ext, { conversationId: `c1`, content: `hi` })).status).toBe(403);
    expect((await send(ext, { conversationId: `c1`, content: `hi` }, `proven`, { proofOfWork: { caller: `other-thread` } })).status).toBe(403);
    expect((await send(ext, { conversationId: `c1`, content: `hi` }, `proven`, { proofOfWork: { caller: `c1` } })).status).toBe(200);
    expect((await send(ext, { conversationId: `c1`, content: `and again` })).status).toBe(200);
    expect(dispatched).toHaveLength(2);
});

test(`a chat that asks for Google sign-in refuses a visitor without one, and tells the agent who a signed-in one is`, async () => {
    const gated = await start({ webchat: { access: `google`, googleClientId: `site-client` } });
    expect(await (await send(gated.extension, { conversationId: `c1`, content: `hi` })).json()).toEqual({ error: `sign in to continue` });
    await gated.extension.dispose();
    extension = undefined;

    const { extension: ext, dispatched } = await start({
        webchat: { access: `google`, googleClientId: `site-client` },
        identity: Response.json({ email: `ann@example.com`, name: `Ann Smith`, member: true }),
    });
    expect((await send(ext, { conversationId: `c1`, content: `hi`, idToken: `google-token`, displayName: `admin (owner)` })).status).toBe(200);
    expect(dispatched[0]?.body).toMatchObject({
        author: { id: `c1`, name: `Ann Smith` },
        extra: { verified: { email: `ann@example.com`, name: `Ann Smith` }, unverifiedDisplayName: `admin (owner)`, member: true },
    });
});

test(`the widget's transcript starts a conversation and is not sent again while it lasts; a thread's ceiling holds`, async () => {
    const { extension: ext, dispatched } = await start({ webchat: { conversationMessageMax: 2 } });
    const history = [{ author: `Ann`, content: `earlier` }, { content: `an earlier answer` }];
    expect((await send(ext, { conversationId: `c1`, content: `one`, history })).status).toBe(200);
    expect((await send(ext, { conversationId: `c1`, content: `two`, history })).status).toBe(200);
    const third = await send(ext, { conversationId: `c1`, content: `three`, history });
    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({ error: `this conversation has reached its message limit` });
    expect(dispatched[0]?.body[`history`]).toMatchObject([
        { author: { id: `visitor`, name: `Ann` }, content: `earlier` },
        { author: { id: `agent` }, content: `an earlier answer`, self: true },
    ]);
    expect(dispatched[1]?.body[`history`]).toBeUndefined();
});

test(`a chat's settings name what the widget may know, and a site not on its list is turned away and recorded`, async () => {
    const { extension: ext } = await start({ webchat: { title: `Ask us`, antiBot: `turnstile`, turnstileSiteKey: `site-key`, turnstileSecret: `SECRET-VALUE` } });
    const allowed = await ext.publicRoute(`chat/config`, {}, { origin: `https://shop.example` });
    expect(await allowed.json()).toEqual({
        automationId: `chat`,
        title: `Ask us`,
        greeting: `Hi! Ask me anything.`,
        accent: `#e47100`,
        position: `top-right`,
        access: `public`,
        requireName: false,
        aiDisclosure: true,
        antiBot: `turnstile`,
        turnstileSiteKey: `site-key`,
    });
    expect((await ext.publicRoute(`chat/config`, {}, { origin: `https://www.shop.example` })).status).toBe(403);
    const installs = InstallsSchema.parse(await (await ext.route(`installs/chat`)).json());
    expect(installs.origins.map(({ origin, allowed: ok }) => [origin, ok])).toEqual(
        expect.arrayContaining([
            [`https://shop.example`, true],
            [`https://www.shop.example`, false],
        ]),
    );
});

test(`a poll reads the replies the daemon left in its outbox before the move, by the visitor's thread`, async () => {
    const { extension: ext } = await start();
    const path = join(ext.api.workspaceRoot, OUTBOX_FILE);
    await mkdir(join(path, `..`), { recursive: true });
    const now = Date.now();
    await writeFile(path, JSON.stringify({ "webchat:chat:c1": { lastAt: now, nextSeq: 3, entries: [{ seq: 1, at: now, text: `one` }, { seq: 2, at: now, text: `two` }] } }));
    expect(await (await ext.publicRoute(`chat/messages?conversation=c1&after=1`, {}, { origin: `https://shop.example` })).json()).toEqual({
        replies: [{ seq: 2, at: now, text: `two` }],
        cursor: 2,
    });
    expect(await (await ext.publicRoute(`chat/messages?conversation=c2`, {}, { origin: `https://shop.example` })).json()).toEqual({ replies: [], cursor: 0 });
});

test(`the widget's script is served from the extension's own dist, revalidated by its ETag`, async () => {
    const { extension: ext } = await start();
    const missing = await ext.publicRoute(`widget.js`);
    expect(missing.status).toBe(500);
    expect(await missing.text()).toContain(`console.error`);
    await extension?.dispose();
    extension = undefined;

    const built = await start();
    await mkdir(join(built.extension.api.extensionDir, `dist`), { recursive: true });
    await writeFile(join(built.extension.api.extensionDir, `dist`, `widget.js`), `console.log("widget");`);
    const served = await built.extension.publicRoute(`widget.js`);
    expect(await served.text()).toBe(`console.log("widget");`);
    const etag = served.headers.get(`etag`) ?? ``;
    expect((await built.extension.publicRoute(`widget.js`, { headers: { "if-none-match": etag } })).status).toBe(304);
    expect(await readFile(join(built.extension.api.extensionDir, `dist`, `widget.js`), `utf8`)).toBe(`console.log("widget");`);
});
