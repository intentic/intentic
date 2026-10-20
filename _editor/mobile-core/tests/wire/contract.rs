//! The schemas the samples are checked against, and the checks themselves.

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::OnceLock;

fn crate_path(path: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(path)
}

fn read_json(path: &str) -> Value {
    let full = crate_path(path);
    let text = std::fs::read_to_string(&full)
        .unwrap_or_else(|error| panic!("{}: {error}", full.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", full.display()))
}

/// `_shared/sandbox-contract/contract.lock.json`: every daemon schema by its export name, and `access:METHOD /path`
/// for every route.
pub fn lock() -> &'static Map<String, Value> {
    static LOCK: OnceLock<Map<String, Value>> = OnceLock::new();
    LOCK.get_or_init(
        || match read_json("../../_shared/sandbox-contract/contract.lock.json") {
            Value::Object(map) => map,
            _ => panic!("the lock is not an object"),
        },
    )
}

/// `src/wire/api.schema.json`: each platform call the app makes, with its method, path and schemas.
pub fn api() -> &'static Map<String, Value> {
    static API: OnceLock<Map<String, Value>> = OnceLock::new();
    API.get_or_init(|| match read_json("src/wire/api.schema.json") {
        Value::Object(map) => map,
        _ => panic!("api.schema.json is not an object"),
    })
}

/// The schema a sample file's key names: a lock export (`AgentSummarySchema`) or a platform call's half
/// (`sandbox.list:output`).
fn schema_of(key: &str) -> &'static Value {
    match key.split_once(':') {
        Some((call, half)) => api()
            .get(call)
            .and_then(|entry| entry.get(half))
            .unwrap_or_else(|| panic!("api.schema.json has no {half} for {call}")),
        None => lock()
            .get(key)
            .unwrap_or_else(|| panic!("the lock has no {key}")),
    }
}

/// Better Auth tags a field `.meta({ required: true })`, which zod copies into the JSON Schema as a `required` keyword
/// that is not an array, so the validator refuses the whole schema. The field is in its object's own `required` list
/// already, so the stray one is dropped.
fn without_stray_required(schema: &mut Value) {
    match schema {
        Value::Object(map) => {
            if map.get("required").is_some_and(Value::is_boolean) {
                map.remove("required");
            }
            map.values_mut().for_each(without_stray_required);
        }
        Value::Array(items) => items.iter_mut().for_each(without_stray_required),
        _ => {}
    }
}

fn validator(key: &str) -> jsonschema::Validator {
    let mut schema = schema_of(key).clone();
    without_stray_required(&mut schema);
    jsonschema::draft202012::new(&schema)
        .unwrap_or_else(|error| panic!("{key} does not compile: {error}"))
}

fn assert_valid(validator: &jsonschema::Validator, key: &str, label: &str, value: &Value) {
    let errors: Vec<String> = validator
        .iter_errors(value)
        .map(|error| format!("  at {}: {error}", error.instance_path()))
        .take(8)
        .collect();
    assert!(
        errors.is_empty(),
        "{key} / {label}:\n{}\n{}",
        errors.join("\n"),
        serde_json::to_string_pretty(value).unwrap()
    );
}

/// One sample file: its samples by schema key, then by name. Taken key by key, so a key no test reads fails.
pub struct Samples {
    file: String,
    entries: BTreeMap<String, Map<String, Value>>,
}

impl Samples {
    pub fn load(file: &str) -> Samples {
        let path = format!("src/wire/samples/{file}");
        let entries = serde_json::from_value(read_json(&path))
            .unwrap_or_else(|error| panic!("{path}: {error}"));
        Samples {
            file: path,
            entries,
        }
    }

    fn take(&mut self, key: &str) -> Map<String, Value> {
        self.entries
            .remove(key)
            .unwrap_or_else(|| panic!("{} has no samples for {key}", self.file))
    }

    /// Checks every sample under `key` against its schema, decoded as `T` and written back.
    pub fn checked<T: DeserializeOwned + Serialize>(&mut self, key: &str) -> Vec<(String, T)> {
        let validator = validator(key);
        self.take(key)
            .into_iter()
            .map(|(label, sample)| {
                assert_valid(&validator, key, &label, &sample);
                let typed: T = serde_json::from_value(sample.clone())
                    .unwrap_or_else(|error| panic!("{key} / {label} does not decode: {error}"));
                let written = serde_json::to_value(&typed).unwrap();
                assert_valid(&validator, key, &format!("{label}, written back"), &written);
                (label, typed)
            })
            .collect()
    }

    /// Decodes the samples of a shape no schema holds (`unschemed:Name`): bodies the daemon or Better Auth write by
    /// hand, and frames from a daemon newer than the contract.
    pub fn decoded<T: DeserializeOwned>(&mut self, name: &str) -> Vec<(String, T)> {
        let key = format!("unschemed:{name}");
        self.take(&key)
            .into_iter()
            .map(|(label, sample)| {
                let typed = serde_json::from_value(sample)
                    .unwrap_or_else(|error| panic!("{key} / {label} does not decode: {error}"));
                (label, typed)
            })
            .collect()
    }

    pub fn finish(self) {
        let left: Vec<&String> = self.entries.keys().collect();
        assert!(
            left.is_empty(),
            "{} has samples no test reads: {left:?}",
            self.file
        );
    }
}

/// Fails unless the daemon declares this route: its `access:` row in the lock, which every raw route and procedure has.
pub fn assert_daemon_route(endpoint: intentic_mobile::wire::Endpoint) {
    let key = format!("access:{} {}", endpoint.method.as_str(), endpoint.path);
    assert!(lock().contains_key(&key), "the daemon declares no {key}");
}

/// Fails unless the platform call `name` is this method and path.
pub fn assert_platform_route(name: &str, endpoint: intentic_mobile::wire::Endpoint) {
    let entry = api()
        .get(name)
        .unwrap_or_else(|| panic!("api.schema.json has no {name}"));
    assert_eq!(entry["method"], endpoint.method.as_str(), "{name}'s method");
    assert_eq!(entry["path"], endpoint.path, "{name}'s path");
}

/// Whether `value` is valid against the schema `key` names, for tests that prove the check refuses what it should.
pub fn is_valid(key: &str, value: &Value) -> bool {
    validator(key).is_valid(value)
}
