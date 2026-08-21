import type { IntenticApi } from "@intentic/extension-api";
import { type PanelSummary, PanelsListSchema } from "@intentic/sandbox-contract";
import { QueryClient, VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, effectScope, nextTick, ref } from "vue";
import { bindHost } from "./host";
import { aimOf, useTargets } from "./useTargets";

/* THE DISTINCTION THIS SUITE EXISTS FOR: `running` means the daemon spawned the dev server's tmux session,
 * `servers` is what actually answered. The command behind a start installs dependencies first, so the gap between
 * them is routinely minutes. A surface that treats `running` as "serving" hides its Start button, reports
 * success, and points a fan-out of agent sessions at a socket nobody is listening on.
 *
 * And the second distinction, which the first one's fix exposed: a repo serving THREE apps has no single address,
 * so the repo answers for no group until each says which app it walks. */

// Every field the contract requires, so the parse below is a real check rather than a shape this file invented.
const panel = (over: Partial<PanelSummary> & { repo: string }): PanelSummary => ({
    hasPanel: true,
    running: false,
    healthy: false,
    servers: [],
    deployConfig: false,
    desiredState: false,
    directoryUi: false,
    monorepo: false,
    vitest: false,
    userStories: true,
    docs: false,
    ...over,
});

// The intentic repo as the daemon reports it: one `pnpm dev`, a turbo fan-out, three pinned ports and two
// schemes. The case that made the panel spin "Starting…" forever, and, in its sessions, the three ways an
// address comes to be occupied: the panel the daemon started, something outside this sandbox's terminals, and a
// dev server someone launched in a terminal of their own.
const MONOREPO = [
    { url: `https://localhost:47145`, dir: `_editor/web`, session: `panel-intentic` },
    { url: `https://localhost:6480`, dir: `_platform/api` },
    { url: `http://localhost:4321`, dir: `_site/site`, session: `web-3f2a` },
];

const hostFor = (panels: readonly PanelSummary[]): IntenticApi =>
    ({
        sandbox: {
            key: (...parts: readonly string[]) => [`sandbox`, ...parts],
            reachable: () => true,
            json: async (path: string) => {
                if (path !== `/panels`) {
                    throw new Error(`404 ${path}`);
                }
                return PanelsListSchema.parse({ panels });
            },
            request: async () => new Response(),
            origin: () => undefined,
        },
        workspace: { repos: () => [], capabilities: () => [], onDidChange: () => ({ dispose: () => {} }) },
    }) as unknown as IntenticApi;

const scopes: { stop: () => void }[] = [];
afterEach(() => {
    while (scopes.length > 0) {
        scopes.pop()?.stop();
    }
});

const read = async (panels: readonly PanelSummary[], remembered: Readonly<Record<string, string>> = {}): Promise<ReturnType<typeof useTargets>> => {
    bindHost(hostFor(panels));
    const app = createApp({});
    app.use(VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) });
    const scope = effectScope();
    const result = scope.run(() => app.runWithContext(() => useTargets(ref(remembered))));
    if (result === undefined) {
        throw new Error(`the composable returned nothing`);
    }
    scopes.push(scope);
    for (let tick = 0; tick < 100 && result.isLoading.value; tick += 1) {
        await nextTick();
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(result.isLoading.value, `the query never settled`).toBe(false);
    return result;
};

describe(`useTargets`, () => {
    it(`reads a spawned-but-unanswering dev server as starting, and offers no address for it`, async () => {
        const { stateOf, localUrl } = await read([panel({ repo: `app`, running: true, healthy: false, port: 5173 })]);

        expect(stateOf(`app`)).toBe(`starting`);
        // The gate. A port that exists but does not answer is not somewhere to send five agent sessions.
        expect(localUrl(`app`)).toBeUndefined();
    });

    it(`offers the loopback address only once something actually answers`, async () => {
        const { stateOf, localUrl } = await read([
            panel({ repo: `app`, running: true, healthy: true, port: 5173, servers: [{ url: `http://localhost:5173` }] }),
        ]);

        expect(stateOf(`app`)).toBe(`ready`);
        expect(localUrl(`app`)).toBe(`http://localhost:5173`);
    });

    /* THE PORT THE DAEMON ASSIGNED IS NOT THE PORT THE APP BOUND. A repo that pins its own ports: a committed
     * dev cert's origin, a CORS allowlist, an OAuth client's authorized redirect: ignores the injected PORT, so
     * the address comes from what the daemon FOUND listening, scheme and all. */
    it(`takes the address from what is serving, not from the port the daemon handed out`, async () => {
        const { stateOf, localUrl } = await read([
            panel({ repo: `app`, running: true, healthy: true, port: 39481, servers: [{ url: `https://localhost:47145`, dir: `_editor/web` }] }),
        ]);

        expect(stateOf(`app`)).toBe(`ready`);
        expect(localUrl(`app`)).toBe(`https://localhost:47145`);
    });

    // A dev server someone started in their own terminal is exactly as walkable, and offering Start for it would
    // collide on the very ports it pinned.
    it(`counts a dev server the daemon never spawned as ready`, async () => {
        const { stateOf, localUrl } = await read([panel({ repo: `app`, running: false, servers: [{ url: `http://localhost:5173` }] })]);

        expect(stateOf(`app`)).toBe(`ready`);
        expect(localUrl(`app`)).toBe(`http://localhost:5173`);
    });

    /* WHICH TERMINAL TO OPEN, which is a different question from "is it up" and used to be answered by guessing
     * `panel-<repo>`: the session a Start WOULD have made. For a dev server started by hand that session has
     * never existed, so the terminals panel opened onto an empty strip. */
    it(`opens the terminal a lone dev server is actually served from, and offers none when it has one`, async () => {
        const byHand = await read([panel({ repo: `app`, running: false, servers: [{ url: `http://localhost:5173`, session: `web-3f2a` }] })]);
        expect(byHand.terminalOf(`app`)).toBe(`web-3f2a`);

        // Answering from outside this sandbox's terminals: green, walkable, and nothing to open.
        const outside = await read([panel({ repo: `app`, running: false, servers: [{ url: `http://localhost:5173` }] })]);
        expect(outside.stateOf(`app`)).toBe(`ready`);
        expect(outside.terminalOf(`app`)).toBeUndefined();

        // Several servers have no ONE terminal either: each row in the popover carries its own.
        const monorepo = await read([panel({ repo: `intentic`, running: true, healthy: true, servers: MONOREPO })]);
        expect(monorepo.terminalOf(`intentic`)).toBeUndefined();
        expect(monorepo.serversOf(`intentic`).map((server) => server.session)).toEqual([`panel-intentic`, undefined, `web-3f2a`]);
    });

    it(`never falls back to the preview URL: a stopped panel answers it with a 502`, async () => {
        const stopped = await read([panel({ repo: `app`, running: false, previewUrl: `https://preview-app-abc.example.dev` })]);
        expect(stopped.stateOf(`app`)).toBe(`stopped`);
        expect(stopped.localUrl(`app`)).toBeUndefined();

        // Still booting behind the tunnel is the same 502, and the same non-answer.
        const starting = await read([panel({ repo: `app`, running: true, healthy: false, previewUrl: `https://preview-app-abc.example.dev` })]);
        expect(starting.localUrl(`app`)).toBeUndefined();
    });

    /* THE CASE THAT BLOCKED A REAL RUN. Three apps behind one `pnpm dev`: the repo is plainly up, and there is
     * still no address to give a group until it says which app its stories belong to. */
    it(`gives a repo serving several apps no repo-level address, and lets each group pick one`, async () => {
        const targets = await read([panel({ repo: `intentic`, running: true, healthy: true, servers: MONOREPO })]);

        expect(targets.stateOf(`intentic`)).toBe(`ready`);
        expect(targets.serversOf(`intentic`)).toHaveLength(3);
        // No guess at which of the three a group meant: the gate holds until someone says.
        expect(targets.localUrl(`intentic`)).toBeUndefined();
        expect(targets.addressOf(`intentic`, `01-arrive`)).toBeUndefined();

        targets.aimAt(`intentic`, `01-arrive`, `http://localhost:4321`);
        targets.aimAt(`intentic`, `02-setup`, `https://localhost:47145`);
        expect(targets.addressOf(`intentic`, `01-arrive`)).toBe(`http://localhost:4321`);
        expect(targets.addressOf(`intentic`, `02-setup`)).toBe(`https://localhost:47145`);
    });

    // Picked once, not once per run: the address rides the run manifests back as `remembered`, and a loopback
    // memory that is still one of the repo's live servers is a pick, not the stale port the gate guards against.
    it(`keeps a group aimed at the app it was last run against, across a restart of the dev server`, async () => {
        const targets = await read([panel({ repo: `intentic`, running: true, healthy: true, servers: MONOREPO })], {
            "intentic/01-arrive": `http://localhost:4321`,
        });

        expect(targets.addressOf(`intentic`, `01-arrive`)).toBe(`http://localhost:4321`);
        // And a memory whose port is no longer among them is a dead socket, not a pick.
        const moved = await read([panel({ repo: `intentic`, running: true, healthy: true, servers: [MONOREPO[0]!, MONOREPO[1]!] })], {
            "intentic/01-arrive": `http://localhost:4321`,
        });
        expect(moved.addressOf(`intentic`, `01-arrive`)).toBeUndefined();
    });

    /* THE RUN THIS FIX IS NAMED AFTER. `pnpm dev` fans out and the apps come up seconds apart, so a window exists
     * in which the intentic repo is serving exactly one thing: the web app, and the marketing group has no
     * memory yet. Inheriting the only address up made the run legal, and a fan-out walked the landing page's
     * stories through the app's sign-in screen; the manifest then remembered that address as if someone had
     * chosen it. A package's dev server is one app of several however alone it is at that instant. */
    it(`refuses to hand a group the one app that happens to be up while the rest of the repo boots`, async () => {
        const booting = await read([panel({ repo: `intentic`, running: true, healthy: true, servers: [MONOREPO[0]!] })]);

        expect(booting.stateOf(`intentic`)).toBe(`ready`);
        expect(booting.addressOf(`intentic`, `01-arrive`)).toBeUndefined();
        // And the row says so, because the pick that unblocks it lives there.
        expect(booting.needsAddress(`intentic`, `01-arrive`)).toBe(true);

        // The site's own server arriving is what the group was waiting for: still its own choice to state.
        const up = await read([panel({ repo: `intentic`, running: true, healthy: true, servers: MONOREPO })]);
        up.aimAt(`intentic`, `01-arrive`, `http://localhost:4321`);
        expect(up.addressOf(`intentic`, `01-arrive`)).toBe(`http://localhost:4321`);
    });

    it(`reports a repo the daemon runs nothing for as having no dev server at all`, async () => {
        const { stateOf, localUrl } = await read([panel({ repo: `docs`, hasPanel: false })]);

        // This one's groups show an address field rather than a dot: free text is the genuine answer here.
        expect(stateOf(`docs`)).toBe(`none`);
        expect(localUrl(`docs`)).toBeUndefined();
    });

    it(`reports an unknown repo as having no dev server rather than throwing`, async () => {
        const { stateOf } = await read([]);

        expect(stateOf(`nothing-here`)).toBe(`none`);
    });

    /* One repository, two applications: a monorepo's marketing site and its web app are two ports behind one
     * `pnpm dev`, and the story GROUP is the only thing in the tree that says which is which. So the dev server
     * is shared and the addresses are not, which is what the list draws as one chip on the repo's heading and a
     * second one on the group's row. */
    it(`aims each of a repo's groups separately while they share its one dev server`, async () => {
        const targets = await read([panel({ repo: `site`, running: true, healthy: true, servers: [{ url: `http://localhost:5173` }] })], {
            "site/marketing": `https://staging.example.dev`,
        });

        expect(targets.addressOf(`site`, `app`)).toBe(`http://localhost:5173`);
        expect(targets.isElsewhere(`site`, `app`)).toBe(false);
        expect(targets.addressOf(`site`, `marketing`)).toBe(`https://staging.example.dev`);
        expect(targets.isElsewhere(`site`, `marketing`)).toBe(true);
    });

    /* WHAT THE GROUP'S ROW HAS TO SAY OUT LOUD. The chip is quiet by default, so this predicate is the whole
     * difference between "the run refuses and the fix is one click away" and the failure it was reported as:
     * everything green, Run dead, and the control that unblocks it invisible until hovered. */
    it(`tells a group serving several apps that it needs an address, and stops once it has one`, async () => {
        const targets = await read([panel({ repo: `intentic`, running: true, healthy: true, servers: MONOREPO })]);

        expect(targets.needsAddress(`intentic`, `01-arrive`)).toBe(true);
        targets.aimAt(`intentic`, `01-arrive`, `http://localhost:4321`);
        expect(targets.needsAddress(`intentic`, `01-arrive`)).toBe(false);
    });

    // The alarm belongs where the remedy is, and the remedy for these two is Start, on the heading.
    it(`says nothing about a group whose repo is merely stopped or still starting`, async () => {
        const stopped = await read([panel({ repo: `app`, running: false })]);
        expect(stopped.needsAddress(`app`, `checkout`)).toBe(false);

        const starting = await read([panel({ repo: `app`, running: true, healthy: false, port: 5173 })]);
        expect(starting.needsAddress(`app`, `checkout`)).toBe(false);
    });

    // A repo the daemon runs nothing for has no Start to offer, so the address really is this row's to give.
    it(`asks for an address on a repo with no dev server, until one is remembered`, async () => {
        const bare = await read([panel({ repo: `docs`, hasPanel: false })]);
        expect(bare.needsAddress(`docs`, `guides`)).toBe(true);

        const known = await read([panel({ repo: `docs`, hasPanel: false })], { "docs/guides": `https://staging.example.dev` });
        expect(known.needsAddress(`docs`, `guides`)).toBe(false);
    });

    // The ordinary repo: one dev server, every group inheriting it, nothing to state.
    it(`asks for nothing while the repo's own dev server answers for the group`, async () => {
        const targets = await read([panel({ repo: `app`, running: true, healthy: true, servers: [{ url: `http://localhost:5173` }] })]);

        expect(targets.needsAddress(`app`, `checkout`)).toBe(false);
    });

    it(`hands a group back to the dev server when its typed address is cleared`, async () => {
        const targets = await read([panel({ repo: `app`, running: true, healthy: true, servers: [{ url: `http://localhost:5173` }] })]);

        targets.aimAt(`app`, ``, `https://preview.example.dev`);
        expect(targets.addressOf(`app`, ``)).toBe(`https://preview.example.dev`);

        // Emptying the field is a real answer: nowhere, and the run says so rather than quietly re-aiming.
        targets.aimAt(`app`, ``, ``);
        expect(targets.addressOf(`app`, ``)).toBeUndefined();

        targets.aimAt(`app`, ``, undefined);
        expect(targets.addressOf(`app`, ``)).toBe(`http://localhost:5173`);
    });
});

/* WHERE A GROUP AIMS: the rule the whole surface is built on, and the one that decides whether a run is allowed
 * to spend an agent session per story. Tested against the pure function rather than through the query, because
 * every interesting case is a combination of four inputs and none of them is about HTTP. */
describe(`aimOf`, () => {
    // The ordinary repo: one dev server, bound at the repo root, which is why it carries no package `dir`. That
    // absence is load-bearing: it is what makes this address the REPO's rather than one app's.
    const ONE = [{ url: `http://localhost:5173` }];
    const THREE = MONOREPO;
    // The same monorepo caught mid-boot: `pnpm dev` has brought the web app up and the other two are still
    // compiling. One address, and still no answer to "which app does this group walk".
    const ONE_OF_THREE = [MONOREPO[0]!];

    it(`sends a group at its repo's dev server, which is what almost every group means`, () => {
        expect(aimOf({ typed: undefined, remembered: undefined, state: `ready`, servers: ONE })).toBe(`http://localhost:5173`);
    });

    it(`offers nothing while that server is stopped or still starting: the gate the run waits on`, () => {
        expect(aimOf({ typed: undefined, remembered: undefined, state: `stopped`, servers: [] })).toBeUndefined();
        expect(aimOf({ typed: undefined, remembered: undefined, state: `starting`, servers: [] })).toBeUndefined();
    });

    // Three answering apps are three answers, and the rule refuses to invent one. The cost of guessing is a
    // fan-out of agent sessions walking marketing stories through the app's sign-in screen.
    it(`refuses to choose for a repo serving several apps, however plainly up it is`, () => {
        expect(aimOf({ typed: undefined, remembered: undefined, state: `ready`, servers: THREE })).toBeUndefined();
    });

    /* AND REFUSES JUST AS FLATLY WHEN ONLY ONE OF THEM HAS FINISHED BOOTING, which is the failure this rule was
     * rewritten for. `_editor/web` answering alone is not "the repo's address": it is the first app up out of a
     * turbo fan-out, and a marketing group that inherits it walks a sign-in screen looking for a landing page.
     * The package `dir` is the whole difference: a server bound at the repo ROOT is the repo and every group takes
     * it; a server a package bound is one app, and one app is never the answer to "which app". */
    it(`refuses the one app that is up while its siblings are still compiling`, () => {
        expect(aimOf({ typed: undefined, remembered: undefined, state: `ready`, servers: ONE_OF_THREE })).toBeUndefined();
        // Same instant, same single address, no `dir`: an ordinary repo, and its group inherits without asking.
        expect(aimOf({ typed: undefined, remembered: undefined, state: `ready`, servers: ONE })).toBe(`http://localhost:5173`);
    });

    /* THE BUG THIS RULE EXISTS TO CLOSE. The old derivation compared the remembered address against the repo's
     * single address, which is undefined precisely when the server is down, so a remembered
     * `http://localhost:5173` "differed from" nothing, was read as a deliberate elsewhere, and let a fan-out be
     * aimed at a dead port. */
    it(`does not resurrect a remembered loopback address once its dev server has stopped`, () => {
        expect(aimOf({ typed: undefined, remembered: `http://localhost:5173`, state: `stopped`, servers: [] })).toBeUndefined();
        expect(aimOf({ typed: undefined, remembered: `http://127.0.0.1:5173`, state: `starting`, servers: [] })).toBeUndefined();
    });

    // …but a loopback memory that is STILL being served names one of this repo's apps, which is a pick worth
    // keeping. Without this, a monorepo's groups would have to be re-aimed every single run.
    it(`keeps a remembered loopback address while it is still one of the repo's servers`, () => {
        expect(aimOf({ typed: undefined, remembered: `http://localhost:4321`, state: `ready`, servers: THREE })).toBe(`http://localhost:4321`);
        // A repo whose ONE server moved port is the same app at a new number, so the memory's death costs nothing.
        expect(aimOf({ typed: undefined, remembered: `http://localhost:5199`, state: `ready`, servers: ONE })).toBe(`http://localhost:5173`);
    });

    /* WHAT A DEAD MEMORY MUST NEVER BECOME: a different app. The marketing group was remembered at the site's own
     * port, that port went away, and the rule handed it the only address left: the web app's, which reads as a
     * deliberate aim ever after, because the run manifests are the memory. A group that was aimed once is not the
     * repo's to re-aim; with nothing safe to offer, the honest answer is to ask. */
    it(`never substitutes a sibling app for a group's remembered address`, () => {
        expect(aimOf({ typed: undefined, remembered: `http://localhost:4321`, state: `ready`, servers: ONE_OF_THREE })).toBeUndefined();
        expect(
            aimOf({ typed: undefined, remembered: `http://localhost:4321`, state: `ready`, servers: [MONOREPO[0]!, MONOREPO[1]!] }),
        ).toBeUndefined();
    });

    it(`keeps aiming a group at the elsewhere it was last run against, so it is typed once and not once per run`, () => {
        // The marketing-site case: this group is a second app, and the repo's own dev server is not it.
        expect(aimOf({ typed: undefined, remembered: `https://staging.example.dev`, state: `ready`, servers: ONE })).toBe(
            `https://staging.example.dev`,
        );
        // And it is still the answer while that repo's dev server is down: nothing about this group needs it.
        expect(aimOf({ typed: undefined, remembered: `https://staging.example.dev`, state: `stopped`, servers: [] })).toBe(
            `https://staging.example.dev`,
        );
    });

    it(`falls back to the remembered address for a repo the daemon runs nothing for`, () => {
        expect(aimOf({ typed: undefined, remembered: `http://localhost:4321`, state: `none`, servers: [] })).toBe(`http://localhost:4321`);
        // With no dev server and nothing remembered there is genuinely no answer, and the run says so.
        expect(aimOf({ typed: undefined, remembered: undefined, state: `none`, servers: [] })).toBeUndefined();
    });

    it(`lets a typed address win over both, and a typed blank mean blank`, () => {
        expect(aimOf({ typed: `  https://preview.example.dev  `, remembered: `https://old.example.dev`, state: `ready`, servers: ONE })).toBe(
            `https://preview.example.dev`,
        );
        // An emptied field is "not there", not "surprise me": it must not snap back to a server or a memory.
        expect(aimOf({ typed: ``, remembered: `https://staging.example.dev`, state: `ready`, servers: ONE })).toBeUndefined();
    });
});
