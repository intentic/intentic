import { createMemoryHistory, createRouter, type RouteRecordRaw } from "vue-router";
import { routePatternOf } from "./routePattern";

// The shapes the app's own table uses (`router/index.ts`): a shell with children, params with a regex, an optional param,
// a path-spanning param, and a catch-all.
const view = { render: () => null };
const routes: RouteRecordRaw[] = [
    {
        path: `/`,
        component: view,
        children: [
            { path: `workspace/:path(.*)*`, component: view },
            { path: `agents/:id`, component: view },
            { path: `ext/:ext/:key?`, component: view },
            { path: `settings/:tab?`, component: view },
        ],
    },
    { path: `/invite/:token`, component: view },
    { path: `/floating/:panel(chat|terminal|preview)`, component: view },
    { path: `/:pathMatch(.*)*`, redirect: `/` },
];

const routerAt = (base?: string) => createRouter({ history: createMemoryHistory(base), routes });

describe(`routePatternOf`, () => {
    it(`names the params instead of holding their values`, () => {
        const router = routerAt();
        expect(routePatternOf(router, `/workspace/web/src/checkout.ts`)).toBe(`/workspace/:path*`);
        expect(routePatternOf(router, `/workspace`)).toBe(`/workspace/:path*`);
        expect(routePatternOf(router, `/agents/cnv_checkout_stripe`)).toBe(`/agents/:id`);
        expect(routePatternOf(router, `/ext/projects/acme-shop`)).toBe(`/ext/:ext/:key?`);
        expect(routePatternOf(router, `/invite/tok_secret`)).toBe(`/invite/:token`);
    });

    it(`drops the regex a param carries, and leaves a route without params as it is`, () => {
        const router = routerAt();
        expect(routePatternOf(router, `/floating/chat`)).toBe(`/floating/:panel`);
        expect(routePatternOf(router, `/`)).toBe(`/`);
    });

    // The catch-all matches whatever else is asked, so an unknown path is reported as the catch-all's own name.
    it(`answers the catch-all for a path no route names`, () => {
        expect(routePatternOf(routerAt(), `/nowhere/at/all`)).toBe(`/:pathMatch*`);
    });

    it(`cuts the router's base off before matching, and leaves a path that only starts like it`, () => {
        const router = routerAt(`/demo`);
        expect(routePatternOf(router, `/demo/workspace/web/src/a.ts`)).toBe(`/workspace/:path*`);
        expect(routePatternOf(router, `/demo`)).toBe(`/`);
        expect(routePatternOf(router, `/demonstration/agents/x`)).toBe(`/:pathMatch*`);
    });
});
