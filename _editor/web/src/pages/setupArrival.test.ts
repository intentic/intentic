import { describe, expect, it } from "vitest";
import { arrivalFor, type ArrivalInput } from "./setupArrival";

// A blank first arrival in a browser on a platform that offers everything: the shape every case below varies
// one fact of, so what each test is actually about is the field it overrides.
const arrival = (over: Partial<ArrivalInput> = {}): ArrivalInput => ({
    inApp: false,
    touched: false,
    fresh: true,
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

/* …AND NOT ON ONE NOTHING EVER HAPPENED TO EITHER, WHICH IS THE HALF `touched` COULD NOT SEE. Opening /setup
 * mints a row; closing the tab leaves it, untouched and permanent. Every later visit then found a row that
 * looked exactly like a blank first arrival and started a real machine on the platform's provider for it,
 * spending the account's one free allowance on a box nobody asked for — observed on the live product against
 * a draft a fortnight old, and the reason somebody who had deliberately removed their machine came back to
 * another one. The picker is what a found row gets: one click, and it says what it will do. */
it(`starts a machine only for the row this arrival minted`, () => {
    expect(arrivalFor(arrival({ fresh: true }))).toBe(`hosted`);
    expect(arrivalFor(arrival({ fresh: false }))).toBe(`choose`);
});

// The reader's own click still outranks it: somebody who pressed "Start instantly" on the site has asked, so
// the row being one they left behind last week is beside the point.
it(`still honours an explicit ask on a row it found rather than made`, () => {
    expect(arrivalFor(arrival({ fresh: false, requestedMachine: `hosted` }))).toBe(`hosted`);
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
