import { answeringUi, machineUi, sandboxUrlOf } from "./cli-ui.js";
import { linkNamed } from "./device/commands.js";

// A pipe's process, keeping what lands on each stream.
const piped = () => {
    const out: string[] = [];
    const err: string[] = [];
    return {
        process: {
            stdout: { write: (chunk: string) => void out.push(chunk) },
            stderr: { write: (chunk: string) => void err.push(chunk) },
            env: { INTENTIC_UI: "plain" },
        },
        out,
        err,
    };
};

describe("the run's renderer", () => {
    it("is one per run, so a stop settles the line that was running", () => {
        const { process } = piped();
        expect(machineUi(process)).toBe(machineUi(process));
    });

    // Under --json stdout carries the one document; a live line or a note there would break the reader.
    it("draws every human line on stderr when the run answers in JSON", () => {
        const { process, out, err } = piped();
        const ui = answeringUi(process, true);
        ui.act("Attaching the folder");
        ui.note("starting the agent");
        expect(out).toEqual([]);
        expect(err.join("")).toBe("intentic: attaching the folder…\nintentic: starting the agent\n");
    });
});

describe("--sandbox, the one spelling", () => {
    it("stands in for --url, and refuses two different sandboxes or none", () => {
        expect(sandboxUrlOf(undefined, "https://a.example", "x")).toBe("https://a.example");
        expect(sandboxUrlOf("https://a.example", undefined, "x")).toBe("https://a.example");
        expect(sandboxUrlOf("https://a.example", "https://a.example", "x")).toBe("https://a.example");
        expect(() => sandboxUrlOf("https://a.example", "https://b.example", "Nothing was set up.")).toThrow(
            /^Nothing was set up\.\n {3}problem: --url and --sandbox/,
        );
        expect(() => sandboxUrlOf(undefined, undefined, "Nothing was set up.")).toThrow("no sandbox was named");
    });

    it("names a device link by its URL, or by the one URL holding the id given", () => {
        const urls = ["https://sandbox-0738.example.dev", "https://sandbox-bce5.example.dev"];
        expect(linkNamed(urls, "https://sandbox-bce5.example.dev")).toBe("https://sandbox-bce5.example.dev");
        expect(linkNamed(urls, "0738")).toBe("https://sandbox-0738.example.dev");
        expect(linkNamed(urls, "nope")).toBe("nope");
        expect(() => linkNamed(urls, "example.dev")).toThrow("matches more than one connected sandbox");
    });
});
