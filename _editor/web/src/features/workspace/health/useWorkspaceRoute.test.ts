import { createMemoryHistory, createRouter, type RouteRecordRaw } from "vue-router";
import { queryWithScope, scopeFromQuery } from "./scopeRoute";

/* The workspace deep-link route must remain resolvable by Vue Router. */

const noop = { template: `<div />` };
const routes: RouteRecordRaw[] = [
    { path: `/workspace/:path(.*)*`, name: `workspace`, component: noop },
    { path: `/:pathMatch(.*)*`, redirect: `/` },
];
const makeRouter = () => createRouter({ history: createMemoryHistory(), routes });
const readPath = (params: Record<string, unknown>): string => {
    const path = params[`path`];
    return Array.isArray(path) ? path.join(`/`) : ((path as string | undefined) ?? ``);
};

describe(`workspace splat route`, () => {
    it(`reads a nested file path as joined segments`, () => {
        expect(readPath(makeRouter().resolve(`/workspace/src/foo.ts`).params)).toBe(`src/foo.ts`);
    });

    it(`reads bare /workspace as an empty path (the "no file" sentinel)`, () => {
        expect(readPath(makeRouter().resolve(`/workspace`).params)).toBe(``);
    });

    it(`writes an array param as real slashes, not %2F`, () => {
        expect(makeRouter().resolve({ name: `workspace`, params: { path: [`src`, `foo.ts`] } }).href).toBe(`/workspace/src/foo.ts`);
    });

    it(`writing a single string param encodes the slash: why useWorkspaceRoute splits to an array`, () => {
        expect(makeRouter().resolve({ name: `workspace`, params: { path: `src/foo.ts` } }).href).toBe(`/workspace/src%2Ffoo.ts`);
    });

    it(`round-trips a filename with spaces`, () => {
        const router = makeRouter();
        const href = router.resolve({ name: `workspace`, params: { path: `my dir/a b.ts`.split(`/`) } }).href;
        expect(href).toBe(`/workspace/my%20dir/a%20b.ts`);
        expect(readPath(router.resolve(href).params)).toBe(`my dir/a b.ts`);
    });

    it(`writes bare /workspace for an empty path array`, () => {
        expect(makeRouter().resolve({ name: `workspace`, params: { path: [] } }).href).toBe(`/workspace`);
    });

    it(`outranks the root catch-all for a nested path`, () => {
        expect(makeRouter().resolve(`/workspace/src/foo.ts`).name).toBe(`workspace`);
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
        const href = router.resolve({ name: `workspace`, params: { path: [] }, query: queryWithScope({}, { repo: `apps/web`, branch: `feature/a b` }) }).href;
        expect(scopeFromQuery(router.resolve(href).query)).toEqual({ repo: `apps/web`, branch: `feature/a b` });
    });
});
