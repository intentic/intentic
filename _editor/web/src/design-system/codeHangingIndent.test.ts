import "@intentic/testing/dom";
import { Code, Icon } from "@intentic/ui";
import { type App, createApp, h, nextTick } from "vue";

// A wrapped <Code> block hangs a wrapped line's rest under that line's own indent (code.css `--hang`): wrapped at the
// margin, the compose file the Environment card hands out lost its shape in a narrow column, every key's continuation
// starting where the top-level keys do.

const mounted: { app: App; host: HTMLElement }[] = [];
afterEach(() => {
    for (const { app, host } of mounted.splice(0)) {
        app.unmount();
        host.remove();
    }
});

const linesOf = async (props: { code: string; wrap?: boolean }): Promise<(string | undefined)[]> => {
    const host = document.createElement(`div`);
    document.body.append(host);
    const app = createApp({ render: () => h(Code, { ...props, lang: `yaml` }) });
    app.component(`Icon`, Icon);
    app.mount(host);
    mounted.push({ app, host });
    for (let i = 0; i < 80 && host.querySelector(`.shiki`) === null; i++) {
        await nextTick();
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return [...host.querySelectorAll<HTMLElement>(`.shiki .line`)].map((line) => line.style.getPropertyValue(`--hang`) || undefined);
};

const YAML = `build:\n    pull: true\n    dockerfile_inline: |\n\tRUN true\n\n        FROM base`;

it(`tags each line of a wrapped block with its indent, a tab to the next stop and a flush line left bare`, async () => {
    expect(await linesOf({ code: YAML, wrap: true })).toEqual([undefined, `4`, `4`, `8`, undefined, `8`]);
});

it(`leaves a block that scrolls instead of wrapping as Shiki drew it`, async () => {
    expect(await linesOf({ code: YAML })).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
});
