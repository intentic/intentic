import { computed, inject, type InjectionKey, ref, watch } from "vue";
import { inSetup, provided } from "./inSetup";

const GREETING: InjectionKey<{ readonly name: () => string }> = Symbol(`greeting`);

describe("inSetup", () => {
    it("hands the composable what an ancestor would provide", () => {
        const { result } = inSetup(() => inject(GREETING)?.name(), { provides: [provided(GREETING, { name: () => `Ada` })] });
        expect(result).toBe(`Ada`);
    });

    it("installs plugins on the app before the composable runs", () => {
        const { result } = inSetup(() => inject<string>(`theme`), { plugins: [(app) => app.provide(`theme`, `dark`)] });
        expect(result).toBe(`dark`);
    });

    it("returns a composable's undefined as its result rather than as a refusal", () => {
        expect(inSetup(() => undefined).result).toBeUndefined();
    });

    it("stops every watcher the composable started", async () => {
        const source = ref(1);
        const seen: number[] = [];
        const { result, stop } = inSetup(() => {
            watch(source, (value) => seen.push(value), { flush: `sync` });
            return computed(() => source.value * 2);
        });
        source.value = 2;
        stop();
        source.value = 3;
        expect(seen).toEqual([2]);
        expect(result.value).toBe(6);
    });
});
