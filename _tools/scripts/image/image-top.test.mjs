// Pins what an environment build replays of an image's `runtime` stage (image-top.mjs): the paths one copy carries, the
// RUNs and config kept in order, and what keeps a recipe step above the replay.
import assert from "node:assert/strict";
import { test } from "node:test";
import { imageTop, imageTopLabel } from "./image-top.mjs";

const dockerfile = `FROM node:24 AS tools
RUN apt-get install -y git
COPY --link --from=trees layers/starter/ /

# ---- runtime
FROM tools AS runtime

# image-top: /opt/extensions
COPY --link --from=trees layers/messaging-deps/ /
COPY --from=trees cli /opt/intentic-cli
RUN chmod +x /opt/intentic-cli/dist/cli.js \\
    && ln -s /opt/intentic-cli/dist/cli.js /usr/local/bin/intentic
COPY --from=trees sandbox /opt/sandbox
COPY --from=trees netd /opt/sandbox/netd
COPY _extensions/connectors /opt/extensions/connectors
COPY --chmod=755 _sandbox/sandbox/bin/vpn _sandbox/sandbox/bin/heavy-shims /usr/local/bin/
RUN fileq git-attributes > /etc/gitattributes \\
    # a comment Docker drops
    && mkdir -p /etc/fileq /etc/other
WORKDIR /work
ENV LANG=C.utf8 SHELL=/bin/bash \\
    DO_NOT_TRACK=1
EXPOSE 8787 22
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]`;

const directories = new Map([["_sandbox/sandbox/bin/heavy-shims", ["pnpm", "cargo"]]]);
const inspect = (source) => (directories.has(source) ? { entries: directories.get(source) } : {});

test("one copy carries every path the stage's COPYs write, under the roots that hold them", () => {
    const [copy] = imageTop(dockerfile, inspect).replay.split("\n");
    // /opt/sandbox/netd under /opt/sandbox, the connectors under the static root's /opt/extensions; a file into a `/`
    // destination lands under its name, and a directory's entries merge into it one by one, never the shared directory.
    assert.equal(
        copy,
        "COPY --link --parents --from=sandbox-image /opt/extensions /opt/intentic-cli /opt/sandbox /usr/local/bin/cargo /usr/local/bin/pnpm /usr/local/bin/vpn /",
    );
});

test("RUNs replay in order after the copy, then the config, and ENV and WORKDIR are the prelude", () => {
    const top = imageTop(dockerfile, inspect);
    const lines = top.replay.split("\n");
    assert.equal(lines[1], "RUN chmod +x /opt/intentic-cli/dist/cli.js \\");
    assert.ok(top.replay.includes("&& mkdir -p /etc/fileq /etc/other"));
    assert.ok(!top.replay.includes("a comment Docker drops"));
    assert.deepEqual(lines.slice(-2), ["EXPOSE 8787 22", 'ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]']);
    assert.equal(top.prelude, "WORKDIR /work\nENV LANG=C.utf8 SHELL=/bin/bash \\\n    DO_NOT_TRACK=1");
    assert.deepEqual(top.env, ["DO_NOT_TRACK", "LANG", "SHELL"]);
});

test("what the top writes outside the copy, and the commands its RUNs install, keep a recipe step above it", () => {
    const top = imageTop(dockerfile, inspect);
    assert.deepEqual(top.commands, ["intentic"]);
    for (const path of ["/etc/gitattributes", "/etc/fileq", "/etc/other", "/usr/local/bin/intentic", "/opt/sandbox"]) {
        assert.ok(top.touches.includes(path), path);
    }
    assert.ok(!top.touches.includes("/opt/sandbox/netd"), "a path under a root is the root's");
});

test("a static layer root with no paths named, or an instruction that cannot be replayed, is refused", () => {
    assert.throws(() => imageTop(dockerfile.replace("# image-top: /opt/extensions\n", ""), inspect), /names no paths/u);
    assert.throws(() => imageTop(`${dockerfile}\nARG VERSION=1`, inspect), /cannot be replayed onto an environment with ARG/u);
    assert.throws(() => imageTop(`${dockerfile}\nCOPY --from=alpine /bin/sh /bin/sh2`, inspect), /only from the trees context/u);
    assert.throws(() => imageTop("FROM node:24\nRUN true", inspect), /no "FROM tools AS runtime" line/u);
    assert.throws(() => imageTop(dockerfile, () => undefined), /file or a directory/u);
    assert.throws(() => imageTop(`${dockerfile}\nCOPY _sandbox/sandbox/bin /usr/local/bin`, inspect), /writes \/usr\/local\/bin whole/u);
});

test("the label holds the JSON in single quotes with no quote or `$` of its own", () => {
    const top = { format: 1, replay: `RUN printf '%s' "$@"` };
    const label = imageTopLabel(top);
    const quoted = /^LABEL dev\.intentic\.image-top='(.*)'$/u.exec(label)?.[1] ?? "";
    assert.ok(!quoted.includes("'") && !quoted.includes("$"), quoted);
    assert.deepEqual(JSON.parse(quoted), top);
});
