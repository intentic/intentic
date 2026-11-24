import { existsSync, writeFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import {
    agent,
    type AgentContext,
    methods,
    ndJsonStream,
    type PromptRequest,
    type PromptResponse,
    RequestError,
    type SessionUpdate,
} from "@agentclientprotocol/sdk/unstable";
import { webStream } from "@intentic/base/web-stream";
import { z } from "zod";

// A HARNESS FOR TESTS: a real process that speaks the Agent Client Protocol on stdio, as an installed harness does, so
// the connection, the turn and the sign-in are exercised through a spawn. What it does is keyed by a word in the
// prompt. Started with `--signed-out=<file>` it refuses every session until that file is there, which is its stored
// sign-in as a real harness keeps one on disk: `authenticate` writes it, and so does the sign-in command it plays when
// `auth login` follows its own arguments (a page's address printed, then an exit).

const args = new Set(process.argv.slice(2));
// `--expired=<file>` is the same stored sign-in gone stale: sessions still open and nothing says it is signed out, and
// every prompt is refused until the file is there.
const expiredFile = process.argv.find((arg) => arg.startsWith(`--expired=`))?.slice(`--expired=`.length);
const signInFile = expiredFile ?? process.argv.find((arg) => arg.startsWith(`--signed-out=`))?.slice(`--signed-out=`.length);
const signedIn = (): boolean => signInFile === undefined || existsSync(signInFile);
const signIn = (): void => {
    if (signInFile !== undefined) {
        writeFileSync(signInFile, `signed in\n`);
    }
};

const MODES = [
    { id: `default`, name: `Manual` },
    { id: `acceptEdits`, name: `Accept edits` },
    { id: `plan`, name: `Plan` },
    { id: `bypassPermissions`, name: `Bypass permissions` },
];
const MODELS = [`small`, `large`];

interface Sessions {
    readonly mode: Map<string, string>;
    readonly model: Map<string, string>;
    readonly cancelled: Map<string, () => void>;
}

const ValueSchema = z.object({ value: z.string() });

// One prompt, answered by the word it carries.
const answerPrompt = async (sessions: Sessions, params: PromptRequest, client: AgentContext): Promise<PromptResponse> => {
    const { sessionId } = params;
    const text = params.prompt.map((block) => (block.type === `text` ? block.text : ``)).join(``);
    const push = (update: SessionUpdate): Promise<void> => client.notify(methods.client.session.update, { sessionId, update });
    const say = (said: string): Promise<void> => push({ sessionUpdate: `agent_message_chunk`, content: { type: `text`, text: said } });
    if (text.includes(`explode`)) {
        throw new Error(`the harness exploded`);
    }
    if (text.includes(`wait`)) {
        await say(`waiting`);
        await new Promise<void>((resolve) => sessions.cancelled.set(sessionId, resolve));
        return { stopReason: `cancelled` };
    }
    if (text.includes(`edit`)) {
        await push({
            sessionUpdate: `tool_call`,
            toolCallId: `t1`,
            title: `Edit`,
            kind: `edit`,
            status: `in_progress`,
            locations: [{ path: `${process.cwd()}/src/app.ts`, line: 3 }],
            content: [{ type: `diff`, path: `${process.cwd()}/src/app.ts`, oldText: `a`, newText: `b` }],
        });
        await push({ sessionUpdate: `tool_call_update`, toolCallId: `t1`, status: `completed` });
    }
    if (text.includes(`ask`)) {
        const response = await client.request(methods.client.session.requestPermission, {
            sessionId,
            toolCall: { toolCallId: `p1`, kind: `execute`, title: `Run the tests`, locations: [{ path: `${process.cwd()}/package.json` }] },
            options: [
                { optionId: `allow`, name: `Allow`, kind: `allow_once` },
                { optionId: `always`, name: `Always`, kind: `allow_always` },
                { optionId: `deny`, name: `Deny`, kind: `reject_once` },
            ],
        });
        await say(`permission:${response.outcome.outcome === `selected` ? response.outcome.optionId : `cancelled`}`);
        return { stopReason: `end_turn` };
    }
    if (text.includes(`which`)) {
        await say(`mode:${sessions.mode.get(sessionId) ?? `bypassPermissions`} model:${sessions.model.get(sessionId) ?? `small`} cwd:${process.cwd()}`);
        return { stopReason: `end_turn` };
    }
    await say(`Hi there`);
    return { stopReason: `end_turn`, usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } };
};

const serve = (): void => {
    let nextSession = 0;
    const sessions: Sessions = { mode: new Map(), model: new Map(), cancelled: new Map() };
    const stateOf = (sessionId: string) => ({
        modes: { currentModeId: sessions.mode.get(sessionId) ?? `bypassPermissions`, availableModes: MODES },
        configOptions: [
            {
                id: `model`,
                name: `Model`,
                category: `model` as const,
                type: `select` as const,
                currentValue: sessions.model.get(sessionId) ?? `small`,
                options: MODELS.map((value) => ({ value, name: value.toUpperCase() })),
            },
        ],
    });
    const guard = (): void => {
        if (!signedIn()) {
            throw RequestError.authRequired();
        }
    };
    // A stale sign-in still opens sessions: only working on one is refused.
    const sessionGuard = (): void => {
        if (expiredFile === undefined) {
            guard();
        }
    };
    agent({ name: `fake-harness` })
        .onRequest(methods.agent.initialize, () => ({
            protocolVersion: 1,
            agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} } },
            authMethods: args.has(`--command-sign-in`)
                ? [{ id: `login`, name: `Log in`, type: `terminal` as const, args: [`auth`, `login`] }]
                : [{ id: `browser`, name: `Log in in the browser` }],
        }))
        .onRequest(methods.agent.authenticate, () => {
            signIn();
            return {};
        })
        .onRequest(methods.agent.session.new, () => {
            sessionGuard();
            nextSession += 1;
            const sessionId = `fake-${process.pid}-${nextSession}`;
            return { sessionId, ...stateOf(sessionId) };
        })
        .onRequest(methods.agent.session.resume, ({ params }) => {
            sessionGuard();
            if (!params.sessionId.startsWith(`fake-`)) {
                throw RequestError.resourceNotFound(params.sessionId);
            }
            return stateOf(params.sessionId);
        })
        .onRequest(methods.agent.session.close, () => ({}))
        .onRequest(methods.agent.session.setMode, ({ params }) => {
            sessions.mode.set(params.sessionId, params.modeId);
            return {};
        })
        .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
            const picked = ValueSchema.safeParse(params);
            if (params.configId === `model` && picked.success) {
                sessions.model.set(params.sessionId, picked.data.value);
            }
            return { configOptions: stateOf(params.sessionId).configOptions };
        })
        .onNotification(methods.agent.session.cancel, ({ params }) => {
            sessions.cancelled.get(params.sessionId)?.();
            sessions.cancelled.delete(params.sessionId);
        })
        .onRequest(methods.agent.session.prompt, ({ params, client }) => {
            guard();
            return answerPrompt(sessions, params, client);
        })
        .connect(ndJsonStream(Writable.toWeb(process.stdout), webStream<Uint8Array>(Readable.toWeb(process.stdin))));
};

if (args.has(`auth`)) {
    // The sign-in command: a page's address as a terminal hyperlink prints it, then a moment for "the browser".
    process.stdout.write(`Opening browser to sign in…\n\u001B]8;;https://example.test/login?code=abc\u0007https://example.test/login?code=abc\u001B]8;;\u0007\n`);
    setTimeout(() => {
        signIn();
        process.exit(0);
    }, 150);
} else {
    serve();
}
