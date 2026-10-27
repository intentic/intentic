import { NO_SESSION } from "./remote.js";
import { neededPerson, ProofGate, proofAsked } from "./proof-gate.js";

describe("the session helper's proof", () => {
    test("after a no, is not asked again until something needs a person", async () => {
        const gate = new ProofGate();
        let woke = false;
        const waiting = gate.whenWanted().then(() => {
            woke = true;
        });
        await Promise.resolve();
        expect(woke).toBe(false);
        gate.want();
        await waiting;
        expect(woke).toBe(true);
    });

    test("is asked at once when a need came while it was still being asked", async () => {
        const gate = new ProofGate();
        gate.want();
        await expect(gate.whenWanted()).resolves.toBeUndefined();
    });

    test("forgets a need the moment a person proves the session", async () => {
        const gate = new ProofGate();
        gate.want();
        gate.settle(true);
        expect(gate.proven).toBe(true);
        gate.settle(false);
        let woke = false;
        void gate.whenWanted().then(() => {
            woke = true;
        });
        await Promise.resolve();
        expect(woke).toBe(false);
    });

    test("is needed only by the service's 'nobody is signed in to ask'", () => {
        expect(neededPerson({ ok: false, code: "locked", refusal: `The keyring is locked and no passphrase prompt could be shown: ${NO_SESSION}.` })).toBe(true);
        expect(neededPerson({ ok: false, code: "locked", refusal: "Locked." })).toBe(false);
        expect(neededPerson({ ok: true })).toBe(false);
    });

    test("tells the person where to look, by what it asks", () => {
        expect(proofAsked("passphrase")).toContain("recovery key");
        expect(proofAsked("hello")).not.toContain("recovery key");
    });
});
