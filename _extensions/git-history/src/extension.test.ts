import type { DocumentProviderRegistration, IntenticApi, RepoFacts, ViewRegistration } from "@intentic/extension-api";
import { activate } from "./extension.js";
import { registerExtensionMessages } from "@intentic/extension-ui/i18n";
import { extensionIdOf } from "@intentic/extension-manifest";
import { messages } from "./i18n";
import { manifest } from "./manifest";

// The host registers this before it calls `activate`; a test that calls `activate` itself has to, or every label
// it asserts on reads as its own dotted key.
await registerExtensionMessages(extensionIdOf(manifest), messages);

// Pins which repositories get a Git tab and what the palette command opens; both fail silently, a wrong `detect()` or
// an empty command looks like nothing went wrong.

const facts = (repo: string): RepoFacts => ({
    repo,
    hasPanel: false,
    deployConfig: false,
    desiredState: false,
    directoryUi: false,
    monorepo: false,
    tests: false,
    userStories: false,
    docs: false,
});

// Records every registration `activate` makes, on a stub shaped like the host's api, narrowed to this extension.
const capture = (repos: readonly RepoFacts[]) => {
    const views: ViewRegistration[] = [];
    const documents: DocumentProviderRegistration[] = [];
    const commands = new Map<string, () => unknown>();
    const open = jest.fn();
    const api = {
        views: {
            register: (view: ViewRegistration) => {
                views.push(view);
                return { dispose: () => {} };
            },
        },
        documents: {
            register: (provider: DocumentProviderRegistration) => {
                documents.push(provider);
                return { dispose: () => {} };
            },
            open,
        },
        commands: {
            register: (command: string, handler: () => unknown) => {
                commands.set(command, handler);
                return { dispose: () => {} };
            },
        },
        workspace: { repos: () => repos },
    } as unknown as IntenticApi;
    activate(api, { extensionId: `intentic.git-history`, subscriptions: [] });
    return { views, documents, commands, open };
};

describe(`ext-git-history`, () => {
    // The tab is bound to the repository's own path, which is what GitHistoryTab resolves its repo from.
    it(`gives every repository a Git tab in its management panel`, () => {
        const { views } = capture([facts(`intentic`), facts(`shop`)]);
        const view = views[0]!;

        expect(view.surface).toBe(`directory`);
        expect(view.detect([facts(`intentic`), facts(`shop`)], [])).toEqual([
            { key: `intentic`, title: `Git`, repo: `intentic`, props: { path: `intentic` } },
            { key: `shop`, title: `Git`, repo: `shop`, props: { path: `shop` } },
        ]);
    });

    // Auxiliary, or a history every repo has would claim every repo and starve the views that serve unclaimed ones.
    it(`adds its tab without claiming the repository`, () => {
        expect(capture([]).views[0]!.auxiliary).toBe(true);
    });

    // The workspace root has no tree row and so no management panel, so its history stays a document the palette
    // opens; a repository row must not offer one too, or the icon the tab replaced comes back.
    it(`offers its document on the workspace root and nowhere else`, () => {
        const provider = capture([facts(`intentic`)]).documents[0]!;

        expect(provider.detect(``)).toEqual({ icon: `sitemap`, tooltip: `Open git history`, title: `History` });
        expect(provider.detect(`intentic`)).toBeUndefined();
        expect(provider.detect(`intentic/_editor/web`)).toBeUndefined();
    });

    it(`opens the root repository's history from the palette command`, () => {
        const { commands, open } = capture([facts(`intentic`)]);
        commands.get(`git-history.open`)!();
        expect(open).toHaveBeenCalledWith(`git-history`, ``);
    });
});
