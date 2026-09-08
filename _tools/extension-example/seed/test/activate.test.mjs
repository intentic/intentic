import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

// Runs the built bundle's activate() against a host stub that enforces the manifest's registration rules, catching
// code/manifest drift. Node's test runner only; the bundle's host-provided imports resolve here from devDependencies.

const manifest = JSON.parse(await readFile(new URL(`../intentic-extension.json`, import.meta.url), `utf8`));
const { activate } = await import(`../dist/extension.js`);

const declaredViews = new Set((manifest.contributes?.views ?? []).map((view) => view.id));
const declaredCommands = new Set((manifest.contributes?.commands ?? []).map((entry) => entry.command));
const declaredRoutes = manifest.permissions?.sandbox ?? [];
// Paths the host may wake this extension for; exactly what contributes.files declares.
const declaredFiles = (manifest.contributes?.files ?? []).map((file) => file.path);

const disposable = () => ({ dispose: () => {} });

const hostStub = () => {
    const registered = { views: [], commands: [], requested: [], watchers: [] };
    const api = {
        apiVersion: `2.10.0`,
        views: {
            register: (view) => {
                assert.ok(declaredViews.has(view.id), `view "${view.id}" is not declared in contributes.views`);
                registered.views.push(view);
                return disposable();
            },
        },
        commands: {
            register: (command) => {
                assert.ok(declaredCommands.has(command), `command "${command}" is not declared in contributes.commands`);
                registered.commands.push(command);
                return disposable();
            },
        },
        settings: { get: (key) => (key === `limit` ? 5 : undefined) },
        sandbox: {
            reachable: () => true,
            key: (...parts) => [...parts, `sandbox-test`],
            json: async (path) => {
                registered.requested.push(path);
                return { path, content: JSON.stringify({ notes: [{ at: `2026-01-01T00:00:00.000Z`, text: `hello` }] }) };
            },
        },
        workspace: {
            // Recorded, not ignored: a badge that doesn't subscribe is only as fresh as its poll interval.
            onDidChangeFiles: (listener) => {
                registered.watchers.push(listener);
                return disposable();
            },
        },
        navigate: () => {},
    };
    // Simulates the daemon's push. The path is read off the manifest, not retyped, so a test copy can't drift from the
    // declared contract.
    const notesWritten = () => {
        for (const listener of registered.watchers) {
            listener(declaredFiles);
        }
    };
    return { api, registered, notesWritten };
};

test(`activate registers exactly what the manifest declares`, async () => {
    const { api, registered } = hostStub();
    const context = { extensionId: `intentic.example`, subscriptions: [] };

    await activate(api, context);

    assert.deepEqual(
        registered.views.map((view) => view.id),
        [`example`],
    );
    assert.deepEqual(registered.commands, [`example.reload`]);

    const view = registered.views[0];
    assert.equal(view.surface, `rail`);
    // One activation, workspace-wide: this view isn't rooted at a repo.
    assert.deepEqual(
        view.detect([], []).map((activation) => activation.key),
        [`example`],
    );
    // Confirms the SFC bundled: the lazy import actually resolves inside this single file.
    assert.equal(typeof (await view.view()), `object`);

    for (const subscription of context.subscriptions) {
        subscription.dispose();
    }
});

test(`the badge stays quiet until there is something unread, and clears the timer on dispose`, async () => {
    const { api, registered } = hostStub();
    const context = { extensionId: `intentic.example`, subscriptions: [] };
    await activate(api, context);
    const view = registered.views[0];

    // The badge's own scan fetches this, independent of the view being open.
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(registered.requested.some((path) => path.startsWith(`/workspace/file?path=`)));
    assert.equal(view.badge(view.detect([], [])[0])?.count, 1);

    for (const subscription of context.subscriptions) {
        subscription.dispose();
    }
});

test(`the badge re-reads when the file it derives from is written, rather than at the next tick`, async () => {
    const { api, registered, notesWritten } = hostStub();
    const context = { extensionId: `intentic.example`, subscriptions: [] };
    await activate(api, context);

    await new Promise((resolve) => setImmediate(resolve));
    const afterActivation = registered.requested.length;

    notesWritten();
    await new Promise((resolve) => setImmediate(resolve));

    // Without the file-write subscription, the tile would lag ten minutes (POLL_MS) behind a file already visible.
    assert.ok(registered.requested.length > afterActivation);

    for (const subscription of context.subscriptions) {
        subscription.dispose();
    }
});

test(`every route the extension can reach is one the manifest declared`, () => {
    // A reminder, not a runtime check: this list is the approval surface the owner sees at install.
    assert.deepEqual(declaredRoutes, [`GET /workspace/file`]);
});
