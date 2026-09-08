#!/usr/bin/env node
// Measures what FINDING a symbol costs, from transcripts; bench.mjs measures opening one instead.
// Reads HISTORY_ROOT/transcripts/*.jsonl and agents.json (append-only). Definitions must not drift pre/post-run:
// - work session: 3+ reads+searches; chat and one-shot commands aren't work.
// - listing: Bash/exec starting ls/tree/find/fd/rg --files/exa/eza, matched on the command text, not the tool name.
// - big listing: a listing whose result exceeds 4,000 characters.
// - failed read: a Read with failed status, or a result saying the path doesn't exist.
// - stale name: a mention of a name in STALE; extend STALE at every rename.
import fs from "node:fs";
import path from "node:path";
import { HISTORY_ROOT } from "@intentic/constants";
import { arg } from "./lib/args.mjs";

const since = arg("since", "");

const agents = JSON.parse(fs.readFileSync(path.join(HISTORY_ROOT, "agents.json"), "utf8"));
const meta = new Map(agents.map((a) => [a.id, a]));
const dir = path.join(HISTORY_ROOT, "transcripts");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));

// Names this repo no longer has; extend at every rename, until a name's count stays at zero.
const STALE = ["_apps", "_libs", "_computers", "intentic-app/", "intentic-dev/", "packages/"];

// A repo-relative path out of an absolute one, whether the session ran in the main checkout or in a worktree.
const rel = (s) => {
    const m = String(s).match(/(?:\/work\/|\/history\/worktrees\/[^/\s]+\/)intentic\/([A-Za-z0-9_.\-/]+)/);
    return m ? m[1] : null;
};
// Every repo path a command mentions: absolute paths, plus bare partial ones like `_editor/web/src`.
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

// Per-session records, plus the cross-session tallies the report ranks.
const S = [];
const listDirs = new Map();
const bigListings = new Map();
const failedReads = new Map();
const fileSessions = new Map();
const dirSessions = new Map();
const pkgPairs = new Map();
const staleByDate = {};

// Splits one tool call's contribution into what it can answer: named a dead directory, listed one, searched, or read; a
// call may be more than one (e.g., `rg --files` is a listing and a search).
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

// A read that landed is what the session knows; one that missed is what the structure cost it.
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
    // Co-read package pairs: the vertical slice of work, against the horizontal layers it touches.
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
