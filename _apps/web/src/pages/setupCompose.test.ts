import { expect, test } from "vitest";
import type { ComposeArgs } from "./setupCompose";
import { composeBootstrap, composeFile } from "./setupCompose";

const base: ComposeArgs = {
    mode: `intentic`,
    code: `abc123`,
    hostname: `sandbox-0f00ba4dd12b.intentic.dev`,
    image: `registry.gitlab.com/radarsu/intentic/sandbox:stable`,
    googleClientId: `client-id.apps.googleusercontent.com`,
};

test("intentic path: the bootstrap is claim → up, against the production platform, no -k", () => {
    expect(composeBootstrap(base)).toBe(`curl -fsS https://app.intentic.dev/setup/claim -d code=abc123 > .env\ndocker compose up -d`);
});

test("own path: the bootstrap appends the CF token and mints the tunnel through the .env before up", () => {
    const bootstrap = composeBootstrap({ ...base, mode: `own`, hostname: `dev.example.com`, cfToken: `cf-tok` });
    expect(bootstrap).toContain(`echo "CLOUDFLARE_API_TOKEN=cf-tok" >> .env`);
    expect(bootstrap).toContain(`docker run --rm --env-file .env --entrypoint intentic ${base.image} sandbox-tunnel`);
    expect(bootstrap).toContain(`--subdomain 'dev' >> .env`);
    expect(bootstrap.endsWith(`docker compose up -d`)).toBe(true);
});

test("local dev claims against the localhost platform with -k (repo CA)", () => {
    expect(composeBootstrap({ ...base, platformUrl: `https://localhost:6480` })).toContain(
        `curl -fsSk https://localhost:6480/setup/claim -d code=abc123 > .env`,
    );
});

test("the compose file mirrors connect.sh: slugged names, origin alias, .env guards, inlined public url", () => {
    const yaml = composeFile(base);
    // Same names as connect.sh derives, so cleanup.sh + coexistence checks + workspace data stay compatible.
    expect(yaml).toContain(`container_name: intentic-sandbox-sandbox-0f00ba4dd12b`);
    expect(yaml).toContain(`container_name: intentic-sandbox-tunnel-sandbox-0f00ba4dd12b`);
    expect(yaml).toContain(`name: intentic-workspace-sandbox-0f00ba4dd12b`);
    expect(yaml).toContain(`name: intentic-history-sandbox-0f00ba4dd12b`);
    expect(yaml).toContain(`name: intentic-docker-sandbox-0f00ba4dd12b`);
    expect(yaml).toContain(`aliases: [intentic-sandbox-workspace]`);
    // Secrets come from the claimed .env, with a clear error when the bootstrap was skipped.
    expect(yaml).toContain(`CONNECT_TOKEN: \${CONNECT_TOKEN:?run the .env bootstrap first}`);
    expect(yaml).toContain(`--token \${TUNNEL_TOKEN:?run the .env bootstrap first}`);
    expect(yaml).toContain(`SANDBOX_PUBLIC_URL: https://sandbox-0f00ba4dd12b.intentic.dev`);
    expect(yaml).toContain(`PLATFORM_URL: https://app.intentic.dev`);
    // The intentic path bakes NO Cloudflare token env — an empty one would shadow the workspace .env later.
    expect(yaml).not.toContain(`CLOUDFLARE_API_TOKEN`);
    expect(yaml).not.toContain(`agent-auth`);
});

test("a local-only dev image is marked pull_policy: never so `compose pull` skips it instead of failing", () => {
    expect(composeFile({ ...base, image: `intentic-sandbox:dev`, platformUrl: `https://localhost:6480` })).toContain(`pull_policy: never`);
});

test("the production registry image is pull_policy: always so it tracks the moving :stable release", () => {
    const yaml = composeFile(base);
    expect(yaml).toContain(`image: registry.gitlab.com/radarsu/intentic/sandbox:stable`);
    expect(yaml).toContain(`pull_policy: always`);
    expect(yaml).not.toContain(`pull_policy: never`);
});

test("daemon-defaulted vars are omitted — the environment block stays minimal", () => {
    const yaml = composeFile(base);
    for (const noise of [`WORKSPACE_ROOT`, `HISTORY_ROOT`, `SANDBOX_HOST`, `SANDBOX_PORT`, `PREVIEW_PORT`, `SANDBOX_NAME:`, `SANDBOX_IMAGE`, `SYNC_PAIR_TOKEN`]) {
        expect(yaml, `${noise} should ride the daemon default`).not.toContain(noise);
    }
});

test("the own path feeds the sandbox its Cloudflare token from the .env", () => {
    expect(composeFile({ ...base, mode: `own`, cfToken: `cf-tok` })).toContain(
        `CLOUDFLARE_API_TOKEN: \${CLOUDFLARE_API_TOKEN:?run the .env bootstrap first}`,
    );
});

test("local dev rewrites the container-visible platform url and mounts the shared agent-auth volume", () => {
    const yaml = composeFile({ ...base, platformUrl: `https://localhost:6480`, image: `intentic-sandbox:dev` });
    expect(yaml).toContain(`PLATFORM_URL: https://host.docker.internal:6480`);
    expect(yaml).toContain(`- agent-auth:/agent-auth`);
    expect(yaml).toContain(`AGENT_AUTH_DIR: /agent-auth`);
    expect(yaml).toContain(`name: intentic-dev-agent-auth`);
});
