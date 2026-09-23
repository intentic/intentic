import type { ViewRegistration } from "@intentic/extension-api";
import type { ActiveExtension } from "../../../core-views/registry";
import { directoryTabs } from "./directoryTabs";

// The management panel is the only way in to a repository's git history, docs and health, so which tabs it shows and
// which one it opens on is the whole affordance: a wrong order silently buries one.

const tab = (id: string, repo: string, surface: ViewRegistration[`surface`] = `directory`): ActiveExtension => ({
    extension: { id, label: id, surface, detect: () => [], view: () => Promise.resolve({}) },
    activation: { key: repo, title: id, repo },
});

const ids = (tabs: readonly ActiveExtension[]): readonly string[] => tabs.map(({ extension }) => extension.id);

describe(`directoryTabs`, () => {
    // Detection order is arbitrary (core views seed the registry before any extension activates), so the panel opens
    // on whatever was registered first unless the order is declared.
    it(`leads with Git and ends with the repo's own UI, whatever order they were detected in`, () => {
        const detected = [
            tab(`directory-ui`, `shop`),
            tab(`apps`, `shop`),
            tab(`codebase-health`, `shop`),
            tab(`documentation-repo`, `shop`),
            tab(`git-history-repo`, `shop`),
        ];

        expect(ids(directoryTabs(detected, `shop`, false))).toEqual([
            `git-history-repo`,
            `documentation-repo`,
            `codebase-health`,
            `apps`,
            `directory-ui`,
        ]);
    });

    // A third-party directory surface has no declared rank; it sits after the ones that do rather than displacing Git.
    it(`puts an unlisted surface last, in its detection order`, () => {
        const detected = [tab(`acme.audit`, `shop`), tab(`acme.costs`, `shop`), tab(`documentation-repo`, `shop`)];

        expect(ids(directoryTabs(detected, `shop`, false))).toEqual([`documentation-repo`, `acme.audit`, `acme.costs`]);
    });

    // Git history and codebase health are a developer's surfaces: they left the tree row for this panel, and the
    // audience rule has to travel with them or a maker gets them back through the cog.
    it(`hides Git and Health from a maker, keeping the rest`, () => {
        const detected = [tab(`git-history-repo`, `shop`), tab(`documentation-repo`, `shop`), tab(`codebase-health`, `shop`), tab(`apps`, `shop`)];

        expect(ids(directoryTabs(detected, `shop`, true))).toEqual([`documentation-repo`, `apps`]);
    });

    it(`takes only this directory's surfaces, and only directory ones`, () => {
        const detected = [tab(`apps`, `shop`), tab(`apps`, `intentic`), tab(`documentation`, `shop`, `rail`)];

        expect(ids(directoryTabs(detected, `shop`, false))).toEqual([`apps`]);
    });
});
