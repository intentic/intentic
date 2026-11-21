import { runnerNameProblem } from "./runnerNames";

// A new runner's name is its container on that computer and this sandbox's enrollment for it: one name each, so a name
// already used is said before a flow that would fail minutes in, or quietly replace a working runner's enrollment.

const OWN = [{ id: `omen` }];
const OMEN = [
    { slug: `runner-omen`, runnerOf: { url: `https://sandbox-574ea8038415.sbx.intentic.dev`, name: `phaser` } },
    { slug: `runner-gpu`, runnerOf: { url: `https://sandbox-aaaaaaaaaaaa.example.dev`, name: `research` } },
    { slug: `runner-old` },
    { slug: `sandbox-40ebeea77f90`, runnerOf: null },
];

test(`nothing typed yet, or a free name, is no problem`, () => {
    expect(runnerNameProblem(``, OWN, OMEN)).toBeUndefined();
    expect(runnerNameProblem(`omen-2`, OWN, OMEN)).toBeUndefined();
    // A person's sandbox does not share the runners' names: its container is not `runner-<name>`.
    expect(runnerNameProblem(`sandbox-40ebeea77f90`, OWN, OMEN)).toBeUndefined();
});

test(`a name ic would not take is said first`, () => {
    expect(runnerNameProblem(`Omen PC`, OWN, OMEN)).toBe(`Lowercase letters, digits and dashes only.`);
});

test(`a name this sandbox already uses is refused, wherever that runner is`, () => {
    expect(runnerNameProblem(`omen`, OWN, [])).toBe(`This sandbox already has a runner called omen.`);
});

test(`a name another sandbox's runner holds on this computer says whose it is, when the computer says`, () => {
    expect(runnerNameProblem(`gpu`, OWN, OMEN)).toBe(`gpu is taken on this computer by a runner of research.`);
    expect(runnerNameProblem(`old`, OWN, OMEN)).toBe(`old is already a runner's name on this computer.`);
});
