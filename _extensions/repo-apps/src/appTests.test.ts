import { describe, expect, it } from "vitest";
import { groupTests } from "./appTests";

describe(`groupTests`, () => {
    const projects = [
        `mono/_apps/api`, // discovered app "api"
        `mono/_apps/web/pkg`, // nested under discovered app "web"
        `mono/_apps/cli`, // _apps dir, NOT a discovered app → packages
        `mono/_libs/engine`, // a lib → libraries
        `mono`, // repo root → libraries
    ];
    const apps = [`api`, `web`];

    it(`splits into discovered apps, non-app packages, and libraries`, () => {
        const { byApp, packages, libraries } = groupTests(projects, apps, `mono`);
        expect(byApp.get(`api`)).toEqual([`mono/_apps/api`]);
        expect(byApp.get(`web`)).toEqual([`mono/_apps/web/pkg`]);
        expect(packages.get(`cli`)).toEqual([`mono/_apps/cli`]);
        expect(byApp.has(`cli`)).toBe(false);
        expect(libraries).toEqual([`mono/_libs/engine`, `mono`]);
    });

    it(`returns empty buckets when there are no projects`, () => {
        const { byApp, packages, libraries } = groupTests([], apps, `mono`);
        expect(byApp.size).toBe(0);
        expect(packages.size).toBe(0);
        expect(libraries).toEqual([]);
    });
});
