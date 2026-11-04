import { insidePath, page, SANDBOX_PAGES, SANDBOX_SEGMENT } from "@intentic/sandbox-contract/app-routes";
import { createMemoryHistory, createRouter, type RouteRecordRaw } from "vue-router";
import { queryWithScope, scopeFromQuery } from "./scopeRoute";

/* The workspace deep-link route must remain resolvable by Vue Router, at the address the shared table writes for it. */

const noop = { template: `<div />` };
const routes: RouteRecordRaw[] = [
    { path: `/${SANDBOX_SEGMENT}/:sandbox/${SANDBOX_PAGES.workspace}`, name: `inside:workspace`, component: noop },
    { path: `/:pathMatch(.*)*`, redirect: `/` },
];
const makeRouter = () => createRouter({ history: createMemoryHistory(), routes });
const readPath = (params: Record<string, unknown>): string => {
    const path = params[`path`];
    return Array.isArray(path) ? path.join(`/`) : ((path as string | undefined) ?? ``);
};
// The address useWorkspaceRoute writes for a path, as the builders make it (lib/routes/links.ts `here`).
const workspaceAt = (path?: string): string => insidePath(`sb-1`, page.workspace(path));

describe(`workspace splat route`, () => {
    it(`reads a nested file path as joined segments`, () => {
        expect(readPath(makeRouter().resolve(workspaceAt(`src/foo.ts`)).params)).toBe(`src/foo.ts`);
    });

    it(`reads the bare workspace as an empty path (the "no file" sentinel)`, () => {
        expect(readPath(makeRouter().resolve(workspaceAt()).params)).toBe(``);
    });

    it(`writes a file's path with real slashes, not %2F`, () => {
        expect(makeRouter().resolve({ path: workspaceAt(`src/foo.ts`), query: {} }).href).toBe(`/s/sb-1/workspace/src/foo.ts`);
    });

    it(`round-trips a filename with spaces`, () => {
        const router = makeRouter();
        const href = router.resolve({ path: workspaceAt(`my dir/a b.ts`), query: {} }).href;
        expect(href).toBe(`/s/sb-1/workspace/my%20dir/a%20b.ts`);
        expect(readPath(router.resolve(href).params)).toBe(`my dir/a b.ts`);
    });

    it(`writes the bare workspace for an empty path`, () => {
        expect(makeRouter().resolve({ path: workspaceAt(``), query: {} }).href).toBe(`/s/sb-1/workspace`);
    });

    it(`outranks the root catch-all for a nested path`, () => {
        expect(makeRouter().resolve(workspaceAt(`src/foo.ts`)).name).toBe(`inside:workspace`);
    });
});

describe(`the scope the workspace URL carries`, () => {
    it(`reads ?agent= as that conversation's copy, ?repo=&branch= as a branch, and nothing as the shared tree`, () => {
        expect(scopeFromQuery({ agent: `c-1` })).toEqual({ agent: `c-1` });
        expect(scopeFromQuery({ repo: `apps/web`, branch: `feature/login` })).toEqual({ repo: `apps/web`, branch: `feature/login` });
        expect(scopeFromQuery({})).toEqual({});
    });

    it(`takes a branch with no repo as the workspace's own, and ignores a repeated or empty parameter`, () => {
        expect(scopeFromQuery({ branch: `release` })).toEqual({ repo: `root`, branch: `release` });
        expect(scopeFromQuery({ agent: ``, branch: [`a`, `b`] })).toEqual({});
    });

    it(`lets an agent outrank a branch, which the daemon never takes together`, () => {
        expect(scopeFromQuery({ agent: `c-1`, repo: `root`, branch: `x` })).toEqual({ agent: `c-1` });
    });

    it(`writes either shape back in place of the other, keeping every other parameter`, () => {
        expect(queryWithScope({ agent: `c-1`, dir: `src` }, { repo: `root`, branch: `x` })).toEqual({ dir: `src`, repo: `root`, branch: `x` });
        expect(queryWithScope({ repo: `root`, branch: `x`, diff: `a.ts` }, { agent: `c-2` })).toEqual({ diff: `a.ts`, agent: `c-2` });
        expect(queryWithScope({ repo: `root`, branch: `x`, dir: `src` }, {})).toEqual({ dir: `src` });
    });

    it(`round-trips a branch through a real URL, slashes and all`, () => {
        const router = makeRouter();
        const href = router.resolve({ path: workspaceAt(), query: queryWithScope({}, { repo: `apps/web`, branch: `feature/a b` }) }).href;
        expect(scopeFromQuery(router.resolve(href).query)).toEqual({ repo: `apps/web`, branch: `feature/a b` });
    });
});
