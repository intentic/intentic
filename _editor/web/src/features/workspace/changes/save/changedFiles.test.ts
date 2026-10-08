import type { ChangedFile } from "./changedFiles";
import { discardTargets } from "./changedFiles";

const file = (repo: string, path: string, from?: string): ChangedFile => ({
    key: JSON.stringify([repo, path]),
    repo,
    path,
    label: repo === `root` ? path : `${repo}/${path}`,
    status: from === undefined ? `modified` : `renamed`,
    side: `unstaged`,
    ...(from === undefined ? {} : { from }),
});

describe(`discardTargets`, () => {
    test(`sends one target a repository, naming each file a heading holds`, () => {
        expect(discardTargets([file(`root`, `a.md`), file(`site`, `index.html`), file(`root`, `b.md`)])).toEqual([
            { repo: `root`, paths: [`a.md`, `b.md`] },
            { repo: `site`, paths: [`index.html`] },
        ]);
    });

    test(`names both legs of a rename, or undoing it would leave the old name deleted`, () => {
        expect(discardTargets([file(`root`, `new.md`, `old.md`)])).toEqual([{ repo: `root`, paths: [`new.md`, `old.md`] }]);
    });

    test(`sends nothing for no files, rather than an empty path list git would read as the whole repository`, () => {
        expect(discardTargets([])).toEqual([]);
    });
});
