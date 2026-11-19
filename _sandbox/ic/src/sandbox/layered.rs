use std::collections::{BTreeMap, BTreeSet};

use serde::Deserialize;

use crate::docker;
use crate::logfile::Log;

/* AN ENVIRONMENT BUILT IN LAYERS, so a new daemon does not rebuild the recipe.

An overlay is `FROM <sandbox image>` and its recipe's steps. Every commit's daemon is a new image, and BuildKit keys each
step on the whole chain under it, so every update (and every `pnpm rebuild:sandbox`) ran the whole recipe again: on rog,
2026-11-19, a dev rebuild spent 16 of its 30 minutes re-installing an Android SDK, Flutter and a JDK that had not changed,
and another four exporting the 28.5 GB result.

An image built from this checkout says how to avoid that (_tools/scripts/image/image-top.mjs): its `dev.intentic.tools`
label names the image of its `tools` stage (the OS, the CLIs, the feature packs: what a commit rarely changes), and its
`dev.intentic.image-top` label carries a replay of the rest, one COPY of every path the per-commit stage writes, out of
the image itself, and the few RUNs that link them in. So the build here is

    FROM <the image> AS sandbox-image
    FROM <its tools image>
    <the stage's ENV and WORKDIR>          what the recipe saw on the whole image
    <the recipe's leading steps>           cached for as long as `tools` is
    <the replay>                           one COPY layer and a handful of RUNs, the only part a new commit rebuilds
    <the rest of the recipe>

A step goes below the replay only if it cannot tell the difference: a RUN or ENV that names no path the replay writes,
no command the replay installs and no variable the replay sets. The first step that does stays above, with every step
after it, so the recipe's order is kept. The replay costs a copy of the per-commit stage on every new daemon, so only a
recipe heavier than that is built in layers (`worth_layering`). An image without the labels (one published before them,
the core profile), a light recipe or one whose first step must stay above is built as before, FROM the whole image.
Either way the overlay's content, and so its hash and the stamp the container carries, is the recipe as composed: only
what is built from it differs. */

/// The image's `tools` stage image, named by the image (build-sandbox-image.sh, publish-images.sh).
pub const TOOLS_LABEL: &str = "dev.intentic.tools";
/// The replay of the image's per-commit stage (image-top.mjs).
pub const IMAGE_TOP_LABEL: &str = "dev.intentic.image-top";

/// The one replay format this binary reads.
const FORMAT: u64 = 1;

/// The image-top label's content, as image-top.mjs writes it.
#[derive(Debug, Deserialize)]
pub(crate) struct ImageTop {
    format: u64,
    prelude: String,
    replay: String,
    #[serde(default)]
    touches: Vec<String>,
    #[serde(default)]
    commands: Vec<String>,
    #[serde(default)]
    env: Vec<String>,
}

/// What a layered build builds, and how the recipe split.
#[derive(Debug, PartialEq)]
pub(crate) struct Layered {
    pub(crate) dockerfile: String,
    pub(crate) below: usize,
    pub(crate) above: usize,
}

/// The layered build for `overlay` on `base`, when `base` says how, its tools image is here (pulled when `pull`) and the
/// recipe is worth it ([`worth_layering`], with `previous` the image the sandbox runs now); None for the classic build.
/// The labels returned are the base's own, to carry onto the build: FROM `tools` it inherits none of the ones the whole
/// image was given at build time.
pub(crate) fn plan(
    overlay: &str,
    base: &str,
    previous: Option<&str>,
    pull: bool,
    log: &Log,
) -> Option<(Layered, BTreeMap<String, String>)> {
    let labels: BTreeMap<String, String> = docker::inspect(base, "{{json .Config.Labels}}")
        .and_then(|json| {
            serde_json::from_str::<Option<BTreeMap<String, String>>>(&json)
                .ok()
                .flatten()
        })
        .unwrap_or_default();
    let tools = labels.get(TOOLS_LABEL)?.trim().to_string();
    let top: ImageTop = match serde_json::from_str(labels.get(IMAGE_TOP_LABEL)?) {
        Ok(top) => top,
        Err(why) => {
            log.line(&format!("{base}'s {IMAGE_TOP_LABEL} label does not parse ({why}): building FROM the whole image"));
            return None;
        }
    };
    let layered = layered(overlay, &tools, &top)?;
    if !docker::image_exists(&tools) && !(pull && docker::pull(&tools, log).is_ok()) {
        log.line(&format!(
            "{tools}, the tools image {base} names, is not here: building FROM the whole image"
        ));
        return None;
    }
    let size = |image: &str| {
        docker::try_capture(&["image", "inspect", "--format", "{{.Size}}", image])
            .and_then(|bytes| bytes.trim().parse::<u64>().ok())
    };
    let (Some(base_bytes), Some(tools_bytes)) = (size(base), size(&tools)) else {
        return None;
    };
    let top_bytes = base_bytes.saturating_sub(tools_bytes);
    let recipe_bytes = previous
        .and_then(size)
        .map(|bytes| bytes.saturating_sub(base_bytes));
    if !worth_layering(recipe_bytes, top_bytes) {
        log.line(&format!(
            "building FROM the whole image: the recipe's last build ({} bytes) is lighter than replaying {base}'s per-commit stage ({top_bytes} bytes)",
            recipe_bytes.map_or_else(|| "none".to_string(), |bytes| bytes.to_string())
        ));
        return None;
    }
    let carried = labels
        .into_iter()
        .filter(|(key, _)| key != TOOLS_LABEL && key != IMAGE_TOP_LABEL)
        .collect();
    Some((layered, carried))
}

/// Whether a layered build pays for itself. Its price is the replay: a copy of the whole per-commit stage (`top_bytes`,
/// the base less its tools image; ~3 GB, measured at 115 s to copy and 70 s to export and unpack, 2026-11-19), made on
/// every new daemon and kept unpacked beside the base in each environment. What it saves is re-running the recipe, which
/// costs about as much as the layers it writes: `recipe_bytes`, what the image the sandbox runs now holds beyond its base
/// (it carries the replay too when it was built in layers, as the base carries the top, so the difference is the recipe
/// either way). A recipe of a few packages is cheaper to re-run than the replay, so it is built FROM the whole image, as
/// is a first build, which has no earlier one to measure (and builds every step either way). Pure.
pub(crate) fn worth_layering(recipe_bytes: Option<u64>, top_bytes: u64) -> bool {
    recipe_bytes.is_some_and(|recipe| top_bytes > 0 && recipe > top_bytes)
}

/// One instruction of the overlay, with the comment lines above it.
struct Step {
    text: String,
    keyword: String,
    body: String,
}

/// The overlay split into the lines before its FROM, the FROM line, and its steps. None without a FROM. Pure.
fn steps_of(overlay: &str) -> Option<(Vec<&str>, &str, Vec<Step>)> {
    let lines: Vec<&str> = overlay.lines().collect();
    let at = lines
        .iter()
        .position(|line| line.trim_start().to_ascii_uppercase().starts_with("FROM "))?;
    let mut steps = Vec::new();
    let mut pending: Vec<&str> = Vec::new();
    let mut index = at + 1;
    while index < lines.len() {
        let line = lines[index];
        index += 1;
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            pending.push(line);
            continue;
        }
        let mut body = vec![line];
        let mut text = std::mem::take(&mut pending);
        text.push(line);
        // A continued instruction runs on past its comment lines, which Docker drops, until a line that does not continue.
        while body
            .last()
            .is_some_and(|last| last.trim_end().ends_with('\\'))
            && index < lines.len()
        {
            let next = lines[index];
            index += 1;
            text.push(next);
            if !next.trim().starts_with('#') {
                body.push(next);
            }
        }
        steps.push(Step {
            keyword: trimmed
                .split_whitespace()
                .next()
                .unwrap_or("")
                .to_ascii_uppercase(),
            body: body.join("\n"),
            text: text.join("\n"),
        });
    }
    let tail = pending.join("\n");
    if !tail.trim().is_empty() {
        steps.push(Step {
            text: tail,
            keyword: String::new(),
            body: String::new(),
        });
    }
    Some((lines[..at].to_vec(), lines[at], steps))
}

/// Whether `text` names `path` as a path: not as the start of a longer name (`/usr/local/bin/base` in `.../base64`). Pure.
fn names_path(text: &str, path: &str) -> bool {
    text.match_indices(path).any(|(at, _)| {
        text[at + path.len()..]
            .chars()
            .next()
            .is_none_or(|next| !(next.is_ascii_alphanumeric() || matches!(next, '-' | '_' | '.')))
    })
}

/// The variables an ENV step sets. Pure.
fn env_names(body: &str) -> Vec<String> {
    body.split_whitespace()
        .skip(1)
        .filter_map(|word| word.split_once('=').map(|(name, _)| name.to_string()))
        .collect()
}

/// Whether a step may run below the replay: a RUN or ENV that names nothing the replay writes, installs or sets. A
/// trailing comment block (no instruction) goes wherever the steps before it went. Pure.
fn below_safe(step: &Step, top: &ImageTop, commands: &BTreeSet<&str>) -> bool {
    if step.keyword.is_empty() {
        return true;
    }
    if step.keyword != "RUN" && step.keyword != "ENV" {
        return false;
    }
    if top.touches.iter().any(|path| names_path(&step.body, path)) {
        return false;
    }
    let words = step
        .body
        .split(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')));
    if words.into_iter().any(|word| commands.contains(word)) {
        return false;
    }
    step.keyword != "ENV"
        || env_names(&step.body)
            .iter()
            .all(|name| !top.env.contains(name))
}

/// The layered Dockerfile for `overlay` on the image its FROM names, whose tools image is `tools` and whose replay is
/// `top`. None when the replay is of a format this binary does not read, or no step of the recipe can go below it
/// (then there is nothing to keep, and the classic build is the cheaper one). Pure.
pub(crate) fn layered(overlay: &str, tools: &str, top: &ImageTop) -> Option<Layered> {
    if top.format != FORMAT || top.replay.trim().is_empty() || tools.is_empty() {
        return None;
    }
    let (preamble, from, steps) = steps_of(overlay)?;
    let base = from.split_whitespace().nth(1)?;
    let commands: BTreeSet<&str> = top.commands.iter().map(String::as_str).collect();
    let below = steps
        .iter()
        .take_while(|step| below_safe(step, top, &commands))
        .count();
    if steps[..below].iter().all(|step| step.keyword.is_empty()) {
        return None;
    }
    let mut out: Vec<String> = preamble.iter().map(|line| line.to_string()).collect();
    out.push(format!(
        "# Built by ic in layers (layered.rs): the recipe's leading steps on {base}'s tools stage, its per-commit stage replayed after them."
    ));
    out.push(format!("FROM {base} AS sandbox-image"));
    out.push(format!("FROM {tools}"));
    out.push(top.prelude.clone());
    out.extend(steps[..below].iter().map(|step| step.text.clone()));
    out.push(top.replay.clone());
    out.extend(steps[below..].iter().map(|step| step.text.clone()));
    Some(Layered {
        dockerfile: format!("{}\n", out.join("\n")),
        below: steps[..below]
            .iter()
            .filter(|step| !step.keyword.is_empty())
            .count(),
        above: steps[below..]
            .iter()
            .filter(|step| !step.keyword.is_empty())
            .count(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn top() -> ImageTop {
        ImageTop {
            format: 1,
            prelude: "WORKDIR /work\nENV LANG=C.utf8 SHELL=/bin/bash".to_string(),
            replay: "COPY --link --parents --from=sandbox-image /opt/sandbox /usr/local/bin/base /\nRUN ln -s /opt/sandbox/x /usr/local/bin/fileq".to_string(),
            touches: vec!["/opt/sandbox".into(), "/usr/local/bin/base".into(), "/usr/local/bin/fileq".into()],
            commands: vec!["fileq".into()],
            env: vec!["LANG".into(), "SHELL".into()],
        }
    }

    const OVERLAY: &str = "# Composed by the intentic sandbox daemon: do not edit by hand.

FROM ghcr.io/intentic/sandbox:stable

RUN --mount=type=cache,target=/var/cache/apt apt-get update \\
    # a comment inside the instruction
    && apt-get install -y ffmpeg
ENV PATH=/opt/flutter/bin:$PATH

# ---- custom (owner-approved) ----
# Rust
RUN curl https://sh.rustup.rs | sh && cp target/release/x /usr/local/bin/base64
RUN fileq read notes.pdf > /tmp/notes.txt
RUN echo after
";

    #[test]
    fn the_leading_steps_go_on_tools_the_replay_follows_and_the_rest_stays_above_it() {
        let built = layered(
            OVERLAY,
            "ghcr.io/intentic/sandbox:tools-1.2.3-amd64@sha256:abc",
            &top(),
        )
        .unwrap();
        assert_eq!(
            built.below, 3,
            "apt, the PATH and rustup (base64 is not base)"
        );
        assert_eq!(built.above, 2, "the fileq step, and every step after it");
        let file = built.dockerfile;
        let order = [
            "# Composed by the intentic sandbox daemon",
            "FROM ghcr.io/intentic/sandbox:stable AS sandbox-image",
            "FROM ghcr.io/intentic/sandbox:tools-1.2.3-amd64@sha256:abc",
            "WORKDIR /work",
            "apt-get install -y ffmpeg",
            "ENV PATH=/opt/flutter/bin:$PATH",
            "# ---- custom (owner-approved) ----",
            "RUN curl https://sh.rustup.rs",
            "COPY --link --parents --from=sandbox-image",
            "RUN fileq read notes.pdf",
            "RUN echo after",
        ];
        let at: Vec<usize> = order
            .iter()
            .map(|needle| {
                file.find(needle)
                    .unwrap_or_else(|| panic!("{needle} in\n{file}"))
            })
            .collect();
        assert!(at.windows(2).all(|pair| pair[0] < pair[1]), "{file}");
        assert!(
            file.contains("    # a comment inside the instruction\n    && apt-get"),
            "a continued step keeps its lines"
        );
        assert_eq!(
            file.matches("FROM ").count(),
            2,
            "the overlay's own FROM is replaced, not kept: {file}"
        );
    }

    #[test]
    fn a_step_naming_what_the_replay_writes_or_sets_stays_above_it() {
        let commands: BTreeSet<&str> = ["fileq"].into_iter().collect();
        let step = |text: &str| Step {
            keyword: text.split_whitespace().next().unwrap().to_string(),
            body: text.to_string(),
            text: text.to_string(),
        };
        let top = top();
        for text in [
            "RUN node /opt/sandbox/dist/x.js",
            "RUN cp x /usr/local/bin/base",
            "RUN fileq read x",
            "RUN x | /usr/bin/env fileq",
            "ENV LANG=en_US.UTF-8",
            "COPY --from=alpine /bin/sh /bin/sh2",
        ] {
            assert!(!below_safe(&step(text), &top, &commands), "{text}");
        }
        for text in [
            "RUN apt-get install -y tesseract-ocr --no-fileq-here",
            "RUN cp x /usr/local/bin/base64",
            "RUN mkdir -p /opt/sandbox-tools",
            "ENV ANDROID_HOME=/opt/android-sdk",
        ] {
            assert!(below_safe(&step(text), &top, &commands), "{text}");
        }
    }

    #[test]
    fn nothing_to_keep_below_or_nothing_to_replay_builds_the_classic_way() {
        let first_above =
            "FROM ghcr.io/intentic/sandbox:stable\nRUN node /opt/sandbox/x.js\nRUN echo hi\n";
        assert_eq!(
            layered(first_above, "tools", &top()),
            None,
            "the first step stays above"
        );
        assert_eq!(
            layered("FROM ghcr.io/intentic/sandbox:stable\n", "tools", &top()),
            None,
            "a bare overlay"
        );
        let mut newer = top();
        newer.format = 2;
        assert_eq!(
            layered(OVERLAY, "tools", &newer),
            None,
            "a replay format this binary does not read"
        );
        assert_eq!(layered(OVERLAY, "", &top()), None, "no tools image");
        assert_eq!(layered("RUN echo no from\n", "tools", &top()), None);
    }

    #[test]
    fn only_a_recipe_heavier_than_the_replay_is_built_in_layers() {
        let top = 3_000_000_000;
        assert!(
            worth_layering(Some(20_000_000_000), top),
            "rog's Android and Flutter environment"
        );
        assert!(
            !worth_layering(Some(400_000_000), top),
            "a few packages re-run faster than the replay copies"
        );
        assert!(
            !worth_layering(Some(top), top),
            "even is not worth the disk"
        );
        assert!(
            !worth_layering(None, top),
            "a first build has nothing to measure"
        );
        assert!(
            !worth_layering(Some(20_000_000_000), 0),
            "a base no bigger than its tools says nothing"
        );
    }

    #[test]
    fn the_label_parses_as_image_top_mjs_writes_it() {
        let label = r#"{"format":1,"prelude":"WORKDIR /work","replay":"COPY --link --parents --from=sandbox-image /opt/sandbox /\nRUN printf \u0027%s\u0027 \"\u0024@\"","touches":["/opt/sandbox"],"commands":[],"env":[]}"#;
        let top: ImageTop = serde_json::from_str(label).unwrap();
        assert!(
            top.replay.ends_with(r#"RUN printf '%s' "$@""#),
            "{}",
            top.replay
        );
    }
}
