import type { RemoteRef, RemoteRefs } from "@intentic/sandbox-contract";
import { describe, test, expect } from "bun:test";
import { initialChoice, MANUAL_KEY, refGroups, refKey, refSummary } from "./refs";

// The version picker's ordering and its opening selection: what a repository offers, turned into the list a person
// reads and the one row that starts selected.

const sha = (seed: string): string => seed.repeat(40).slice(0, 40);

const branch = (name: string): RemoteRef => ({ name, kind: `branch`, sha: sha(name.slice(0, 1)) });
const tag = (name: string): RemoteRef => ({ name, kind: `tag`, sha: sha(name.replace(/\D/gu, `1`).slice(0, 1)) });

const repo = (defaultBranch: string | undefined, ...refs: RemoteRef[]): RemoteRefs => ({
    ...(defaultBranch === undefined ? {} : { defaultBranch }),
    refs,
});

const labels = (refs: RemoteRefs, group: string): readonly string[] =>
    refGroups(refs)
        .find((candidate) => candidate.label === group)
        ?.options.map((option) => option.label) ?? [];

describe(`refGroups`, () => {
    test(`orders releases as versions, not as text`, () => {
        const refs = repo(`main`, tag(`v2.0.0`), tag(`v10.0.0`), tag(`v9.1.0`), branch(`main`));
        expect(labels(refs, `Releases`)).toEqual([`v10.0.0`, `v9.1.0`, `v2.0.0`]);
    });

    test(`a release leads its own prereleases`, () => {
        const refs = repo(`main`, tag(`v1.2.0-rc.1`), tag(`v1.2.0`), tag(`v1.2.0-rc.2`));
        expect(labels(refs, `Releases`)).toEqual([`v1.2.0`, `v1.2.0-rc.2`, `v1.2.0-rc.1`]);
    });

    test(`tags that are not versions sort newest-name-first, after the ones that are`, () => {
        const refs = repo(`main`, tag(`nightly`), tag(`2024-05-01`), tag(`v1.0.0`), tag(`2024-06-01`));
        expect(labels(refs, `Releases`)).toEqual([`v1.0.0`, `nightly`, `2024-06-01`, `2024-05-01`]);
    });

    test(`the default branch leads the branches and says so`, () => {
        const refs = repo(`develop`, branch(`alpha`), branch(`develop`), branch(`zeta`));
        expect(labels(refs, `Branches`)).toEqual([`develop`, `alpha`, `zeta`]);
        const first = refGroups(refs).find((group) => group.label === `Branches`)?.options[0];
        expect(first?.description).toContain(`default`);
    });

    test(`a group with nothing in it is not drawn, and the raw-sha row is always there`, () => {
        const groups = refGroups(repo(`main`, branch(`main`)));
        expect(groups.map((group) => group.label)).toEqual([`Branches`, undefined]);
        expect(groups.at(-1)?.options[0]?.value).toBe(MANUAL_KEY);
    });

    test(`a branch and a tag on the same commit stay two rows`, () => {
        const sameSha = sha(`a`);
        const refs: RemoteRefs = { defaultBranch: `main`, refs: [{ name: `main`, kind: `branch`, sha: sameSha }, { name: `v1.0.0`, kind: `tag`, sha: sameSha }] };
        const values = refGroups(refs).flatMap((group) => group.options.map((option) => option.value));
        expect(new Set(values).size).toBe(values.length);
    });
});

describe(`initialChoice`, () => {
    test(`an empty box lands on the default branch, which is what pointing at a repository means`, () => {
        const refs = repo(`main`, tag(`v1.0.0`), branch(`main`), branch(`next`));
        expect(initialChoice(refs, ``)).toEqual({ kind: `ref`, ref: branch(`main`) });
    });

    test(`a commit the repository still names shows as that version`, () => {
        const refs = repo(`main`, branch(`main`), tag(`v1.0.0`));
        expect(initialChoice(refs, tag(`v1.0.0`).sha)).toEqual({ kind: `ref`, ref: tag(`v1.0.0`) });
    });

    test(`a pinned commit no branch or tag names is kept, never quietly moved to the newest one`, () => {
        const refs = repo(`main`, branch(`main`));
        expect(initialChoice(refs, sha(`f`))).toEqual({ kind: `manual` });
    });

    test(`a repository advertising nothing leaves the box alone`, () => {
        expect(initialChoice(repo(undefined), ``)).toBeUndefined();
    });

    test(`a remote with no default branch still offers the branches it has`, () => {
        const refs = repo(undefined, branch(`trunk`));
        expect(initialChoice(refs, ``)).toEqual({ kind: `ref`, ref: branch(`trunk`) });
    });
});

test(`refKey separates a branch from a tag of the same name`, () => {
    expect(refKey({ name: `release`, kind: `branch`, sha: sha(`a`) })).not.toBe(refKey({ name: `release`, kind: `tag`, sha: sha(`a`) }));
});

describe(`refSummary`, () => {
    test(`a branch is described as pinned, because that is what stops it moving`, () => {
        expect(refSummary(branch(`main`))).toContain(`branch can't move under it`);
    });

    test(`a tag says the same of a re-tag`, () => {
        expect(refSummary(tag(`v1.0.0`))).toContain(`re-tag can't move it`);
    });

    test(`both name the commit, short, since that is what gets stored`, () => {
        expect(refSummary(branch(`main`))).toContain(branch(`main`).sha.slice(0, 7));
    });
});
