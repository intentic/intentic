// glance's hands: the programs that read pictures and video and write the finished sheet. ffmpeg (with ffprobe) is
// the engine wherever the image carries it (the browser pack does); ImageMagick stands in for still images where it
// does not, and reads what ffmpeg cannot (PSD, HEIC, a vector format). Every call is a child process with arguments
// as an array, never a shell line, and pixels cross as raw RGBA on a pipe.
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, linkSync, mkdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export class GlanceError extends Error {}

const onPath = (name) =>
    (process.env["PATH"] ?? "").split(":").some((dir) => {
        if (dir === "") {
            return false;
        }
        try {
            accessSync(join(dir, name), constants.X_OK);
            return true;
        } catch {
            // allow(silent-catch): not in this directory is the common answer of a PATH search
            return false;
        }
    });

// The engines present, honouring GLANCE_ENGINE=ffmpeg|magick (tests use it to run the ImageMagick path on a machine
// that has both). ImageMagick 7 is `magick`, 6 is `convert` and `identify`.
export const detectEngines = () => {
    const forced = process.env["GLANCE_ENGINE"];
    const ffmpeg = forced !== "magick" && onPath("ffmpeg") && onPath("ffprobe");
    const im7 = onPath("magick");
    const im6 = !im7 && onPath("convert") && onPath("identify");
    const magick = forced === "ffmpeg" || !(im7 || im6) ? undefined : { convert: im7 ? ["magick"] : ["convert"], identify: im7 ? ["magick", "identify"] : ["identify"] };
    return { ffmpeg, magick };
};

const MISSING = "glance needs ffmpeg (or ImageMagick for still images), and this sandbox has neither on PATH. " + "Ask for it to be baked into the image: `environment propose ffmpeg`.";

const run = ([command, ...prefix], args, input) => {
    const result = spawnSync(command, [...prefix, ...args], { input, maxBuffer: 1 << 30, stdio: ["pipe", "pipe", "pipe"] });
    if (result.error !== undefined) {
        throw new GlanceError(`${command}: ${result.error.message}`);
    }
    if (result.status !== 0) {
        const said = result.stderr.toString("utf8").trim().split("\n").slice(-3).join(" | ");
        throw new GlanceError(`${command} failed (exit ${result.status}): ${said}`);
    }
    return result.stdout;
};

// A path ImageMagick cannot mistake for an option, frame index included ("[0]": the first frame of a GIF).
const magickPath = (file) => `${file.startsWith("-") ? `./${file}` : file}[0]`;

const probeFfmpeg = (file) => {
    const out = run(["ffprobe"], ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:stream_side_data=rotation:format=duration,format_name", "-of", "json", `file:${file}`]);
    const parsed = JSON.parse(out.toString("utf8"));
    const stream = parsed.streams?.[0];
    if (stream?.width === undefined) {
        throw new GlanceError(`${file}: no picture in it`);
    }
    const rotation = Math.abs(Number(stream.side_data_list?.find((each) => each.rotation !== undefined)?.rotation ?? 0));
    const turned = rotation === 90 || rotation === 270;
    const duration = Number(parsed.format?.duration);
    return { width: turned ? stream.height : stream.width, height: turned ? stream.width : stream.height, duration: Number.isFinite(duration) ? duration : undefined };
};

const probeMagick = (magick, file) => {
    const [width, height] = run(magick.identify, ["-format", "%w %h", magickPath(file)]).toString("utf8").trim().split(" ").map(Number);
    if (!(width > 0 && height > 0)) {
        throw new GlanceError(`${file}: no picture in it`);
    }
    return { width, height, duration: undefined, viaMagick: true };
};

// What a file is: its displayed width and height, its duration when it moves, and which engine reads it.
export const probe = (engines, file) => {
    if (!existsSync(file)) {
        throw new GlanceError(`${file}: no such file`);
    }
    if (statSync(file).isDirectory()) {
        throw new GlanceError(`${file}: is a directory`);
    }
    if (!engines.ffmpeg && engines.magick === undefined) {
        throw new GlanceError(MISSING);
    }
    if (engines.ffmpeg) {
        try {
            return probeFfmpeg(file);
        } catch (error) {
            if (engines.magick === undefined) {
                throw new GlanceError(`${file}: not a picture or video ffmpeg can read (${error.message})`);
            }
        }
    }
    try {
        return probeMagick(engines.magick, file);
    } catch (error) {
        throw new GlanceError(`${file}: not a picture ImageMagick can read (${error.message})`);
    }
};

const decodeFfmpeg = (file, { width, height, sampling, crop, at }) => {
    const filters = [...(crop === undefined ? [] : [`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`]), `scale=${width}:${height}:flags=${sampling === "nearest" ? "neighbor" : "area"}`, "format=rgba"];
    const seek = at === undefined ? [] : ["-ss", at.toFixed(3)];
    return run(["ffmpeg"], ["-v", "error", "-nostdin", ...seek, "-i", `file:${file}`, "-frames:v", "1", "-vf", filters.join(","), "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
};

const decodeMagick = (magick, file, { width, height, sampling, crop }) => {
    const region = crop === undefined ? [] : ["-crop", `${crop.width}x${crop.height}+${crop.x}+${crop.y}`, "+repage"];
    const filter = sampling === "nearest" ? "Point" : "Box";
    return run(magick.convert, [magickPath(file), "-alpha", "on", ...region, "-filter", filter, "-resize", `${width}x${height}!`, "-depth", "8", "rgba:-"]);
};

// One picture of `file` as width×height RGBA (from `at` seconds into a video, of `crop` when given). An empty answer
// (a seek past the last frame) is undefined.
export const decode = (engines, file, info, request) => {
    const pixels = engines.ffmpeg && info.viaMagick !== true ? decodeFfmpeg(file, request) : decodeMagick(engines.magick, file, request);
    if (pixels.length === 0) {
        return undefined;
    }
    if (pixels.length !== request.width * request.height * 4) {
        throw new GlanceError(`${file}: decoded ${pixels.length} bytes, expected ${request.width}x${request.height} RGBA`);
    }
    return pixels;
};

const encodeArgs = (engines, c, output, { format, quality, width, height }) => {
    const resize = width !== c.width || height !== c.height;
    if (engines.ffmpeg) {
        const codec = format === "png" ? ["-c:v", "png", "-compression_level", "9", "-pred", "mixed"] : ["-c:v", "mjpeg", "-pix_fmt", "yuvj444p", "-q:v", String(Math.round(2 + ((100 - quality) * 29) / 100))];
        const scale = resize ? ["-vf", `scale=${width}:${height}:flags=area`] : [];
        return [["ffmpeg"], ["-v", "error", "-nostdin", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${c.width}x${c.height}`, "-i", "-", ...scale, ...codec, "-frames:v", "1", "-f", "image2", "-update", "1", "-y", output]];
    }
    const codec = format === "png" ? ["-define", "png:compression-level=9"] : ["-quality", String(quality), "-sampling-factor", "1x1"];
    const scale = resize ? ["-filter", "Box", "-resize", `${width}x${height}!`] : [];
    return [engines.magick.convert, ["-size", `${c.width}x${c.height}`, "-depth", "8", "rgb:-", ...scale, "-strip", ...codec, `${format}:${output}`]];
};

const encode = (engines, c, output, options) => {
    const [command, args] = encodeArgs(engines, c, output, options);
    run(command, args, c.data);
    return statSync(output).size;
};

// Each PNG first; then JPEG at falling quality; then the whole thing smaller. "png" or "jpg" holds the format and only
// shrinks.
const attempts = (format) => {
    const png = format === "jpg" ? [] : [{ format: "png", quality: 100 }];
    const jpg = format === "png" ? [] : [90, 80, 70, 55].map((quality) => ({ format: "jpg", quality }));
    return [...png, ...jpg];
};

// A name in `dir` no earlier output has, claimed by a hard link (which refuses an existing name), so two runs in the
// same second never overwrite each other.
const claim = (dir, stem, ext, scratch) => {
    for (let n = 1; n < 1000; n++) {
        const path = join(dir, `${stem}${n === 1 ? "" : `-${n}`}.${ext}`);
        try {
            linkSync(scratch, path);
            return path;
        } catch (error) {
            if (error.code !== "EEXIST") {
                throw error;
            }
        }
    }
    throw new GlanceError(`no free name for ${stem} in ${dir}`);
};

// The canvas written into `dir` as `<stem>.png|jpg` under the byte budget, never overwriting; answers the path, the
// size in bytes and the pixel size it was written at.
export const save = (engines, c, { dir, stem, format = "auto", maxBytes }) => {
    if (!engines.ffmpeg && engines.magick === undefined) {
        throw new GlanceError(MISSING);
    }
    mkdirSync(dir, { recursive: true });
    let width = c.width;
    let height = c.height;
    for (let round = 0; round < 8; round++) {
        for (const attempt of attempts(format)) {
            const scratch = join(dir, `.${basename(stem)}-${process.pid}-${round}.${attempt.format}`);
            try {
                const bytes = encode(engines, c, scratch, { ...attempt, width, height });
                if (bytes <= maxBytes) {
                    return { path: claim(dir, stem, attempt.format, scratch), bytes, width, height };
                }
            } finally {
                rmSync(scratch, { force: true });
            }
        }
        width = Math.max(1, Math.round(width * 0.8));
        height = Math.max(1, Math.round(height * 0.8));
    }
    throw new GlanceError(`could not bring ${stem} under ${maxBytes} bytes`);
};
