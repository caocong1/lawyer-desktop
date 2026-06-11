use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rand::RngCore;
use std::path::Path;

const NONCE_LEN: usize = 12;
const KEY_FILE: &str = "encryption.key";

/// Manages AES-256-GCM encryption for sensitive values (e.g. API keys).
pub struct KeyStore {
    cipher: Aes256Gcm,
}

impl KeyStore {
    /// Load or create a 32-byte key in `data_dir`.
    pub fn load_or_create(data_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(data_dir).context("failed to create app data dir")?;
        let key_path = data_dir.join(KEY_FILE);

        let key_bytes = if key_path.exists() {
            let stored = std::fs::read(&key_path).context("failed to read encryption key")?;
            if stored.len() != 32 {
                anyhow::bail!("invalid encryption key length: {}", stored.len());
            }
            stored
        } else {
            let mut key = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut key);
            std::fs::write(&key_path, &key).context("failed to write encryption key")?;
            key.to_vec()
        };

        let cipher = Aes256Gcm::new_from_slice(&key_bytes).context("invalid AES key")?;
        Ok(Self { cipher })
    }

    pub fn encrypt(&self, plaintext: &str) -> Result<String> {
        let mut nonce_bytes = [0u8; NONCE_LEN];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);

        let ciphertext = self
            .cipher
            .encrypt(nonce, plaintext.as_bytes())
            .map_err(|e| anyhow::anyhow!("encryption failed: {}", e))?;

        let mut combined = nonce_bytes.to_vec();
        combined.extend(ciphertext);
        Ok(B64.encode(combined))
    }

    pub fn decrypt(&self, encoded: &str) -> Result<String> {
        let combined = B64
            .decode(encoded)
            .context("failed to decode encrypted value")?;

        if combined.len() <= NONCE_LEN {
            anyhow::bail!("encrypted payload too short");
        }

        let (nonce_bytes, ciphertext) = combined.split_at(NONCE_LEN);
        let nonce = Nonce::from_slice(nonce_bytes);

        let plaintext = self
            .cipher
            .decrypt(nonce, ciphertext)
            .map_err(|e| anyhow::anyhow!("decryption failed: {}", e))?;

        String::from_utf8(plaintext).context("decrypted value is not valid UTF-8")
    }

    /// Encrypt if non-empty; pass through `None` and empty strings.
    pub fn encrypt_optional(&self, value: Option<&str>) -> Result<Option<String>> {
        match value {
            Some(v) if !v.is_empty() => Ok(Some(self.encrypt(v)?)),
            _ => Ok(None),
        }
    }

    /// Decrypt if present; return `None` for missing values.
    pub fn decrypt_optional(&self, value: Option<&str>) -> Result<Option<String>> {
        match value {
            Some(v) if !v.is_empty() => Ok(Some(self.decrypt(v)?)),
            _ => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env::temp_dir;

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let dir = temp_dir().join(format!("lawyer-desktop-test-{}", uuid::Uuid::new_v4()));
        let store = KeyStore::load_or_create(&dir).unwrap();
        let encrypted = store.encrypt("sk-test-api-key-12345").unwrap();
        assert_ne!(encrypted, "sk-test-api-key-12345");
        let decrypted = store.decrypt(&encrypted).unwrap();
        assert_eq!(decrypted, "sk-test-api-key-12345");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn key_persists_across_instances() {
        let dir = temp_dir().join(format!("lawyer-desktop-test-{}", uuid::Uuid::new_v4()));
        let store1 = KeyStore::load_or_create(&dir).unwrap();
        let encrypted = store1.encrypt("persistent-secret").unwrap();
        let store2 = KeyStore::load_or_create(&dir).unwrap();
        assert_eq!(store2.decrypt(&encrypted).unwrap(), "persistent-secret");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn wrong_ciphertext_fails() {
        let dir = temp_dir().join(format!("lawyer-desktop-test-{}", uuid::Uuid::new_v4()));
        let store = KeyStore::load_or_create(&dir).unwrap();
        assert!(store.decrypt("not-valid-base64!!!").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
