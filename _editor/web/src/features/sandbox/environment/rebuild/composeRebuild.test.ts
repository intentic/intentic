import { PLATFORM_WEB_ORIGIN } from "@intentic/constants";
import { composeRebuildOf, recipeBaseOf } from "./composeRebuild";

// The rebuild of a Compose-run sandbox is its whole file again, building the approved recipe. How the recipe becomes
// `build:` (comments dropped, heredocs whole, `$` doubled) is the run contract's, tested in sandbox-run's compose.test.ts.

const HASH = `0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`;
const HEADER = `# Composed by the intentic sandbox daemon: do not edit by hand.\n\nFROM ghcr.io/intentic/sandbox:stable\n`;
const DOCKER = `# docker capability: this directive grants dockerd the privileges it needs\n# intentic:runtime --privileged`;
const CONTEXT = { hostname: `sandbox-0f00ba4dd12b.intentic.dev`, googleClientId: `client-id`, webOrigin: PLATFORM_WEB_ORIGIN };

it(`turns the docker capability on a base that carries the engine into privileged: true and the hash, with no build`, () => {
    const edit = composeRebuildOf(HASH, `${HEADER}\n${DOCKER}\n`, CONTEXT);
    expect(edit.builds).toBe(false);
    expect(edit.file).toContain(`privileged: true`);
    expect(edit.file).toContain(`SANDBOX_ENVIRONMENT_HASH: "${HASH}"`);
    expect(edit.file).toContain(`image: "ghcr.io/intentic/sandbox:stable"`);
    expect(edit.file).not.toContain(`build:`);
});

it(`builds a recipe with steps inline, on the storage the sandbox already has`, () => {
    const edit = composeRebuildOf(HASH, `${HEADER}\nRUN apt-get install -y ripgrep\n\n${DOCKER}\n`, CONTEXT);
    expect(edit.builds).toBe(true);
    expect(edit.file).toContain(`pull_policy: build`);
    expect(edit.file).toContain(`                RUN apt-get install -y ripgrep`);
    expect(edit.file).toContain(`image: "intentic-sandbox-env-sandbox-0f00ba4dd12b:0123456789ab"`);
    expect(edit.file).toContain(`        name: intentic-workspace-sandbox-0f00ba4dd12b\n        external: true`);
});

it(`keeps every credential in the .env the folder already has`, () => {
    const { file } = composeRebuildOf(HASH, HEADER, CONTEXT);
    expect(file).toContain(`CONNECT_TOKEN: \${CONNECT_TOKEN:?run the .env bootstrap first}`);
    expect(file).toContain(`SANDBOX_GRANT: \${SANDBOX_GRANT:?run the .env bootstrap first}`);
    expect(file).toContain(`SANDBOX_PUBLIC_URL: "https://sandbox-0f00ba4dd12b.intentic.dev"`);
});

it(`builds on the base the recipe names, the published image when it names none`, () => {
    expect(recipeBaseOf(`# x\nFROM intentic-sandbox:dev\nRUN true\n`)).toBe(`intentic-sandbox:dev`);
    expect(recipeBaseOf(`RUN true\n`)).toBe(`ghcr.io/intentic/sandbox:stable`);
});
