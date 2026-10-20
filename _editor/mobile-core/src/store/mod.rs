//! The local store: SQLite in the app's own data directory, so a cold start draws what it last saw before the network
//! answers. `MIGRATIONS` runs once each, in order, tracked by SQLite's `user_version`; a migration is never edited
//! after it ships, only followed by another.

mod sealed;

use rusqlite::Connection;
pub use sealed::{SealError, Sealer};
use std::path::Path;

const MIGRATIONS: &[&str] = &[
    // 1: a key-value table for what has no table of its own yet, and the sealed secrets (sessions).
    "CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
     CREATE TABLE secrets (name TEXT PRIMARY KEY, sealed BLOB NOT NULL) STRICT;",
];

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error(transparent)]
    Seal(#[from] SealError),
}

pub struct Store {
    connection: Connection,
    sealer: Sealer,
}

impl Store {
    pub fn open(path: &Path, sealer: Sealer) -> Result<Store, StoreError> {
        let mut connection = Connection::open(path)?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "NORMAL")?;
        migrate(&mut connection)?;
        Ok(Store { connection, sealer })
    }

    /// A secret kept sealed; `None` when absent, or sealed by a key this start does not hold (the app's data was
    /// restored onto another device), which reads as signed out.
    pub fn secret(&self, name: &str) -> Result<Option<String>, StoreError> {
        let mut statement = self
            .connection
            .prepare_cached("SELECT sealed FROM secrets WHERE name = ?1")?;
        let mut rows = statement.query([name])?;
        let Some(row) = rows.next()? else {
            return Ok(None);
        };
        let sealed: Vec<u8> = row.get(0)?;
        Ok(self
            .sealer
            .open(name, &sealed)
            .ok()
            .and_then(|plain| String::from_utf8(plain).ok()))
    }

    pub fn put_secret(&self, name: &str, value: &str) -> Result<(), StoreError> {
        let sealed = self.sealer.seal(name, value.as_bytes())?;
        self.connection.execute(
            "INSERT INTO secrets (name, sealed) VALUES (?1, ?2) ON CONFLICT (name) DO UPDATE SET sealed = excluded.sealed",
            rusqlite::params![name, sealed],
        )?;
        Ok(())
    }

    pub fn forget_secret(&self, name: &str) -> Result<(), StoreError> {
        self.connection
            .execute("DELETE FROM secrets WHERE name = ?1", [name])?;
        Ok(())
    }

    /// Forgets every secret and every value: what signing out leaves behind is nothing.
    pub fn forget_all(&self) -> Result<(), StoreError> {
        self.connection
            .execute_batch("DELETE FROM secrets; DELETE FROM kv;")?;
        Ok(())
    }

    /// A value kept as JSON; `None` when absent or when it no longer reads as `T` (a shape an older build wrote).
    pub fn get_json<T: serde::de::DeserializeOwned>(
        &self,
        key: &str,
    ) -> Result<Option<T>, StoreError> {
        Ok(self
            .get(key)?
            .and_then(|json| serde_json::from_str(&json).ok()))
    }

    pub fn put_json(&self, key: &str, value: &impl serde::Serialize) -> Result<(), StoreError> {
        let json = serde_json::to_string(value).unwrap_or_else(|_| "null".into());
        self.put(key, &json)
    }

    pub fn get(&self, key: &str) -> Result<Option<String>, StoreError> {
        let mut statement = self
            .connection
            .prepare_cached("SELECT value FROM kv WHERE key = ?1")?;
        let mut rows = statement.query([key])?;
        Ok(match rows.next()? {
            Some(row) => Some(row.get(0)?),
            None => None,
        })
    }

    pub fn put(&self, key: &str, value: &str) -> Result<(), StoreError> {
        self.connection.execute(
            "INSERT INTO kv (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            [key, value],
        )?;
        Ok(())
    }
}

fn migrate(connection: &mut Connection) -> Result<(), StoreError> {
    let applied: usize = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    for (index, migration) in MIGRATIONS.iter().enumerate().skip(applied) {
        let transaction = connection.transaction()?;
        transaction.execute_batch(migration)?;
        transaction.pragma_update(None, "user_version", index + 1)?;
        transaction.commit()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

    fn open(path: &Path) -> Store {
        Store::open(path, Sealer::new(KEY).unwrap()).unwrap()
    }

    #[test]
    fn keeps_values_and_secrets_across_opens_and_migrates_once() {
        let path = std::env::temp_dir().join(format!(
            "intentic-mobile-store-{}.sqlite3",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let store = open(&path);
        store.put("board", "[]").unwrap();
        store.put_secret("platform", "session=abc").unwrap();
        drop(store);
        let store = open(&path);
        assert_eq!(store.get("board").unwrap().as_deref(), Some("[]"));
        assert_eq!(store.get("absent").unwrap(), None);
        assert_eq!(
            store.secret("platform").unwrap().as_deref(),
            Some("session=abc")
        );
        store.forget_secret("platform").unwrap();
        assert_eq!(store.secret("platform").unwrap(), None);
    }
}
