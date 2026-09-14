import { createMemoryHistory, createRouter, type RouteRecordRaw } from "vue-router";
import { describe, expect, it } from "vitest";

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
