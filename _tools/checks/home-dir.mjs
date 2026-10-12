#!/usr/bin/env node
// ONE WAY TO THE HOME DIRECTORY in the device agent (_devices/machine): `homeDir()` from @intentic/local-agent, which
// follows a HOME (or USERPROFILE) set after startup where `os.homedir()` is fixed at it. Three spellings of "home" once
// lived side by side there, and a test that moved HOME moved only some of them. Its tests are not read: one may reach
// the real home to compare against.
//
// This was a suite inside @intentic/machine, which ran only when that package's tests did. A check runs as the line is
// written, in whichever package the writer is working.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homeDirCalls } from "./lib/home-dir-calls.mjs";
import { finish } from "./lib/report.mjs";
import { root, subjectFiles } from "./lib/repo.mjs";

const files = subjectFiles("_devices/machine/src").filter((path) => path.endsWith(".ts") && !path.slice(path.lastIndexOf("/") + 1).includes(".test."));
const found = files.flatMap((path) => homeDirCalls(readFileSync(join(root, path), "utf8")).map((line) => `${path}:${line}  homedir(`));

finish(
    [
        [
            `the home directory reached past homeDir(): import { homeDir } from "@intentic/local-agent", which follows a HOME (or USERPROFILE) set after startup where os.homedir() is fixed at it`,
            found,
        ],
    ],
    [`${files.length} sources in _devices/machine/src: every reach for the home directory goes through homeDir()`],
);
