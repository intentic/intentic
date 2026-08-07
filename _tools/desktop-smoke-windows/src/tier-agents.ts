/* TIER 3 — from this Windows machine, is the sandbox REACHABLE, is its gate real, and does one /agents turn
 * complete?
 *
 * The three questions tier 2 deliberately stops short of. Tier 2 asks the daemon whether it is alive from
 * INSIDE its own container, which is the right question for "did setup work" and the wrong one for "can this
 * machine use it" — the address a browser dials, the credential it presents and the answer it gets back are
 * all outside that container.
 *
 * HOW A BROWSER FINDS IT. A sandbox on the same machine as the browser does not go through Cloudflare: the
 * container publishes its loopback listener on a host port DERIVED from the sandbox id, and the browser
 * computes that address rather than being told it. So this tier derives it the same way, from the same
 * function — `localDaemonPort` in `@intentic/sandbox-run`, never a copy of the arithmetic. If the publish is
 * broken on Windows, every local user's workspace silently falls back to the tunnel and nobody finds out here.
 *
 * HOW A PROGRAM AUTHENTICATES. Not by pretending to be a browser. The daemon verifies a real Google ID token
 * on every route but /health, which no CI job can mint — so this uses the credential the product provides for
 * exactly this case: a CONTROL TOKEN, the thing "anything outside the browser presents to drive this sandbox",
 * at `drive` scope, which reaches `POST /agent` and the fleet reads and stops short of landing anything.
 *
 * The token is SEEDED rather than minted, because minting is owner-gated and the owner is a person with a
 * Google account. Seeding writes the store the daemon reads, inside the container, as root — the same shape of
 * move the browser tier makes when it seeds a signed session cookie instead of signing in to Google. Both are
 * the harness standing in for the one step a machine cannot take, and both are worth naming as such.
 *
 * HOW AN ACCOUNT IS CONNECTED. This is the one thing CI cannot fake, and the tier does not try: connecting an
 * AI account is a subscription OAuth flow through a browser. What it uses instead is the product's own answer
 * to "several sandboxes, one set of credentials" — a shared agent-auth VOLUME. Connect an account once, by
 * hand, in the runner's snapshot; every sandbox this tier creates mounts that volume and comes up already
 * connected. Absent the volume the turn stands down NAMING it, exactly as the repo's other gated tiers do:
 * a tier that cannot reach its credential has nothing to say, and must not fail.
 */

import { localDaemonPort } from "@intentic/sandbox-run";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { CONNECT_TOKEN } from "./constants.js";
import type { Harness } from "./harness.js";
import { controlTokenStore } from "./parse.js";
import { run } from "./run.js";

export interface AgentsTierOptions {
    /** The container tier 2 brought up. */
    readonly container: string;
    /**
     * A Docker volume holding an already-connected AI account, mounted at /agent-auth by the setup. Absent ⇒
     * the turn stands down naming it, and everything up to the turn still runs.
     */
    readonly agentAuthVolume: string | undefined;
    /** How long one turn may take before this gives up on it. */
    readonly turnSeconds: number;
}

/* The prompt. Deliberately the smallest thing that can only be answered by a model actually running: no tools,
 * no files, one word back. A turn that "worked" because the harness short-circuited it would prove nothing, and
 * a long prompt buys nothing but a slower nightly and more ways to be flaky. */
const PROMPT = `Reply with exactly the word: ready`;
const EXPECTED = `ready`;

const STORE_PATH = `/work/.intentic/control-tokens.json`;

/** sha256, computed by the container so the digest is the one that container's own code would compute. */
const seedControlToken = async (container: string, token: string): Promise<boolean> => {
    const digest = await run(`docker`, [`exec`, container, `sh`, `-c`, `printf %s "${token}" | sha256sum | cut -d" " -f1`]);
    if (digest.code !== 0) {
        return false;
    }
    const store = controlTokenStore(digest.stdout.trim());
    const write = await run(`docker`, [`exec`, container, `sh`, `-c`, `mkdir -p /work/.intentic && cat > ${STORE_PATH} <<'STORE'\n${store}\nSTORE`]);
    return write.code === 0;
};

interface DaemonCall {
    readonly status: number;
    readonly body: string;
}

/* Spoken from the Windows host over the derived loopback address — the whole point of the tier. `fetch` rather
 * than a curl inside the container: a call made from inside would go through neither the publish nor the host's
 * own network stack, which is exactly the half tier 2 already covered. */
const callDaemon = async (port: number, path: string, token: string | undefined, body?: unknown): Promise<DaemonCall> => {
    const headers: Record<string, string> = { "content-type": `application/json` };
    if (token !== undefined) {
        headers[`x-intentic-control`] = token;
    }
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: body === undefined ? `GET` : `POST`,
        headers,
        // Spread rather than an explicit `undefined`: a GET with a `body` key present at all is a different
        // request to fetch, whatever the value is.
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(60_000),
    });
    return { status: response.status, body: await response.text() };
};

export const runAgentsTier = async (harness: Harness, options: AgentsTierOptions): Promise<void> => {
    const sandboxId = sandboxIdFromToken(CONNECT_TOKEN);
    if (sandboxId === undefined) {
        harness.fail(`no sandbox id derives from the connect token`, `The token this tier's setup used is not one a sandbox id can be read from.`);
        return;
    }
    const port = localDaemonPort(sandboxId);

    // ── reachable from the host, at the address the browser derives ──────────────────────────────────────
    harness.section(`the loopback shortcut (port ${port}, derived from sandbox ${sandboxId})`);
    const reachable = await harness.untilTrue(60, `the daemon answers /health on the host's loopback`, async () => {
        const health = await callDaemon(port, `/health`, undefined);
        return health.status === 200;
    });
    if (!reachable) {
        harness.detail(
            `The container publishes its loopback listener on this port so a browser on this machine can skip the tunnel.\n` +
                `Nothing answering means the publish did not happen — every local workspace would fall back to the tunnel.`,
        );
        return;
    }

    // ── the gate is real ─────────────────────────────────────────────────────────────────────────────────
    // Asserted before the credential is used, and worth asserting because the failure it guards is silent: a
    // daemon that answers everything to everyone looks identical, from every other assertion here, to one that
    // is correctly gated. The daemon refuses to boot at all in that state — this proves it did not.
    const unauthenticated = await callDaemon(port, `/agents`, undefined);
    if (unauthenticated.status === 401 || unauthenticated.status === 403) {
        harness.pass(`an uncredentialed call is refused (${unauthenticated.status})`);
    } else {
        harness.fail(`an uncredentialed /agents answered ${unauthenticated.status}`, `This daemon is reachable and ungated.`);
    }

    // ── the credential a program is meant to use ─────────────────────────────────────────────────────────
    harness.section(`driving it with a control token`);
    const token = `ict_windows_smoke_${sandboxId}`;
    if (!(await seedControlToken(options.container, token))) {
        harness.fail(`could not seed a drive-scoped control token into ${options.container}`);
        return;
    }
    harness.pass(`a drive-scoped control token is in place`);

    const fleet = await callDaemon(port, `/agents`, token);
    if (fleet.status === 200) {
        harness.pass(`/agents answers the control token`);
    } else {
        harness.fail(`/agents answered ${fleet.status} to a drive-scoped token`, fleet.body.slice(0, 500));
        return;
    }

    // ── one turn ─────────────────────────────────────────────────────────────────────────────────────────
    if (options.agentAuthVolume === undefined) {
        harness.section(`one /agents turn — stood down, no INTENTIC_AGENT_AUTH_VOLUME`);
        harness.pass(`everything up to the turn passed. Connect an AI account once on this machine and name its volume to run the turn too.`);
        return;
    }

    harness.section(`one /agents turn`);
    const started = await callDaemon(port, `/agent`, token, { prompt: PROMPT, title: `windows smoke` });
    if (started.status !== 200) {
        harness.fail(`starting a turn answered ${started.status}`, started.body.slice(0, 800));
        return;
    }
    harness.pass(`the turn started`);

    /* Completion is read from the fleet registry rather than the attach stream: `/agents` is a plain GET whose
     * body says whether a conversation is still running, and a poll over it needs no event-stream client in a
     * tier whose subject is Windows rather than transports. The attach path is covered where it belongs, in the
     * daemon's own suites. */
    const done = await harness.untilTrue(options.turnSeconds, `the turn completed`, async () => {
        const state = await callDaemon(port, `/agents`, token);
        return state.status === 200 && !state.body.includes(`"running"`);
    });
    if (!done) {
        harness.detail((await callDaemon(port, `/agents`, token)).body.slice(0, 1_500));
        return;
    }

    const transcript = await callDaemon(port, `/sessions`, token);
    if (transcript.status === 200 && transcript.body.toLowerCase().includes(EXPECTED)) {
        harness.pass(`the agent replied, and the reply reached the transcript`);
    } else {
        harness.fail(
            `no reply containing "${EXPECTED}" in the transcript`,
            `An account is connected and a turn ran, so this is the turn failing rather than the plumbing.\n${transcript.body.slice(0, 800)}`,
        );
    }
};
