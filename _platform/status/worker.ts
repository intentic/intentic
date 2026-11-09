/* THE STATUS PAGE (Worker `intentic-status`, for status.intentic.dev): whether the platform is up, asked from somewhere
that is not the platform's own box.

Every minute (wrangler.jsonc `triggers`) it asks the three public doors in parallel, each with its own short timeout:
the api, the editor, and the sandbox edge. Each answer becomes a sample in one Durable Object (StatusLog, SQLite),
which keeps a day of them and holds each component's confirmed state. A state is confirmed by two samples in a row,
so one dropped request is not an outage and one good answer in the middle of one is not a recovery; a confirmed change
is posted to ALERT_WEBHOOK_URL (a Discord-compatible webhook) when that secret is set.

GET / is the page, GET /api/status the same as JSON, open to any origin: the editor reads it to tell an outage it
cannot reach the platform through from one in the reader's own network. */

import { DurableObject } from "cloudflare:workers";

interface Env {
    readonly STATUS: DurableObjectNamespace<StatusLog>;
    /** Optional secret: where confirmed changes are posted, as `{ content }`. Unset, nothing is sent. */
    readonly ALERT_WEBHOOK_URL?: string;
    /** The page's public address, linked from alerts (wrangler.jsonc `vars`). */
    readonly PAGE_URL: string;
}

type ComponentId = `api` | `editor` | `edge`;
type State = `operational` | `degraded` | `down`;

// One answer to one probe.
interface Sample {
    readonly id: ComponentId;
    readonly at: number;
    readonly state: State;
    readonly latencyMs: number | null;
    readonly detail: string;
}

// A confirmed change of one component's state, for the alert.
interface Transition {
    readonly id: ComponentId;
    readonly from: State;
    readonly to: State;
    readonly since: number;
    readonly previousSince: number;
    readonly detail: string;
}

interface ComponentNow {
    readonly id: ComponentId;
    readonly state: State;
    readonly since: number;
    readonly latencyMs: number | null;
    readonly detail: string;
    readonly checkedAt: number;
}

interface Snapshot {
    readonly updatedAt: number | null;
    readonly components: readonly ComponentNow[];
    readonly history: readonly Sample[];
}

// Past this, a probe that is answered well too late; the box answers in tens of milliseconds when well.
const PROBE_TIMEOUT_MS = 8_000;
// The editor's probe waits past the edge Worker's navigation deadline (_editor/web/edge/worker.ts
// NAVIGATION_DEADLINE_MS, 10 s), so a hung box is reported as served from the edge copy (degraded) rather than down
// before that copy can answer (code review, 2026-11-09).
const EDITOR_PROBE_TIMEOUT_MS = 13_000;
// Answered right but this slow: degraded, since a person waiting on it feels it.
const SLOW_MS = 4_000;
// How much history is kept and drawn.
const DAY_MS = 24 * 60 * 60 * 1000;
// The day's bar, in slices of this many minutes, each drawn as the worst state sampled in it.
const SLICE_MINUTES = 15;
// The one Durable Object every sample goes to.
const LOG_NAME = `intentic`;
const RANK = { operational: 0, degraded: 1, down: 2 } satisfies Record<State, number>;

// What a probe reads off the answer: its verdict on a response that arrived in time.
type Judge = (response: Response) => Promise<{ readonly state: State; readonly detail: string }>;

interface Component {
    readonly id: ComponentId;
    readonly name: string;
    readonly about: string;
    readonly url: string;
    // How long its probe waits; PROBE_TIMEOUT_MS unless said.
    readonly timeoutMs?: number;
    readonly judge: Judge;
}

// The body of a JSON answer, or undefined when it is not JSON; read as a record of whatever it holds.
const jsonOf = async (response: Response): Promise<Record<string, string | number | boolean | null> | undefined> => {
    try {
        // SAFETY: only ever read by key and compared against literals below, so a value of another shape compares unequal.
        return (await response.json()) as Record<string, string | number | boolean | null>;
    } catch {
        // allow(silent-catch): a body that is not JSON is exactly what undefined says here; the caller judges the status.
        return undefined;
    }
};

const httpDetail = (response: Response): string => `answered HTTP ${response.status}`;

const COMPONENTS: readonly Component[] = [
    {
        id: `api`,
        name: `Platform API`,
        about: `Sign-in, accounts and the sandbox directory (api.intentic.dev)`,
        // Answers only once the database does: it reads the platform's identity row. /health is the same database
        // ping and answers {"status":"ok"} (503 {"status":"error"} without it); this one is what the editor asks first.
        url: `https://api.intentic.dev/api/identity`,
        judge: async (response) => {
            if (response.status !== 200) {
                return { state: `down`, detail: response.status === 503 ? `the database is not answering` : httpDetail(response) };
            }
            const body = await jsonOf(response);
            return body?.identity === undefined || body.identity === null ? { state: `down`, detail: `answered without an identity` } : { state: `operational`, detail: `` };
        },
    },
    {
        id: `editor`,
        name: `Editor`,
        about: `The app at app.intentic.dev`,
        // Once the edge Worker fronts it (_editor/web/edge), a dead origin is answered from the edge copy: the editor
        // still loads and opens sandboxes directly, but sign-in and everything else the platform does is gone.
        url: `https://app.intentic.dev/`,
        timeoutMs: EDITOR_PROBE_TIMEOUT_MS,
        judge: async (response) => {
            const fromEdge = response.headers.get(`x-intentic-served-by`) === `edge-fallback`;
            const html = response.status === 200 && (response.headers.get(`content-type`) ?? ``).includes(`text/html`) && (await response.text()).includes(`id="app"`);
            if (!html) {
                return { state: `down`, detail: response.status === 200 ? `answered something that is not the editor` : httpDetail(response) };
            }
            return fromEdge ? { state: `degraded`, detail: `served from the edge copy: its origin is down` } : { state: `operational`, detail: `` };
        },
    },
    {
        id: `edge`,
        name: `Sandbox edge`,
        about: `How browsers and agents reach sandboxes (ingress.sbx.intentic.dev)`,
        url: `https://ingress.sbx.intentic.dev/health`,
        judge: async (response) => {
            if (response.status !== 200) {
                return { state: `down`, detail: httpDetail(response) };
            }
            const body = await jsonOf(response);
            return body?.status === `ok` ? { state: `operational`, detail: `` } : { state: `down`, detail: `reports status ${String(body?.status ?? `unreadable`)}` };
        },
    },
];
const COMPONENT_BY_ID = new Map(COMPONENTS.map((component) => [component.id, component]));

// One probe: the verdict, or down with why when there is no answer in time. Latency is to the whole answer.
const probe = async (component: Component, at: number): Promise<Sample> => {
    const started = Date.now();
    const timeoutMs = component.timeoutMs ?? PROBE_TIMEOUT_MS;
    try {
        const response = await fetch(component.url, {
            signal: AbortSignal.timeout(timeoutMs),
            redirect: `manual`,
            headers: { accept: `text/html, application/json`, "user-agent": `intentic-status (+https://status.intentic.dev)` },
        });
        const verdict = await component.judge(response);
        const latencyMs = Date.now() - started;
        if (verdict.state === `operational` && latencyMs > SLOW_MS) {
            return { id: component.id, at, state: `degraded`, latencyMs, detail: `slow: ${(latencyMs / 1000).toFixed(1)} s to answer` };
        }
        return { id: component.id, at, latencyMs, ...verdict };
    } catch (cause) {
        const timedOut = cause instanceof Error && (cause.name === `TimeoutError` || cause.name === `AbortError`);
        return { id: component.id, at, state: `down`, latencyMs: null, detail: timedOut ? `no answer within ${timeoutMs / 1000} s` : `unreachable` };
    }
};

// Every component at once, stamped with one time so a minute's samples line up.
const probeAll = (at: number): Promise<Sample[]> => Promise.all(COMPONENTS.map((component) => probe(component, at)));

const worst = (states: readonly State[]): State => states.reduce<State>((acc, state) => (RANK[state] > RANK[acc] ? state : acc), `operational`);

// THE LOG: samples and confirmed states, in this Durable Object's own SQLite (no KV on this account's token, and a
// day of three probes a minute is a few thousand rows).
export class StatusLog extends DurableObject<Env> {
    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        const { sql } = ctx.storage;
        sql.exec(`CREATE TABLE IF NOT EXISTS samples (
            component TEXT NOT NULL, at INTEGER NOT NULL, state TEXT NOT NULL, latency_ms INTEGER, detail TEXT NOT NULL,
            PRIMARY KEY (component, at))`);
        sql.exec(`CREATE TABLE IF NOT EXISTS components (component TEXT PRIMARY KEY, state TEXT NOT NULL, since INTEGER NOT NULL)`);
    }

    // Keep a minute's samples, drop what is older than a day, and say which components changed confirmed state.
    record(samples: readonly Sample[]): Transition[] {
        const { sql } = this.ctx.storage;
        const transitions: Transition[] = [];
        for (const sample of samples) {
            const [previous] = sql
                .exec<{ state: State; at: number }>(`SELECT state, at FROM samples WHERE component = ? AND at < ? ORDER BY at DESC LIMIT 1`, sample.id, sample.at)
                .toArray();
            sql.exec(
                `INSERT OR REPLACE INTO samples (component, at, state, latency_ms, detail) VALUES (?, ?, ?, ?, ?)`,
                sample.id,
                sample.at,
                sample.state,
                sample.latencyMs,
                sample.detail,
            );
            const [confirmed] = sql.exec<{ state: State; since: number }>(`SELECT state, since FROM components WHERE component = ?`, sample.id).toArray();
            if (confirmed === undefined) {
                // The very first sample is the state: there is nothing to have changed from.
                sql.exec(`INSERT INTO components (component, state, since) VALUES (?, ?, ?)`, sample.id, sample.state, sample.at);
            } else if (confirmed.state !== sample.state && previous?.state === sample.state) {
                sql.exec(`UPDATE components SET state = ?, since = ? WHERE component = ?`, sample.state, previous.at, sample.id);
                transitions.push({ id: sample.id, from: confirmed.state, to: sample.state, since: previous.at, previousSince: confirmed.since, detail: sample.detail });
            }
        }
        sql.exec(`DELETE FROM samples WHERE at < ?`, Date.now() - DAY_MS);
        return transitions;
    }

    // Each component's confirmed state with its latest sample, and the day's samples oldest first.
    snapshot(): Snapshot {
        const { sql } = this.ctx.storage;
        const components = sql
            .exec<{ component: ComponentId; state: State; since: number; latency_ms: number | null; detail: string; at: number }>(
                `SELECT c.component, c.state, c.since, s.latency_ms, s.detail, s.at FROM components c
                 JOIN samples s ON s.component = c.component AND s.at = (SELECT MAX(at) FROM samples WHERE component = c.component)`,
            )
            .toArray()
            .map((row) => ({ id: row.component, state: row.state, since: row.since, latencyMs: row.latency_ms, detail: row.detail, checkedAt: row.at }));
        const history = sql
            .exec<{ component: ComponentId; at: number; state: State; latency_ms: number | null; detail: string }>(
                `SELECT component, at, state, latency_ms, detail FROM samples WHERE at >= ? ORDER BY at`,
                Date.now() - DAY_MS,
            )
            .toArray()
            .map((row) => ({ id: row.component, at: row.at, state: row.state, latencyMs: row.latency_ms, detail: row.detail }));
        const updatedAt = components.length === 0 ? null : Math.max(...components.map((component) => component.checkedAt));
        return { updatedAt, components, history };
    }
}

const logOf = (env: Env) => env.STATUS.get(env.STATUS.idFromName(LOG_NAME));

// "3 h 12 min", "4 min", "40 s": how long a state lasted, for an alert.
const lasted = (ms: number): string => {
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 1) {
        return `${Math.max(1, Math.round(ms / 1000))} s`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 1) {
        return `${minutes} min`;
    }
    return hours < 48 ? `${hours} h ${minutes % 60} min` : `${Math.floor(hours / 24)} days`;
};

// A confirmed change as one line in a chat channel, posted only when the webhook secret is set.
const alert = async (env: Env, transitions: readonly Transition[]): Promise<void> => {
    if (env.ALERT_WEBHOOK_URL === undefined || env.ALERT_WEBHOOK_URL === `` || transitions.length === 0) {
        return;
    }
    const lines = transitions.map((change) => {
        const name = COMPONENT_BY_ID.get(change.id)?.name ?? change.id;
        const why = change.detail === `` ? `` : ` (${change.detail})`;
        return `**${name}** is ${change.to}${why}, after ${lasted(change.since - change.previousSince)} ${change.from}.`;
    });
    const response = await fetch(env.ALERT_WEBHOOK_URL, {
        method: `POST`,
        headers: { "content-type": `application/json` },
        body: JSON.stringify({ content: `${lines.join(`\n`)}\n${env.PAGE_URL}` }),
    });
    if (!response.ok) {
        console.error(`[status] the alert webhook answered ${response.status}: ${await response.text()}`);
    }
};

// One round: probe, record, alert.
const check = async (env: Env, at: number): Promise<void> => {
    const transitions = await logOf(env).record(await probeAll(at));
    await alert(env, transitions);
};

// The snapshot, probing live first when there is nothing recorded yet (a fresh deploy before its first cron).
const current = async (env: Env): Promise<Snapshot> => {
    const log = logOf(env);
    const snapshot = await log.snapshot();
    if (snapshot.components.length > 0) {
        return snapshot;
    }
    await log.record(await probeAll(Date.now()));
    return log.snapshot();
};

const iso = (ms: number): string => new Date(ms).toISOString();

const statusJson = (snapshot: Snapshot) => ({
    updatedAt: snapshot.updatedAt === null ? null : iso(snapshot.updatedAt),
    overall: worst(snapshot.components.map((component) => component.state)),
    components: snapshot.components.map((component) => ({
        id: component.id,
        name: COMPONENT_BY_ID.get(component.id)?.name ?? component.id,
        state: component.state,
        latencyMs: component.latencyMs,
        since: iso(component.since),
        detail: component.detail === `` ? null : component.detail,
        checkedAt: iso(component.checkedAt),
    })),
});

// --- the page ---------------------------------------------------------------------------------------------------

const escapeHtml = (text: string): string =>
    text.replace(/[&<>"']/g, (char) => ({ "&": `&amp;`, "<": `&lt;`, ">": `&gt;`, '"': `&quot;`, "'": `&#39;` })[char] ?? char);

const HEADLINE = { operational: `All systems operational`, degraded: `Partly degraded`, down: `Outage` } satisfies Record<State, string>;
const LABEL = { operational: `Operational`, degraded: `Degraded`, down: `Down` } satisfies Record<State, string>;

// One slice of the day's bar: the worst state sampled in it (undefined with no samples), from when, of how many.
interface Slice {
    state: State | undefined;
    readonly start: number;
    count: number;
}

// The day as SLICE_MINUTES slices, oldest first.
const slicesOf = (samples: readonly Sample[], now: number): Slice[] => {
    const sliceMs = SLICE_MINUTES * 60_000;
    const count = DAY_MS / sliceMs;
    const end = Math.ceil(now / sliceMs) * sliceMs;
    const slices = Array.from({ length: count }, (_, index): Slice => ({ state: undefined, start: end - (count - index) * sliceMs, count: 0 }));
    for (const sample of samples) {
        const slice = slices[Math.floor((sample.at - (end - DAY_MS)) / sliceMs)];
        if (slice !== undefined) {
            slice.state = slice.state === undefined ? sample.state : worst([slice.state, sample.state]);
            slice.count += 1;
        }
    }
    return slices;
};

// The share of the day's samples that were operational, as "99.9%".
const uptimeOf = (samples: readonly Sample[]): string => {
    if (samples.length === 0) {
        return `–`;
    }
    const share = samples.filter((sample) => sample.state === `operational`).length / samples.length;
    return `${(Math.floor(share * 1000) / 10).toFixed(1)}%`;
};

const timeTag = (ms: number): string => `<time datetime="${iso(ms)}">${iso(ms).slice(11, 16)} UTC</time>`;

const componentHtml = (component: ComponentNow, samples: readonly Sample[], now: number): string => {
    const meta = COMPONENT_BY_ID.get(component.id);
    const bars = slicesOf(samples, now)
        .map((slice) => {
            const title = `${iso(slice.start).slice(11, 16)} UTC: ${slice.state === undefined ? `no data` : `${LABEL[slice.state]} (${slice.count} checks)`}`;
            return `<i class="${slice.state ?? `none`}" title="${title}"></i>`;
        })
        .join(``);
    const latency = component.latencyMs === null ? `no answer` : `${component.latencyMs} ms`;
    return `<section class="component">
  <header>
    <div><h2>${escapeHtml(meta?.name ?? component.id)}</h2><p>${escapeHtml(meta?.about ?? ``)}</p></div>
    <span class="pill ${component.state}">${LABEL[component.state]}</span>
  </header>
  <p class="facts">${latency} · since ${timeTag(component.since)}${component.detail === `` ? `` : ` · ${escapeHtml(component.detail)}`}</p>
  <div class="bar" role="img" aria-label="The last 24 hours of ${escapeHtml(meta?.name ?? component.id)}">${bars}</div>
  <p class="scale"><span>24 h ago</span><span>${uptimeOf(samples)} operational</span><span>now</span></p>
</section>`;
};

const pageHtml = (snapshot: Snapshot, now: number): string => {
    const overall = worst(snapshot.components.map((component) => component.state));
    const sections = snapshot.components.map((component) =>
        componentHtml(
            component,
            snapshot.history.filter((sample) => sample.id === component.id),
            now,
        ),
    );
    const checked = snapshot.updatedAt === null ? `not yet` : timeTag(snapshot.updatedAt);
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>${HEADLINE[overall]} · intentic status</title>
<style>
  :root { color-scheme: light dark; --bg: #fafaf9; --fg: #1c1917; --muted: #78716c; --card: #fff; --line: #e7e5e4;
    --ok: #16a34a; --warn: #d97706; --bad: #dc2626; --none: #e7e5e4; --on-fill: #fff; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0c0a09; --fg: #f5f5f4; --muted: #a8a29e; --card: #1c1917;
    --line: #292524; --ok: #22c55e; --warn: #f59e0b; --bad: #ef4444; --none: #292524; --on-fill: #0c0a09; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 40px 20px 56px; }
  .brand { font-weight: 600; letter-spacing: -0.01em; color: var(--muted); margin: 0 0 20px; }
  .overall { display: flex; align-items: center; gap: 12px; padding: 18px 20px; border-radius: 12px; color: var(--on-fill); margin-bottom: 28px; }
  .overall h1 { font-size: 20px; margin: 0; font-weight: 600; }
  .overall.operational { background: var(--ok); } .overall.degraded { background: var(--warn); } .overall.down { background: var(--bad); }
  .component { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 18px 20px; margin-bottom: 14px; }
  .component header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
  h2 { font-size: 16px; margin: 0; font-weight: 600; }
  .component header p, .facts, .scale, footer { color: var(--muted); font-size: 13px; margin: 2px 0 0; }
  .facts { margin-top: 10px; }
  .pill { font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 999px; white-space: nowrap; color: var(--on-fill); }
  .pill.operational { background: var(--ok); } .pill.degraded { background: var(--warn); } .pill.down { background: var(--bad); }
  .bar { display: flex; gap: 2px; height: 30px; margin-top: 12px; }
  .bar i { flex: 1; border-radius: 2px; background: var(--none); }
  .bar i.operational { background: var(--ok); } .bar i.degraded { background: var(--warn); } .bar i.down { background: var(--bad); }
  .scale { display: flex; justify-content: space-between; margin-top: 6px; font-size: 12px; }
  footer { margin-top: 28px; }
  footer a { color: inherit; }
</style>
</head>
<body>
<main>
  <p class="brand">intentic status</p>
  <div class="overall ${overall}"><h1>${HEADLINE[overall]}</h1></div>
  ${sections.join(`\n  `)}
  <footer>Checked every minute from Cloudflare's network, outside the platform's own servers. Last check ${checked}.
    Refreshes by itself. As JSON: <a href="/api/status">/api/status</a>.</footer>
</main>
<script>
  // Times are written in UTC so the page reads without scripts; with them, in the reader's own zone.
  for (const node of document.querySelectorAll("time")) {
    // zone-checked: the reader's own clock, in a standalone public page with no editor kit to format through.
    node.textContent = new Date(node.dateTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
</script>
</body>
</html>`;
};

// Readable by any origin (the editor asks from app.intentic.dev and from every sandbox's address), and cacheable
// briefly: the answer moves once a minute.
const API_HEADERS = { "access-control-allow-origin": `*`, "cache-control": `max-age=30` };

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const { pathname } = new URL(request.url);
        if (request.method === `OPTIONS`) {
            return new Response(null, { status: 204, headers: { ...API_HEADERS, "access-control-allow-methods": `GET, HEAD, OPTIONS`, "access-control-max-age": `86400` } });
        }
        if (request.method !== `GET` && request.method !== `HEAD`) {
            return new Response(`Method not allowed\n`, { status: 405, headers: { allow: `GET, HEAD, OPTIONS` } });
        }
        if (pathname === `/api/status`) {
            return Response.json(statusJson(await current(env)), { headers: API_HEADERS });
        }
        if (pathname === `/`) {
            const html = pageHtml(await current(env), Date.now());
            return new Response(html, {
                headers: {
                    "content-type": `text/html; charset=utf-8`,
                    "cache-control": `max-age=30`,
                    "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'`,
                    "x-content-type-options": `nosniff`,
                },
            });
        }
        return new Response(`Not found\n`, { status: 404, headers: { "cache-control": `max-age=300` } });
    },

    scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
        ctx.waitUntil(check(env, controller.scheduledTime));
    },
};
