/**
 * AES-GCM encryption for the SmartBill token at rest.
 *
 * IMPORTANT: Only the CURRENT ENCRYPTION_KEY is valid. NEVER regenerate
 * ENCRYPTION_KEY after data exists — every row silently fails to decrypt.
 * Rotation re-encrypts rows with the SAME key; it never re-keys.
 *
 * ENCRYPTION_KEY is a 64-char hex string (openssl rand -hex 32 => 256-bit key).
 */

const KEY_HEX_RE = /^[0-9a-fA-F]{64}$/;

function assertKeyHex(key: string): void {
	if (!KEY_HEX_RE.test(key)) {
		throw new Error("ENCRYPTION_KEY must be a 64-char hex string (256-bit key) — never regenerate after data exists");
	}
}

function hexToBytes(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

async function getCryptoKey(encryptionKey: string): Promise<CryptoKey> {
	assertKeyHex(encryptionKey);
	return crypto.subtle.importKey(
		"raw",
		hexToBytes(encryptionKey).buffer as ArrayBuffer,
		{ name: "AES-GCM" },
		false,
		["encrypt", "decrypt"],
	);
}

export interface EncryptedValue {
	/** base64 ciphertext */
	enc: string;
	/** base64 12-byte IV */
	iv: string;
}

/** Encrypt a plaintext string to a base64 ciphertext + IV. */
export async function encryptToken(token: string, encryptionKey: string): Promise<EncryptedValue> {
	const key = await getCryptoKey(encryptionKey);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const encBuf = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv: iv.buffer as ArrayBuffer },
		key,
		new TextEncoder().encode(token),
	);
	return { enc: bytesToBase64(new Uint8Array(encBuf)), iv: bytesToBase64(iv) };
}

/** Decrypt a base64 ciphertext + IV back to the plaintext token. */
export async function decryptToken(value: EncryptedValue, encryptionKey: string): Promise<string> {
	const key = await getCryptoKey(encryptionKey);
	const decBuf = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: base64ToBytes(value.iv).buffer as ArrayBuffer },
		key,
		base64ToBytes(value.enc).buffer as ArrayBuffer,
	);
	return new TextDecoder().decode(decBuf);
}
