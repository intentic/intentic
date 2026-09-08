import type { DocumentProviderRegistration, IntenticApi, RepoFacts } from "@intentic/extension-api";
import { describe, expect, it, vi } from "vitest";
import { activate } from "./extension.js";

// Pins which rows get the icon and what the palette command opens; both fail silently, a wrong `detect()` or an empty
// command looks like nothing went wrong.

const facts = (repo: string): RepoFacts => ({
    repo,
    hasPanel: false,
    deployConfig: false,
    desiredState: false,
    directoryUi: false,
    monorepo: false,
    vitest: false,
    userStories: false,
    docs: false,
});

// Records every registration `activate` makes, on a stub shaped like the host's api, narrowed to this extension.
const capture = (repos: readonly RepoFacts[]) => {
    const documents: DocumentProviderRegistration[] = [];
    const commands = new Map<string, () => unknown>();
    const open = vi.fn();
    const api = {
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
    return { documents, commands, open };
};

describe(`ext-git-history`, () => {
    it(`offers its document on a repository row and nowhere else`, () => {
        const { documents } = capture([facts(`intentic`)]);
        const provider = documents[0]!;

        expect(provider.detect(`intentic`)).toEqual({ icon: `sitemap`, tooltip: `Open git history`, title: `History` });
        // A package inside the monorepo is a directory, not a repository: it has files, but no history of its own.
        expect(provider.detect(`intentic/_editor/web`)).toBeUndefined();
        expect(provider.detect(`not-a-repo`)).toBeUndefined();
    });

    // The workspace root has no tree row (it's the container every other repo is discovered inside), so
    // `workspace.repos()` omits it; if this breaks, root's history becomes unreachable.
    it(`offers the workspace root's history under the empty path`, () => {
        const { documents } = capture([]);
        expect(documents[0]!.detect(``)).toMatchObject({ title: `History` });
    });

    // detect() reads live facts, so a cloned repo must flip from undefined to a result with no re-registration.
    it(`tracks the live repo set rather than a snapshot taken at activation`, () => {
        const repos: RepoFacts[] = [];
        const documents: DocumentProviderRegistration[] = [];
        const api = {
            documents: {
                register: (p: DocumentProviderRegistration) => {
                    documents.push(p);
                    return { dispose: () => {} };
                },
                open: vi.fn(),
            },
            commands: { register: () => ({ dispose: () => {} }) },
            workspace: { repos: () => repos },
        } as unknown as IntenticApi;
        activate(api, { extensionId: `intentic.git-history`, subscriptions: [] });

        expect(documents[0]!.detect(`fresh-clone`)).toBeUndefined();
        repos.push(facts(`fresh-clone`));
        expect(documents[0]!.detect(`fresh-clone`)).toMatchObject({ title: `History` });
    });

    it(`opens the root repository's history from the palette command`, () => {
        const { commands, open } = capture([facts(`intentic`)]);
        commands.get(`git-history.open`)!();
        expect(open).toHaveBeenCalledWith(`git-history`, ``);
    });
});
