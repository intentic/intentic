import { combinedFix, fixPrompt, outputTail, type AgentFix } from "./agentFix";

const sync: AgentFix = {
    title: `Sync failed in targowisko`,
    repo: `targowisko`,
    reason: `1 local commit conflict with origin/main; rebase in a terminal to resolve them`,
    goal: `Bring it level.`,
    tree: `shared`,
};

test(`the brief names what failed, where, git's own words, the goal, and that the tree is the owner's own`, () => {
    const prompt = fixPrompt(sync);

    expect(prompt.startsWith(`Sync failed in targowisko. Fix it.`)).toBe(true);
    expect(prompt).toContain("Repository: `targowisko`");
    expect(prompt).toContain(`1 local commit conflict with origin/main`);
    expect(prompt).toContain(`Bring it level.`);
    expect(prompt).toContain(`Never force-push`);
});

test(`the workspace's own repository is named as that, not by its route id`, () => {
    expect(fixPrompt({ ...sync, repo: `root` })).toContain(`the workspace's own repository`);
});

test(`a reason the output already ends with is said once, and a fence survives backticks in the output`, () => {
    const prompt = fixPrompt({ ...sync, reason: `error: failed`, output: "```\nnoise\nerror: failed" });

    expect(prompt).not.toContain(`What it said:`);
    expect(prompt).toContain("````\n```\nnoise\nerror: failed\n````");
});

test(`a copy's brief asks for a report of the change instead of the shared tree's rules`, () => {
    const prompt = fixPrompt({ ...sync, tree: `own` });

    expect(prompt).not.toContain(`Never force-push`);
    expect(prompt).toContain(`say what was wrong and what you changed`);
});

test(`only the tail of a long output rides in the brief`, () => {
    const lines = Array.from({ length: 500 }, (_, index) => `line ${index}`).join(`\n`);
    const tail = outputTail(lines);

    expect(tail.startsWith(`line 420`)).toBe(true);
    expect(tail.endsWith(`line 499`)).toBe(true);
});

test(`several refused repos make one fix, on the owner's tree when any of them is`, () => {
    expect(combinedFix(`Sync failed`, [sync])).toBe(sync);
    const both = combinedFix(`Sync failed`, [sync, { ...sync, repo: `registry`, reason: `rejected`, tree: `own` }]);

    expect(both?.tree).toBe(`shared`);
    expect(both?.facts).toEqual(["`targowisko`: 1 local commit conflict with origin/main; rebase in a terminal to resolve them", "`registry`: rejected"]);
});
