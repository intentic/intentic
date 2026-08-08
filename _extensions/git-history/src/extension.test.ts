import type { DocumentProviderRegistration, IntenticApi, RepoFacts } from "@intentic/extension-api";
import { describe, expect, it, vi } from "vitest";
import { activate } from "./extension.js";

/* WHICH ROWS GET THE ICON, and what the palette command opens. Worth a test because both answers are invisible
 * when they go wrong: a `detect()` that returns undefined costs the row its icon with nothing failing, and a
 * command that opens nothing looks exactly like a command that ran. */

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

// Accepts every registration `activate` makes and records what it was handed — the same shape the host's real
// api presents, narrowed to what this extension touches.
const capture = (repos: readonly RepoFacts[]) => {
    const documents: DocumentProviderRegistration[] = [];
    const commands = new Map<string, () => unknown>();
    const open = vi.fn();
    const api = {
        documents: {
            register: (provider: DocumentProviderRegistration) => (documents.push(provider), { dispose: () => {} }),
            open,
        },
        commands: { register: (command: string, handler: () => unknown) => (commands.set(command, handler), { dispose: () => {} }) },
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
        // A package inside the monorepo is a directory, not a repository — it has files, but no history of its own.
        expect(provider.detect(`intentic/_editor/web`)).toBeUndefined();
        expect(provider.detect(`not-a-repo`)).toBeUndefined();
    });

    /* The workspace root is a repository the tree never draws a row for — it is the container every other repo is
     * discovered inside, so `workspace.repos()` legitimately omits it. If this stops answering, root's history
     * becomes unreachable rather than merely awkward. */
    it(`offers the workspace root's history under the empty path`, () => {
        const { documents } = capture([]);
        expect(documents[0]!.detect(``)).toMatchObject({ title: `History` });
    });

    // The icon has to appear the moment a repo is cloned, and `detect` reads the host's live facts to manage it —
    // so a repo absent from one call and present in the next must flip the answer with no re-registration.
    it(`tracks the live repo set rather than a snapshot taken at activation`, () => {
        const repos: RepoFacts[] = [];
        const documents: DocumentProviderRegistration[] = [];
        const api = {
            documents: { register: (p: DocumentProviderRegistration) => (documents.push(p), { dispose: () => {} }), open: vi.fn() },
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
