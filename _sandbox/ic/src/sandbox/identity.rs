use crate::docker;

/* WHICH BASE AN IMAGE WAS BUILT ON, by identity rather than by name.

A stock sandbox runs its base image, and the container's own image id answers the question. A sandbox with an approved
environment runs an overlay build (`intentic-sandbox-env-<slug>:<hash>`) whose base the container names only as a TAG
(SANDBOX_BASE_IMAGE, e.g. `ghcr.io/intentic/sandbox:stable`), and a tag moves: the machine agent's background prepare,
another sandbox's update or a connect on the same machine pulls it forward, and from then on "the id that tag names" is
the NEW base, not the one the container was built on. Read that way, every later update found the sandbox "already
current" and never moved it, and the rollback pin pinned the new build instead of the old one. */

/// The label every overlay build this ic makes carries: the image id of the base it was built on.
pub const BASE_ID_LABEL: &str = "dev.intentic.base-id";

/// The layer digests an image is made of, in order.
pub fn layers(image: &str) -> Option<Vec<String>> {
    let json = docker::try_capture(&[
        "image",
        "inspect",
        "--format",
        "{{json .RootFS.Layers}}",
        image,
    ])?;
    serde_json::from_str::<Vec<String>>(json.trim())
        .ok()
        .filter(|layers| !layers.is_empty())
}

/// Whether an image made of `image_layers` was built on one made of `base_layers`: the base's layers are its first
/// ones. An image is built on itself. Pure, so the rule is asserted without a daemon.
pub fn is_built_on(image_layers: &[String], base_layers: &[String]) -> bool {
    !base_layers.is_empty()
        && image_layers.len() >= base_layers.len()
        && image_layers[..base_layers.len()] == *base_layers
}

/// Whether `image` is built on `base` (both a reference or an id); None when either cannot be inspected.
pub fn built_on(image: &str, base: &str) -> Option<bool> {
    Some(is_built_on(&layers(image)?, &layers(base)?))
}

/// The base-id label an image carries, None when it carries none (a stock image, or an overlay an older ic built).
pub fn base_label(image: &str) -> Option<String> {
    docker::try_capture(&[
        "image",
        "inspect",
        "--format",
        &format!("{{{{index .Config.Labels \"{BASE_ID_LABEL}\"}}}}"),
        image,
    ])
    .map(|value| value.trim().to_string())
    .filter(|value| value.starts_with("sha256:"))
}

/// The id of the base the image `container` runs was built on, or None when that cannot be known honestly.
///
/// - A stock sandbox (no base stamp, or a base stamp naming the image it runs): the image it runs.
/// - An overlay this ic built: the label it carries.
/// - An overlay an older ic built: the base tag's image while that is still what it was built on; otherwise the
///   local image it WAS built on, found by its layers among the images still on this machine (the previous base is
///   usually still here, untagged); otherwise None.
pub fn running_base(
    container: &str,
    current_base: Option<&str>,
    sandbox_image: Option<&str>,
) -> Option<String> {
    let running = docker::inspect(container, "{{.Image}}")?;
    if current_base.is_none() || current_base == sandbox_image {
        return Some(running);
    }
    if let Some(labelled) = base_label(&running) {
        return Some(labelled);
    }
    let running_layers = layers(&running)?;
    if let Some(tagged) = current_base.and_then(docker::image_id) {
        if layers(&tagged).is_some_and(|base| is_built_on(&running_layers, &base)) {
            return Some(tagged);
        }
    }
    base_among_local_images(&running, &running_layers)
}

/// The deepest image on this machine, other than `running` itself, that `running` was built on: its base. One docker
/// call for every image's layers, so an overlay built before the label existed still gets its rollback pin.
fn base_among_local_images(running: &str, running_layers: &[String]) -> Option<String> {
    let ids = docker::try_capture(&["images", "--all", "--quiet", "--no-trunc"])?;
    let ids: Vec<&str> = ids
        .lines()
        .map(str::trim)
        .filter(|id| !id.is_empty() && *id != running)
        .collect();
    if ids.is_empty() {
        return None;
    }
    let mut args = vec![
        "image",
        "inspect",
        "--format",
        "{{.Id}} {{json .RootFS.Layers}}",
    ];
    args.extend(ids.iter().copied());
    let listing = docker::try_capture(&args)?;
    deepest_base(&listing, running_layers)
}

/// Out of `<id> <layers json>` lines, the image with the most layers that `running_layers` starts with, short of all
/// of them (an image with every one of its layers is a copy of it, not its base). Pure.
fn deepest_base(listing: &str, running_layers: &[String]) -> Option<String> {
    listing
        .lines()
        .filter_map(|line| {
            let (id, json) = line.split_once(' ')?;
            let base: Vec<String> = serde_json::from_str(json.trim()).ok()?;
            (base.len() < running_layers.len() && is_built_on(running_layers, &base))
                .then(|| (base.len(), id.to_string()))
        })
        .max_by_key(|(depth, _)| *depth)
        .map(|(_, id)| id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layers_of(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| format!("sha256:{name}")).collect()
    }

    #[test]
    fn an_image_is_built_on_the_image_its_layers_start_with() {
        let base = layers_of(&["a", "b"]);
        let overlay = layers_of(&["a", "b", "c"]);
        assert!(is_built_on(&overlay, &base));
        assert!(is_built_on(&base, &base), "an image is built on itself");
        // The same number of layers in another order, and a sibling built on another base, are not.
        assert!(!is_built_on(&layers_of(&["b", "a", "c"]), &base));
        assert!(!is_built_on(&layers_of(&["a", "x", "c"]), &base));
        // A base deeper than the image cannot be under it, and nothing is built on no layers at all.
        assert!(!is_built_on(&base, &overlay));
        assert!(!is_built_on(&overlay, &[]));
    }

    #[test]
    fn the_base_among_local_images_is_the_deepest_one_the_running_image_starts_with() {
        let running = layers_of(&["a", "b", "c"]);
        let listing = [
            // The new base a prepare pulled: it shares only the first layer, so it is not what this was built on.
            format!("sha256:new {}", serde_json::json!(layers_of(&["a", "z"]))),
            format!("sha256:old {}", serde_json::json!(layers_of(&["a", "b"]))),
            format!("sha256:root {}", serde_json::json!(layers_of(&["a"]))),
            // A copy of the running image (another tag) is not its base.
            format!(
                "sha256:copy {}",
                serde_json::json!(layers_of(&["a", "b", "c"]))
            ),
            "sha256:broken not-json".to_string(),
        ]
        .join("\n");
        assert_eq!(
            deepest_base(&listing, &running).as_deref(),
            Some("sha256:old")
        );
        assert_eq!(deepest_base("", &running), None);
    }
}
