import { callsByOwner, ownerOf, type ScriptCoverage } from "./coverage.js";

const origin = "http://127.0.0.1:47201";
const script = (url: string, ...counts: number[]): ScriptCoverage => ({ url, functions: counts.map((count) => ({ ranges: [{ count }] })) });

describe("ownerOf", () => {
    it("reads workspace source served through /@fs as the app, wherever the repo is checked out", () => {
        expect(ownerOf(`${origin}/demo/@fs/work/intentic/_editor/web/src/features/chat/panel/ChatPane.vue?t=1`)).toBe("app");
        expect(ownerOf(`${origin}/demo/@fs/home/ada/src/intentic/_editor/ui/src/composables/useNow.ts`)).toBe("app");
    });

    it("reads pre-bundled packages, linked packages' node_modules and Vite's virtual modules as dependencies", () => {
        expect(ownerOf(`${origin}/demo/node_modules/.vite/deps/vue.runtime.esm-bundler-DUq4i4wk.js?v=b2c60b38`)).toBe("dependency");
        expect(ownerOf(`${origin}/demo/@fs/work/intentic/node_modules/.pnpm/zod@4.5.4/node_modules/zod/index.js`)).toBe("dependency");
        expect(ownerOf(`${origin}/demo/@id/__x00__plugin-vue:export-helper`)).toBe("dependency");
        expect(ownerOf(`${origin}/demo/ext-shims/vue.js`)).toBe("dependency");
    });

    it("reads the demo's fake platform and daemon as the fixture, root-relative or through /@fs", () => {
        expect(ownerOf(`${origin}/demo/src/daemon.ts`)).toBe("fixture");
        expect(ownerOf(`${origin}/demo/vendor/knowledge/notes/index.ts`)).toBe("fixture");
        expect(ownerOf(`${origin}/demo/@fs/work/intentic/_site/demo/src/fixture/fleet.ts`)).toBe("fixture");
    });

    it("reads Playwright's own scripts and Vite's client as the harness", () => {
        expect(ownerOf("")).toBe("harness");
        expect(ownerOf("__playwright_evaluation_script__")).toBe("harness");
        expect(ownerOf(`${origin}/demo/@vite/client`)).toBe("harness");
    });
});

describe("callsByOwner", () => {
    it("sums every function's invocations per owner, a function never called adding nothing", () => {
        const calls = callsByOwner([
            script(`${origin}/demo/@fs/work/intentic/_editor/web/src/main.ts`, 1, 40, 0),
            script(`${origin}/demo/node_modules/.vite/deps/vue.js`, 300, 2),
            script(`${origin}/demo/src/daemon.ts`, 7),
            script("", 9000),
        ]);
        expect(calls).toEqual({ app: 41, dependency: 302, fixture: 7, harness: 9000 });
    });

    it("counts a function reported without ranges as uncalled", () => {
        expect(callsByOwner([{ url: `${origin}/demo/src/main.ts`, functions: [{ ranges: [] }] }]).fixture).toBe(0);
    });
});
