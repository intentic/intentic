// Usage: node normalize-starter.mjs <layer root> <msgpackr module dir>; normalize pnpm timestamps/temp paths for reproducible starter layers.
// Rewrite SQLite/msgpack checkedAt, prunedAt, lastValidatedTimestamp and engine shim/project paths without dropping values.
// Use 1980-01-01T00:00:01Z, one second after file mtimes, so pnpm does not rehash/revalidate newer files; cp -a preserves that ordering.
// Later pnpm metadata changes may cost cache reuse, but must not affect correctness.
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const FIXED_MS = Date.UTC(1980, 0, 1, 0, 0, 1);
const FIXED_HTTP_DATE = new Date(FIXED_MS).toUTCString();

const [root, msgpackrDir] = process.argv.slice(2);
if (root === undefined || msgpackrDir === undefined) {
    console.error("usage: normalize-starter.mjs <layer root> <msgpackr module dir>");
    process.exit(2);
}
const { Packr, Unpackr } = createRequire(join(msgpackrDir, "package.json"))(msgpackrDir);
const pnpmHome = join(root, "usr/local/share/pnpm");
const starter = join(root, "opt/starter");

const walk = (dir, visit) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        visit(path, entry);
        if (entry.isDirectory()) {
            walk(path, visit);
        }
    }
};

// pnpm's index entry for a package: `files` maps each file name to {checkedAt, digest, mode, size}, and `sideEffects`
// maps a build's cache key to the files that build `added` (the same shape). pnpm writes the file maps as msgpack MAPS
// and the rest as records, so a blob is decoded with maps kept as Maps: re-encoded with msgpackr's defaults it is then
// byte-for-byte what pnpm wrote (445 of 445 blobs round-tripped identically before any value was changed), and only
// the timestamps differ. Either container shape is read, so a pnpm that switches one to the other still normalizes.
const valuesOf = (container) => (container instanceof Map ? [...container.values()] : Object.values(container ?? {}));
let checkedAtFixed = 0;
const fixFiles = (files) => {
    for (const info of valuesOf(files)) {
        if (Object.hasOwn(info, "checkedAt")) {
            info.checkedAt = FIXED_MS;
            checkedAtFixed += 1;
        }
    }
};
const fieldOf = (entry, name) => (entry instanceof Map ? entry.get(name) : entry[name]);
const fixEntry = (entry) => {
    fixFiles(fieldOf(entry, "files"));
    for (const effect of valuesOf(fieldOf(entry, "sideEffects"))) {
        fixFiles(fieldOf(effect, "added"));
    }
    return entry;
};

const normalizeIndex = (path) => {
    const unpackr = new Unpackr({ mapsAsObjects: false });
    const packr = new Packr();
    const db = new DatabaseSync(path);
    const rows = db.prepare("SELECT key, data FROM package_index").all();
    const update = db.prepare("UPDATE package_index SET data = ? WHERE key = ?");
    db.exec("BEGIN");
    for (const { key, data } of rows) {
        update.run(packr.pack(fixEntry(unpackr.unpack(Buffer.from(data)))), key);
    }
    db.exec("COMMIT");
    // VACUUM rebuilds the file from the rows alone, so the page layout no longer remembers the order the packages
    // were fetched in; the checkpoint first folds the WAL in, and closing removes it.
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.exec("VACUUM");
    db.close();
    for (const suffix of ["-wal", "-shm"]) {
        rmSync(`${path}${suffix}`, { force: true });
    }
    return rows.length;
};

const replaceIn = (path, pattern, replacement) => {
    const text = readFileSync(path, "utf8");
    const next = text.replace(pattern, replacement);
    if (next !== text) {
        writeFileSync(path, next);
    }
};

// pnpm's own scratch space for an install in progress: empty once it finished, but for the links into it.
const clearScratch = (storeVersionDir) => {
    const tmp = join(storeVersionDir, "tmp");
    for (const leftover of existsSync(tmp) ? readdirSync(tmp) : []) {
        rmSync(join(tmp, leftover), { recursive: true, force: true });
    }
    // projects/ links each project that uses the store. Two point at nothing once the layer is taken out of the build:
    // the engine install's temp dir, and this build's own pnpm global dir (time-named, and not the image's, which has
    // its own pnpm install). A link that resolves inside the layer, as /opt/starter's does, stays.
    const projects = join(storeVersionDir, "projects");
    for (const link of existsSync(projects) ? readdirSync(projects) : []) {
        const path = join(projects, link);
        if (lstatSync(path).isSymbolicLink() && !existsSync(path)) {
            rmSync(path);
        }
    }
};

let indexes = 0;
for (const store of ["store", "package-manager-store"].map((name) => join(pnpmHome, name)).filter(existsSync)) {
    walk(store, (path, entry) => {
        if (entry.isFile() && entry.name === "index.db") {
            indexes += normalizeIndex(path);
        }
    });
    for (const version of readdirSync(store)) {
        clearScratch(join(store, version));
    }
}

// pnpm 11's shims, generated while its engine was installed through a temp dir that no longer exists.
const enginePath = /pnpm-engine-([0-9][0-9A-Za-z.+-]*?)-\d+-\d+(?=\/)/g;
const managerStore = join(pnpmHome, "package-manager-store");
if (existsSync(managerStore)) {
    walk(managerStore, (path, entry) => {
        if (entry.isFile() && path.includes("/node_modules/.bin/") && statSync(path).size < 1_000_000) {
            replaceIn(path, enginePath, "pnpm-engine-$1-0-0");
        }
    });
}

let modulesFiles = 0;
walk(starter, (path, entry) => {
    if (!entry.isFile()) {
        return;
    }
    if (entry.name === ".modules.yaml") {
        replaceIn(path, /("prunedAt": )"[^"]*"/g, `$1"${FIXED_HTTP_DATE}"`);
        modulesFiles += 1;
    } else if (entry.name.startsWith(".pnpm-workspace-state")) {
        replaceIn(path, /("lastValidatedTimestamp": )\d+/g, `$1${FIXED_MS}`);
    }
});

if (indexes === 0 || checkedAtFixed === 0 || modulesFiles === 0) {
    console.error(
        `normalize-starter: found ${indexes} index entries, ${checkedAtFixed} file timestamps and ${modulesFiles} .modules.yaml under ${root}; is this a starter?`,
    );
    process.exit(1);
}
console.log(
    `normalize-starter: ${indexes} index entries (${checkedAtFixed} file timestamps) and ${modulesFiles} modules manifest(s) set to ${FIXED_HTTP_DATE}`,
);
