// Run linux-host-prune.sh against a docker that only records what it is asked: a deployment's container or volume
// must never be in what it removes, stopped or not. On z440 it removed a Komodo-run sandbox's container a day after the
// keeper put it to sleep, then its volumes with `volume prune -a` (2026-11-12), and the auto-translate stack's data
// after a reboot (2026-11-17).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const script = join(import.meta.dirname, "linux-host-prune.sh");

// `docker container ls` answers from PRUNE_TEST_CONTAINERS; every call is appended to PRUNE_TEST_CALLS.
const dockerStub = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$PRUNE_TEST_CALLS"
if [ "$1 $2" = "container ls" ]; then cat "$PRUNE_TEST_CONTAINERS"; fi
exit 0
`;
const stubs = {
    docker: dockerStub,
    // No job running, so the full pass (volumes included) runs.
    pgrep: "#!/usr/bin/env bash\n[ \"$1\" = -cx ] && echo 0\nexit 1\n",
    // Half full: an idle pass, not a pressure one.
    df: '#!/usr/bin/env bash\necho header\ncase "$*" in *pcent*) echo " 50%" ;; *) echo " 1G 1G" ;; esac\n',
    systemctl: "#!/usr/bin/env bash\nexit 0\n",
    // `ctr content active`: a header, and one in-flight ingest when PRUNE_TEST_INGEST is set.
    ctr: '#!/usr/bin/env bash\nprintf "REF\\tSIZE\\tAGE\\n"\n[ -n "${PRUNE_TEST_INGEST:-}" ] && printf "tar-blobs/sha256/2fbb\\t118558746\\t47s\\n"\nexit 0\n',
};

// docker's CreatedAt format, in UTC.
const createdAt = (hoursAgo) => `${new Date(Date.now() - hoursAgo * 3_600_000).toISOString().slice(0, 19).replace("T", " ")} +0000 UTC`;

const prune = (containers, { ingest = false } = {}) => {
    const root = mkdtempSync(join(tmpdir(), "linux-host-prune-test-"));
    try {
        const bin = join(root, "bin");
        mkdirSync(bin);
        for (const [name, source] of Object.entries(stubs)) {
            writeFileSync(join(bin, name), source);
            chmodSync(join(bin, name), 0o755);
        }
        const calls = join(root, "calls");
        const listing = join(root, "containers");
        writeFileSync(calls, "");
        writeFileSync(listing, containers.map((row) => `${row.join("\t")}\n`).join(""));
        const result = spawnSync("bash", [script], {
            encoding: "utf8",
            env: {
                ...process.env,
                PATH: `${bin}:${process.env.PATH}`,
                PRUNE_TEST_CALLS: calls,
                PRUNE_TEST_CONTAINERS: listing,
                PRUNE_STATE_DIR: join(root, "state"),
                PRUNE_RUNNERS_GLOB: join(root, "no-runners-*"),
                PRUNE_RUNNER_CACHE: join(root, "no-cache"),
                PRUNE_TEST_INGEST: ingest ? "1" : "",
            },
        });
        assert.equal(result.status, 0, result.stderr);
        return readFileSync(calls, "utf8").trim().split("\n");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
};

test("only a CI container stopped for over a day is removed; a deployment's never is", () => {
    const calls = prune([
        ["old-ci", createdAt(30), "", ""],
        ["young-ci", createdAt(2), "", ""],
        ["komodo-stack", createdAt(30), "auto-translate", ""],
        ["asleep-sandbox", createdAt(30), "", "sandbox"],
        ["compose-sandbox", createdAt(30), "translations-sandbox", "sandbox"],
        ["unparseable", "sometime", "", ""],
    ]);
    const removed = calls.filter((call) => call.startsWith("container rm"));
    assert.deepEqual(removed, ["container rm old-ci"]);
    assert.ok(!calls.some((call) => call.startsWith("container prune")), "container prune takes any stopped container");
});

test("nothing to remove asks docker to remove nothing", () => {
    const calls = prune([["komodo-stack", createdAt(30), "auto-translate", ""]]);
    assert.ok(!calls.some((call) => call.startsWith("container rm")));
});

test("the volume prune takes anonymous volumes and testcontainers', never every unused named one", () => {
    const volumes = prune([]).filter((call) => call.startsWith("volume prune"));
    assert.deepEqual(volumes, ["volume prune -f", "volume prune -af --filter label=org.testcontainers=true"]);
});

test("the network prune leaves a compose project's networks", () => {
    const networks = prune([]).filter((call) => call.startsWith("network prune"));
    assert.deepEqual(networks, ["network prune -f --filter until=24h --filter label!=com.docker.compose.project"]);
});

test("images and build cache wait while docker is writing an image; volumes do not", () => {
    const writing = prune([], { ingest: true });
    assert.ok(!writing.some((call) => /^(image|builder) prune/.test(call)), writing.join("\n"));
    assert.ok(writing.includes("volume prune -f"));
    const quiet = prune([]);
    assert.ok(quiet.includes("image prune -f --filter until=1h"));
    assert.ok(quiet.some((call) => call.startsWith("builder prune")));
});
