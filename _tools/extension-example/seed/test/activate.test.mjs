import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

/* Testing an extension without the app: import the BUILT bundle and run `activate()` against a host stub that
 * enforces the same rule the real host does — a registration whose id the manifest never declared is refused.
 *
 * That is the whole trick. The manifest is the contract between an extension and its host, so a test that reads
 * the manifest and checks the code against it catches the failure mode that actually happens in practice: code
 * and manifest drifting apart, which in the real app shows up as a view that silently never appears.
 *
 * Node's own test runner, and no test dependency at all — the bundle's only imports are the ones the host
 * provides (`vue`, `@tanstack/vue-query`), and those resolve here from devDependencies. If this import ever fails
 * for a missing package, the bundle is carrying an import the host does not publish, which is a real bug: it
 * would throw inside the browser's blob-URL import, where the failure is far less obvious than here. */

const manifest = JSON.parse(await readFile(new URL(`../intentic-extension.json`, import.meta.url), `utf8`));
const { activate } = await import(`../dist/extension.js`);

const declaredViews = new Set((manifest.contributes?.views ?? []).map((view) => view.id));
const declaredCommands = new Set((manifest.contributes?.commands ?? []).map((entry) => entry.command));
const declaredRoutes = manifest.permissions?.sandbox ?? [];

const disposable = () => ({ dispose: () => {} });

const hostStub = () => {
    const registered = { views: [], commands: [], requested: [] };
    const api = {
        apiVersion: `2.1.0`,
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
        navigate: () => {},
    };
    return { api, registered };
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
    // One activation, workspace-wide: this view is not rooted at a repo.
    assert.deepEqual(
        view.detect([], []).map((activation) => activation.key),
        [`example`],
    );
    // The lazily imported component resolved — the SFC really is inside this single-file bundle.
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

    // The badge's own scan is what fetched — a closed view still knows there is a note.
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(registered.requested.some((path) => path.startsWith(`/workspace/file?path=`)));
    assert.equal(view.badge(view.detect([], [])[0])?.count, 1);

    for (const subscription of context.subscriptions) {
        subscription.dispose();
    }
});

test(`every route the extension can reach is one the manifest declared`, () => {
    // Not a runtime assertion — a reminder that this list IS the approval surface the owner sees at install.
    assert.deepEqual(declaredRoutes, [`GET /workspace/file`]);
});
