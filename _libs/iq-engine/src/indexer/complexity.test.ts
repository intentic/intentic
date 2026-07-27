import { expect, test } from "vitest";
import { fileComplexity } from "./complexity.js";

// These counts pin BRANCH_KINDS against each grammar we load. A grammar upgrade that renames a node kind makes
// one of these fail loudly instead of silently deflating every hotspot score.

test("straight-line code has no branch points", () => {
    expect(fileComplexity("src/a.ts", "ts", "export const add = (a: number, b: number): number => a + b;\n")).toBe(0);
});

test("TypeScript: if, else-if, loop, switch arms, catch, ternary, short-circuit", () => {
    const ts = `export const classify = (n: number, flag: boolean): string => {
    if (n < 0) {
        return "neg";
    } else if (n === 0) {
        return "zero";
    }
    for (const _ of [1, 2]) {
        while (flag && n > 0) {
            n--;
        }
    }
    switch (n) {
        case 1:
            break;
        case 2:
            break;
        default:
            break;
    }
    try {
        JSON.parse("{}");
    } catch {
        return "err";
    }
    return n > 3 ? "big" : (undefined ?? "small");
};
`;
    // if + else-if + for + while + && + 2 cases + catch + ternary + ?? = 10
    expect(fileComplexity("src/a.ts", "ts", ts)).toBe(10);
});

test("Python: if/elif, for, while, except, ternary, boolean operator", () => {
    const py = `def classify(n, flag):
    if n < 0:
        return "neg"
    elif n == 0:
        return "zero"
    for _ in [1, 2]:
        while flag and n > 0:
            n -= 1
    try:
        parse()
    except ValueError:
        return "err"
    return "big" if n > 3 else "small"
`;
    // if + elif + for + while + and + except + ternary = 7
    expect(fileComplexity("src/a.py", "python", py)).toBe(7);
});

test("Go: if, for, switch cases, short-circuit", () => {
    const go = `package main

func classify(n int, flag bool) string {
	if n < 0 {
		return "neg"
	}
	for i := 0; i < n; i++ {
		if flag && i > 2 {
			return "hit"
		}
	}
	switch n {
	case 1:
		return "one"
	case 2:
		return "two"
	}
	return "other"
}
`;
    // 2 ifs + for + && + 2 cases = 6
    expect(fileComplexity("src/a.go", "go", go)).toBe(6);
});

test("Rust: if expression, loops, match arms, short-circuit", () => {
    const rust = `pub fn classify(n: i32, flag: bool) -> &'static str {
    if n < 0 && flag {
        return "neg";
    }
    for _ in 0..n {
        while n > 0 {
            break;
        }
    }
    match n {
        1 => "one",
        _ => "other",
    }
}
`;
    // if + && + for + while + 2 match arms = 6
    expect(fileComplexity("src/a.rs", "rust", rust)).toBe(6);
});

test("Java: if, enhanced for, switch cases, catch", () => {
    const java = `class Classifier {
    String classify(int n, boolean flag) {
        if (n < 0 || flag) {
            return "neg";
        }
        for (int i : new int[] { 1, 2 }) {
            n += i;
        }
        switch (n) {
            case 1:
                return "one";
            case 2:
                return "two";
        }
        try {
            check();
        } catch (Exception e) {
            return "err";
        }
        return "other";
    }
}
`;
    // if + || + enhanced-for + 2 cases + catch = 6
    expect(fileComplexity("src/A.java", "java", java)).toBe(6);
});

test("Vue SFC: only the script block's decisions count, not the template's v-if", () => {
    const vue = `<script setup lang="ts">
const label = (n: number): string => {
    if (n > 0) {
        return "pos";
    }
    return n === 0 ? "zero" : "neg";
};
</script>

<template>
    <span v-if="ok">{{ label(1) }}</span>
    <span v-else-if="other">x</span>
</template>
`;
    // if + ternary — the template's v-if/v-else-if are markup.
    expect(fileComplexity("src/A.vue", "vue", vue)).toBe(2);
});

test("languages with no grammar fall back to a lexical count", () => {
    const shell = `if [ -f x ]; then
  for f in *; do echo "$f"; done
fi
`;
    expect(fileComplexity("scripts/run.sh", undefined, shell)).toBe(2);
});

test("data and markup score zero — their keywords are content, not code paths", () => {
    // `\bfor\b` matches inside hyphenated package names; unfiltered, pnpm-lock.yaml outranked every real file.
    const lock = "packages:\n  /es5-ext-for-each@1.0.0:\n  /param-case@3.0.4:\n  /is-if-when@2.0.0:\n";
    expect(fileComplexity("pnpm-lock.yaml", undefined, lock)).toBe(0);
    expect(fileComplexity("docs/guide.md", undefined, "Use `if` and `for` loops when iterating.\n")).toBe(0);
});
