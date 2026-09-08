import { describe, expect, it } from "vitest";
import { arrivalFor, type ArrivalInput } from "./setupArrival";

// A blank first arrival on a platform offering everything; each test overrides the one field it is about.
const arrival = (over: Partial<ArrivalInput> = {}): ArrivalInput => ({
    inApp: false,
    touched: false,
    fresh: true,
    hostedOffered: true,
    hostedSpent: false,
    hostedFull: false,
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

    it(`falls back to the picker when the surface's own answer cannot be taken`, () => {
        expect(arrivalFor(arrival({ hostedOffered: false }))).toBe(`choose`);
        expect(arrivalFor(arrival({ hostedSpent: true }))).toBe(`choose`);
        expect(arrivalFor(arrival({ inApp: true, commandOffered: false }))).toBe(`choose`);
    });
});

// Platform fleet is at its ceiling, distinct from this account's own `hostedSpent`; known here because this
// page starts a machine unasked.
describe(`a platform with no machines left`, () => {
    it(`shows the picker instead of starting one that cannot be started`, () => {
        expect(arrivalFor(arrival({ hostedFull: true }))).toBe(`choose`);
    });

    it(`ignores an explicit ask for a rung the platform cannot serve right now`, () => {
        expect(arrivalFor(arrival({ hostedFull: true, requestedMachine: `hosted` }))).toBe(`choose`);
    });

    it(`leaves the desktop app's own answer alone`, () => {
        expect(arrivalFor(arrival({ hostedFull: true, inApp: true }))).toBe(`local`);
    });
});

it(`never acts on a resumed sandbox that something has happened to`, () => {
    expect(arrivalFor(arrival({ touched: true }))).toBe(`choose`);
    expect(arrivalFor(arrival({ touched: true, inApp: true }))).toBe(`choose`);
});

it(`starts a machine only for the row this arrival minted`, () => {
    expect(arrivalFor(arrival({ fresh: true }))).toBe(`hosted`);
    expect(arrivalFor(arrival({ fresh: false }))).toBe(`choose`);
});

it(`still honours an explicit ask on a row it found rather than made`, () => {
    expect(arrivalFor(arrival({ fresh: false, requestedMachine: `hosted` }))).toBe(`hosted`);
});

// An explicit rung chosen before this page (site's /where-it-runs cards) outranks the surface's own guess;
// re-deciding here would void the click.
describe(`an explicit ask`, () => {
    it(`is honoured over the surface's own answer`, () => {
        // `mine` in the app still lands on `choose`: the query surfaces the step instead of starting install silently.
        expect(arrivalFor(arrival({ inApp: true, requestedMachine: `mine` }))).toBe(`choose`);
        expect(arrivalFor(arrival({ requestedMachine: `hosted` }))).toBe(`hosted`);
    });

    it(`is ignored when the platform does not offer that rung`, () => {
        expect(arrivalFor(arrival({ requestedMachine: `hosted`, hostedOffered: false }))).toBe(`choose`);
    });
});

it(`shows the options rather than installing when the app says this computer cannot`, () => {
    expect(arrivalFor(arrival({ inApp: true, elsewhere: true }))).toBe(`choose`);
});
