#!/usr/bin/env node
// THE EXPLORER MENU'S IDENTITY PACKAGE, PACKED ON LINUX for a release to sign (_editor/desktop-app/explorer-menu).
//
//   explorer-menu-msix.mjs --publisher "<signing certificate's subject>" --version <x.y.z> --out <file.msix>
//
// Windows 11 lists "Open with Intentic" in its own context menu only when a signed package declares it. A release
// whose build holds Intentic's code-signing certificate ships that package already signed, and the installer
// registers it with no prompt; this writes it, unsigned, for sign-windows.sh to sign (jsign and osslsigncode both sign
// .msix). The DLL's own packer (explorer-menu/src/register.rs) writes the same thing on a PC, with Windows' packaging
// API; here there is no Windows, so the three parts an .msix adds to a ZIP are spelled out by hand:
//
//   - the payload: the manifest (AppxManifest.xml, its publisher and version filled in) and the logos it names;
//   - AppxBlockMap.xml: every payload file's size, local-header size and SHA-256 per 64 KiB block, which Windows checks
//     every byte of the package against, and which the signature covers;
//   - [Content_Types].xml: the OPC content type of every part.
//
// Laid out byte for byte the way makeappx lays out a package (compared against VS Code's and Zed's, 2026-10-07), and
// that is not taste: osslsigncode signs a ZIP32 archive into one Windows cannot open (0x80073CF0), and the same
// signer's output over a makeappx-shaped archive opens fine. So, like makeappx: every part deflated, the payload in
// independent 64 KiB blocks whose compressed sizes the block map records; a data descriptor after each payload
// part and the block map; [Content_Types].xml with its sizes in its own header; a ZIP64 end of central directory, its
// locator, and a classic end record whose counts point at them.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { constants, crc32, deflateRawSync } from "node:zlib";

const ROOT = join(import.meta.dirname, "../../..");
const CRATE = join(ROOT, "_editor/desktop-app/explorer-menu");
const ICONS = join(ROOT, "_editor/desktop-app/src-tauri/icons");
const BLOCK = 64 * 1024;

const { values } = parseArgs({
    options: {
        publisher: { type: "string" },
        version: { type: "string" },
        out: { type: "string" },
    },
});
if (!values.publisher || !values.version || !values.out) {
    console.error('usage: explorer-menu-msix.mjs --publisher "<subject>" --version <x.y.z> --out <file.msix>');
    process.exit(2);
}

/** A release version as a package version: four parts, each at most 65535. */
function packageVersion(version) {
    const parts = version.split(/[.+-]/).slice(0, 3).map(Number);
    if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 65535)) {
        throw new Error(`"${version}" is not a version an app package can carry`);
    }
    return `${parts.join(".")}.0`;
}

const escapeXml = (text) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const manifest = readFileSync(join(CRATE, "AppxManifest.xml"), "utf8")
    .replaceAll("{PUBLISHER}", escapeXml(values.publisher))
    .replaceAll("{VERSION}", packageVersion(values.version));

const payload = [
    ...["StoreLogo.png", "Square150x150Logo.png", "Square44x44Logo.png"].map((name) => ({ name, bytes: readFileSync(join(ICONS, name)) })),
    { name: "AppxManifest.xml", bytes: Buffer.from(manifest, "utf8") },
];

const localHeaderSize = (name) => 30 + Buffer.byteLength(name);

/** `bytes` deflated block by block: each 64 KiB block compressed on its own up to a full flush, so a reader can
 * inflate any block alone, then the two bytes of an empty final block. Returns the data and each block's size. */
function deflateBlocks(bytes) {
    const blocks = [];
    for (let offset = 0; offset === 0 || offset < bytes.length; offset += BLOCK) {
        const block = bytes.subarray(offset, offset + BLOCK);
        blocks.push({ plain: block, packed: deflateRawSync(block, { finishFlush: constants.Z_FULL_FLUSH }) });
    }
    return { data: Buffer.concat([...blocks.map((block) => block.packed), Buffer.from([0x03, 0x00])]), blocks };
}

const packed = payload.map(({ name, bytes }) => ({ name, bytes, ...deflateBlocks(bytes) }));

const blockMap = [
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
    '<BlockMap xmlns="http://schemas.microsoft.com/appx/2010/blockmap" HashMethod="http://www.w3.org/2001/04/xmlenc#sha256">',
    ...packed.map(({ name, bytes, blocks }) => {
        const hashes = blocks.map(
            ({ plain, packed: data }) => `<Block Hash="${createHash("sha256").update(plain).digest("base64")}" Size="${data.length}"/>`,
        );
        return `<File Name="${escapeXml(name)}" Size="${bytes.length}" LfhSize="${localHeaderSize(name)}">${hashes.join("")}</File>`;
    }),
    "</BlockMap>",
].join("");

const contentTypes = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="png" ContentType="image/png"/>',
    '<Override PartName="/AppxManifest.xml" ContentType="application/vnd.ms-appx.manifest+xml"/>',
    '<Override PartName="/AppxBlockMap.xml" ContentType="application/vnd.ms-appx.blockmap+xml"/>',
    "</Types>",
].join("");

const blockMapBytes = Buffer.from(blockMap, "utf8");
const contentTypesBytes = Buffer.from(contentTypes, "utf8");
const entries = [
    ...packed.map(({ name, bytes, data }) => ({ name, bytes, data, descriptor: true })),
    { name: "AppxBlockMap.xml", bytes: blockMapBytes, data: deflateBlocks(blockMapBytes).data, descriptor: true },
    { name: "[Content_Types].xml", bytes: contentTypesBytes, data: deflateRawSync(contentTypesBytes), descriptor: false },
];

// A fixed MS-DOS time (1980-01-01 00:00), so the same inputs always make the same bytes.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const DEFLATE = 8;
const DATA_DESCRIPTOR = 0x0008;

const chunks = [];
const central = [];
let offset = 0;
for (const { name, bytes, data, descriptor } of entries) {
    if (data.length > 0xffffffff || offset > 0xffffffff) {
        throw new Error("the package outgrew what this writer spells without ZIP64 extra fields");
    }
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(descriptor ? 45 : 20, 4); // version needed: 4.5 where a ZIP64 descriptor follows
    local.writeUInt16LE(descriptor ? DATA_DESCRIPTOR : 0, 6);
    local.writeUInt16LE(DEFLATE, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    // With a descriptor the header's CRC and sizes are zero, and the descriptor after the data carries them.
    local.writeUInt32LE(descriptor ? 0 : crc, 14);
    local.writeUInt32LE(descriptor ? 0 : data.length, 18);
    local.writeUInt32LE(descriptor ? 0 : bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBytes, data);
    let written = local.length + nameBytes.length + data.length;
    if (descriptor) {
        const trailer = Buffer.alloc(24);
        trailer.writeUInt32LE(0x08074b50, 0);
        trailer.writeUInt32LE(crc, 4);
        trailer.writeBigUInt64LE(BigInt(data.length), 8);
        trailer.writeBigUInt64LE(BigInt(bytes.length), 16);
        chunks.push(trailer);
        written += trailer.length;
    }

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(45, 4); // made by
    header.writeUInt16LE(descriptor ? 45 : 20, 6); // needed
    header.writeUInt16LE(descriptor ? DATA_DESCRIPTOR : 0, 8);
    header.writeUInt16LE(DEFLATE, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(bytes.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt16LE(0, 30); // extra
    header.writeUInt16LE(0, 32); // comment
    header.writeUInt16LE(0, 34); // disk
    header.writeUInt16LE(0, 36); // internal attributes
    header.writeUInt32LE(0, 38); // external attributes
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBytes);
    offset += written;
}
const centralBytes = Buffer.concat(central);
const zip64End = Buffer.alloc(56);
zip64End.writeUInt32LE(0x06064b50, 0);
zip64End.writeBigUInt64LE(44n, 4); // the size of the rest of this record
zip64End.writeUInt16LE(45, 12);
zip64End.writeUInt16LE(45, 14);
zip64End.writeUInt32LE(0, 16);
zip64End.writeUInt32LE(0, 20);
zip64End.writeBigUInt64LE(BigInt(entries.length), 24);
zip64End.writeBigUInt64LE(BigInt(entries.length), 32);
zip64End.writeBigUInt64LE(BigInt(centralBytes.length), 40);
zip64End.writeBigUInt64LE(BigInt(offset), 48);
const locator = Buffer.alloc(20);
locator.writeUInt32LE(0x07064b50, 0);
locator.writeUInt32LE(0, 4);
locator.writeBigUInt64LE(BigInt(offset + centralBytes.length), 8);
locator.writeUInt32LE(1, 16);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(0xffff, 8);
end.writeUInt16LE(0xffff, 10);
end.writeUInt32LE(0xffffffff, 12);
end.writeUInt32LE(0xffffffff, 16);
end.writeUInt16LE(0, 20);

writeFileSync(values.out, Buffer.concat([...chunks, centralBytes, zip64End, locator, end]));
console.log(`==> wrote ${values.out} (${values.publisher}, ${packageVersion(values.version)})`);
