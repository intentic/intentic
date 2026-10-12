import type { IntenticApi, SandboxQuerySpec } from "@intentic/extension-api";
import { unstubbed } from "@intentic/testing";
import { ref } from "vue";
import { bindHost } from "./host";
import { usePersonas } from "./usePersonas";

// The persona picker reads the persona list through the host's own daemon-read wrapper, not a `useQuery` of its own: the
// host asks only while the sandbox answers, so the read states nothing about reachability itself, and it files the
// procedure's whole answer under the procedure's own key, narrowing it in `select` for this reader.

interface Call {
    readonly spec: SandboxQuerySpec<unknown, unknown>;
}

const bound = (answer: unknown) => {
    const calls: Call[] = [];
    const api = unstubbed<IntenticApi>(`host`, {
        sandbox: unstubbed<IntenticApi[`sandbox`]>(`host.sandbox`, {
            readKey: (procedure: string) => [procedure, `sbx-1`],
            rpc: unstubbed<IntenticApi[`sandbox`][`rpc`]>(`host.sandbox.rpc`, {}),
            // SAFETY: the stub answers the one read this suite makes, so the spec it is handed is that read's, typed loosely.
            query: ((spec: SandboxQuerySpec<unknown, unknown>) => {
                calls.push({ spec });
                // What the wrapper hands back: the entry as the procedure answered it, narrowed by this reader's `select`.
                const selected = spec.select === undefined ? answer : spec.select(answer);
                return { query: { data: ref(selected) }, error: ref(undefined) };
            }) as IntenticApi[`sandbox`][`query`],
        }),
    });
    bindHost(api);
    return calls;
};

describe(`usePersonas`, () => {
    it(`reads personas.list under its own key, with no gate of its own on the sandbox answering`, () => {
        const calls = bound({ personas: [{ id: `support`, label: `Support`, capabilities: [] }] });
        const { personas } = usePersonas();
        expect(personas.value).toEqual([{ id: `support`, label: `Support`, capabilities: [] }]);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.spec.queryKey).toEqual([`personas.list`, `sbx-1`]);
        expect(Object.keys(calls[0]?.spec ?? {}).toSorted()).toEqual([`queryFn`, `queryKey`, `select`]);
    });
});
