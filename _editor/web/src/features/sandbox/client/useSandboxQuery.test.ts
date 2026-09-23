// A failed read shows the daemon's message, or the version drift when this app's schema refused the answer.
import { waitFor } from "@intentic/testing/bun";
import { effectScope, type EffectScope } from "vue";
import { z } from "zod";
import { queryClient } from "../../../lib/queryPersistence";
import { useSandboxQuery } from "./useSandboxQuery";

let scope: EffectScope | undefined;
const failingRead = (key: string, fail: () => unknown) => {
    scope = effectScope();
    return scope.run(() => useSandboxQuery({ queryKey: [key], queryFn: async () => fail(), retry: false }, `sbx-1`))!;
};

afterEach(() => {
    scope?.stop();
    scope = undefined;
    queryClient.clear();
});

// The failure seen on a sandbox one release apart from the page: an extension kind this app's schema no longer lists.
const EXTENSION_KINDS = z.object({ kind: z.enum([`cli`, `browser`, `device`, `webext`, `agent`]) });

describe(`useSandboxQuery`, () => {
    it(`names the version drift when this app's schema refuses the daemon's answer`, async () => {
        const { error } = failingRead(`extensions`, () => EXTENSION_KINDS.parse({ kind: `service` }));
        await waitFor(() => expect(error.value).toEqual(expect.any(String)));
        expect(error.value).toStartWith(`This sandbox answered in a shape this app doesn't expect.`);
        expect(error.value).not.toContain(`invalid_value`);
    });

    it(`shows the daemon's own message for any other failure`, async () => {
        const { error } = failingRead(`settings`, () => {
            throw new Error(`The sandbox is restarting.`);
        });
        await waitFor(() => expect(error.value).toBe(`The sandbox is restarting.`));
    });
});
