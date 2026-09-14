import type { IntenticApi, ViewRegistration } from "@intentic/extension-api";
import { describe, expect, it, vi } from "vitest";
import { activate } from "./extension.js";

// Pins that the dashboard exists for an empty workspace too, and that the palette command lands on it.

const capture = (project?: string) => {
    const views: ViewRegistration[] = [];
    const commands = new Map<string, () => unknown>();
    const navigate = vi.fn();
    const api = {
        workspace: { project: () => project },
        views: {
            register: (view: ViewRegistration) => {
                views.push(view);
                return { dispose: () => {} };
            },
        },
        commands: {
            register: (command: string, handler: () => unknown) => {
                commands.set(command, handler);
                return { dispose: () => {} };
            },
        },
        navigate,
    } as unknown as IntenticApi;
    activate(api, { extensionId: `intentic.projects`, subscriptions: [] });
    return { views, commands, navigate };
};

describe(`the projects extension`, () => {
    it(`registers one rail view that activates with no repositories at all`, () => {
        const { views } = capture();
        const view = views.find((candidate) => candidate.id === `projects`);
        expect(view?.surface).toBe(`rail`);
        expect(view?.detect([], [])).toEqual([{ key: `projects`, title: `Projects`, icon: `th-large` }]);
        expect(view?.badge?.({ key: `projects`, title: `Projects` })).toBeUndefined();
    });

    it(`names the open project on its tile and wears its monogram, so the scope has a visible cause`, () => {
        const { views } = capture(`shop`);
        const view = views.find((candidate) => candidate.id === `projects`);
        expect(view?.detect([], [])[0]).toMatchObject({ title: `Projects · shop`, monogram: `sh` });
        // A tooltip only: the monogram already says a scope is on, so the corner carries no second mark.
        expect(view?.badge?.({ key: `projects`, title: `Projects` })).toEqual({ tooltip: `looking at shop only` });
    });

    it(`opens the dashboard from the palette`, () => {
        const { commands, navigate } = capture();
        commands.get(`projects.open`)?.();
        expect(navigate).toHaveBeenCalledWith(`/ext/projects`);
    });
});
