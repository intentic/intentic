import "@intentic/testing/dom";
import { IconStub } from "@intentic/ui/testing";
import PrimeVue from "primevue/config";
import { createApp, h, nextTick, ref } from "vue";
import type { LocalAgentsHost } from "../../app/environments/localHost";

// The one screen before an agent runs on this computer: it says what a sandbox would have contained, and nothing is
// turned on until the reader presses the one button, whose yes is the app's to keep.

const { default: LocalAgentsConsent } = await import("./LocalAgentsConsent.vue");

const hostOf = (accept: () => Promise<void>): LocalAgentsHost => ({
    accepted: ref(false),
    running: ref(0),
    follow: async () => undefined,
    accept,
    takeDraft: async () => undefined,
    onDraft: () => () => undefined,
});

const mount = async (host: LocalAgentsHost | undefined) => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const app = createApp({ render: () => h(LocalAgentsConsent, { host }) });
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    await nextTick();
    return {
        el,
        unmount: () => {
            app.unmount();
            el.remove();
        },
    };
};

describe(`the consent before an agent runs on this computer`, () => {
    it(`says it is not sandboxed and asks, turning nothing on by itself`, async () => {
        const accept = jest.fn(async () => undefined);
        const { el, unmount } = await mount(hostOf(accept));
        expect(el.textContent).toContain(`This computer · not sandboxed`);
        expect(el.textContent).toContain(`Run an agent on this computer?`);
        expect(el.textContent).toContain(`It asks before it acts, except for what the agent's own settings on this computer already allow.`);
        expect(accept).not.toHaveBeenCalled();
        unmount();
    });

    it(`hands the reader's yes to the app on the one press`, async () => {
        const accept = jest.fn(async () => undefined);
        const { el, unmount } = await mount(hostOf(accept));
        const press = [...el.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Turn on agents for this computer`));
        press?.click();
        await nextTick();
        expect(accept).toHaveBeenCalledTimes(1);
        unmount();
    });

    it(`shows why when the app could not keep the yes`, async () => {
        const { el, unmount } = await mount(
            hostOf(async () => {
                throw new Error(`The app could not save that.`);
            }),
        );
        [...el.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Turn on agents`))?.click();
        await nextTick();
        await nextTick();
        expect(el.textContent).toContain(`The app could not save that.`);
        unmount();
    });

    it(`offers no press where no app stands behind the page`, async () => {
        const { el, unmount } = await mount(undefined);
        expect(el.textContent).toContain(`Agents can be turned on from the Intentic desktop app only.`);
        expect([...el.querySelectorAll(`button`)].some((button) => button.textContent?.includes(`Turn on agents`))).toBe(false);
        unmount();
    });
});
