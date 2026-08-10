import type { Disposable, ViewRegistration } from "@intentic/extension-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerView } from "../../../core-views/registry";
import { queryClient } from "../../queryPersistence";
import { extensionsWarmSource } from "./extensionsWarm";

/* The rail is mostly extensions — eight of its fourteen tiles — and before this source existed not one of them
 * was warmed, because the registry the core pointed extensions at was never reachable from the extension API. */

const view = (id: string, warm?: ViewRegistration[`warm`]): ViewRegistration => ({
    id,
    label: id,
    surface: `rail`,
    detect: () => [{ key: id, title: id, icon: `wrench` }],
    view: () => Promise.resolve({}),
    ...(warm === undefined ? {} : { warm }),
});

const open: Disposable[] = [];
const register = (owner: string, registration: ViewRegistration): void => {
    open.push(registerView(owner, registration));
};

afterEach(() => {
    for (const entry of open.splice(0)) {
        entry.dispose();
    }
    queryClient.clear();
});

describe(`the extensions' wish list`, () => {
    it(`collects what each registered view asked for, in the rail band`, () => {
        register(
            `ext-maintenance`,
            view(`maintenance`, () => [{ queryKey: [`maintenance-report`, `sbx`], queryFn: () => Promise.resolve(1) }]),
        );

        const plan = extensionsWarmSource();

        expect(plan).toHaveLength(1);
        expect(plan[0]?.band).toBe(`rail`);
        expect(plan[0]?.key).toBe(`ext:["maintenance-report","sbx"]`);
    });

    it(`warms into the very entry the view's own query reads`, async () => {
        const key = [`maintenance-runs`, `sbx`];
        register(
            `ext-maintenance`,
            view(`maintenance`, () => [{ queryKey: key, queryFn: () => Promise.resolve([`a run`]) }]),
        );

        const wish = extensionsWarmSource()[0];
        expect(wish?.have()).toBe(false);
        await wish?.read();

        expect(wish?.have()).toBe(true);
        // The view mounts and finds it sitting there instead of drawing a skeleton.
        expect(queryClient.getQueryData(key)).toEqual([`a run`]);
    });

    it(`asks nothing on behalf of a view that wants nothing`, () => {
        register(`ext-quiet`, view(`quiet`));

        expect(extensionsWarmSource()).toEqual([]);
    });

    it(`contains one extension's broken wish list rather than losing everybody else's`, () => {
        const noise = vi.spyOn(console, `error`).mockImplementation(() => undefined);
        register(
            `ext-broken`,
            view(`broken`, () => {
                throw new Error(`no host yet`);
            }),
        );
        register(
            `ext-fine`,
            view(`fine`, () => [{ queryKey: [`fine`], queryFn: () => Promise.resolve(1) }]),
        );

        expect(extensionsWarmSource().map((task) => task.key)).toEqual([`ext:["fine"]`]);
        noise.mockRestore();
    });

    it(`stops wanting anything once the view is disposed`, () => {
        const disposable = registerView(
            `ext-gone`,
            view(`gone`, () => [{ queryKey: [`gone`], queryFn: () => Promise.resolve(1) }]),
        );
        expect(extensionsWarmSource()).toHaveLength(1);

        disposable.dispose();

        // A wish list outliving its view is the loader warming a screen nobody can reach.
        expect(extensionsWarmSource()).toEqual([]);
    });
});
