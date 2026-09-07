#!/usr/bin/env node
/* WHAT THIS DIRECTORY STRUCTURE COSTS THE AGENTS THAT WORK IN IT, mined from the conversations themselves.
 *
 *   node _tools/nav/structure-stats.mjs > _tools/nav/baselines/structure-pre.json
 *   node _tools/nav/structure-stats.mjs --since 2026-09-06 > _tools/nav/baselines/structure-post.json
 *
 * The sibling of bench.mjs, one level up. bench.mjs measures what opening a SYMBOL costs; this measures what
 * FINDING one costs: how many directory listings a session runs, how many of them come back too big to read,
 * which paths agents guess at and miss, how many packages and directories a single piece of work touches, and
 * how long a removed directory name goes on being typed after the rename. Those are the numbers the
 * directory-structure overhaul (docs/audits/directory-structure-audit.md) is judged by, and they can only be had
 * from the transcript corpus — no property of the tree predicts them.
 *
 * WHAT IT READS. `HISTORY_ROOT/transcripts/<conversation>.jsonl` (one line per message; assistant lines carry
 * `tools[]` with `name`, `status`, `target` and `content[]`, with the children of an Agent call inlined) and
 * `HISTORY_ROOT/agents.json` (provider, model, createdAt per conversation). Both are daemon-owned and
 * append-only, so a run over the same window always produces the same file.
 *
 * THE DEFINITIONS ARE THE MEASUREMENT, so they are stated once here and must not drift between a pre- and a
 * post-overhaul run, or the comparison means nothing:
 *
 *   work session   a conversation with at least 3 reads+searches. Chat and one-shot commands are not work.
 *   listing        a Bash/exec command starting with ls, tree, find, fd, rg --files, exa or eza. In raw
 *                  Claude sessions the search tools are not Grep/Glob (zero calls) but Bash running rg, which
 *                  is why every classifier below reads the COMMAND rather than trusting the tool name.
 *   big listing    a listing whose result text exceeds 4,000 characters: a directory too flat to read.
 *   failed read    a Read whose status is failed, or whose short result says the path does not exist. This is
 *                  the direct cost of a name that moved, or of a directory an agent expected and guessed.
 *   stale name     a mention, anywhere in a tool call's target or command, of a name STALE lists as removed.
 *                  Extend STALE at every rename; the point of the metric is how many weeks a dead name lives.
 *
 * `--since <YYYY-MM-DD>` filters by the conversation's createdAt, which is how a window after a landing is
 * isolated from the corpus that predates it. */
import fs from "node:fs";
import path from "node:path";
import { HISTORY_ROOT } from "@intentic/constants";
import { arg } from "./lib/args.mjs";

const since = arg("since", "");

const agents = JSON.parse(fs.readFileSync(path.join(HISTORY_ROOT, "agents.json"), "utf8"));
const meta = new Map(agents.map((a) => [a.id, a]));
const dir = path.join(HISTORY_ROOT, "transcripts");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));

// Names this repository no longer has. Extend at every rename: an entry stops being interesting only when its
// count reaches zero and stays there, which is the whole finding.
const STALE = ["_apps", "_libs", "_computers", "intentic-app/", "intentic-dev/", "packages/"];

// A repo-relative path out of an absolute one, whether the session ran in the main checkout or in a worktree.
const rel = (s) => {
    const m = String(s).match(/(?:\/work\/|\/history\/worktrees\/[^/\s]+\/)intentic\/([A-Za-z0-9_.\-/]+)/);
    return m ? m[1] : null;
};
// Every repo path a command mentions: absolute ones, plus bare part-relative ones (`_editor/web/src`), which
// is how a listing command names its target.
const pathsIn = (s) =>
    [...String(s).matchAll(/(?:\/work\/|\/history\/worktrees\/[^/\s]+\/)intentic\/([A-Za-z0-9_.\-/]+)/g)]
        .map((m) => m[1])
        .concat(
            [
                ...String(s).matchAll(
                    /(?<![\w/.-])(_(?:editor|sandbox|shared|extensions|platform|search|deploy|devices|site|tools|apps|libs|computers)(?:\/[A-Za-z0-9_.\-/]*)?)/g,
                ),
            ].map((m) => m[1]),
        );
const pkgOf = (p) => {
    const s = p.split("/");
    return s[0] === "docs" ? "docs" : s.slice(0, 2).join("/");
};

const isCmd = (t) => t.name === "Bash" || t.name === "exec" || /run_command|shell/.test(t.name);
const cmdOf = (t) => {
    if (t.name === "exec") {
        const m = String(t.target || "").match(/cmd\\?":\\?"((?:[^"\\]|\\.)*)/);
        return m ? m[1].replace(/\\"/g, '"') : String(t.target || "");
    }
    return String(t.target || "");
};
const isListing = (c) => /^(?:cd [^&;|]+ (?:&&|;) )?\s*(?:ls|tree|find|fd|rg --files|exa|eza)\b/.test(c);
const isSearch = (t) => t.name === "Grep" || t.name === "Glob" || (isCmd(t) && /\b(?:rg|grep|iq|ag|find|fd|ack)\b/.test(cmdOf(t)));
const isEdit = (t) =>
    ["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch", "edit_file", "write_file", "StrReplace", "create_file"].includes(t.name) ||
    (isCmd(t) && /\b(?:sed -i|cat >|tee |>>|apply_patch|git apply)\b/.test(cmdOf(t)));
const isRead = (t) =>
    t.name === "Read" || t.name === "read_file" || (isCmd(t) && /^(?:cd [^&;|]+ (?:&&|;) )?\s*(?:cat|sed -n|head|tail|bat|less)\b/.test(cmdOf(t)));
const textOf = (t) => (t.content || []).map((c) => String(c.text || "")).join("\n");
const failText =
    /(?:does not exist|No such file|ENOENT|not found|No files found|No matches found|no matches|not a directory|Path not found|cannot access|is a directory)/i;

// What the whole corpus adds up to: one session record each, and the cross-session tallies the report ranks.
const S = [];
const listDirs = new Map();
const bigListings = new Map();
const failedReads = new Map();
const fileSessions = new Map();
const dirSessions = new Map();
const pkgPairs = new Map();
const staleByDate = {};

/* One tool call's contribution to its session's counters, split from the loop by the four questions it can
 * answer: did it name a dead directory, did it list one, did it search, did it read. A call can be more than
 * one of those (`rg --files _editor/web` is a listing and a search), and each is counted where it belongs. */
const countStale = (s, mentioned) => {
    for (const st of STALE) {
        if (mentioned.includes(st)) {
            s.stale++;
            (staleByDate[st] ||= {})[s.date] = ((staleByDate[st] || {})[s.date] || 0) + 1;
        }
    }
};

const countListing = (s, cmd, out) => {
    s.listings++;
    const p = pathsIn(cmd)[0] || "(other)";
    listDirs.set(p, (listDirs.get(p) || 0) + 1);
    if (out.length > 4000) {
        s.bigListings++;
        bigListings.set(p, (bigListings.get(p) || 0) + 1);
    }
};

// A read that landed is what the session KNOWS; one that missed is what the structure cost it.
const countRead = (s, seen, t, cmd, failed) => {
    s.reads++;
    const rp = t.name === "Read" ? rel(t.target) : pathsIn(cmd)[0] || null;
    if (rp === null) {
        return;
    }
    if (rp.endsWith("README.md")) {
        s.readme++;
    }
    if (t.name === "Read" && failed) {
        failedReads.set(rp, (failedReads.get(rp) || 0) + 1);
        return;
    }
    s.files.add(rp);
    s.dirs.add(path.dirname(rp));
    s.pkgs.add(pkgOf(rp));
    seen.set(rp, (seen.get(rp) || 0) + 1);
};

const countTool = (s, seen, t) => {
    const out = textOf(t);
    const cmd = isCmd(t) ? cmdOf(t) : "";
    const failed = t.status === "failed" || (out.length < 400 && failText.test(out));
    if (failed) {
        s.fails++;
    }
    countStale(s, `${t.target || ""} ${cmd}`);
    if (cmd !== "" && isListing(cmd)) {
        countListing(s, cmd, out);
    }
    if (isSearch(t)) {
        s.searches++;
    }
    if (isRead(t)) {
        countRead(s, seen, t, cmd, failed);
    }
};

for (const f of files) {
    const id = f.replace(/\.jsonl$/, "");
    const m = meta.get(id) || {};
    const date = m.createdAt ? new Date(m.createdAt).toISOString().slice(0, 10) : "?";
    if (since !== "" && date < since) {
        continue;
    }
    let txt;
    try {
        txt = fs.readFileSync(path.join(dir, f), "utf8");
    } catch {
        continue; // a transcript rotated away between readdir and here
    }
    const tools = [];
    for (const line of txt.split("\n")) {
        if (!line) {
            continue;
        }
        let o;
        try {
            o = JSON.parse(line);
        } catch {
            continue;
        }
        for (const t of o.tools || []) {
            tools.push(t);
            for (const c of t.children || []) {
                tools.push(c);
            }
        }
    }
    if (!tools.length) {
        continue;
    }
    const s = {
        id,
        provider: m.provider || "?",
        date,
        calls: tools.length,
        beforeEdit: -1,
        listings: 0,
        bigListings: 0,
        searches: 0,
        reads: 0,
        fails: 0,
        stale: 0,
        rereads: 0,
        readme: 0,
        files: new Set(),
        dirs: new Set(),
        pkgs: new Set(),
    };
    const seen = new Map();
    tools.forEach((t, i) => {
        if (s.beforeEdit < 0 && isEdit(t)) {
            s.beforeEdit = i;
        }
        countTool(s, seen, t);
    });
    for (const v of seen.values()) {
        if (v > 1) {
            s.rereads += v - 1;
        }
    }
    for (const x of s.files) {
        fileSessions.set(x, (fileSessions.get(x) || 0) + 1);
    }
    for (const x of s.dirs) {
        dirSessions.set(x, (dirSessions.get(x) || 0) + 1);
    }
    // Co-read pairs: the vertical slice a piece of work actually is, against the horizontal layers it reads it from.
    const pr = [...s.pkgs].filter((p) => p.startsWith("_")).sort();
    for (let i = 0; i < pr.length; i++) {
        for (let j = i + 1; j < pr.length; j++) {
            const k = `${pr[i]} + ${pr[j]}`;
            pkgPairs.set(k, (pkgPairs.get(k) || 0) + 1);
        }
    }
    S.push({ ...s, files: s.files.size, dirs: s.dirs.size, pkgs: s.pkgs.size });
}

const q = (arr, p) => {
    const a = [...arr].sort((x, y) => x - y);
    return a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : null;
};
const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

const work = S.filter((s) => s.reads + s.searches >= 3);
const byProv = {};
for (const s of work) {
    (byProv[s.provider] ||= []).push(s);
}
const table = Object.fromEntries(
    Object.entries(byProv).map(([p, arr]) => {
        const ed = arr.filter((s) => s.beforeEdit >= 0);
        const mean = (k) => +(arr.reduce((a, s) => a + s[k], 0) / arr.length).toFixed(2);
        return [
            p,
            {
                n: arr.length,
                beforeEdit: [
                    q(
                        ed.map((s) => s.beforeEdit),
                        0.5,
                    ),
                    q(
                        ed.map((s) => s.beforeEdit),
                        0.75,
                    ),
                    q(
                        ed.map((s) => s.beforeEdit),
                        0.9,
                    ),
                ],
                listingsMean: mean("listings"),
                bigListingsMean: mean("bigListings"),
                searchesMean: mean("searches"),
                readsMean: mean("reads"),
                failSessions: arr.filter((s) => s.fails > 0).length,
                staleSessions: arr.filter((s) => s.stale > 0).length,
                rereadsMean: mean("rereads"),
                pkgs: [
                    q(
                        arr.map((s) => s.pkgs),
                        0.5,
                    ),
                    q(
                        arr.map((s) => s.pkgs),
                        0.9,
                    ),
                ],
                dirs: [
                    q(
                        arr.map((s) => s.dirs),
                        0.5,
                    ),
                    q(
                        arr.map((s) => s.dirs),
                        0.9,
                    ),
                ],
                readmeSessions: arr.filter((s) => s.readme > 0).length,
            },
        ];
    }),
);

console.log(
    JSON.stringify(
        {
            since: since || null,
            sessions: S.length,
            workSessions: work.length,
            byProvider: table,
            listingTargets: top(listDirs, 40),
            bigListings: top(bigListings, 25),
            failedReads: top(failedReads, 40),
            mostReadDirs: top(dirSessions, 40),
            mostReadFiles: top(fileSessions, 25),
            packagePairs: top(pkgPairs, 25),
            staleByName: Object.fromEntries(Object.entries(staleByDate).map(([k, v]) => [k, Object.entries(v).sort()])),
        },
        null,
        1,
    ),
);
