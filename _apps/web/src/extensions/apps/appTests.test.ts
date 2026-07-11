import { describe, expect, it } from "vitest";
import { groupTests } from "./appTests";

describe(`groupTests`, () => {
    const projects = [
        `repositories/mono/_apps/api`, // discovered app "api"
        `repositories/mono/_apps/web/pkg`, // nested under discovered app "web"
        `repositories/mono/_apps/cli`, // _apps dir, NOT a discovered app → packages
        `repositories/mono/_libs/engine`, // a lib → libraries
        `repositories/mono`, // repo root → libraries
    ];
    const apps = [`api`, `web`];

    it(`splits into discovered apps, non-app packages, and libraries`, () => {
        const { byApp, packages, libraries } = groupTests(projects, apps, `mono`);
        expect(byApp.get(`api`)).toEqual([`repositories/mono/_apps/api`]);
        expect(byApp.get(`web`)).toEqual([`repositories/mono/_apps/web/pkg`]);
        expect(packages.get(`cli`)).toEqual([`repositories/mono/_apps/cli`]);
        expect(byApp.has(`cli`)).toBe(false);
        expect(libraries).toEqual([`repositories/mono/_libs/engine`, `repositories/mono`]);
    });

    it(`returns empty buckets when there are no projects`, () => {
        const { byApp, packages, libraries } = groupTests([], apps, `mono`);
        expect(byApp.size).toBe(0);
        expect(packages.size).toBe(0);
        expect(libraries).toEqual([]);
    });
});
