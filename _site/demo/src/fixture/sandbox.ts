import type { CapabilitySummary } from "@intentic/api-contract";
import { builtinModules } from "@intentic/web/builtins";
import type {
    Environment,
    EnvironmentContents,
    ExtensionSummary,
    LocalModelFitResponse,
    PanelSummary,
    UsageRollupRow,
} from "@intentic/sandbox-contract";
import { LOCAL_MODEL_KV_BYTES_PER_TOKEN, LOCAL_MODEL_WINDOWS, LOCAL_MODELS } from "@intentic/sandbox-contract";
import { deskEdition, enabledExtensions } from "../mode";
import pins from "../../vendor/extensions.json";
import { DESK_REPOS } from "./desk";

// acme-shop's workspace furniture: what it's made of, what it's wired to, the extensions supplying that wiring, and the
// Usage tab's spend ledger. Connector entries copy the real `_extensions/connectors` and `_extensions/discord`
// manifests, minus credential guides.

const day = (now: number, back: number): string => new Date(now - back * 86_400_000).toISOString().slice(0, 10);

// Facts every extension's `detect()` runs over, deciding which rail tiles show. `running` is false for both: nothing
// runs in a recording.
export const demoPanels = (): PanelSummary[] => (deskEdition ? DESK_REPOS.map((repo) => ({ ...NO_PANEL, repo })) : CODE_PANELS);

// A folder of documents: nothing to run, nothing to publish, no stories and no docs set. Every tile that keys on these
// stays off the desk's rail.
const NO_PANEL: Omit<PanelSummary, "repo"> = {
    hasPanel: false,
    running: false,
    installed: false,
    healthy: false,
    servers: [],
    deployConfig: false,
    desiredState: false,
    directoryUi: false,
    monorepo: false,
    tests: false,
    userStories: false,
    docs: false,
};

const CODE_PANELS: PanelSummary[] = [
    {
        repo: `web`,
        hasPanel: true,
        running: false,
        // Tree already installed; Start would promise seconds, not a fresh install.
        installed: true,
        healthy: false,
        servers: [],
        deployConfig: false,
        desiredState: false,
        directoryUi: false,
        monorepo: false,
        tests: false,
        userStories: true,
        // Set is published (fixture/docs.ts); `api`'s below is only staged.
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
        tests: false,
        userStories: true,
        docs: false,
    },
];

// One capability per system the agents operate. `config` is the secret-stripped echo the daemon returns; `secrets`
// names the stripped keys so a form can show dots for them.
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
    { id: `stripe`, kind: `cli`, status: { state: `active` }, config: { provider: `stripe` }, secrets: [`apiKey`] },
    { id: `docker`, kind: `docker`, status: { state: `active` }, config: {}, secrets: [] },
    // The owner's PC (fixture/devices.ts), admitted to run commands and manage its sandboxes: the two switches every
    // button on its Devices page is gated on, so the demo draws the page as the owner sees it rather than as a refusal.
    {
        id: `ada-pc`,
        kind: `device`,
        status: { state: `active` },
        config: { platform: `windows`, shell: `on`, sandboxes: `on`, write: `off`, screen: `off`, control: `off`, destructive: `off` },
        secrets: [],
    },
    {
        id: `ops-box`,
        kind: `ssh`,
        status: { state: `active` },
        config: { auth: `key`, host: `ops.acme.dev`, port: 22, user: `deploy` },
        secrets: [`key`],
    },
];

// A believable laptop for the connect view's local lane: 32 GB, no GPU passed through, nothing downloaded yet. Priced
// with the daemon's own arithmetic rather than typed numbers, so the demo cannot show a machine the real fit route
// would size differently.
const DEMO_MEMORY_BYTES = 32 * 1024 * 1024 * 1024;
const DEMO_RUNTIME_BYTES = 1_000_000_000;
const DEMO_BUDGET_BYTES = Math.round(DEMO_MEMORY_BYTES * 0.8);
const demoTotal = (weightsBytes: number, tokens: number): number => weightsBytes + tokens * LOCAL_MODEL_KV_BYTES_PER_TOKEN + DEMO_RUNTIME_BYTES;

// Flipped by the connect view's own prefetch press: the demo has no download, but "started, halfway" is the state the
// lane has the most to draw, and a fixture that stayed idle would hide the progress line and its Stop.
let demoPrefetching = false;
export const demoStartPrefetch = (start: boolean): LocalModelFitResponse["prefetch"] => {
    demoPrefetching = start;
    return demoLocalModelFit().prefetch;
};

export const demoLocalModelFit = (): LocalModelFitResponse => {
    const instant = LOCAL_MODELS.find((choice) => choice.tier === `instant`)!;
    const best = LOCAL_MODELS.findLast((choice) => choice.tier === `work` && demoTotal(choice.weightsBytes, 65_536) <= DEMO_BUDGET_BYTES)!;
    return {
        memoryBytes: DEMO_MEMORY_BYTES,
        memoryCapped: false,
        gpu: `absent`,
        gpuMemoryBytes: 0,
        budgetBytes: DEMO_BUDGET_BYTES,
        serverReady: true,
        options: LOCAL_MODELS.map((choice) => ({
            model: choice.id,
            label: choice.label,
            tier: choice.tier,
            weightsBytes: choice.weightsBytes,
            held: false,
            windows: LOCAL_MODEL_WINDOWS.map(Number).map((tokens) => ({
                tokens,
                totalBytes: demoTotal(choice.weightsBytes, tokens),
                fits: demoTotal(choice.weightsBytes, tokens) <= DEMO_BUDGET_BYTES,
            })),
        })),
        instant: { model: instant.id, context: `65536` },
        best: { model: best.id, context: `65536` },
        prefetch: demoPrefetching
            ? { model: instant.id, state: `downloading`, receivedBytes: Math.round(instant.weightsBytes * 0.4), totalBytes: instant.weightsBytes }
            : { model: instant.id, state: `idle`, receivedBytes: 0, totalBytes: 0 },
    };
};

// No `enabled` here; `demoExtensions()` below applies demo mode's on/off once.
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
                    {
                        id: `stripe`,
                        kind: `cli`,
                        catalog: {
                            name: `Stripe`,
                            logo: `stripe`,
                            description: `Payments, customers, invoices and subscriptions.`,
                            category: `business`,
                        },
                        fields: [{ key: `apiKey`, label: `Secret key`, secret: true }],
                        env: { STRIPE_API_KEY: `\${apiKey}` },
                        skill: `skills/stripe/SKILL.md`,
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

// Every first-party extension compiled into this build, read from the app's own registry so it can't drift from what's
// really compiled in. `commit` is `demo`: this recording isn't a real build.
const compiledExtensions = (): Omit<ExtensionSummary, "enabled">[] =>
    [...builtinModules].map(([id, module]) => ({ id, manifest: module.manifest, commit: `demo`, source: `builtin` }));

// The LISTED first-party extensions (acceptance, documentation, maintenance, knowledge, deployments, issues), vendored
// at the registry's pinned commits by scripts/sync-extensions.mjs and read here exactly as an installed checkout: the
// manifest is the row, the bundle is what `GET /extensions/{id}/bundle` serves. A pin the sync has not fetched yet is
// simply not installed in this recording.
// Plain string literals throughout: Vite reads a glob call statically and a template literal in its options is not a
// string to it, which turned `?raw` into a module import of a minified bundle.
const VENDORED_MANIFESTS = import.meta.glob<ExtensionSummary["manifest"]>("../../vendor/extensions/*/intentic-extension.json", {
    eager: true,
    import: "default",
});
const VENDORED_BUNDLES = import.meta.glob<string>("../../vendor/extensions/*/extension.js", { eager: true, query: "?raw", import: "default" });
const vendoredIdOf = (path: string): string => path.split(`/`).at(-2) ?? ``;
const vendoredExtensions = (): Omit<ExtensionSummary, "enabled">[] =>
    Object.entries(VENDORED_MANIFESTS).map(([path, manifest]) => {
        const id = vendoredIdOf(path);
        return { id, manifest, commit: (pins as Record<string, { sha: string }>)[id]?.sha ?? `pending`, source: `installed` };
    });

// The bundle bytes for one vendored id, or a 404 in the daemon's own words.
export const vendoredBundle = (id: string): Response => {
    const entry = Object.entries(VENDORED_BUNDLES).find(([path]) => vendoredIdOf(path) === id);
    return entry === undefined
        ? new Response(JSON.stringify({ error: `no bundle vendored for ${id}` }), { status: 404, headers: { "content-type": `application/json` } })
        : new Response(entry[1], { headers: { "content-type": `text/javascript` } });
};

// Built once, then live: toggling here persists across reads, like the real daemon.
let extensions: ExtensionSummary[] | undefined;

// Which extensions start on is demo mode's opening position only; every extension stays listed, most switched off, as
// an unset-up workspace really looks.
export const demoExtensions = (): ExtensionSummary[] =>
    (extensions ??= [...compiledExtensions(), ...vendoredExtensions(), ...CONNECTOR_EXTENSIONS].map((extension) =>
        // Mutates in place: `setExtensionEnabled` below writes `enabled` straight onto these objects.
        Object.assign(extension, { enabled: enabledExtensions()?.includes(extension.id) ?? true }),
    ));

export const setExtensionEnabled = (id: string, enabled: boolean): void => {
    const extension = demoExtensions().find((candidate) => candidate.id === id);
    if (extension !== undefined) {
        extension.enabled = enabled;
    }
};

// Applied is what the container was built from; the proposal awaits owner approval, never the agent's.
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

// Same environment as contents (what the sandbox has, not how it was built); every row state is represented. Versions
// are real tool output, not round numbers.
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
                { name: `node`, version: `24.21.0` },
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
            detail: `Built from source and pinned to v1.9.4, so a transcript made today can be reproduced next year.`,
            commands: `RUN git clone --depth 1 --branch v1.9.4 https://github.com/ggml-org/whisper.cpp /tmp/whisper.cpp \\\n    && cmake --build /tmp/whisper.cpp/build -j --target whisper-cli`,
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
            tools: [{ name: `node`, version: `24.21.0` }],
            purpose: `The runtime everything JavaScript in here runs on.`,
        },
        {
            id: `base:pnpm`,
            name: `pnpm`,
            origin: `base`,
            state: `active`,
            tools: [{ name: `pnpm`, version: `12.6.0` }],
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
            tools: [{ name: `python3`, version: `3.13.5` }],
            purpose: `Scripting, plus anything reached for with pip inside a virtual environment.`,
        },
        {
            id: `base:rg`,
            name: `ripgrep`,
            origin: `base`,
            state: `active`,
            tools: [{ name: `rg`, version: `15.2.0` }],
            purpose: `Fast text search across the workspace, and the engine behind code search.`,
        },
        {
            id: `base:jq`,
            name: `jq`,
            origin: `base`,
            state: `active`,
            tools: [{ name: `jq`, version: `1.8.2` }],
            purpose: `Reads and rewrites JSON on the command line.`,
        },
        {
            id: `base:sqlite3`,
            name: `SQLite`,
            origin: `base`,
            state: `active`,
            tools: [{ name: `sqlite3`, version: `3.46.1` }],
            purpose: `Opens and queries a local database file.`,
        },
        {
            id: `base:cloudflared`,
            name: `cloudflared`,
            origin: `base`,
            state: `active`,
            tools: [{ name: `cloudflared`, version: `2026.9.3` }],
            purpose: `Puts a local port on a public URL.`,
        },
    ],
});

// Spend ledger the Usage tab projects: two providers, two accounts, the models the fleet actually runs.
export const demoUsageRollup = (now: number): UsageRollupRow[] => {
    const rows: UsageRollupRow[] = [];
    const shape = [
        { provider: `claude`, account: `ada@acme.dev`, model: `claude-sonnet-5`, harness: `claude-code`, turns: 14, cost: 2.9 },
        { provider: `claude`, account: `ada@acme.dev`, model: `claude-opus-5`, harness: `claude-code`, turns: 4, cost: 3.4 },
        { provider: `claude`, account: `ada@acme.dev`, model: `claude-haiku-4-5-20251001`, harness: `claude-code`, turns: 9, cost: 0.28 },
        { provider: `codex`, account: `chatgpt-ada`, model: `gpt-5.2-codex`, harness: `native`, turns: 6, cost: 1.1 },
    ];
    // Two weeks with a weekend dip; rows are per day × provider × account × model.
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
