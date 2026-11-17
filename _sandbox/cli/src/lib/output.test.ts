import { loadConfig } from "../env.config.js";
import { createOutput } from "./output.js";

const sink = () => {
    const chunks: string[] = [];
    return { chunks, write: (chunk: string) => chunks.push(chunk) };
};

afterEach(() => {
    delete process.env["INTENTIC_OUTPUT"];
});

test("intenticOutput reads INTENTIC_OUTPUT and defaults to text", () => {
    process.env["INTENTIC_OUTPUT"] = "json";
    expect(loadConfig().intenticOutput).toBe("json");
    process.env["INTENTIC_OUTPUT"] = "ndjson";
    expect(loadConfig().intenticOutput).toBe("ndjson");
    process.env["INTENTIC_OUTPUT"] = "garbage";
    expect(loadConfig().intenticOutput).toBe("text");
    delete process.env["INTENTIC_OUTPUT"];
    expect(loadConfig().intenticOutput).toBe("text");
});

test("text mode prints each text line and leaves the result unprinted", () => {
    const s = sink();
    const out = createOutput(s, "text");
    out.text("created empty monorepo shop");
    out.result({ name: "shop" });
    expect(s.chunks).toEqual(["created empty monorepo shop\n"]);
});

test("ndjson mode emits only a timestamped terminal result", () => {
    const s = sink();
    const out = createOutput(s, "ndjson");
    out.text("ignored in ndjson");
    out.result({ name: "shop", dir: "./shop" });
    expect(s.chunks).toHaveLength(1);
    const { t, ...rest } = JSON.parse(s.chunks[0] ?? "") as Record<string, unknown>;
    expect(typeof t).toBe("number");
    expect(rest).toEqual({ kind: "result", name: "shop", dir: "./shop" });
});

test("json mode is silent during the run and emits one document at the end", () => {
    const s = sink();
    const out = createOutput(s, "json");
    out.text("ignored in json");
    out.result({ name: "shop" });
    expect(s.chunks).toHaveLength(1);
    expect(JSON.parse(s.chunks[0] ?? "")).toEqual({ name: "shop" });
});
