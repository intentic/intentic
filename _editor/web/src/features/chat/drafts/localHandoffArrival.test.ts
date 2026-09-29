// jsdom: the handoff waits in this tab's session storage, and the file arrives as a DOM File.
import "@intentic/testing/dom";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { nextTick, ref } from "vue";

// Everything the arrival waits on and acts through, stood in for: who is signed in, the sandbox and whether it answers,
// the screen the router is on, whether this window draws the chat, the new chat it opens, and what it says.
const user = ref<{ id: string } | null>({ id: `u-1` });
const reachable = ref(true);
const drawsChat = ref(true);
const currentRoute = ref({ matched: [{ path: `/` }, { path: `/workspace/:path(.*)*` }] });
const started: string[] = [];
const said: { kind: string; text: string }[] = [];
jest.mock("../../sandbox/client/useSandbox", () => ({ useSandbox: () => ({ activeSandboxId: ref(`box-1`), reachable }) }));
jest.mock("../run/chatEcho", () => ({ drawsChat }));
jest.mock("../../../router", () => ({ router: { currentRoute } }));
jest.mock("../../agents/fleet/agentActions", () => ({
    startAgent: () => {
        started.push(`c-${started.length + 1}`);
        return `c-${started.length}`;
    },
}));
jest.mock("../../../shell/notifications/notifications", () => ({
    useNotifications: () => ({
        say: (text: string) => said.push({ kind: `say`, text }),
        warn: (text: string) => said.push({ kind: `warn`, text }),
    }),
}));

const { handoffWaiting, keepHandoff } = await import("./localHandoff");
const { takeQueuedAttachments } = await import("./pendingAttachments");
const { startLocalHandoff } = await import("./localHandoffArrival");

const handoff = { url: `http://127.0.0.1:47123/workspace/raw?path=Q3.docx`, token: `aB3_-`.repeat(8), name: `Q3.docx` };

// What the file server was asked for, and how it answers.
const asked: { url: string; authorization: string | null }[] = [];
let answer = (): Response => new Response(`the document's bytes`, { headers: { "content-type": `application/msword` } });

// A fetch, its body and the queue's reactions each settle on a later turn.
const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
};

beforeEach(() => {
    sessionStorage.clear();
    asked.length = 0;
    started.length = 0;
    said.length = 0;
    reachable.value = true;
    drawsChat.value = true;
    currentRoute.value = { matched: [{ path: `/` }, { path: `/workspace/:path(.*)*` }] };
    answer = () => new Response(`the document's bytes`, { headers: { "content-type": `application/msword` } });
    stubGlobal(`fetch`, (url: string, init?: RequestInit) => {
        asked.push({ url, authorization: new Headers(init?.headers).get(`authorization`) });
        return Promise.resolve(answer());
    });
});

afterEach(() => {
    unstubAllGlobals();
    takeQueuedAttachments(`c-1`);
});

describe(`bringing a file from the user's computer into a chat`, () => {
    it(`reads it with its bearer, opens a new chat, and queues it there under its name and type`, async () => {
        keepHandoff(handoff);
        startLocalHandoff(() => user.value !== null);
        await settle();
        expect(asked).toEqual([{ url: handoff.url, authorization: `Bearer ${handoff.token}` }]);
        expect(started).toEqual([`c-1`]);
        expect(handoffWaiting()).toBe(false);

        const [queued] = takeQueuedAttachments(`c-1`);
        expect(queued?.file.name).toBe(`Q3.docx`);
        expect(queued?.file.type).toBe(`application/msword`);
        expect(await queued?.file.text()).toBe(`the document's bytes`);
        // Said only once the composer has it.
        expect(said).toEqual([]);
        queued?.taken?.();
        expect(said).toEqual([{ kind: `say`, text: `Attached Q3.docx from your computer` }]);
    });

    it(`says it couldn't, and lets the handoff go, when the file server refuses`, async () => {
        answer = () => new Response(`token expired`, { status: 401 });
        keepHandoff(handoff);
        startLocalHandoff(() => user.value !== null);
        await settle();
        expect(started).toEqual([]);
        expect(said).toEqual([{ kind: `warn`, text: `Couldn't bring Q3.docx from your computer. Open it there and ask again.` }]);
        expect(handoffWaiting()).toBe(false);
    });

    it(`waits until the window can show a chat: a sandbox that answers, a screen of the shell`, async () => {
        reachable.value = false;
        currentRoute.value = { matched: [{ path: `/setup` }] };
        keepHandoff(handoff);
        startLocalHandoff(() => user.value !== null);
        await settle();
        expect(asked).toEqual([]);
        expect(handoffWaiting()).toBe(true);

        reachable.value = true;
        await settle();
        expect(asked).toEqual([]);

        currentRoute.value = { matched: [{ path: `/` }, { path: `/workspace/:path(.*)*` }] };
        await settle();
        expect(asked).toEqual([{ url: handoff.url, authorization: `Bearer ${handoff.token}` }]);
        expect(started).toEqual([`c-1`]);
    });
});
