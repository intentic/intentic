import type { IntenticApi, ViewRegistration } from "@intentic/extension-api";
import { describe, it, expect, mock } from "bun:test";
import { activate } from "./extension.js";
import { registerExtensionMessages } from "@intentic/extension-ui/i18n";
import { extensionIdOf } from "@intentic/extension-manifest";
import { messages } from "./i18n";
import { manifest } from "./manifest";

// The host registers this before it calls `activate`; a test that calls `activate` itself has to, or every label
// it asserts on reads as its own dotted key.
await registerExtensionMessages(extensionIdOf(manifest), messages);

// Pins that the dashboard exists for an empty workspace too, and that the palette command lands on it.

const capture = (project?: string) => {
    const views: ViewRegistration[] = [];
    const commands = new Map<string, () => unknown>();
    const navigate = mock();
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
});
