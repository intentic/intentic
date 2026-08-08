// @vitest-environment jsdom
//
// jsdom because the subject is WHAT A ROW SAYS. The tab drew a name, a reach and a badge, so a Windows laptop and
// a Linux desktop with no sync agent on either rendered as two identical lines — and the pair of rows in the
// report that prompted this were the same machine twice over. What is worth pinning is therefore not the
// derivation (computerFacts.test.ts has that) but that the row actually PUTS it on screen, next to the name, for a
// computer that has nothing else to show.
import type { Computer } from "@intentic/sandbox-contract";
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, ref } from "vue";

// What this component's import chain reads at module eval: the app's environment (the daemon client) and a media
// query (the UI barrel's useDevice). jsdom plus these two is the whole of it — see daemonRestart.test.ts, which
// cuts the same edge.
vi.hoisted(() => {
    globalThis.window.env ??= {
        production: false,
        api: { url: `http://localhost` },
        auth: { googleClientId: `` },
        analytics: { posthogKey: ``, posthogHost: `` },
    };
    globalThis.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof globalThis.matchMedia;
});

const computers = ref<Computer[]>([]);
vi.mock(`../../composables/sandbox/useComputers`, async () => {
    // reportStale is a plain function of the row and the clock — real, so a row's staleness line is decided the
    // way it is in the app rather than by this file's idea of it.
    const real = await import(`../../composables/sandbox/useComputers`);
    return {
        ...real,
        useComputers: () => ({ computers, error: ref(undefined), refetch: () => {} }),
    };
});
// `sandboxKey` is reached at module eval by the real useComputers above, which is why it is here as well as the
// one hook the component calls.
vi.mock(`../../composables/sandbox/useSandbox`, () => ({
    useSandbox: () => ({ daemonUrl: ref(undefined) }),
    sandboxKey: (name: string) => [name],
}));
// The two cards below the list have their own daemon calls; this mounts the list and nothing else.
vi.mock(`./DesktopSyncCard.vue`, () => ({ default: defineComponent({ render: () => null }) }));
vi.mock(`./BridgeTokensCard.vue`, () => ({ default: defineComponent({ render: () => null }) }));
vi.mock(`vue-router`, () => ({ useRoute: () => ({ query: {} }) }));

const { default: SandboxComputers } = await import("./SandboxComputers.vue");

let app: App | undefined;
const mount = (rows: Computer[]): HTMLElement => {
    computers.value = rows;
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(SandboxComputers) });
    app.component(`Icon`, defineComponent({ props: { name: String }, render: () => h(`i`) }));
    app.directive(`tooltip`, {});
    app.mount(el);
    return el;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

/* The row from the report: a connected computer, reachable, with no sync agent on it — so no report, and before
 * this nothing but its name. Everything asserted here was already known to the daemon while the row said none of
 * it. */
it(`says what a computer is when it has no report to show`, () => {
    const el = mount([
        {
            key: `radarsu-rog`,
            label: `radarsu-rog`,
            syncEnrolled: false,
            hostId: `radarsu-rog`,
            online: true,
            platform: `windows`,
            facts: {
                os: `Windows 11 Pro (build 10.0.26100)`,
                arch: `x64`,
                shell: `PowerShell 7`,
                home: `C:\\Users\\ada`,
                roots: [`C:\\Users\\ada`],
            },
            hostAgent: `0.5.1`,
            gap: `no-agent`,
        },
    ]);
    const text = el.textContent ?? ``;
    expect(text).toContain(`Windows 11 Pro`);
    expect(text).toContain(`x64`);
    expect(text).toContain(`PowerShell 7`);
    expect(text).toContain(`computer agent 0.5.1`);
    // The gap it had before is still said, because the OS does not answer it: this machine still has no agent.
    expect(text).toContain(`no sync agent`);
});

// A machine that never described itself still has to answer "Windows or Linux?" — the card it was added with says
// so, and that is true from the moment it is added and while it is asleep.
it(`falls back to the platform, and ages a computer that is not here`, () => {
    const el = mount([
        {
            key: `linux`,
            label: `linux`,
            syncEnrolled: false,
            hostId: `linux`,
            online: false,
            platform: `linux`,
            lastSeen: Date.now() - 3 * 60 * 60_000,
            gap: `offline`,
        },
    ]);
    const text = el.textContent ?? ``;
    expect(text).toContain(`Linux`);
    expect(text).toContain(`last seen 3h ago`);
});

// The image is what Update changes, and one sandbox on a machine running something older than its neighbour was
// invisible on a list that named only the container.
it(`names the image each sandbox on the machine is running`, () => {
    const el = mount([
        {
            key: `laptop`,
            label: `laptop`,
            syncEnrolled: true,
            platform: `linux`,
            report: {
                hostname: `laptop`,
                os: `linux`,
                agents: { sync: `0.1.0` },
                sandboxes: [{ slug: `work`, container: `intentic-sandbox-work`, running: true, image: `ghcr.io/intentic/sandbox:2.3.1` }],
                pairings: [],
                ports: [],
                watcher: { running: true },
                capturedAt: Date.now(),
            },
        },
    ]);
    expect(el.textContent ?? ``).toContain(`ghcr.io/intentic/sandbox:2.3.1`);
});
