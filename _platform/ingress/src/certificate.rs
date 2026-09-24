//! Where the edge's certificate comes from, kept current in its slot: a PEM pair on disk an operator renews, or the
//! platform, which orders one wildcard for every edge machine so no two of them ask the CA for the same names. A load
//! that fails keeps what the slot holds; an empty slot is asked again soon, a full one on the refresh.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use http::{Request, StatusCode, header};
use http_body_util::{BodyExt, Empty};
use serde::Deserialize;
use tokio::task::JoinHandle;

use crate::platform;
use crate::tls::CertificateSlot;

/// The platform's answer to an edge asking for the certificate it issued.
pub const CERTIFICATE_PATH: &str = "/api/ingress/certificate";

// A certificate lives ninety days and is renewed with thirty left, so an hour is always in time.
const REFRESH: Duration = Duration::from_secs(60 * 60);
const WHILE_EMPTY: Duration = Duration::from_secs(30);

// An answer larger than a chain and a key is not one the platform gives.
const MAX_ANSWER: usize = 256 * 1024;

pub enum Source {
    Files { chain: PathBuf, key: PathBuf },
    Platform { url: String, token: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Issued {
    certificate: String,
    private_key: String,
}

/// Loads now and then on the refresh, for the process's life.
pub fn keep(slot: Arc<CertificateSlot>, source: Source) -> JoinHandle<()> {
    tokio::spawn(async move {
        let client = platform::client();
        loop {
            match load(&source, &client).await {
                Ok(Some((chain, key))) => match slot.replace(&chain, &key) {
                    Ok(()) => tracing::debug!("the certificate is current"),
                    Err(error) => {
                        tracing::error!(
                            error = format!("{error:#}"),
                            "the certificate does not load; keeping the one held"
                        )
                    }
                },
                Ok(None) => tracing::warn!("no certificate has been issued for the edge yet"),
                Err(error) => {
                    tracing::warn!(
                        error = format!("{error:#}"),
                        "the certificate could not be read; keeping the one held"
                    )
                }
            }
            tokio::time::sleep(if slot.present() { REFRESH } else { WHILE_EMPTY }).await;
        }
    })
}

async fn load(
    source: &Source,
    client: &platform::PlatformClient,
) -> anyhow::Result<Option<(String, String)>> {
    match source {
        Source::Files { chain, key } => Ok(Some((
            tokio::fs::read_to_string(chain).await?,
            tokio::fs::read_to_string(key).await?,
        ))),
        Source::Platform { url, token } => {
            let request = Request::get(format!("{}{CERTIFICATE_PATH}", url.trim_end_matches('/')))
                .header(header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Empty::new())?;
            let answer =
                tokio::time::timeout(Duration::from_secs(20), client.request(request)).await??;
            if answer.status() == StatusCode::NOT_FOUND {
                return Ok(None);
            }
            if !answer.status().is_success() {
                anyhow::bail!("the platform answered {}", answer.status());
            }
            let body = http_body_util::Limited::new(answer.into_body(), MAX_ANSWER)
                .collect()
                .await
                .map_err(|error| anyhow::anyhow!("reading the certificate: {error}"))?
                .to_bytes();
            let issued: Issued = serde_json::from_slice(&body)?;
            Ok(Some((issued.certificate, issued.private_key)))
        }
    }
}
