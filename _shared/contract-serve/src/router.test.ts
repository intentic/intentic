import type { SystemEvent } from "@intentic/sandbox-contract";
import { Frames, refuse, serve, servedProcedures } from "./router.js";

// A stand-in daemon of two procedures and one raw route, answered the way the demo and the local files sidecar are.
const lines: string[] = [];
const procedures = {
    workspace: {
        file: ({ path }: { path: string }) => (path === `secret` ? refuse(`not yours`, 403) : { present: false as const, path }),
    },
    system: {
        events: () =>
            new Frames<SystemEvent>((sink) => {
                sink.emit({ kind: `heartbeat`, rev: 7 });
                sink.close();
                return () => undefined;
            }),
    },
};
const handle = serve(procedures, { "GET /workspace/raw": () => new Response(`bytes`) }, { "git.log": `no history here` }, {
    speaker: `This stand-in`,
    tag: `[test]`,
    log: (line) => lines.push(line),
});
const ask = (path: string): Promise<Response> => {
    const url = new URL(`http://daemon.test${path}`);
    return handle(new Request(url), url);
};

beforeEach(() => {
    lines.length = 0;
});

describe(`serve`, () => {
    it(`answers a procedure with its input parsed from the query`, async () => {
        expect(await (await ask(`/workspace/file?path=docs/a.md`)).json()).toEqual({ present: false, path: `docs/a.md` });
    });

    it(`answers a refusal in the daemon's words and status, and a bad input as a 400`, async () => {
        const refused = await ask(`/workspace/file?path=secret`);
        expect([refused.status, await refused.json()]).toEqual([403, { error: `not yours` }]);
        expect((await ask(`/workspace/file`)).status).toBe(400);
    });

    it(`answers a raw route by its contract key`, async () => {
        expect(await (await ask(`/workspace/raw?path=a.png`)).text()).toBe(`bytes`);
    });

    it(`streams frames in oRPC's event-iterator format`, async () => {
        const answer = await ask(`/events?clientId=c1`);
        expect(answer.headers.get(`content-type`)).toBe(`text/event-stream`);
        expect(await answer.text()).toBe(`event: message\ndata: {"kind":"heartbeat","rev":7}\n\nevent: done\n\n`);
    });

    // A route nothing serves is a 404 said in the stand-in's voice, with the reason it gave, if any.
    it(`answers what it does not serve with a 404 and one line saying why`, async () => {
        const answer = await ask(`/git/root/log`);
        expect([answer.status, await answer.json()]).toEqual([404, { error: `This stand-in doesn't serve GET /git/root/log.` }]);
        expect(lines).toEqual([`[test] GET /git/root/log is left out: no history here`]);
    });
});

describe(`servedProcedures`, () => {
    it(`names every procedure a table serves the way the contract does`, () => {
        expect(servedProcedures(procedures)).toEqual([`workspace.file`, `system.events`]);
    });
});
