import { APP_GONE, Asks, NO_ANSWER } from "./asks.js";
import type { ControlEvent } from "./control.js";

// The asks this process makes of the app, with the app played by the test: what goes out, and how each ask ends.

const asking = (timeoutMs?: number) => {
    const said: ControlEvent[] = [];
    return { asks: new Asks((event) => said.push(event), timeoutMs), said };
};

// The id the app would answer, read off the line the ask wrote.
const idOf = (event: ControlEvent | undefined): string => (event?.event === `ask` ? event.id : ``);

describe(`Asks`, () => {
    it(`says what it asks, with an id, and settles when the app answers yes`, async () => {
        const { asks, said } = asking();
        const done = asks.ask(`trash`, `/home/me/project/old.txt`);
        expect(said).toEqual([{ event: `ask`, id: expect.any(String), verb: `trash`, path: `/home/me/project/old.txt` }]);
        expect(asks.answer({ op: `answer`, id: idOf(said[0]), ok: true })).toBe(true);
        expect(await done).toBeUndefined();
    });

    it(`rejects with the app's own words when it could not`, async () => {
        const { asks, said } = asking();
        const done = asks.ask(`trash`, `/home/me/project/old.txt`);
        asks.answer({ op: `answer`, id: idOf(said[0]), ok: false, error: `The Trash is on another drive.` });
        expect(await done.catch((error: Error) => error.message)).toBe(`The Trash is on another drive.`);
    });

    // An app from before asks never answers one; the window is told rather than left waiting.
    it(`ends an ask nobody answers, and drops an answer that comes after`, async () => {
        const { asks, said } = asking(10);
        expect(await asks.ask(`trash`, `/a`).catch((error: Error) => error.message)).toBe(NO_ANSWER);
        expect(asks.answer({ op: `answer`, id: idOf(said[0]), ok: true })).toBe(false);
        expect(asks.answer({ op: `answer`, id: `never-asked`, ok: true })).toBe(false);
    });

    it(`ends every open ask when the app lets go`, async () => {
        const { asks } = asking();
        const open = [asks.ask(`trash`, `/a`), asks.ask(`trash`, `/b`)].map((ask) => ask.catch((error: Error) => error.message));
        asks.close();
        expect(await Promise.all(open)).toEqual([APP_GONE, APP_GONE]);
    });

    it(`gives each ask its own id`, () => {
        const { asks, said } = asking();
        void asks.ask(`trash`, `/a`).catch(() => undefined);
        void asks.ask(`trash`, `/b`).catch(() => undefined);
        asks.close();
        expect(new Set(said.map(idOf)).size).toBe(2);
    });
});
