import type { IntenticApi } from "@intentic/extension-api";
import { unstubbed } from "@intentic/testing";
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { createApp, effectScope, ref } from "vue";
import { bindHost } from "./host.js";
import { useRefRefresh } from "./useRefRefresh.js";

test("an unnamed refs batch refreshes the open repository after reconnect", () => {
    let changed: (repos: readonly string[]) => void = () => undefined;
    const dispose = jest.fn();
    bindHost(
        unstubbed<IntenticApi>("host", {
            sandbox: unstubbed<IntenticApi["sandbox"]>("sandbox", { key: (...parts: unknown[]) => [...parts, "sandbox"] }),
            workspace: unstubbed<IntenticApi["workspace"]>("workspace", {
                onDidChangeRefs: (listener) => {
                    changed = listener;
                    return { dispose };
                },
            }),
        }),
    );
    const client = new QueryClient();
    const invalidate = jest.spyOn(client, "invalidateQueries").mockResolvedValue();
    const app = createApp({});
    app.use(VueQueryPlugin, { queryClient: client });
    const scope = effectScope();
    try {
        app.runWithContext(() => scope.run(() => useRefRefresh(ref("repo"), ["log"])));
        changed([]);
        expect(invalidate).toHaveBeenCalledWith({ queryKey: ["git-history", "log", "repo", "sandbox"] });
        invalidate.mockClear();
        changed(["other"]);
        expect(invalidate).toHaveBeenCalledTimes(0);
    } finally {
        scope.stop();
        client.clear();
    }
    expect(dispose).toHaveBeenCalledTimes(1);
});
