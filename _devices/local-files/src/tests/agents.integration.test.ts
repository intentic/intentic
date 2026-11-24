import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostAgents, type HostAgents } from "@intentic/host-agents";
import { type Hello, HelloSchema } from "@intentic/sandbox-contract/events/system-events";
import { type Grant, Grants } from "../grants.js";
import { unhurried } from "../server.js";
import { type Ask, askerOf, localServer, PORT } from "../testing.js";

// Which windows are served the agents of this computer (@intentic/host-agents), and how the editor learns it: a folder
// a window may write gets their four groups in place of the empty truths and says so in its hello; every other window,
// and every window of a process started without them, is exactly what it was.

const FOLDER_TOKEN = `f`.repeat(64);
const FILE_TOKEN = `d`.repeat(64);
const READ_ONLY_TOKEN = `r`.repeat(64);
const AGENT_ROUTES = [`agent.run`, `agent.attach`, `agent.reply`, `agent.stop`, `agents.transcript`, `accounts.start`];

let dir: string;
let home: string;
let agents: HostAgents;
let grants: Grants;
beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), `local-files-agents-`)));
    home = mkdtempSync(join(tmpdir(), `local-files-agents-home-`));
    writeFileSync(join(dir, `notes.txt`), `notes`);
    // No harness at all: these are about who is served, not about a turn (host-agents' own suite runs those).
    agents = createHostAgents({ home, log: () => undefined, accepted: () => false, harnesses: [] });
    grants = new Grants();
    const folder: Grant = { token: FOLDER_TOKEN, id: `w1`, root: dir, name: `project` };
    grants.add(folder);
    grants.add({ token: FILE_TOKEN, id: `w2`, root: dir, file: `notes.txt`, name: `notes.txt` });
    grants.add({ ...folder, token: READ_ONLY_TOKEN, id: `w3`, readOnly: true });
});
afterEach(() => {
    agents.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
});

const routesOf = async (ask: (path: string, init?: Ask) => Promise<Response>, token: string): Promise<readonly string[]> => {
    const stop = new AbortController();
    const response = await ask(`/events`, { token, signal: stop.signal });
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let text = ``;
    // The hello is the stream's first frame: read up to the blank line that ends it, and no further.
    for (let read = await reader?.read(); read !== undefined && !read.done; read = await reader?.read()) {
        text += decoder.decode(read.value, { stream: true });
        if (text.includes(`\n\n`)) {
            break;
        }
    }
    await reader?.cancel();
    stop.abort();
    const hello: Hello = HelloSchema.parse(JSON.parse(/^data: (.*)$/m.exec(text)?.[1] ?? `null`));
    return hello.routes ?? [];
};

describe(`the agents of this computer, beside a window's folder`, () => {
    it(`are served to a folder a window may write, which says so in its hello`, async () => {
        const ask = askerOf(localServer(grants, { agents }));
        const routes = await routesOf(ask, FOLDER_TOKEN);
        expect(AGENT_ROUTES.filter((route) => routes.includes(route))).toEqual(AGENT_ROUTES);
        // Still a folder: the editor tells this window from a sandbox by its surface, and its agents by these routes.
        expect(await (await ask(`/agents`, { token: FOLDER_TOKEN })).json()).toEqual({ agents: [], rev: 1, held: [] });
        expect(await (await ask(`/providers`, { token: FOLDER_TOKEN })).json()).toEqual({ native: [], agents: [], endpoints: [], loops: {} });
    });

    it(`start no turn until the reader has turned them on`, async () => {
        const ask = askerOf(localServer(grants, { agents }));
        const answer = await ask(`/agent`, {
            method: `POST`,
            token: FOLDER_TOKEN,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ conversationId: `otter-k7mq`, prompt: `Hello` }),
        });
        expect(answer.status).toBe(403);
        expect(await answer.json()).toEqual({ error: expect.stringContaining(`Agents on this computer are off`) });
    });

    it(`are not served to a document opened on its own or to a read-only window`, async () => {
        const ask = askerOf(localServer(grants, { agents }));
        for (const token of [FILE_TOKEN, READ_ONLY_TOKEN]) {
            const routes = await routesOf(ask, token);
            expect(AGENT_ROUTES.filter((route) => routes.includes(route))).toEqual([]);
            const answer = await ask(`/agent`, { method: `POST`, token, headers: { "content-type": `application/json` }, body: `{"prompt":"Hello"}` });
            expect(answer.status).toBe(404);
        }
    });

    it(`are not served at all by a process started without them`, async () => {
        const routes = await routesOf(askerOf(localServer(grants)), FOLDER_TOKEN);
        expect(AGENT_ROUTES.filter((route) => routes.includes(route))).toEqual([]);
    });

    // A turn is watched for as long as it runs, silent through a long tool call, and a harness's first read may fetch it.
    it(`keep a turn's stream and a harness's first read off the connection's idle bound`, () => {
        const routes: [string, string][] = [
            [`POST`, `/agent/attach`],
            [`POST`, `/accounts/claude/login/start`],
            [`GET`, `/providers/claude/models`],
            [`POST`, `/agent`],
            [`GET`, `/agents`],
        ];
        expect(routes.map(([method, path]) => unhurried(new Request(`http://127.0.0.1:${PORT}${path}`, { method })))).toEqual([true, true, true, false, false]);
    });
});
