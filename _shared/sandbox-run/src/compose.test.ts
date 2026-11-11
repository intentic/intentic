import { AT_REST_KEY_ENV, AT_REST_KEY_MOUNT, sandboxRunArgv, STOP_TIMEOUT_SECONDS } from "./index.js";
import { composeEnvFile, recipeBuildLines, sandboxCompose } from "./compose.js";
import { asJson, COMPOSE_CASES, golden, RECIPE, RUN_CASES } from "./run-cases.testing.js";

// The run contract has two dialects rendered from one spec: the `docker run` argv, held byte-for-byte to what it emitted
// before the spec existed, and the Compose file. `INTENTIC_WRITE_GOLDEN=1` rewrites the goldens.

test("the argv is the one the emitter wrote before it was rendered from a spec, for every case", () => {
    const { onDisk, expected } = golden("run-argv.json", asJson(Object.fromEntries(Object.entries(RUN_CASES).map(([name, run]) => [name, sandboxRunArgv(run)]))));
    expect(onDisk).toBe(expected);
});

test.each(Object.entries(COMPOSE_CASES))("golden/compose-%s.yaml is the Compose rendering of the case", (name, { run, inputs }) => {
    const { onDisk, expected } = golden(`compose-${name}.yaml`, sandboxCompose(run, inputs).compose);
    expect(onDisk).toBe(expected);
});

// ic keeps KEY_MOUNT and KEY_ENV in at_rest.rs; its test holds them to this file.
test("golden/at-rest.json is where the run contract mounts the at-rest key", () => {
    const { onDisk, expected } = golden("at-rest.json", asJson({ keyMount: AT_REST_KEY_MOUNT, keyEnv: AT_REST_KEY_ENV }));
    expect(onDisk).toBe(expected);
});

const full = () => sandboxCompose(COMPOSE_CASES.full.run, COMPOSE_CASES.full.inputs);

test("a credential is a variable of the .env, never a value in the file, and comes back for the .env", () => {
    const { compose, env } = full();
    expect(compose).toContain("CONNECT_TOKEN: ${CONNECT_TOKEN:?run the .env bootstrap first}");
    expect(compose).not.toContain("ict_secret");
    expect(compose).not.toContain("BEGIN KEY");
    expect(env["CONNECT_TOKEN"]).toBe("ict_secret$value");
    expect(env["HOST_SSH_KEY"]).toContain("\n");
    // The loopback port derives from the id, as the run line's does, and rides in the .env.
    expect(env["LOCAL_PORT"]).toBe(sandboxRunArgv(RUN_CASES.full).find((arg) => arg.startsWith("127.0.0.1:"))?.split(":")[1]);
});

test("the .env quotes each value with a delimiter it does not hold, so Compose reads a `$` and a newline as they are", () => {
    expect(composeEnvFile({ A: "x$y", B: "it's" })).toBe(`A='x$y'\nB="it's"\n`);
});

test("what the hand-written files missed rides: stop grace, key bind, caps, directive stamps, side stamps, manager", () => {
    const { compose } = full();
    expect(compose).toContain(`stop_grace_period: ${STOP_TIMEOUT_SECONDS}s`);
    expect(compose).toContain(`- "./at-rest.key:${AT_REST_KEY_MOUNT}:ro"`);
    expect(compose).toContain(`${AT_REST_KEY_ENV}: "${AT_REST_KEY_MOUNT}"`);
    // The run line's own key mount is replaced by the one beside the file, never mounted twice.
    expect(compose).not.toContain("/home/a/.intentic/keys");
    expect(compose).toContain("mem_limit: 12g");
    expect(compose).toContain("memswap_limit: 14g");
    expect(compose).toContain("cpus: 4");
    expect(compose).toContain("cap_add: [SYS_ADMIN, SYS_PTRACE, NET_ADMIN]");
    expect(compose).toContain(`devices: ["/dev/net/tun:/dev/net/tun"]`);
    expect(compose).toContain("privileged: true");
    expect(compose).toContain(`SANDBOX_OVERLAY_RUNTIME: "--privileged"`);
    expect(compose).toContain(`HOST_PLATFORM: "linux"`);
    expect(compose).toContain(`HOST_ENV: "native"`);
    expect(compose).toContain(`SANDBOX_MANAGER: "compose"`);
    expect(compose).toContain(`SANDBOX_ENVIRONMENT_HASH: "${RECIPE.hash}"`);
});

test("a GPU rides as `gpus: all` with its stamp, and one this host failed its probe for is dropped and stamped so", () => {
    const asked = sandboxCompose(RUN_CASES.noPublish).compose;
    expect(asked).toContain("gpus: all");
    expect(asked).toContain(`SANDBOX_GPU: "all"`);
    // No loopback shortcut when the run asked for none.
    expect(asked).not.toContain("ports:");
    const dropped = sandboxCompose(RUN_CASES.full).compose;
    expect(dropped).not.toContain("gpus: all");
    expect(dropped).toContain(`SANDBOX_GPU: "unsupported"`);
});

test("a host the renderer cannot measure gets no cgroup caps rather than the fallback sized for another machine", () => {
    const { compose } = sandboxCompose(COMPOSE_CASES.fresh.run, COMPOSE_CASES.fresh.inputs);
    expect(compose).not.toContain("mem_limit");
    expect(sandboxCompose(RUN_CASES.bare).compose).toContain("mem_limit: 7g");
});

test("a recipe with steps is built by Compose, its `$` doubled; without steps the image is pulled", () => {
    const { compose } = full();
    expect(compose).toContain(`image: "intentic-sandbox-env-abc-123:0123456789ab"`);
    expect(compose).toContain("pull_policy: build");
    expect(compose).toContain(`RUN ln -sf "/opt/x-$$(node -p 'process.arch')" /usr/local/bin/x`);
    expect(compose).toContain(`SANDBOX_IMAGE: "intentic-sandbox-env-abc-123:0123456789ab"`);
    const plain = sandboxCompose(COMPOSE_CASES.fresh.run, { recipe: { hash: RECIPE.hash, content: "FROM x\n# intentic:runtime --privileged\n" } }).compose;
    expect(plain).toContain("pull_policy: always");
    expect(plain).toContain("privileged: true");
    expect(plain).not.toContain("build:");
});

test("a heredoc's body is kept whole in the inline Dockerfile; the recipe's own comments are not", () => {
    expect(recipeBuildLines(RECIPE.content)).toEqual([
        "FROM ghcr.io/intentic/sandbox:stable",
        `RUN ln -sf "/opt/x-$(node -p 'process.arch')" /usr/local/bin/x`,
        "RUN <<EOF cat > /usr/local/bin/hello",
        "#!/bin/sh",
        "",
        "echo hi",
        "EOF",
    ]);
});

test("storage that exists is external, so `compose down` never deletes a workspace; a new sandbox's is Compose's own", () => {
    expect(full().compose).toContain("        name: intentic-workspace-abc-123\n        external: true");
    expect(sandboxCompose(COMPOSE_CASES.fresh.run, COMPOSE_CASES.fresh.inputs).compose).not.toContain("external: true");
});

test("a variable only the .env knows is read from it, required or optional as asked", () => {
    const { compose, env } = sandboxCompose(COMPOSE_CASES.fresh.run, COMPOSE_CASES.fresh.inputs);
    expect(compose).toContain("CONNECT_TOKEN: ${CONNECT_TOKEN:?run the .env bootstrap first}");
    expect(compose).toContain("OWNER_EMAIL: ${OWNER_EMAIL:-}");
    expect(env).toEqual({});
});
