import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

/* THE ARTIFACT A STORE TAKES: dist/ as one zip.
 *
 * WRITTEN BY HAND rather than shelled out to `zip`, and the reason is the image this runs in: ci-base installs
 * curl, git, python3, make, g++, ripgrep, openssh-client, tmux and docker — no zip. A publish step that shelled
 * out would work on every developer's machine and fail in the one place it has to work, at the end of a
 * release, after everything else had already been tagged and published.
 *
 * The format is old and small enough to write correctly: per file a local header, deflated bytes and a CRC;
 * then a central directory naming every entry, and an end-of-central-directory record pointing at it. What is
 * deliberately NOT here: zip64 (the whole extension is under a megabyte), encryption, data descriptors, and
 * directory entries (a zip needs none, and Chrome ignores them).
 *
 * TIMESTAMPS ARE FIXED, which is what makes the artifact reproducible: the same dist produces the same bytes,
 * so a re-run of a publish uploads something identical rather than something merely equivalent. The DOS epoch
 * (1980-01-01) is the earliest a zip can express and carries no information anyway.
 *
 *   node _computers/webext/scripts/pack.mjs   → dist.zip beside dist/
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const dist = join(root, "dist");
const out = join(root, "dist.zip");

// Every file under dist/, depth first, in a stable order — the order entries appear in the archive.
const walk = (dir) =>
    readdirSync(dir)
        .toSorted()
        .flatMap((entry) => {
            const path = join(dir, entry);
            return statSync(path).isDirectory() ? walk(path) : [path];
        });

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
        value = value & 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1;
    }
    return value >>> 0;
});
const crc32 = (buffer) => {
    let value = 0xff_ff_ff_ff;
    for (const byte of buffer) {
        value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
    }
    return (value ^ 0xff_ff_ff_ff) >>> 0;
};

const DOS_TIME = 0;
const DOS_DATE = 0x00_21; // 1980-01-01: the DOS epoch, and the only date a reproducible archive can honestly claim.

// The two preview surfaces (scripts/preview.mjs) live in dist/ so their relative `popup.js` resolves, and
// neither may reach a store. Named rather than pattern-matched, so the exclusion is two files rather than a
// rule somebody's real asset can trip over.
const files = walk(dist).filter((path) => !["preview.html", "store-shot.html"].includes(relative(dist, path)));
if (files.length === 0) {
    console.error(`nothing in ${dist}: run the build first`);
    process.exit(1);
}

const locals = [];
const central = [];
let offset = 0;
for (const path of files) {
    // Zip paths are forward-slashed, always, whatever the platform wrote them on.
    const name = Buffer.from(relative(dist, path).split(sep).join("/"), "utf8");
    const raw = readFileSync(path);
    const deflated = deflateRawSync(raw, { level: 9 });
    // A file that deflates larger than it started (a small PNG, already compressed) is stored instead: method 0.
    const stored = deflated.length >= raw.length;
    const body = stored ? raw : deflated;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04_03_4b_50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0, which is what deflate asks for
    local.writeUInt16LE(0, 6); // no flags: no encryption, no data descriptor
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02_01_4b_50, 0);
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(stored ? 0 : 8, 10);
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt16LE(0, 30); // extra
    entry.writeUInt16LE(0, 32); // comment
    entry.writeUInt16LE(0, 34); // disk number
    entry.writeUInt16LE(0, 36); // internal attributes
    // A regular 0644 file, in the high half of the field. `>>> 0` because JS bitwise arithmetic is SIGNED
    // 32-bit and this shift lands past 2^31, which is a negative number the buffer writer refuses.
    entry.writeUInt32LE((0o1_00_644 << 16) >>> 0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + body.length;
}

const directory = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06_05_4b_50, 0);
end.writeUInt16LE(0, 4); // this disk
end.writeUInt16LE(0, 6); // the disk the directory starts on
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20); // no archive comment

const zip = Buffer.concat([...locals, directory, end]);
writeFileSync(out, zip);
// The digest is printed because a publish records what it uploaded, and "the same bytes" is a claim worth
// being able to check afterwards.
console.log(`dist.zip: ${files.length} files, ${zip.length} bytes, sha256 ${createHash("sha256").update(zip).digest("hex")}`);
