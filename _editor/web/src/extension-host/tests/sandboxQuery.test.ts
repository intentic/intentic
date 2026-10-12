import "@intentic/testing/dom";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { waitFor } from "@intentic/testing/bun";
import { repoRoot } from "@intentic/constants/node";
import { type ExtensionManifest, ExtensionManifestSchema, extensionIdOf } from "@intentic/extension-manifest";
import { effectScope, type EffectScope } from "vue";
import { z } from "zod";

// `api.sandbox.query` is the shell's own daemon-read wrapper handed to extension code, not a copy of it: a read is asked
// only while the sandbox answers, and a failure reads as words, where a bare `useQuery` showed raw schema-issue JSON.

const { createExtensionApi, deactivateAllExtensions } = await import("../apiImpl");
const { signalConnection } = await import("../../client/sandbox/useSandbox");
const { classifyFailure } = await import("../../client/sandbox/connection");
const { queryClient } = await import("../../lib/queryPersistence");

const manifest: ExtensionManifest = ExtensionManifestSchema.parse(
    JSON.parse(readFileSync(join(repoRoot(import.meta.url), `_extensions/approvals/intentic-extension.json`), `utf8`)),
);
const api = createExtensionApi(
    { id: extensionIdOf(manifest), manifest, commit: `query`, source: `builtin`, enabled: true },
    { repos: () => [], capabilities: () => [] },
).api;

let scope: EffectScope | undefined;
const inScope = <T>(read: () => T): T => {
    scope = effectScope();
    return scope.run(read)!;
};

beforeEach(() => signalConnection({ kind: `frame`, at: Date.now() }));
afterEach(() => {
    scope?.stop();
    scope = undefined;
    queryClient.clear();
});
afterAll(() => deactivateAllExtensions());

describe(`api.sandbox.query`, () => {
    it(`does not ask a daemon that is down, and asks the moment it answers`, async () => {
        signalConnection({ kind: `failed`, failure: classifyFailure({ message: `tunnel down` }), at: Date.now() });
        const queryFn = jest.fn(async () => [`a`, `b`]);
        const { query } = inScope(() => api.sandbox.query({ queryKey: api.sandbox.key(`query-gate`), queryFn }));
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(queryFn).toHaveBeenCalledTimes(0);
        expect(query.data.value).toBeUndefined();

        signalConnection({ kind: `frame`, at: Date.now() });

        await waitFor(() => expect(query.data.value).toEqual([`a`, `b`]));
        expect(queryFn).toHaveBeenCalledTimes(1);
    });

    it(`keeps the extension's own gate beside the sandbox's, and reshapes the answer for this reader only`, async () => {
        const key = api.sandbox.key(`query-select`);
        const { query } = inScope(() =>
            api.sandbox.query({ queryKey: key, queryFn: async () => ({ items: [1, 2, 3] }), select: (answer) => answer.items.length, enabled: () => false }),
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(query.data.value).toBeUndefined();

        const reader = inScope(() => api.sandbox.query({ queryKey: key, queryFn: async () => ({ items: [1, 2, 3] }), select: (answer) => answer.items.length }));
        await waitFor(() => expect(reader.query.data.value).toBe(3));
        expect(queryClient.getQueryData<{ items: number[] }>([...key])).toEqual({ items: [1, 2, 3] });
    });

    it(`says a schema refusing the daemon's answer as version drift, and any other failure as it was thrown`, async () => {
        const Kinds = z.object({ kind: z.enum([`cli`, `browser`]) });
        const drifted = inScope(() =>
            api.sandbox.query({ queryKey: api.sandbox.key(`query-drift`), queryFn: async () => Kinds.parse({ kind: `service` }), retry: false }),
        );
        await waitFor(() => expect(drifted.error.value).toEqual(expect.any(String)));
        expect(drifted.error.value).toStartWith(`This sandbox answered in a shape this app doesn't expect.`);
        expect(drifted.error.value).not.toContain(`invalid_value`);

        const refused = inScope(() =>
            api.sandbox.query({
                queryKey: api.sandbox.key(`query-refused`),
                queryFn: async (): Promise<string> => {
                    throw new Error(`The sandbox is restarting.`);
                },
                retry: false,
            }),
        );
        await waitFor(() => expect(refused.error.value).toBe(`The sandbox is restarting.`));
    });

    it(`reads another sandbox while the open one is down, when aimed at it`, async () => {
        signalConnection({ kind: `failed`, failure: classifyFailure({ message: `tunnel down` }), at: Date.now() });
        const { query } = inScope(() => api.sandbox.query({ queryKey: [`elsewhere`], queryFn: async () => `from elsewhere` }, `sbx-2`));
        await waitFor(() => expect(query.data.value).toBe(`from elsewhere`));
    });
});
