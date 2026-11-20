import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readChromiumHistory } from "./chromium-history.js";

// A History database laid out as Chromium's is (the tables and columns this module reads), in WAL mode and still open,
// as a running Chromium leaves it: its rows are in the log, not yet in the file.

const EPOCH_DELTA_MS = 11_644_473_600_000;
const chromiumTime = (ms: number): bigint => BigInt(ms + EPOCH_DELTA_MS) * 1000n;
const NOW = 1_791_818_595_064;

const LINK = 0;
const TYPED = 1;
const RELOAD = 8;
const CHAIN_START = 0x10000000;
const CHAIN_END = 0x20000000;
const SERVER_REDIRECT = 0x80000000;
// Chromium stores the transition as a signed 32-bit integer, so a redirect qualifier reads back negative.
const signed = (transition: number): number => transition | 0;

let scratch: string;
let profile: string;
let open: DatabaseSync | undefined;

beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "chromium-history-test-"));
    profile = join(scratch, "profile");
    await mkdir(join(profile, "Default"), { recursive: true });
});

afterEach(async () => {
    open?.close();
    open = undefined;
    await rm(scratch, { recursive: true, force: true });
});

const writeHistory = (): void => {
    const db = new DatabaseSync(join(profile, "Default", "History"));
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA wal_autocheckpoint=0");
    db.exec(`CREATE TABLE urls (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR, visit_count INTEGER DEFAULT 0 NOT NULL,
             typed_count INTEGER DEFAULT 0 NOT NULL, last_visit_time INTEGER NOT NULL, hidden INTEGER DEFAULT 0 NOT NULL)`);
    db.exec(`CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER NOT NULL, visit_time INTEGER NOT NULL, transition INTEGER DEFAULT 0 NOT NULL)`);
    db.exec(`CREATE TABLE keyword_search_terms (keyword_id INTEGER NOT NULL, url_id INTEGER NOT NULL, term LONGVARCHAR NOT NULL,
             normalized_term LONGVARCHAR NOT NULL)`);
    const url = db.prepare("INSERT INTO urls (id, url, title, visit_count, typed_count, last_visit_time, hidden) VALUES (?, ?, ?, ?, ?, ?, ?)");
    url.run(1, "http://192.168.0.168/", "", 3, 2, chromiumTime(NOW), 0);
    url.run(2, "https://search.brave.com/search?q=fritzbox", "fritzbox - Brave Search", 1, 1, chromiumTime(NOW - 5000), 0);
    url.run(3, "https://ads.example/frame", "Ad", 1, 0, chromiumTime(NOW - 6000), 1);
    url.run(4, "https://short.example/", "Shortener", 1, 0, chromiumTime(NOW - 7000), 0);
    const visit = db.prepare("INSERT INTO visits (url, visit_time, transition) VALUES (?, ?, ?)");
    visit.run(1, chromiumTime(NOW), signed(TYPED | CHAIN_START | CHAIN_END));
    visit.run(1, chromiumTime(NOW - 1000), signed(RELOAD | CHAIN_START | CHAIN_END));
    visit.run(1, chromiumTime(NOW - 2000), signed(LINK | CHAIN_START | CHAIN_END));
    visit.run(2, chromiumTime(NOW - 5000), signed(TYPED | CHAIN_START | CHAIN_END));
    // A shortener the browser only passed through on its way elsewhere.
    visit.run(4, chromiumTime(NOW - 7000), signed(LINK | CHAIN_START | SERVER_REDIRECT));
    db.prepare("INSERT INTO keyword_search_terms VALUES (?, ?, ?, ?)").run(2, 2, "fritzbox", "fritzbox");
    // Held open, as Chromium holds it: nothing checkpointed into the file.
    open = db;
};

test("pages, their recent visits and the searches are read from a copy, the write-ahead log included", async () => {
    writeHistory();
    const history = await readChromiumHistory(profile, scratch);
    expect(history?.pages).toEqual([
        {
            url: "http://192.168.0.168/",
            title: undefined,
            visits: 3,
            typed: 2,
            last: NOW,
            // The reload is no visit of its own.
            recent: [{ at: NOW, typed: true }, { at: NOW - 2000 }],
        },
        { url: "https://search.brave.com/search?q=fritzbox", title: "fritzbox - Brave Search", visits: 1, typed: 1, last: NOW - 5000, recent: [{ at: NOW - 5000, typed: true }] },
        // Hidden pages (a frame's) are left out; one only passed through keeps its row but no visit of the person's.
        { url: "https://short.example/", title: "Shortener", visits: 1, typed: 0, last: NOW - 7000, recent: [] },
    ]);
    expect(history?.terms).toEqual([{ term: "fritzbox", last: NOW - 5000 }]);
    // The copy is gone, and the profile holds only what Chromium put there.
    expect((await readdir(scratch)).toSorted()).toEqual(["profile"]);
    expect((await readdir(join(profile, "Default"))).toSorted()).toEqual(["History", "History-shm", "History-wal"]);
});

test("a profile that never browsed has no history to read", async () => {
    expect(await readChromiumHistory(profile, scratch)).toBe(undefined);
    expect(await readChromiumHistory(join(scratch, "absent"), scratch)).toBe(undefined);
});
