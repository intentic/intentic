import type { CapabilitySummary } from "@intentic-app/api-contract";
import { builtinModules } from "@intentic-app/web/builtins";
import type { Environment, EnvironmentContents, ExtensionSummary, PanelSummary, UsageRollupRow } from "@intentic/sandbox-contract";
import { demoMode } from "../mode";

/* The sandbox's own furniture for the recorded workspace: what acme-shop is made of, what it is wired to, which
 * extensions supply that wiring, and the spend ledger behind the Usage tab.
 *
 * The connector entries are copies of the real `_extensions/connectors` and `_extensions/discord` manifests,
 * same providers, same catalog copy, minus the credential guides, which only matter in an add dialog this
 * fixture can't complete. A card a visitor sees here is a card the product really contributes. */

const day = (now: number, back: number): string => new Date(now - back * 86_400_000).toISOString().slice(0, 10);

/* WHAT EACH REPOSITORY IS MADE OF. `GET /panels`, and the most relied-on rows in this fixture.
 *
 * These are the facts every extension's `detect()` runs over, so they are what decides which tiles the rail
 * carries at all: Documentation and Maintenance activate on there being a repository, Acceptance on one that
 * has user stories or a dev server, Preview on `hasPanel`, Apps on `monorepo`/`vitest`. A fixture that answered
 * this route with an empty list, as this one did, is a fixture whose sidebar is missing half the product.
 *
 * Evidence over identity, exactly as the daemon computes it: `web` ships a Vite dev server and carries stories
 * under `docs/user-stories`; `api` carries stories but has no dev script to preview. Neither is a monorepo and
 * neither runs vitest (the storefront's suite is Playwright), so neither claims an Apps panel.
 *
 * `running` is false for both, and that is the honest answer rather than a shy one: nothing runs in a
 * recording. The panel's Start button reaches a refusal that says so (daemon.ts), and Acceptance's target
 * picker shows the repo as "stopped", which is exactly what it shows against a real sandbox before you press
 * anything. */
export const demoPanels = (): PanelSummary[] => [
    {
        repo: `web`,
        hasPanel: true,
        running: false,
        // The recorded workspace is one somebody has already worked in, so its tree is installed and the Start
        // screen would promise seconds rather than an install. `api` has nothing runnable, which reads as
        // installed for the same reason the daemon says so (panels.routes.ts).
        installed: true,
        healthy: false,
        servers: [],
        deployConfig: false,
        desiredState: false,
        directoryUi: false,
        monorepo: false,
        vitest: false,
        userStories: true,
        // Its set is PUBLISHED (fixture/docs.ts); `api`'s is only staged, which is what the false below means.
        docs: true,
    },
    {
        repo: `api`,
        hasPanel: false,
        running: false,
        installed: true,
        healthy: false,
        servers: [],
        deployConfig: false,
        desiredState: false,
        directoryUi: false,
        monorepo: false,
        vitest: false,
        userStories: true,
        docs: false,
    },
];

/* The installed capabilities: one per system the recorded agents operate. Configs are the secret-stripped echo
 * the daemon returns, a token never leaves the sandbox, so it never appears in a list row either. `secrets`
 * names the keys stripped out of each, which is what lets a card's form be opened over one of these and show
 * dots where it may not show a value. */
export const demoCapabilities = (): CapabilitySummary[] => [
    { id: `github`, kind: `cli`, status: { state: `active` }, config: { provider: `github`, git: `on` }, secrets: [`token`] },
    {
        id: `postgres`,
        kind: `cli`,
        status: { state: `active` },
        config: { provider: `postgres`, host: `db.acme.internal`, port: `5432`, user: `acme_app`, database: `acme_shop` },
        secrets: [`password`],
    },
    {
        id: `sentry`,
        kind: `cli`,
        status: { state: `active` },
        config: { provider: `sentry`, url: `https://sentry.io`, org: `acme` },
        secrets: [`token`],
    },
    { id: `discord`, kind: `cli`, status: { state: `active` }, config: { provider: `discord`, guild: `acme` }, secrets: [`token`] },
    { id: `stripe`, kind: `integration`, status: { state: `active` }, config: { provider: `stripe` }, secrets: [] },
    { id: `docker`, kind: `docker`, status: { state: `active` }, config: {}, secrets: [] },
    {
        id: `ops-box`,
        kind: `ssh`,
        status: { state: `active` },
        config: { auth: `key`, host: `ops.acme.dev`, port: 22, user: `deploy` },
        secrets: [`key`],
    },
];

/* The extensions those cli capabilities resolve through: without the contribution there is no card, which is
 * exactly how the product works, a connector is manifest data, not a hardcoded table in the app. These two are
 * daemon-side (a connector catalog and a listener), so no code of theirs runs in the browser and the hub calls
 * them `agent-only`.
 *
 * No `enabled` on either literal: which extensions are switched on is the demo MODE's call, applied once in
 * `demoExtensions()` below. A list that carried its own would quietly outrank the switcher. */
const CONNECTOR_EXTENSIONS: Omit<ExtensionSummary, "enabled">[] = [
    {
        id: `intentic.connectors`,
        commit: `9f2c41d`,
        source: `builtin`,
        manifest: {
            publisher: `intentic`,
            name: `connectors`,
            version: `1.0.0`,
            engines: { intentic: `^1.0.0` },
            contributes: {
                capabilities: [
                    {
                        id: `github`,
                        kind: `cli`,
                        catalog: {
                            name: `GitHub`,
                            logo: `github/f5f5f5`,
                            description: `Issues, PRs, code search and git.`,
                            category: `code`,
                        },
                        fields: [
                            { key: `token`, label: `Personal access token`, secret: true },
                            {
                                key: `git`,
                                label: `Git access`,
                                default: `on`,
                                options: [
                                    { value: `on`, label: `On` },
                                    { value: `off`, label: `Off` },
                                ],
                            },
                        ],
                        env: { GITHUB_TOKEN: `\${token}` },
                        skill: `skills/github/SKILL.md`,
                    },
                    {
                        id: `postgres`,
                        kind: `cli`,
                        catalog: {
                            name: `PostgreSQL`,
                            logo: `postgresql`,
                            description: `Query your PostgreSQL database with psql.`,
                            category: `data`,
                        },
                        fields: [
                            { key: `host`, label: `Host` },
                            { key: `port`, label: `Port`, default: `5432` },
                            { key: `user`, label: `User` },
                            { key: `password`, label: `Password`, secret: true },
                            { key: `database`, label: `Database` },
                        ],
                        env: { POSTGRES_URL: `postgres://\${user}:\${password:uri}@\${host}:\${port}/\${database}` },
                        skill: `skills/postgres/SKILL.md`,
                        fragment: `env/postgres.Dockerfile`,
                    },
                    {
                        id: `sentry`,
                        kind: `cli`,
                        catalog: {
                            name: `Sentry`,
                            logo: `sentry`,
                            description: `Query issues and traces from Sentry.`,
                            category: `observability`,
                        },
                        fields: [
                            { key: `url`, label: `Sentry URL`, default: `https://sentry.io` },
                            { key: `org`, label: `Organization` },
                            { key: `token`, label: `Auth token`, secret: true },
                        ],
                        env: { SENTRY_TOKEN: `\${token}`, SENTRY_URL: `\${url}`, SENTRY_ORG: `\${org}` },
                        skill: `skills/sentry/SKILL.md`,
                    },
                    {
                        id: `outline`,
                        kind: `cli`,
                        catalog: {
                            name: `Outline`,
                            logo: `outline/f5f5f5`,
                            description: `Docs and knowledge base from Outline.`,
                            category: `business`,
                        },
                        fields: [
                            { key: `url`, label: `Outline URL` },
                            { key: `apiKey`, label: `API key`, secret: true },
                        ],
                        env: { OUTLINE_URL: `\${url}`, OUTLINE_API_KEY: `\${apiKey}` },
                        skill: `skills/outline/SKILL.md`,
                    },
                ],
            },
        },
    },
    {
        id: `intentic.discord`,
        commit: `4ab7e10`,
        source: `builtin`,
        manifest: {
            publisher: `intentic`,
            name: `discord`,
            version: `1.0.0`,
            engines: { intentic: `^1.0.0` },
            contributes: {
                capabilities: [
                    {
                        id: `discord`,
                        kind: `cli`,
                        catalog: {
                            name: `Discord`,
                            logo: `discord`,
                            description: `Read and post in your Discord server.`,
                            category: `communication`,
                        },
                        fields: [
                            { key: `token`, label: `Bot token`, secret: true },
                            { key: `guild`, label: `Server`, optional: true },
                        ],
                        env: { DISCORD_TOKEN: `\${token}` },
                        skill: `skills/discord/SKILL.md`,
                    },
                ],
                listener: {
                    provider: `discord`,
                    events: [
                        { type: `message`, label: `Messages` },
                        { type: `voice_utterance`, label: `Voice utterances` },
                        { type: `voice_transcript`, label: `Voice transcripts` },
                    ],
                    automation: {
                        label: `Discord`,
                        mentionLabel: `Only when mentioned`,
                        channel: { label: `Channel ID (optional)`, placeholder: `all channels` },
                        starterPrompt: `Handle the Discord event.`,
                    },
                },
            },
        },
    },
];

/* THE LIST THE IMAGE WOULD BAKE. Every first-party extension whose code this app build compiled in, read off
 * the app's own registry rather than re-typed here, because the extension host treats a compiled-in extension
 * the daemon didn't mention as version drift, and says so on each row: "this sandbox image doesn't list it,
 * the image and the app are on different versions". True of a dogfooding sandbox, alarming nonsense on a
 * marketing page, and re-listing them by hand would only move the drift to the next extension somebody adds.
 *
 * `commit` is `demo` for the same reason `info.version` is: the recording is not a build of anything. */
const compiledExtensions = (): Omit<ExtensionSummary, "enabled">[] =>
    [...builtinModules].map(([id, module]) => ({ id, manifest: module.manifest, commit: `demo`, source: `builtin` }));

// Built once and then LIVE: the hub's Extensions tab really writes these switches, because the daemon persists
// a flip and every later read reflects it, a fixture that answered read-only would have a toggle that springs
// back on the next poll.
let extensions: ExtensionSummary[] | undefined;

/* WHICH OF THEM ARE ON is the demo mode's opening position (mode.ts), and only that: every extension stays in
 * the list, because the Extensions tab showing the whole catalog with most of it switched off is the truth
 * about a workspace nobody has set up yet, and the visitor can turn any of them on from there. */
export const demoExtensions = (): ExtensionSummary[] =>
    (extensions ??= [...compiledExtensions(), ...CONNECTOR_EXTENSIONS].map((extension) =>
        // In place: these objects ARE the live list from here on, the hub's switch writes `enabled` straight
        // back into them (setExtensionEnabled below), as it has since before there were modes.
        Object.assign(extension, { enabled: demoMode.extensions?.includes(extension.id) ?? true }),
    ));

export const setExtensionEnabled = (id: string, enabled: boolean): void => {
    const extension = demoExtensions().find((candidate) => candidate.id === id);
    if (extension !== undefined) {
        extension.enabled = enabled;
    }
};

/* The image overlay: the layer of the environment everyone else keeps closed. What's applied is what the
 * container was built from; the proposal is the agent asking for one more tool, approved by the owner, never
 * by the agent, which is the whole point of showing a Dockerfile diff instead of installing behind your back. */
const APPLIED_OVERLAY = `# intentic:custom: approved 3 days ago
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client-16 \\
 && rm -rf /var/lib/apt/lists/*

# The e2e suite the release agent runs before it lands anything.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN pnpm dlx playwright@1.56 install --with-deps chromium
`;

export const demoEnvironment = (): Environment => ({
    container: `intentic-sandbox-acme-shop`,
    approved: { content: APPLIED_OVERLAY, hash: `sha256:1f4c9ab2` },
    custom: { content: APPLIED_OVERLAY, hash: `sha256:1f4c9ab2` },
    appliedHash: `sha256:1f4c9ab2`,
    proposal: {
        hash: `sha256:8b07de54`,
        content: `${APPLIED_OVERLAY}
# Proposed by the agent while wiring product images on the checkout page.
RUN apt-get update && apt-get install -y --no-install-recommends imagemagick \\
 && rm -rf /var/lib/apt/lists/*
`,
    },
});

/* The same environment read as CONTENTS, what the sandbox has rather than how it was built, which is the view
 * the Environment tab opens on. Every state the rows can be in is represented, because each one is a different
 * sentence to a visitor: installed and answering, approved but waiting on a rebuild, and proposed by the agent
 * and waiting on them. Versions are what the tools report in a real sandbox, so they are written as real
 * versions here rather than as round numbers. */
export const demoEnvironmentContents = (): EnvironmentContents => ({
    items: [
        {
            id: `custom:postgresql-client`,
            name: `Postgresql client`,
            origin: `custom`,
            state: `active`,
            tools: [{ name: `psql`, version: `16.4` }],
            purpose: `Reads the production replica directly, so a schema question is a query rather than a guess.`,
            detail:
                `Pinned to 16 to match the managed database: a newer client warns on every connect and its \\copy output drifts ` +
                `from what the runbooks show.`,
            commands: `RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client-16 \\\n && rm -rf /var/lib/apt/lists/*`,
        },
        {
            id: `custom:playwright`,
            name: `Playwright`,
            origin: `custom`,
            state: `active`,
            tools: [
                { name: `playwright`, version: `1.56.2` },
                { name: `chromium`, version: `140.0.7339` },
                { name: `node`, version: `24.18.0` },
                { name: `xvfb-run` },
            ],
            extras: 34,
            purpose: `Runs the end-to-end suite the release agent goes through before it lands anything.`,
            detail:
                `Headed under a virtual display rather than headless: the headless shell is fingerprinted and blocked by the ` +
                `checkout provider's bot protection, so a headless run fails on the one journey that matters most.`,
            commands: `ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright\nRUN pnpm dlx playwright@1.56 install --with-deps chromium`,
        },
        {
            id: `custom:imagemagick`,
            name: `Imagemagick`,
            origin: `custom`,
            state: `awaiting-approval`,
            tools: [],
            purpose: `Resizes and re-encodes the product images the checkout page serves.`,
            detail:
                `The uploads arrive as 4000px JPEGs and the page wants three widths of WebP, which nothing in this sandbox can ` +
                `currently produce.`,
            commands: `RUN apt-get update && apt-get install -y --no-install-recommends imagemagick \\\n && rm -rf /var/lib/apt/lists/*`,
        },
        {
            id: `capability:whisper`,
            name: `Whisper`,
            origin: `capability`,
            originLabel: `discord capability`,
            state: `after-rebuild`,
            tools: [],
            purpose: `Turns voice-channel audio into text on this machine, without sending it anywhere.`,
            detail: `Built from source and pinned to v1.9.1, so a transcript made today can be reproduced next year.`,
            commands: `RUN git clone --depth 1 --branch v1.9.1 https://github.com/ggml-org/whisper.cpp /tmp/whisper.cpp \\\n    && cmake --build /tmp/whisper.cpp/build -j --target whisper-cli`,
        },
        {
            id: `capability:docker`,
            name: `Docker`,
            origin: `capability`,
            originLabel: `docker capability`,
            state: `active`,
            tools: [
                { name: `docker`, version: `27.3.1` },
                { name: `containerd`, version: `1.7.22` },
            ],
            purpose: `Builds and runs containers inside the sandbox, for the compose stack the shop's API needs.`,
        },
        {
            id: `base:node`,
            name: `Node.js`,
            origin: `base`,
            state: `active`,
            tools: [{ name: `node`, version: `24.18.0` }],
            purpose: `The runtime everything JavaScript in here runs on.`,
        },
        {
            id: `base:pnpm`,
            name: `pnpm`,
            origin: `base`,
            state: `active`,
            tools: [{ name: `pnpm`, version: `12.2.1` }],
            purpose: `Installs and runs workspace packages.`,
        },
        {
            id: `base:git`,
            name: `Git`,
            origin: `base`,
            state: `active`,
            tools: [{ name: `git`, version: `2.47.3` }],
            purpose: `Every repo in the workspace is a real git repo.`,
        },
        {
            id: `base:python3`,
            name: `Python`,
            origin: `base`,
            state: `active`,
            tools: [{ name: `python3`, version: `3.11.2` }],
            purpose: `Scripting, plus anything reached for with pip inside a virtual environment.`,
        },
        {
            id: `base:rg`,
            name: `ripgrep`,
            origin: `base`,
            state: `active`,
            tools: [{ name: `rg`, version: `14.1.1` }],
            purpose: `Fast text search across the workspace, and the engine behind code search.`,
        },
        {
            id: `base:jq`,
            name: `jq`,
            origin: `base`,
            state: `active`,
            tools: [{ name: `jq`, version: `1.7.1` }],
            purpose: `Reads and rewrites JSON on the command line.`,
        },
        {
            id: `base:sqlite3`,
            name: `SQLite`,
            origin: `base`,
            state: `active`,
            tools: [{ name: `sqlite3`, version: `3.40.1` }],
            purpose: `Opens and queries a local database file.`,
        },
        {
            id: `base:cloudflared`,
            name: `cloudflared`,
            origin: `base`,
            state: `active`,
            tools: [{ name: `cloudflared`, version: `2026.7.3` }],
            purpose: `Puts a local port on a public URL.`,
        },
    ],
});

/* The spend ledger the Usage tab projects: real turns cost real money on YOUR subscription, and the sandbox
 * records every one of them. Two providers, two accounts, the models the fleet is actually running. */
export const demoUsageRollup = (now: number): UsageRollupRow[] => {
    const rows: UsageRollupRow[] = [];
    const shape = [
        { provider: `claude`, account: `ada@acme.dev`, model: `claude-sonnet-5`, harness: `claude-code`, turns: 14, cost: 2.9 },
        { provider: `claude`, account: `ada@acme.dev`, model: `claude-opus-5`, harness: `claude-code`, turns: 4, cost: 3.4 },
        { provider: `claude`, account: `ada@acme.dev`, model: `claude-haiku-4-5-20251001`, harness: `claude-code`, turns: 9, cost: 0.28 },
        { provider: `codex`, account: `chatgpt-ada`, model: `gpt-5.2-codex`, harness: `native`, turns: 6, cost: 1.1 },
    ];
    // A fortnight of work with a weekend dip, the ledger is per day × provider × account × model, and the
    // browser re-projects it into every chart on the tab.
    for (let back = 13; back >= 0; back -= 1) {
        const weekday = new Date(now - back * 86_400_000).getUTCDay();
        const load = weekday === 0 || weekday === 6 ? 0.2 : 0.7 + ((back * 37) % 60) / 100;
        for (const row of shape) {
            const turns = Math.max(1, Math.round(row.turns * load));
            rows.push({
                day: day(now, back),
                provider: row.provider,
                account: row.account,
                model: row.model,
                harness: row.harness,
                turns,
                inputTokens: turns * 21_400,
                outputTokens: turns * 2_900,
                cacheReadTokens: turns * 96_000,
                cacheCreationTokens: turns * 12_000,
                costUsd: Math.round(row.cost * load * 100) / 100,
                durationMs: turns * 42_000,
            });
        }
    }
    return rows;
};
