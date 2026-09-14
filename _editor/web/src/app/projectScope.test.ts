// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

// The scope's two halves: the predicate every narrowed source applies, and the selection surviving a reload for
// the sandbox it was made in. jsdom: the selection lives in localStorage.

const load = () => import("./projectScope");

beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
});

describe(`inside a project`, () => {
    it(`is the project itself or a path under it, by segment`, async () => {
        const { inProject } = await load();
        expect(inProject(`shop`, `shop`)).toBe(true);
        expect(inProject(`shop/src/index.ts`, `shop`)).toBe(true);
        expect(inProject(`shop2`, `shop`)).toBe(false);
        expect(inProject(`root`, `shop`)).toBe(false);
    });

    it(`lets everything through while no project is open, and only the project's while one is`, async () => {
        const { withinScope, setProjectScope } = await load();
        expect(withinScope(`api`)).toBe(true);
        setProjectScope(`shop`);
        expect(withinScope(`shop/docs`)).toBe(true);
        expect(withinScope(`api`)).toBe(false);
        setProjectScope(undefined);
        expect(withinScope(`api`)).toBe(true);
    });
});

describe(`the selection`, () => {
    it(`is remembered for the sandbox and cleared when set to nothing`, async () => {
        const { projectScope, setProjectScope } = await load();
        setProjectScope(`shop`);
        expect(projectScope.value).toBe(`shop`);
        expect(Object.keys(localStorage).some((key) => key.startsWith(`intentic.project.`))).toBe(true);
        setProjectScope(undefined);
        expect(projectScope.value).toBeUndefined();
        expect(Object.keys(localStorage).some((key) => key.startsWith(`intentic.project.`))).toBe(false);
    });
});
