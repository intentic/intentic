import { resetSandboxScope } from "@intentic/extension-api";
import { fileOperation, fileOperationNotice, SHOWN_FROM, trackOperation } from "./fileOperations";

// Pins the card a gesture of many entries gets: its progress and a Stop while it runs, nothing after a clean finish,
// and what was left undone, by name, after one that was refused or stopped.

afterEach(() => {
    resetSandboxScope();
});

const card = () => fileOperationNotice(fileOperation.value, () => undefined);
const paths = (count: number): string[] => Array.from({ length: count }, (_, index) => `shots/shot-${index + 1}.png`);

it(`puts nothing on a card for a gesture of a few entries`, () => {
    const operation = trackOperation(`move`, SHOWN_FROM - 1);
    operation.landed(`a.md`, false);
    operation.end();
    expect([fileOperation.value, operation.stopped()]).toEqual([undefined, false]);
});

it(`shows how far a long gesture has got, and retires the card once every entry landed`, () => {
    const operation = trackOperation(`move`, 12);
    const first = card();
    for (const path of paths(12)) {
        operation.landed(path, true);
    }
    operation.end();
    expect([first?.title, first?.actions?.map((action) => action.label), fileOperation.value]).toEqual([`Moving 0 of 12 items`, [`Stop`], undefined]);
});

it(`leaves the rest where it is on Stop, and says what was not done once it ends`, () => {
    const operation = trackOperation(`delete`, 12);
    const [one, two, three, four] = paths(4);
    operation.landed(one ?? ``, true);
    operation.landed(two ?? ``, false);
    operation.landed(three ?? ``, false);
    operation.landed(four ?? ``, false);
    operation.landed(`shots/last.png`, false);
    fileOperation.value?.stop();
    const stopping = card();
    operation.end();

    expect([operation.stopped(), stopping?.detail, stopping?.actions, card()?.title, card()?.detail, card()?.tone]).toEqual([
        true,
        `Stopping after the items already under way`,
        [],
        `Deleted 1 of 12 items`,
        `Not done: shot-2.png, shot-3.png, shot-4.png and 1 more`,
        `warning`,
    ]);
});
