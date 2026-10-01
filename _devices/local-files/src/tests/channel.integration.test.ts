import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OfficePrefetch } from "@intentic/ext-onlyoffice/local-office";
import { type Channel, controlChannel } from "../channel.js";
import type { AnswerMessage, ControlEvent } from "../control.js";
import { type Grant, Grants } from "../grants.js";

// The app's lines, played by the test, against a real folder: what each one does and what this process says back.

const TOKEN = `a`.repeat(64);

let dir: string;
let said: ControlEvent[];
let logged: string[];
let answered: AnswerMessage[];
let forgotten: Grant[];
let prefetched: OfficePrefetch;
let grants: Grants;
// How far the grants' own clock, which a request's check for an end reads, runs ahead of the real one.
let ahead: number;
let write: (line: string) => void;
beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), `local-files-channel-`)));
    said = [];
    logged = [];
    answered = [];
    forgotten = [];
    prefetched = { state: `ready` };
    ahead = 0;
    grants = new Grants(() => Date.now() + ahead);
    const channel: Channel = {
        grants,
        server: {
            forget: async (grant) => {
                forgotten.push(grant);
            },
        },
        office: { prefetch: async () => prefetched },
        asks: {
            answer: (message) => {
                answered.push(message);
                return true;
            },
        },
        say: (event) => said.push(event),
        log: (line) => logged.push(line),
    };
    write = controlChannel(channel);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Waits for what an asynchronous line says; a hang bound, far above how long any of these takes.
const saidWhen = async (count: number): Promise<readonly ControlEvent[]> => {
    for (let turn = 0; turn < 400 && said.length < count; turn++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return said;
};

describe(`the control channel`, () => {
    // The answer carries an `error` field of its own, which must not read as a line that failed to parse.
    it(`hands the app's answer to the ask it ends, its reason included`, () => {
        write(`{"op":"answer","id":"a1","ok":false,"error":"The Trash said no."}`);
        expect(answered).toEqual([{ op: `answer`, id: `a1`, ok: false, error: `The Trash said no.` }]);
        expect(logged).toEqual([]);
    });

    it(`logs a line that is no message, and changes nothing`, () => {
        write(`{"op":"serve-everything"}`);
        write(`   `);
        expect(logged).toEqual([expect.stringMatching(/^ignored a control line: /)]);
        expect(said).toEqual([]);
    });

    it(`says where the office download ended`, async () => {
        prefetched = { state: `failed`, error: `The editor could not be downloaded: offline.` };
        write(`{"op":"prefetch-office"}`);
        expect(await saidWhen(1)).toEqual([{ event: `office`, state: `failed`, error: `The editor could not be downloaded: offline.` }]);
    });

    it(`serves a grant until it is revoked, and refuses a path that is not there`, async () => {
        write(JSON.stringify({ op: `grant`, token: TOKEN, id: `w1`, path: dir, kind: `folder` }));
        expect(await saidWhen(1)).toEqual([{ event: `granted`, token: TOKEN, root: dir, name: expect.any(String) }]);
        write(JSON.stringify({ op: `revoke`, token: TOKEN }));
        expect([said.at(-1), grants.byToken(TOKEN), forgotten.map((grant) => grant.token)]).toEqual([
            { event: `revoked`, token: TOKEN },
            undefined,
            [TOKEN],
        ]);
        write(JSON.stringify({ op: `grant`, token: TOKEN, id: `w1`, path: join(dir, `gone`), kind: `folder` }));
        expect((await saidWhen(3)).at(-1)).toEqual({ event: `refused`, token: TOKEN, error: `${join(dir, `gone`)} is not there` });
    });

    // Let go at its end as a revoked grant is, and the app told so.
    it(`lets a grant go at its end`, async () => {
        write(JSON.stringify({ op: `grant`, token: TOKEN, id: `w1`, path: dir, kind: `folder`, expiresInMs: 20 }));
        expect((await saidWhen(2)).map((event) => event.event)).toEqual([`granted`, `revoked`]);
        expect([grants.byToken(TOKEN), forgotten.map((grant) => grant.token)]).toEqual([undefined, [TOKEN]]);
    });

    // A request can notice the end before the timer does: what the grant held is let go all the same.
    it(`lets a grant go the same way when a request finds it ended`, async () => {
        write(JSON.stringify({ op: `grant`, token: TOKEN, id: `w1`, path: dir, kind: `folder`, expiresInMs: 60_000 }));
        await saidWhen(1);
        ahead = 60_000;
        expect(grants.byToken(TOKEN)).toBeUndefined();
        expect([said.at(-1), forgotten.map((grant) => grant.token)]).toEqual([{ event: `revoked`, token: TOKEN }, [TOKEN]]);
    });

    // The app re-points a window by granting its token again: the old grant's editor goes, and its end, when it comes,
    // takes nothing with it.
    it(`lets go of what a replaced grant held, and keeps the replacement past the old one's end`, async () => {
        const other = join(dir, `other`);
        mkdirSync(other);
        write(JSON.stringify({ op: `grant`, token: TOKEN, id: `w1`, path: dir, kind: `folder`, expiresInMs: 20 }));
        await saidWhen(1);
        write(JSON.stringify({ op: `grant`, token: TOKEN, id: `w1`, path: other, kind: `folder` }));
        await saidWhen(2);
        // Past the first grant's end, and its timer's.
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect([grants.byToken(TOKEN)?.root, forgotten.map((grant) => grant.root)]).toEqual([other, [dir]]);
        expect(said.map((event) => event.event)).toEqual([`granted`, `granted`]);
    });
});
