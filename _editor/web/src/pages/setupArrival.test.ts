import { describe, expect, it } from "vitest";
import { arrivalFor, type ArrivalInput } from "./setupArrival";

// A blank first arrival in a browser on a platform that offers everything: the shape every case below varies
// one fact of, so what each test is actually about is the field it overrides.
const arrival = (over: Partial<ArrivalInput> = {}): ArrivalInput => ({
    inApp: false,
    touched: false,
    hostedOffered: true,
    hostedSpent: false,
    commandOffered: true,
    requestedMachine: undefined,
    elsewhere: false,
    ...over,
});

describe(`the surface answers, not the reader`, () => {
    it(`starts a machine for a browser, and installs on the computer the app is running on`, () => {
        expect(arrivalFor(arrival())).toBe(`hosted`);
        expect(arrivalFor(arrival({ inApp: true }))).toBe(`local`);
    });

    // The picker is what is LEFT: a browser on a platform that hosts nothing has only the reader's own
    // computer to offer, and offering it is a screen rather than an action.
    it(`falls back to the picker when the surface's own answer cannot be taken`, () => {
        expect(arrivalFor(arrival({ hostedOffered: false }))).toBe(`choose`);
        // The allowance is one machine per account, so the SECOND sandbox never auto-starts one: it would be
        // refused by the server, and a browser that fired it anyway would open on an error it caused itself.
        expect(arrivalFor(arrival({ hostedSpent: true }))).toBe(`choose`);
        // In the app the handoff redeems a setup code, so a platform that mints none has nothing to hand over.
        expect(arrivalFor(arrival({ inApp: true, commandOffered: false }))).toBe(`choose`);
    });
});

/* NOTHING IS EVER STARTED ON A SANDBOX SOMEBODY ALREADY ACTED ON. Leaving mid-setup is normal (you get as far
 * as the command, mean to paste it on the other machine, and close the tab), and coming back has to land on
 * the errand as it was left. A visit that quietly attached a machine of ours to that row instead would be the
 * page answering a question the reader had already answered. */
it(`never acts on a resumed sandbox that something has happened to`, () => {
    expect(arrivalFor(arrival({ touched: true }))).toBe(`choose`);
    expect(arrivalFor(arrival({ touched: true, inApp: true }))).toBe(`choose`);
});

/* A RUNG CHOSEN BEFORE THIS PAGE OUTRANKS THE SURFACE, in both directions. The site's /where-it-runs cards
 * are the one surface with room to explain the trade, so a click there is a decision, and re-deciding it here
 * would teach the reader their click meant nothing. */
describe(`an explicit ask`, () => {
    it(`is honoured over the surface's own answer`, () => {
        // In the app, "my own computer" is what the app was going to do anyway; what the query changes is that
        // the reader SEES the step instead of the install starting under them.
        expect(arrivalFor(arrival({ inApp: true, requestedMachine: `mine` }))).toBe(`choose`);
        // …and from the site's "Start instantly" card, the machine starts, phone or desktop.
        expect(arrivalFor(arrival({ requestedMachine: `hosted` }))).toBe(`hosted`);
    });

    // The site is cached and its cards are the same HTML for every platform, so a self-hoster who hosts
    // nothing can be linked at a rung that does not exist here. It lands on the picker, never on a step that
    // can only fail.
    it(`is ignored when the platform does not offer that rung`, () => {
        expect(arrivalFor(arrival({ requestedMachine: `hosted`, hostedOffered: false }))).toBe(`choose`);
    });
});

/* THE APP'S OWN ESCAPE HATCH. Its requirements screen links here with `?elsewhere=1` when the computer it is
 * running on cannot host a sandbox: no WSL2, no Docker, a work laptop somebody else administers. Firing the
 * install at that reader would be the app trying the exact thing it has just told them will not work. */
it(`shows the options rather than installing when the app says this computer cannot`, () => {
    expect(arrivalFor(arrival({ inApp: true, elsewhere: true }))).toBe(`choose`);
});
