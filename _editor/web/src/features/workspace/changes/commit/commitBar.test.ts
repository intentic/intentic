// The press bar's one reading line, picked in one place (commitBar.ts). Pinned: exactly one case wins, most pressing
// first; a commit reads the same whether the daemon or the run this tab follows says so (it was said twice, in two
// wordings, on 10-19); and nothing is said at rest.
import { barLine, type BarFacts } from "./commitBar";
import type { RunLine } from "./runLine";

const rest: BarFacts = {
    changes: 3,
    conflicts: false,
    run: undefined,
    committing: [],
    refused: undefined,
    outgoing: undefined,
    chipNotice: undefined,
    noUpstream: false,
};

const run: RunLine = { words: `Committing in root…`, others: 0, tip: undefined, lostContact: false, slow: true, stop: () => undefined };

describe(`barLine`, () => {
    it(`says nothing at rest`, () => {
        expect(barLine(rest)).toEqual({ kind: `rest` });
    });

    it(`gives a followed run the line over everything else, so a commit is never said twice`, () => {
        const busy: BarFacts = {
            ...rest,
            run,
            conflicts: true,
            committing: [`root`],
            refused: `Write a message first`,
            outgoing: `flow`,
            chipNotice: `x`,
        };
        expect(barLine(busy)).toEqual({ kind: `run`, line: run });
    });

    it(`says a commit before its run is read in the run's own words`, () => {
        expect(barLine({ ...rest, committing: [`root`] })).toEqual({ kind: `committing`, words: `Committing in root…` });
    });

    it(`puts a conflict ahead of a refusal, a refusal ahead of a push, a push ahead of the chip's note`, () => {
        expect(barLine({ ...rest, conflicts: true, refused: `no` })).toEqual({ kind: `conflicts` });
        expect(barLine({ ...rest, refused: `no`, outgoing: `flow` })).toEqual({ kind: `refused`, reason: `no` });
        expect(barLine({ ...rest, outgoing: `flow`, chipNotice: `note` })).toEqual({ kind: `push` });
        expect(barLine({ ...rest, chipNotice: `note`, noUpstream: true })).toEqual({ kind: `chip`, notice: `note` });
        expect(barLine({ ...rest, noUpstream: true })).toEqual({ kind: `no-upstream` });
    });

    it(`says nothing about the box when there is nothing to commit`, () => {
        expect(barLine({ ...rest, changes: 0, conflicts: true, chipNotice: `note` })).toEqual({ kind: `rest` });
    });
});
