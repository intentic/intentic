import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";

// bin/glance as the image installs it, on pictures and a video ffmpeg makes here (testsrc), written under a temporary
// GLANCE_DIR. The ImageMagick path runs too where `magick` is on PATH. Without ffmpeg there is nothing to drive.
const GLANCE = join(packageRoot(import.meta.url), "bin/glance");
const onPath = (name: string): boolean => spawnSync("sh", ["-c", `command -v ${name}`]).status === 0;
const hasFfmpeg = onPath("ffmpeg") && onPath("ffprobe");
const hasMagick = onPath("magick");
const SLOW = 60_000;

const ffmpeg = (args: readonly string[]): void => {
    const result = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { encoding: "utf8" });
    expect(result.stderr).toBe("");
};

const fixtures = () => {
    const root = mkdtempSync(join(tmpdir(), "glance-"));
    const pictures = join(root, "pictures");
    mkdirSync(pictures);
    const still = (name: string, source: string, filter?: string) => {
        ffmpeg(["-f", "lavfi", "-i", source, ...(filter === undefined ? [] : ["-vf", filter]), "-frames:v", "1", join(pictures, name)]);
        return join(pictures, name);
    };
    // `count` pictures `<prefix>1.png`, `<prefix>2.png`, ... from one ffmpeg run: one per second of the source.
    const sequence = (prefix: string, count: number, source: string, filter?: string) => {
        ffmpeg(["-f", "lavfi", "-i", `${source}:r=1`, ...(filter === undefined ? [] : ["-vf", filter]), "-frames:v", String(count), join(pictures, `${prefix}%d.png`)]);
        return Array.from({ length: count }, (_, index) => join(pictures, `${prefix}${index + 1}.png`));
    };
    return { root, pictures, still, sequence, out: join(root, "out") };
};

const glance = (out: string, args: readonly string[], env: Record<string, string> = {}) => {
    const result = spawnSync("node", [GLANCE, ...args], { encoding: "utf8", env: { ...process.env, GLANCE_DIR: out, ...env } });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
};

// The size ffprobe reads off a written file, not the one glance printed.
const sizeOf = (file: string) => {
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], { encoding: "utf8" });
    const [width, height] = probe.stdout.trim().split(",").map(Number);
    return { width: width ?? 0, height: height ?? 0 };
};

const firstPath = (stdout: string): string => stdout.split("\n")[0]?.split("  ")[0] ?? "";

const withinBudget = (file: string): void => {
    const { width, height } = sizeOf(file);
    expect(Math.max(width, height)).toBeLessThanOrEqual(1568);
    expect(width * height).toBeLessThanOrEqual(1_150_000);
    expect(statSync(file).size).toBeLessThanOrEqual(1_000_000);
};

test.skipIf(!hasFfmpeg)(
    "a sheet of mixed sizes from a directory is one labelled picture in the artifacts folder, and a second run never overwrites it",
    () => {
        const { pictures, still, out } = fixtures();
        still("wide.png", "testsrc=s=640x240");
        still("tall.png", "testsrc=s=200x400");
        still("small.png", "testsrc=s=40x30");
        const first = glance(out, ["sheet", pictures]);
        expect(first.stderr).toBe("");
        expect(first.code).toBe(0);
        const path = firstPath(first.stdout);
        expect(path.startsWith(`${out}/sheet-`)).toBe(true);
        expect(path.endsWith("-pictures.png")).toBe(true);
        withinBudget(path);
        expect(first.stdout).toContain("1  ");
        expect(first.stdout).toContain("small.png  40x30");
        expect(first.stdout).toContain("tall.png  200x400");
        const again = glance(out, ["sheet", pictures, "--cols", "1", "--labels", "none"]);
        expect(again.code).toBe(0);
        expect(firstPath(again.stdout)).not.toBe(path);
        expect(existsSync(path)).toBe(true);
        expect(sizeOf(firstPath(again.stdout)).height).toBeGreaterThan(sizeOf(firstPath(again.stdout)).width);
    },
    SLOW,
);

test.skipIf(!hasFfmpeg)(
    "a quoted glob is expanded, and pictures that would shrink past legibility go on several sheets",
    () => {
        const { pictures, sequence, out } = fixtures();
        // Ten tall slivers in one column: on one sheet each would be about 50 px wide, so they split, two to a sheet.
        const [first] = sequence("frame", 10, "testsrc=s=32x80");
        copyFileSync(first ?? "", join(pictures, "other.png"));
        const answer = glance(out, ["sheet", join(pictures, "frame*.png"), "--cols", "1"]);
        expect(answer.stderr).toBe("");
        expect(answer.code).toBe(0);
        const sheets = answer.stdout.split("\n").filter((line) => line.startsWith("/"));
        expect(sheets.length).toBe(5);
        expect(sheets[0]).toContain("-p1.png");
        expect(answer.stdout).toContain("10  ");
        expect(answer.stdout).not.toContain("other.png");
        expect(answer.stdout.indexOf("frame2.png")).toBeLessThan(answer.stdout.indexOf("frame10.png"));
        for (const line of sheets) {
            withinBudget(line.split("  ")[0] ?? "");
        }
    },
    SLOW,
);

test.skipIf(!hasFfmpeg)(
    "noisy pictures that would make a PNG past a megabyte come out as a JPEG inside the budget",
    () => {
        const { sequence, out } = fixtures();
        const files = sequence("noisy", 2, "testsrc2=s=800x450", "noise=alls=80:allf=u");
        const answer = glance(out, ["sheet", ...files]);
        expect(answer.code).toBe(0);
        expect(firstPath(answer.stdout).endsWith(".jpg")).toBe(true);
        withinBudget(firstPath(answer.stdout));
    },
    SLOW,
);

test.skipIf(!hasFfmpeg)(
    "pair measures the difference: identical says so, a changed square is counted and located, --diff adds its panel",
    () => {
        const { still, out } = fixtures();
        const before = still("before.png", "color=c=white:s=300x200");
        const after = still("after.png", "color=c=white:s=300x200", "drawbox=x=120:y=60:w=10:h=10:color=black:t=fill");
        const same = glance(out, ["pair", before, before]);
        expect(same.code).toBe(0);
        expect(same.stdout).toContain("diff: identical: 0 of 60000 pixels differ");
        const changed = glance(out, ["pair", before, after]);
        expect(changed.stdout).toContain("changed: 0.167% of pixels (100 of 60000), max delta 255");
        expect(changed.stdout).toContain("changed region x,y,w,h 120,60,10,10");
        const twoPanels = sizeOf(firstPath(changed.stdout));
        const withDiff = glance(out, ["pair", before, after, "--diff"]);
        expect(withDiff.code).toBe(0);
        expect(sizeOf(firstPath(withDiff.stdout)).width).toBeGreaterThan(twoPanels.width);
        expect(glance(out, ["pair", before, after, "--tolerance", "255"]).code).toBe(2);
    },
    SLOW,
);

test.skipIf(!hasFfmpeg)(
    "frames lays out N timestamped frames of a video, or one every S seconds",
    () => {
        const { root, out } = fixtures();
        const video = join(root, "clip.mp4");
        ffmpeg(["-f", "lavfi", "-i", "testsrc=s=320x240:d=4:r=25", "-pix_fmt", "yuv420p", video]);
        const counted = glance(out, ["frames", video, "--count", "4"]);
        expect(counted.stderr).toBe("");
        expect(counted.stdout).toContain("1  0:00.000");
        expect(counted.stdout).toContain("4  0:03.950");
        expect(counted.stdout).toContain("video: ");
        withinBudget(firstPath(counted.stdout));
        const every = glance(out, ["frames", video, "--every", "1.5"]);
        expect(every.stdout).toContain("3  0:03.000");
        expect(every.stdout).not.toContain("4  0:");
        expect(glance(out, ["frames", video, "--count", "2", "--every", "1"]).code).toBe(2);
    },
    SLOW,
);

test.skipIf(!hasFfmpeg)(
    "crop enlarges a region by a whole factor under its label, and clips a region that runs off the picture",
    () => {
        const { still, out } = fixtures();
        const picture = still("ui.png", "testsrc=s=320x240");
        const zoomed = glance(out, ["crop", picture, "10,20,40,30", "--zoom", "4"]);
        expect(zoomed.code).toBe(0);
        expect(sizeOf(firstPath(zoomed.stdout))).toEqual({ width: 160, height: 120 + 20 });
        const clipped = glance(out, ["crop", picture, "300,200,100,100"]);
        expect(clipped.stdout).toContain("region x,y,w,h 300,200,20,40 of 320x240");
        expect(clipped.stdout).toContain("region clipped to the picture");
        withinBudget(firstPath(clipped.stdout));
    },
    SLOW,
);

test.skipIf(!hasFfmpeg)("what it cannot do it says plainly: a missing file, a still picture as a video, a bad region, an unknown flag", () => {
    const { still, out } = fixtures();
    const picture = still("one.png", "testsrc=s=64x64");
    expect(glance(out, ["sheet", "/nowhere/missing.png"])).toMatchObject({ code: 1, stderr: "glance: /nowhere/missing.png: no such file\n" });
    expect(glance(out, ["frames", picture]).stderr).toContain("has no duration, so it is not a video");
    expect(glance(out, ["crop", picture, "500,500,4,4"]).stderr).toContain("lies outside the 64x64 picture");
    expect(glance(out, ["crop", picture, "1,2,3"]).code).toBe(2);
    expect(glance(out, ["sheet", picture, "--bogus"]).code).toBe(2);
    expect(glance(out, ["--help"]).stdout).toContain("longest side <= 1568 px");
    expect(existsSync(out)).toBe(false);
});

test.skipIf(!hasFfmpeg || !hasMagick)(
    "with ImageMagick as the engine a sheet and a pair come out the same way",
    () => {
        const { still, out } = fixtures();
        const before = still("a.png", "color=c=white:s=120x80");
        const after = still("b.png", "color=c=white:s=120x80", "drawbox=x=0:y=0:w=6:h=6:color=red:t=fill");
        const env = { GLANCE_ENGINE: "magick" };
        const sheet = glance(out, ["sheet", before, after], env);
        expect(sheet.code).toBe(0);
        withinBudget(firstPath(sheet.stdout));
        expect(glance(out, ["pair", before, after, "--diff"], env).stdout).toContain("changed region x,y,w,h 0,0,6,6");
        expect(glance(out, ["frames", before], env).stderr).toContain("frames needs ffmpeg");
    },
    SLOW,
);
