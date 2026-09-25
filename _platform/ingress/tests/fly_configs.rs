//! The edge's two Fly configurations: one behind Fly's HTTP proxy, and one terminating TLS itself with UDP beside it.
//! CI deploys fly.toml on every push and the other waits beside it as `fly.edge-*.toml` (README.md, "Terminating TLS
//! at the edge": the TLS one until the swap, the proxy one after it, for a rollback), so the two must be the same app,
//! image and machine in every respect but their services, or a swap would change more than who holds the certificate.

use std::path::{Path, PathBuf};

use toml::{Table, Value};

// The service sections, the one thing the files are allowed to differ in.
const SERVICES: [&str; 2] = ["http_service", "services"];

// What the runbook sets the process to bind: INGRESS_TLS_PORT and INGRESS_QUIC_PORT, and the plain INGRESS_PORT.
const TLS_PORT: i64 = 8443;
const PLAIN_PORT: i64 = 8080;

fn configs() -> Vec<(PathBuf, Table)> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut found: Vec<(PathBuf, Table)> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("fly") && name.ends_with(".toml"))
        })
        .map(|path| {
            let table = std::fs::read_to_string(&path).unwrap().parse().unwrap();
            (path, table)
        })
        .collect();
    found.sort_by(|a, b| a.0.cmp(&b.0));
    found
}

fn without_services(table: &Table) -> Table {
    let mut rest = table.clone();
    for section in SERVICES {
        rest.remove(section);
    }
    rest
}

fn services(table: &Table) -> Vec<&Table> {
    table
        .get("services")
        .and_then(Value::as_array)
        .map(|services| services.iter().filter_map(Value::as_table).collect())
        .unwrap_or_default()
}

fn at<'a>(table: &'a Table, path: &[&str]) -> Option<&'a Value> {
    let (last, parents) = path.split_last()?;
    let mut current = table;
    for key in parents {
        current = current.get(*key)?.as_table()?;
    }
    current.get(*last)
}

#[test]
fn every_fly_config_is_the_same_app_image_and_machine_but_for_its_services() {
    let configs = configs();
    let names: Vec<String> = configs
        .iter()
        .map(|(path, _)| path.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    assert!(
        names.len() == 2
            && names.contains(&"fly.toml".to_owned())
            && names.iter().any(|name| name.starts_with("fly.edge-")),
        "fly.toml and one fly.edge-*.toml beside it, not {names:?}"
    );
    let deployed = without_services(
        &configs
            .iter()
            .find(|(path, _)| path.ends_with("fly.toml"))
            .unwrap()
            .1,
    );
    assert_eq!(
        configs
            .iter()
            .filter(|(_, table)| table.contains_key("http_service"))
            .count(),
        1,
        "one config behind Fly's proxy, one terminating TLS"
    );
    for (path, table) in &configs {
        assert_eq!(
            without_services(table),
            deployed,
            "{} differs from fly.toml outside its services",
            path.display()
        );
        let sections: Vec<&str> = SERVICES
            .into_iter()
            .filter(|section| table.contains_key(*section))
            .collect();
        assert_eq!(sections.len(), 1, "{} names {sections:?}", path.display());
    }
}

#[test]
fn the_tls_config_passes_443_through_with_proxy_headers_and_carries_udp_beside_it() {
    let configs = configs();
    let (_, proxied) = configs
        .iter()
        .find(|(_, table)| table.contains_key("http_service"))
        .expect("fly.toml sits behind Fly's HTTP proxy");
    let (_, tls) = configs
        .iter()
        .find(|(_, table)| table.contains_key("services"))
        .expect("a config terminates TLS itself");
    let listed = services(tls);
    let on = |protocol: &str, port: i64| -> &Table {
        listed
            .iter()
            .find(|service| {
                service.get("protocol").and_then(Value::as_str) == Some(protocol)
                    && service
                        .get("ports")
                        .and_then(Value::as_array)
                        .is_some_and(|ports| {
                            ports.iter().any(|entry| {
                                entry.get("port").and_then(Value::as_integer) == Some(port)
                            })
                        })
            })
            .unwrap_or_else(|| panic!("no {protocol} service on {port}"))
    };
    let port_of = |service: &Table| -> Table {
        service["ports"].as_array().unwrap()[0]
            .as_table()
            .unwrap()
            .clone()
    };

    let secure = on("tcp", 443);
    assert_eq!(secure["internal_port"].as_integer(), Some(TLS_PORT));
    let secure_port = port_of(secure);
    assert_eq!(
        secure_port["handlers"],
        Value::Array(vec![Value::String("proxy_proto".into())])
    );
    assert_eq!(
        at(&secure_port, &["proxy_proto_options", "version"]).and_then(Value::as_str),
        Some("v2")
    );
    // The same connection accounting fly.toml gives Fly's proxy, for the same streams that never finish.
    assert_eq!(
        secure.get("concurrency"),
        at(proxied, &["http_service", "concurrency"])
    );

    let plain = on("tcp", 80);
    assert_eq!(plain["internal_port"].as_integer(), Some(PLAIN_PORT));
    assert_eq!(
        port_of(plain).get("force_https").and_then(Value::as_bool),
        Some(true)
    );

    let quic = on("udp", 443);
    assert_eq!(quic["internal_port"].as_integer(), Some(TLS_PORT));

    for service in &listed {
        assert_eq!(
            service.get("auto_stop_machines").and_then(Value::as_bool),
            Some(false),
            "a stopped edge machine drops every tunnel it holds"
        );
        assert_eq!(
            service
                .get("min_machines_running")
                .and_then(Value::as_integer),
            Some(1)
        );
    }
}
