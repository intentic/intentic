import "@intentic/testing/dom";
import { Code, Icon } from "@intentic/ui";
import { type App, createApp, h, nextTick, ref } from "vue";

describe("Code scrollBottom", () => {
    const mounted: { app: App; host: HTMLElement }[] = [];
    let box: { top: number; height: number };

    beforeEach(() => {
        box = { top: 0, height: 1000 };
        Object.defineProperty(HTMLPreElement.prototype, "scrollHeight", {
            configurable: true,
            get() {
                return box.height;
            },
        });
        Object.defineProperty(HTMLPreElement.prototype, "scrollTop", {
            configurable: true,
            get() {
                return box.top;
            },
            set(v: number) {
                box.top = v;
            },
        });
    });

    afterEach(() => {
        for (const { app, host } of mounted.splice(0)) {
            app.unmount();
            host.remove();
        }
    });

    const mount = async (props: { code: string; scrollLines?: number; scrollBottom?: boolean }): Promise<HTMLElement> => {
        const host = document.createElement("div");
        document.body.append(host);
        const app = createApp({ render: () => h(Code, props) });
        app.component("Icon", Icon);
        app.mount(host);
        mounted.push({ app, host });
        await nextTick();
        return host;
    };

    it("scrolls to bottom when scrollBottom is true", async () => {
        await mount({ code: "log line 1\nlog line 2", scrollLines: 14, scrollBottom: true });
        await nextTick();
        expect(box.top).toBe(1000);
    });

    it("leaves scrollTop at 0 when scrollBottom is not enabled", async () => {
        await mount({ code: "log line 1\nlog line 2", scrollLines: 14 });
        await nextTick();
        expect(box.top).toBe(0);
    });

    it("scrolls to bottom after shiki replaces the fallback pre", async () => {
        const host = document.createElement("div");
        document.body.append(host);
        const app = createApp({
            render: () => h(Code, { code: `log line 1\nlog line 2\nlog line 3`, lang: `log`, scrollLines: 14, scrollBottom: true }),
        });
        app.component("Icon", Icon);
        app.mount(host);
        mounted.push({ app, host });
        for (let i = 0; i < 40 && box.top !== 1000; i++) {
            await nextTick();
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(box.top).toBe(1000);
    });

    it("scrolls to bottom when code updates on scrollBottom block", async () => {
        const codeRef = ref("log line 1");
        const host = document.createElement("div");
        document.body.append(host);
        const app = createApp({ render: () => h(Code, { code: codeRef.value, scrollLines: 14, scrollBottom: true }) });
        app.component("Icon", Icon);
        app.mount(host);
        mounted.push({ app, host });
        await nextTick();
        expect(box.top).toBe(1000);

        box.top = 100;
        box.height = 2000;
        codeRef.value = "log line 1\nlog line 2\nlog line 3";
        await nextTick();
        await nextTick();
        expect(box.top).toBe(2000);
    });
});
