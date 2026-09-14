import type { IntenticApi, ViewRegistration } from "@intentic/extension-api";
import { describe, expect, it, vi } from "vitest";
import { activate } from "./extension.js";

// Pins that the home exists for an empty workspace too, and that the palette command lands on it.

const capture = () => {
    const views: ViewRegistration[] = [];
    const commands = new Map<string, () => unknown>();
    const navigate = vi.fn();
    const api = {
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
    activate(api, { extensionId: `intentic.project`, subscriptions: [] });
    return { views, commands, navigate };
};

describe(`the project extension`, () => {
    it(`registers one rail view that activates with no repositories at all`, () => {
        const { views } = capture();
        const view = views.find((candidate) => candidate.id === `project`);
        expect(view?.surface).toBe(`rail`);
        expect(view?.detect([], [])).toEqual([{ key: `project`, title: `Project`, icon: `home` }]);
    });

    it(`opens the home from the palette`, () => {
        const { commands, navigate } = capture();
        commands.get(`project.open`)?.();
        expect(navigate).toHaveBeenCalledWith(`/ext/project`);
    });
});
