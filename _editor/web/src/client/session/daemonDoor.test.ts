import { readDaemonDoor, takesEmailProof } from "./daemonDoor";

// Which proofs a daemon opens a session for, read off its unauthenticated /health: a daemon of any age answers, and one
// that predates the field says nothing, which must read as Google alone and never as "everything".

const answering =
    (body: unknown, status = 200) =>
    async (): Promise<Response> =>
        new Response(JSON.stringify(body), { status });

describe(`readDaemonDoor`, () => {
    it(`reads the proofs a current daemon lists`, async () => {
        const door = await readDaemonDoor(`https://daemon.test`, `sb-1`, answering({ ok: true, sandboxId: `sb-1`, signIn: { proofs: [`google`, `email`] } }));
        expect(door).toEqual({ answers: true, proofs: [`google`, `email`] });
        expect(takesEmailProof(door)).toBe(true);
    });

    it(`reads a daemon from before email sign-in as listing nothing, so the assertion is never sent to it`, async () => {
        const door = await readDaemonDoor(`https://daemon.test`, `sb-1`, answering({ ok: true, sandboxId: `sb-1` }));
        expect(door).toEqual({ answers: true, proofs: undefined });
        expect(takesEmailProof(door)).toBe(false);
    });

    it(`keeps only the proofs this editor knows, so a newer daemon's are not mistaken for one of them`, async () => {
        const door = await readDaemonDoor(`https://daemon.test`, undefined, answering({ ok: true, signIn: { proofs: [`email`, `future-proof`, 7] } }));
        expect(door).toEqual({ answers: true, proofs: [`email`] });
    });

    it(`reads a malformed field as silence rather than failing the whole answer`, async () => {
        expect(await readDaemonDoor(`https://daemon.test`, undefined, answering({ ok: true, signIn: `email` }))).toEqual({ answers: true, proofs: undefined });
    });

    // The same identity check the loopback probe makes: a credential is never offered to whatever else answers there.
    it(`counts another sandbox, a refusal and a dead address as nothing answering`, async () => {
        const silent = { answers: false, proofs: undefined };
        expect(await readDaemonDoor(`https://daemon.test`, `sb-1`, answering({ ok: true, sandboxId: `sb-2`, signIn: { proofs: [`email`] } }))).toEqual(silent);
        expect(await readDaemonDoor(`https://daemon.test`, `sb-1`, answering({ error: `down` }, 503))).toEqual(silent);
        expect(
            await readDaemonDoor(`https://daemon.test`, `sb-1`, async () => {
                throw new TypeError(`fetch failed`);
            }),
        ).toEqual(silent);
    });
});
