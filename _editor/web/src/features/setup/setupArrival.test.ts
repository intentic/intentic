import type { SandboxSummary } from "@intentic/api-contract";
import { describe, it, expect } from "bun:test";
import { sandboxSummary } from "../../testing/sandboxSummary";
import { arrivalFor, type ArrivalInput, hostedIdle, rowToOpen, touched } from "./setupArrival";

// A blank first arrival on a platform offering everything; each test overrides the one field it is about.
const arrival = (over: Partial<ArrivalInput> = {}): ArrivalInput => ({
    inApp: false,
    onlySandbox: true,
    touched: false,
    hostedIdle: false,
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

// "Add sandbox" pressed in the app by an account that already has one. Installing here is the whole gesture of
// having just installed the app, and nothing else: the second time, this computer is one of the places it could
// go rather than the only one.
describe(`a second sandbox asked for in the app`, () => {
    it(`asks instead of installing on this computer`, () => {
        expect(arrivalFor(arrival({ inApp: true, onlySandbox: false }))).toBe(`choose`);
    });

    it(`leaves the account's first one alone`, () => {
        expect(arrivalFor(arrival({ inApp: true, onlySandbox: true }))).toBe(`local`);
    });

    // The Billing page's own door: a subscriber's slot is a machine on the platform, never one more on this guest.
    it(`still starts the machine a link asked for by name`, () => {
        expect(arrivalFor(arrival({ inApp: true, onlySandbox: false, requestedMachine: `hosted` }))).toBe(`hosted`);
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

// A machine already on the row, nothing ever run on it: an earlier browser visit's own errand. The browser resumes
// it; the app is the gesture of installing on this computer, so it hands the machine back and goes local instead.
describe(`a row that already carries a machine`, () => {
    it(`is resumed in a browser and handed back in the app`, () => {
        expect(arrivalFor(arrival({ hostedIdle: true }))).toBe(`choose`);
        expect(arrivalFor(arrival({ hostedIdle: true, inApp: true }))).toBe(`local`);
    });

    it(`starts nothing more, however the machine was asked for`, () => {
        expect(arrivalFor(arrival({ hostedIdle: true, requestedMachine: `hosted` }))).toBe(`choose`);
        expect(arrivalFor(arrival({ hostedIdle: true, inApp: true, requestedMachine: `hosted` }))).toBe(`choose`);
    });

    it(`still needs an address to hand the app a code for`, () => {
        expect(arrivalFor(arrival({ hostedIdle: true, inApp: true, commandOffered: false }))).toBe(`choose`);
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

describe(`the row an arrival settles on`, () => {
    const draft = sandboxSummary({ id: `draft` });
    const live = sandboxSummary({ id: `live`, lastSeenAt: `2026-09-23T10:00:00Z` });
    const shared = sandboxSummary({ id: `shared`, role: `writer`, token: null });

    it(`is the one the URL names, if it is the owner's`, () => {
        expect(rowToOpen([live, draft], `live`)?.id).toBe(`live`);
        expect(rowToOpen([shared, draft], `shared`)).toBe(undefined);
    });

    it(`is the account's one unfinished row while nothing it owns has ever run`, () => {
        expect(rowToOpen([draft], undefined)?.id).toBe(`draft`);
        expect(rowToOpen([live, draft], undefined)).toBe(undefined);
        expect(rowToOpen([draft], `gone`)?.id).toBe(`draft`);
    });

    it(`counts only genuine acts as history, and a machine nothing ran on as idle`, () => {
        const acted: SandboxSummary[] = [
            draft,
            live,
            { ...draft, setupCodeClaimedAt: `2026-09-23T10:00:00Z` },
            { ...draft, setupReport: { stage: `preflight`, failed: [], at: `2026-09-23T10:00:00Z` } },
        ];
        expect(acted.map(touched)).toEqual([false, true, true, true]);
        const machine = { region: `iad`, warm: true };
        expect([draft, { ...draft, hosted: machine }, { ...live, hosted: machine }].map(hostedIdle)).toEqual([false, true, false]);
    });
});
