import { landsOnto, landWord, startedFrom } from "./branchLanding";

// Pins what a conversation started from a branch says where its work goes: the branch's name in place of "Land".

describe(`a branch start's land wording`, () => {
    it(`keeps the vocabulary's own word on the main line`, () => {
        expect(landWord(undefined, `Land now`)).toBe(`Land now`);
        expect(landWord([], `Land now`)).toBe(`Land now`);
        expect(startedFrom(undefined)).toBeUndefined();
    });

    it(`says it commits to the branch, by the branch's own name`, () => {
        expect(landWord([{ repo: `apps/web`, branch: `feature/login` }], `Land now`)).toBe(`Commit to apps/web · feature/login`);
        expect(landsOnto([{ repo: `root`, branch: `release` }])).toBe(`release`);
    });

    it(`names where it started from, the repository first when it is not the workspace's own`, () => {
        expect(startedFrom([{ repo: `root`, branch: `release` }])).toBe(`from release`);
        expect(startedFrom([{ repo: `apps/web`, branch: `feature/login` }])).toBe(`from apps/web · feature/login`);
    });
});
