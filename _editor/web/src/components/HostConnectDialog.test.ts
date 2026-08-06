// @vitest-environment jsdom
//
// The command in this dialog is the one command in the app that is READ here and PASTED somewhere else. A local
// dev build renders every script by repo path, which is right everywhere else and wrong here: the computer being
// connected is a second machine, and the checkout is not on it. So the dialog carries the switch, and what is
// pinned is that flipping it actually rewrites the line the user copies.
import PrimeVue from "primevue/config";
import { expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick, ref } from "vue";

vi.hoisted(() => {
    globalThis.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof globalThis.matchMedia;
    globalThis.window.env ??= {
        production: false,
        api: { url: `http://localhost` },
        auth: { googleClientId: `` },
        analytics: { posthogKey: ``, posthogHost: `` },
    };
});

// The two things the composable reads from a live sandbox: where it is, and a pairing token minted for the
// capability. Everything else about the command is built here, which is what this test is about.
vi.mock(`../composables/sandbox/useSandbox`, () => ({ useSandbox: () => ({ daemonUrl: ref(`https://sandbox-abc.intentic.dev`) }) }));
vi.mock(`../composables/sandbox/sandboxClient`, () => ({
    sandboxRequest: vi.fn(async () => ({ ok: true, json: async () => ({ token: `pair-token`, hosts: [] }) })),
}));

const { default: HostConnectDialog } = await import("./HostConnectDialog.vue");
const { scriptSource } = await import("../environments/scriptCommand");

/* PrimeVue's Dialog teleports to the body, so the dialog's own content is never under the mount point.
 * `visible` starts FALSE and is flipped, which is not ceremony: minting hangs off the transition, exactly as
 * on the card — a dialog that was born open never asks for a token, and would sit on "Preparing…" forever. */
const mount = (): { open: () => void } => {
    const el = document.createElement(`div`);
    document.body.append(el);
    const visible = ref(false);
    const app = createApp({
        render: () => h(HostConnectDialog, { visible: visible.value, id: `my-desktop`, platform: `linux`, permissions: `run commands` }),
    });
    app.component(
        `Icon`,
        defineComponent({
            props: { name: String, spin: Boolean },
            render() {
                return h(`i`, { "data-icon": this.name });
            },
        }),
    );
    app.directive(`tooltip`, {});
    // PrimeVue's Dialog reads its own config off the plugin; without it the header fails to render at all.
    // The bare plugin, not installUi — the theme preset and the bundled icon sets are not what is on trial.
    app.use(PrimeVue);
    app.mount(el);
    return {
        open: () => {
            visible.value = true;
        },
    };
};

const pill = (label: string): HTMLButtonElement =>
    [...document.body.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === label)!;

it(`rewrites the command between the working-tree script and the released one`, async () => {
    document.body.innerHTML = ``;
    scriptSource.value = `checkout`;
    mount().open();

    // The token is minted on open, so the command only exists after that round trip.
    await vi.waitFor(() => expect(document.body.textContent).toContain(`PAIR_TOKEN='pair-token'`));
    expect(document.body.textContent).toContain(`sh _site/site/public/scripts/computer.sh`);

    pill(`Standard`).click();
    await nextTick();

    // Same env, fetched delivery — the form that runs on a machine that has never seen the repo.
    expect(document.body.textContent).toContain(`curl -fsSL https://intentic.dev/computer |`);
    expect(document.body.textContent).toContain(`PAIR_TOKEN='pair-token'`);
    expect(document.body.textContent).not.toContain(`_site/site/public/scripts/computer.sh`);
});
