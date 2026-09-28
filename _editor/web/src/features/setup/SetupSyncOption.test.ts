import "@intentic/testing/dom";
import { IconStub } from "@intentic/ui/testing";
import PrimeVue from "primevue/config";
import { createApp, h } from "vue";
import SetupSyncOption from "./SetupSyncOption.vue";

// The sync slot beside the run step: a switch for the folder desktop sync would make up for /work, or, for a project
// setup, the folder the reader picked in the app, stated rather than offered, since it is why the sandbox exists.

const render = (props: { readonly folder?: string; readonly project?: string }) => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const app = createApp({ render: () => h(SetupSyncOption, { ...props, modelValue: true }) });
    app.use(PrimeVue);
    app.component(`Icon`, IconStub);
    app.mount(el);
    const seen = {
        text: el.textContent ?? ``,
        folder: el.querySelector(`code`)?.textContent,
        switches: el.querySelectorAll(`input[type="checkbox"]`).length,
    };
    app.unmount();
    el.remove();
    return seen;
};

it(`states the folder a project setup is for, with no switch to turn it off`, () => {
    const seen = render({ project: `My App`, folder: `~/intentic/my-app-7` });
    expect(seen.text).toContain(`Syncs live with the folder you picked`);
    expect({ folder: seen.folder, switches: seen.switches }).toEqual({ folder: `My App`, switches: 0 });
});

it(`offers the folder it would make up otherwise, behind a switch`, () => {
    const seen = render({ folder: `~/intentic/workspace-7` });
    expect(seen.text).toContain(`Also sync a local folder`);
    expect({ folder: seen.folder, switches: seen.switches }).toEqual({ folder: `~/intentic/workspace-7`, switches: 1 });
});
