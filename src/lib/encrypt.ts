/**
 * AES-256-GCM symmetric encryption for sensitive DB values (e.g. API keys).
 *
 * Key derivation (in priority order):
 *   1. DB_ENCRYPTION_KEY env var — 64-char hex string (32 bytes), for maximum separation
 *   2. NEXTAUTH_SECRET — already required by the app; SHA-256 hashed to 32 bytes
 *
 * No extra configuration needed: works out of the box as long as NEXTAUTH_SECRET is set.
 *
 * Ciphertext format (all hex, concatenated):
 *   IV (12 bytes / 24 hex) + Auth-Tag (16 bytes / 32 hex) + ciphertext
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

function getKey(): Buffer {
  // Prefer an explicit dedicated key
  const explicit = process.env.DB_ENCRYPTION_KEY;
  if (explicit) {
    const buf = Buffer.from(explicit, "hex");
    if (buf.length !== 32) {
      throw new Error("DB_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)");
    }
    return buf;
  }

  // Fall back to deriving a key from NEXTAUTH_SECRET (always present)
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error("Neither DB_ENCRYPTION_KEY nor NEXTAUTH_SECRET is set");
  }
  // SHA-256 produces a stable 32-byte key from any-length secret
  return createHash("sha256").update(secret).digest();
}

/**
 * Encrypt a plaintext string.
 * Returns a hex string: IV + GCM auth-tag + ciphertext.
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString("hex") + tag.toString("hex") + encrypted.toString("hex");
}

/**
 * Decrypt a ciphertext produced by encrypt().
 * Throws if the key is wrong or the ciphertext is tampered with.
 */
export function decrypt(ciphertext: string): string {
  const key = getKey();
  const ivHex = IV_BYTES * 2;
  const tagHex = TAG_BYTES * 2;
  const iv = Buffer.from(ciphertext.slice(0, ivHex), "hex");
  const tag = Buffer.from(ciphertext.slice(ivHex, ivHex + tagHex), "hex");
  const data = Buffer.from(ciphertext.slice(ivHex + tagHex), "hex");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(data).toString("utf8") + decipher.final("utf8");
}
