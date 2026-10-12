import type { IntenticApi, SandboxQuerySpec } from "@intentic/extension-api";
import { unstubbed } from "@intentic/testing";
import { ref } from "vue";
import { bindHost } from "./host";
import { usePlatformCatalog } from "./usePlatformCatalog";

// Who posts it, read off the extensions list through the host's daemon-read wrapper: the entry is the shell's own
// (`extensions.list`), and whether the sandbox is answering is the wrapper's to decide, not this reader's.

const bound = (answer: unknown) => {
    const specs: SandboxQuerySpec<unknown, unknown>[] = [];
    bindHost(
        unstubbed<IntenticApi>(`host`, {
            sandbox: unstubbed<IntenticApi[`sandbox`]>(`host.sandbox`, {
                readKey: (procedure: string) => [procedure, `sbx-1`],
                rpc: unstubbed<IntenticApi[`sandbox`][`rpc`]>(`host.sandbox.rpc`, {}),
                // SAFETY: the stub answers the one read this suite makes, so the spec it is handed is that read's, typed loosely.
                query: ((spec: SandboxQuerySpec<unknown, unknown>) => {
                    specs.push(spec);
                    return { query: { data: ref(answer) }, error: ref(undefined) };
                }) as IntenticApi[`sandbox`][`query`],
            }),
        }),
    );
    return specs;
};

describe(`usePlatformCatalog`, () => {
    it(`names each enabled extension's capability by its catalog entry, and skips a disabled one`, () => {
        const specs = bound({
            extensions: [
                { enabled: true, manifest: { contributes: { capabilities: [{ id: `x`, catalog: { name: `X`, logo: `x` } }] } } },
                { enabled: false, manifest: { contributes: { capabilities: [{ id: `reddit`, catalog: { name: `Reddit` } }] } } },
            ],
        });
        const catalog = usePlatformCatalog();
        expect([...catalog.value]).toEqual([[`x`, { name: `X`, logo: `x` }]]);
        expect(specs[0]?.queryKey).toEqual([`extensions.list`, `sbx-1`]);
        expect(Object.keys(specs[0] ?? {}).toSorted()).toEqual([`queryFn`, `queryKey`]);
    });
});
