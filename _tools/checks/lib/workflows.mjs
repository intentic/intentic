/* THE WORKFLOW FILES, read by a line scanner for the same reason the lockfile is: these checks run before any
 * install, so a YAML parser is not a dependency they may take. Jobs sit at 2 spaces and their keys at 4; a
 * block scalar (`if: |`) or a block sequence (`needs:` over several lines) is folded back to one line, which is
 * all any of them is read for. actionlint and zizmor (lint-workflows.sh) read the same files with real parsers;
 * what lives here is repository policy neither of those tools encodes. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { root } from "./repo.mjs";

export const WORKFLOWS = join(root, ".github/workflows");
export const workflowFiles = () => readdirSync(WORKFLOWS).filter((name) => name.endsWith(".yml"));
export const workflowText = (file) => readFileSync(join(WORKFLOWS, file), "utf8");

// The jobs of one workflow as `{ name, if, needs, runsOn, uses }`, keyed by name.
export const jobsOf = (text) => {
    const lines = text.split("\n");
    const jobs = new Map();
    let job = null;
    for (let i = lines.findIndex((line) => /^jobs:\s*$/.test(line)) + 1; i < lines.length; i++) {
        const header = lines[i].match(/^ {2}([A-Za-z_][\w-]*):\s*$/);
        if (header) {
            jobs.set(header[1], (job = { name: header[1], if: "", needs: [], runsOn: "", uses: "" }));
            continue;
        }
        const field = job && lines[i].match(/^ {4}(if|needs|runs-on|uses):[ \t]*(.*?)\s*$/);
        if (!field) {
            continue;
        }
        let value = field[2];
        if (value === "" || value === "|" || value === ">") {
            for (value = ""; /^ {6,}\S/.test(lines[i + 1] ?? "");) {
                value += ` ${lines[++i].trim().replace(/^-\s*/, ",")}`;
            }
        }
        if (field[1] === "needs") {
            job.needs = value
                .replaceAll(/[[\]]/g, "")
                .split(",")
                .map((name) => name.trim())
                .filter(Boolean);
        } else {
            job[field[1] === "runs-on" ? "runsOn" : field[1]] = value;
        }
    }
    return jobs;
};

// What the shorthands (`permissions: read-all`) set every scope to at once.
const SHORTHAND = { read: "read", write: "write", "read-all": "read", "write-all": "write", "{}": "none" };
export const SCOPES = [
    "actions",
    "attestations",
    "checks",
    "contents",
    "deployments",
    "discussions",
    "id-token",
    "issues",
    "models",
    "packages",
    "pages",
    "pull-requests",
    "repository-projects",
    "security-events",
    "statuses",
];

/* The `permissions:` blocks of one workflow, keyed by the job that owns each, "" for the workflow's own.
 * `permissions:` sits at column 0 (the workflow's own, inherited by every job that names none) or column 4
 * (one job's, replacing it outright: a scope the block omits is `none`, not inherited). */
export const permissionsOf = (text) => {
    const lines = text.split("\n");
    const blocks = new Map();
    let job = "";
    let inJobs = false;
    for (let i = 0; i < lines.length; i++) {
        inJobs ||= /^jobs:\s*$/.test(lines[i]);
        const header = inJobs && lines[i].match(/^ {2}([A-Za-z_][\w-]*):\s*$/);
        if (header) {
            job = header[1];
            continue;
        }
        const declared = lines[i].match(/^( *)permissions:[ \t]*(.*?)\s*$/);
        if (!declared || (declared[1].length !== 0 && declared[1].length !== 4)) {
            continue;
        }
        const owner = declared[1].length === 0 ? "" : job;
        if (declared[2] !== "") {
            blocks.set(owner, Object.fromEntries(SCOPES.map((scope) => [scope, SHORTHAND[declared[2]] ?? "none"])));
            continue;
        }
        // The scopes under the key, to the first line that is not indented past it. A comment among them is a
        // line to step over, not a scope: several of these blocks explain themselves scope by scope.
        const scopes = {};
        const under = new RegExp(`^ {${declared[1].length + 2},}(?:#|([a-z-]+):[ \\t]*(\\S+))`);
        for (let scope; (scope = (lines[i + 1] ?? "").match(under)); i++) {
            if (scope[1]) {
                scopes[scope[1]] = scope[2];
            }
        }
        blocks.set(owner, scopes);
    }
    return blocks;
};

// The step block of each job of one workflow, keyed by job: everything below a job's header until the next one.
export const stepsOf = (text) => {
    const lines = text.split("\n");
    const blocks = new Map();
    let job = null;
    for (let i = lines.findIndex((line) => /^jobs:\s*$/.test(line)) + 1; i < lines.length; i++) {
        const header = lines[i].match(/^ {2}([A-Za-z_][\w-]*):\s*$/);
        if (header) {
            blocks.set((job = header[1]), []);
        } else if (job !== null) {
            blocks.get(job).push(lines[i]);
        }
    }
    return new Map([...blocks].map(([name, block]) => [name, block.join("\n")]));
};
