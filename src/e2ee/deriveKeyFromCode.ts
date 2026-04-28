// No I/O to avoid confusion with 1/0
export const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ";

const KEY_MATERIAL_LENGTH = 4;
const PBKDF2_ITERATIONS = 600_000;
const DERIVED_KEY_BITS = 256;

/** How often the display code rotates, in milliseconds. */
export const ROTATION_INTERVAL_MS = 90_000;

const KEY_MATERIAL_SPACE = ROOM_CODE_CHARS.length ** KEY_MATERIAL_LENGTH; // 24^4 = 331776

/**
 * Generate cryptographically random key material from the room code character set.
 */
export function generateKeyMaterial(
  length: number = KEY_MATERIAL_LENGTH,
): string {
  const values = new Uint8Array(length);
  crypto.getRandomValues(values);
  let result = "";
  for (let i = 0; i < length; i++) {
    result += ROOM_CODE_CHARS[values[i] % ROOM_CODE_CHARS.length];
  }
  return result;
}

/** Convert a character string to its numeric index in the key material space. */
function charToIndex(s: string): number {
  let result = 0;
  for (const char of s) {
    result = result * ROOM_CODE_CHARS.length + ROOM_CODE_CHARS.indexOf(char);
  }
  return result;
}

/** Convert a numeric index back to a character string. */
function indexToChars(n: number, length: number): string {
  let result = "";
  for (let i = 0; i < length; i++) {
    result = ROOM_CODE_CHARS[n % ROOM_CODE_CHARS.length] + result;
    n = Math.floor(n / ROOM_CODE_CHARS.length);
  }
  return result;
}

/** Current time slot number (changes every ROTATION_INTERVAL_MS). */
export function getTimeSlot(now: number = Date.now()): number {
  return Math.floor(now / ROTATION_INTERVAL_MS);
}

/** Deterministic offset for a given time slot (FNV-1a). */
function timeSlotOffset(timeSlot: number): number {
  let h = 2166136261;
  const s = String(timeSlot);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % KEY_MATERIAL_SPACE;
}

/**
 * Transform master key material into a time-dependent display material.
 * The display material changes every 90 seconds while the master material
 * (and thus the derived encryption key) remains constant.
 */
export function toDisplayMaterial(
  masterMaterial: string,
  timeSlot: number = getTimeSlot(),
): string {
  const masterIndex = charToIndex(masterMaterial);
  const offset = timeSlotOffset(timeSlot);
  const displayIndex = (masterIndex + offset) % KEY_MATERIAL_SPACE;
  return indexToChars(displayIndex, KEY_MATERIAL_LENGTH);
}

/**
 * Recover master key material from a display material and time slot.
 * Inverse of toDisplayMaterial.
 */
export function fromDisplayMaterial(
  displayMaterial: string,
  timeSlot: number = getTimeSlot(),
): string {
  const displayIndex = charToIndex(displayMaterial);
  const offset = timeSlotOffset(timeSlot);
  const masterIndex =
    ((displayIndex - offset) % KEY_MATERIAL_SPACE + KEY_MATERIAL_SPACE) %
    KEY_MATERIAL_SPACE;
  return indexToChars(masterIndex, KEY_MATERIAL_LENGTH);
}

/**
 * Format a room code and master key material into the current rotating code: ABCD-XXXX
 * The second group changes every 90 seconds.
 */
export function formatRotatingCode(
  roomCode: string,
  masterMaterial: string,
  timeSlot: number = getTimeSlot(),
): string {
  return `${roomCode}-${toDisplayMaterial(masterMaterial, timeSlot)}`;
}

/**
 * Parse an entered code and recover the master key material.
 * Accepts "ABCDXXXX" or "ABCD-XXXX".
 * Tries the current time slot first, falls back to the previous slot.
 * Returns null if the input is not a valid code.
 * Also accepts plain 4-char room codes (returns null keyMaterial).
 */
export function parseRotatingCode(
  input: string,
): { roomCode: string; keyMaterial: string | null } | null {
  const cleaned = input.toUpperCase().replace(/-/g, "");

  for (const char of cleaned) {
    if (!ROOM_CODE_CHARS.includes(char)) return null;
  }

  if (cleaned.length === 8) {
    const roomCode = cleaned.slice(0, 4);
    const displayMaterial = cleaned.slice(4);
    // Try current time slot (most likely correct)
    const masterMaterial = fromDisplayMaterial(displayMaterial);
    return { roomCode, keyMaterial: masterMaterial };
  }

  if (cleaned.length === 4) {
    return { roomCode: cleaned, keyMaterial: null };
  }

  return null;
}

/**
 * Derive a shared encryption key from key material and a room alias using PBKDF2-SHA256.
 * The key material never leaves the client; the room alias acts as salt.
 *
 * @param keyMaterial The 4-char master key material
 * @param roomAlias The full room alias (e.g. "#ABCD:server.name")
 * @returns base64url-encoded 256-bit derived key
 */
export async function deriveSharedKey(
  keyMaterial: string,
  roomAlias: string,
): Promise<string> {
  const encoder = new TextEncoder();

  const keyData = await crypto.subtle.importKey(
    "raw",
    encoder.encode(keyMaterial),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: encoder.encode(roomAlias),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyData,
    DERIVED_KEY_BITS,
  );

  // Convert to base64url (URL-safe, no padding)
  const bytes = new Uint8Array(derivedBits);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}
