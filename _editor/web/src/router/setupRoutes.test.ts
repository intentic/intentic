import { homeForSetup, setupRoutes } from "./setupRoutes";

// The setup page's old addresses land on Home's ask for the same thing (features/home/newSandbox/).
describe(`an old setup address`, () => {
    it(`asks Home for a new sandbox`, () => {
        expect(homeForSetup(`/setup`, {})).toEqual({ path: `/home`, query: { add: `sandbox` } });
    });

    it(`finishes the row it named, on a machine of ours where it asked for one (the failure mail's second link)`, () => {
        expect(homeForSetup(`/setup`, { sandbox: `sbx_7` })).toEqual({ path: `/home`, query: { add: `sandbox`, finish: `sbx_7` } });
        expect(homeForSetup(`/setup`, { sandbox: `sbx_7`, machine: `hosted` })).toEqual({
            path: `/home`,
            query: { add: `sandbox`, finish: `sbx_7`, machine: `hosted` },
        });
    });

    it(`picks a machine of ours where it asked for one, an older app's "elsewhere" included, with the tier it named`, () => {
        expect(homeForSetup(`/setup`, { elsewhere: `1`, machine: `hosted` })).toEqual({ path: `/home`, query: { add: `sandbox`, machine: `hosted` } });
        expect(homeForSetup(`/start/hosted`, { tier: `standard` })).toEqual({
            path: `/home`,
            query: { add: `sandbox`, machine: `hosted`, tier: `standard` },
        });
        expect(homeForSetup(`/start/hosted`, { tier: `not-a-tier` })).toEqual({ path: `/home`, query: { add: `sandbox`, machine: `hosted` } });
    });

    it(`carries what the desktop app found signed in on this computer`, () => {
        expect(homeForSetup(`/setup`, { found: `claude,codex`, machine: `mine` })).toEqual({ path: `/home`, query: { add: `sandbox`, found: `claude,codex` } });
    });

    it(`keeps both pages' names, so a link naming one still lands`, () => {
        expect(setupRoutes.map((route) => [route.path, route.name, `redirect` in route])).toEqual([
            [`/start/hosted`, `hosted-start`, true],
            [`/setup`, `setup`, true],
        ]);
    });
});
