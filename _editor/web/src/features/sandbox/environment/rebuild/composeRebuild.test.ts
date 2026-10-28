import { composeRebuildOf } from "./composeRebuild";

// The edit a Compose-run sandbox's file needs for an approved recipe: lines indented as the sandbox service's keys,
// pasted under it as they stand.

const HASH = `0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`;
const HEADER = `# Composed by the intentic sandbox daemon: do not edit by hand.\n\nFROM ghcr.io/intentic/sandbox:stable\n`;
const DOCKER = `# docker capability: this directive grants dockerd the privileges it needs\n# intentic:runtime --privileged`;

it(`turns the docker capability on a base that carries the engine into privileged: true and the hash, with no build`, () => {
    const edit = composeRebuildOf(HASH, `${HEADER}\n${DOCKER}\n`);
    expect(edit.builds).toBe(false);
    expect(edit.snippet).toBe(`    privileged: true`);
    expect(edit.hashEnv).toBe(`SANDBOX_ENVIRONMENT_HASH=${HASH}`);
});

it(`says each runtime directive as the service key granting it, keeping the capabilities the file already adds`, () => {
    const edit = composeRebuildOf(HASH, `${HEADER}\n# intentic:runtime --cap-add=NET_ADMIN --device=/dev/net/tun\n# intentic:runtime --gpus=all\n`);
    expect(edit.snippet.split(`\n`)).toEqual([
        `    cap_add: [SYS_ADMIN, SYS_PTRACE, NET_ADMIN]`,
        `    devices: ["/dev/net/tun:/dev/net/tun"]`,
        `    gpus: all`,
    ]);
});

it(`builds a recipe with steps inline, doubling $ so Compose does not read the recipe's shell as its own variables`, () => {
    const steps = `RUN apt-get install -y ripgrep\nRUN ln -sf "/opt/x-$(node -p 'process.arch')" /usr/local/bin/x`;
    const edit = composeRebuildOf(HASH, `${HEADER}\n${steps}\n\n${DOCKER}\n`);
    expect(edit.builds).toBe(true);
    const lines = edit.snippet.split(`\n`);
    expect(lines.slice(0, 1)).toEqual([`    privileged: true`]);
    expect(lines).toContain(`    image: intentic-sandbox-environment:0123456789ab`);
    expect(lines).toContain(`    pull_policy: build`);
    expect(lines).toContain(`        pull: true`);
    expect(lines).toContain(`        dockerfile_inline: |`);
    expect(lines).toContain(`            FROM ghcr.io/intentic/sandbox:stable`);
    expect(lines).toContain(`            RUN ln -sf "/opt/x-$$(node -p 'process.arch')" /usr/local/bin/x`);
});

// The owner read a dozen lines of the daemon's own commentary before the first step that builds anything: the file
// gets the instructions, and Docker would have dropped the rest anyway.
it(`leaves the recipe's comments and blank lines out of the inline Dockerfile`, () => {
    const edit = composeRebuildOf(HASH, `${HEADER}\n# ---- ffmpeg ----\n# Encodes screen recordings.\nRUN apt-get update \\\n    && apt-get install -y ffmpeg\n\n${DOCKER}\n`);
    const inline = edit.snippet.split(`\n`).slice(edit.snippet.split(`\n`).indexOf(`        dockerfile_inline: |`) + 1);
    expect(inline).toEqual([`            FROM ghcr.io/intentic/sandbox:stable`, `            RUN apt-get update \\`, `                && apt-get install -y ffmpeg`]);
});

// A `#` inside a heredoc is the script's own line, and a blank one is part of the file it writes.
it(`keeps a heredoc's body whole, comments and blank lines included`, () => {
    const steps = `RUN <<EOF cat > /usr/local/bin/hello\n#!/bin/sh\n\n# greets\necho hi\nEOF\n# after\nRUN true`;
    const lines = composeRebuildOf(HASH, `${HEADER}\n${steps}\n`).snippet.split(`\n`);
    const at = lines.indexOf(`            RUN <<EOF cat > /usr/local/bin/hello`);
    expect(lines.slice(at)).toEqual([
        `            RUN <<EOF cat > /usr/local/bin/hello`,
        `            #!/bin/sh`,
        ``,
        `            # greets`,
        `            echo hi`,
        `            EOF`,
        `            RUN true`,
    ]);
});

it(`tags the built image from the hash's hex, so a prefixed hash still names a valid image`, () => {
    expect(composeRebuildOf(`sha256:${HASH}`, `${HEADER}RUN true\n`).snippet).toContain(`image: intentic-sandbox-environment:0123456789ab\n`);
});

it(`asks only for the hash when the recipe neither builds nor grants anything`, () => {
    const edit = composeRebuildOf(HASH, HEADER);
    expect(edit.snippet).toBe(``);
    expect(edit.builds).toBe(false);
});
