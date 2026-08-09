/**
 * uvd-x402-sdk - UTF-8 safe base64
 *
 * `btoa()` only accepts code points 0-255. Any character above that throws
 * `InvalidCharacterError`, and the X-PAYMENT payload is not guaranteed to be
 * ASCII: the EIP-712 domain name of USDT on Optimism and Arbitrum is literally
 * `USD₮0` (U+20AE). A header carrying that name crashes a plain `btoa()`.
 *
 * So the JSON is UTF-8 encoded to bytes first, and only then base64'd. Decoding
 * reverses it. For ASCII-only input the output is byte-identical to
 * `btoa(json)`, which is why swapping this in cannot change any existing header.
 *
 * `TextEncoder`/`TextDecoder` are available in every browser the SDK targets and
 * in Node 11+; `btoa`/`atob` are used for the byte<->base64 step because they
 * exist in both environments without pulling in `Buffer`.
 */

/**
 * Encode a string as base64, handling non-ASCII characters correctly.
 *
 * @param value - Any UTF-8 string
 * @returns Base64-encoded value
 */
export function encodeBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Decode a base64 string produced by {@link encodeBase64Utf8}.
 *
 * @param encoded - Base64-encoded value
 * @returns The original UTF-8 string
 */
export function decodeBase64Utf8(encoded: string): string {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * JSON-serialize a value and encode it as UTF-8 safe base64.
 *
 * This is the encoder for every X-PAYMENT header the SDK emits.
 *
 * @param value - Value to serialize
 * @returns Base64-encoded JSON
 */
export function encodeBase64Json(value: unknown): string {
  return encodeBase64Utf8(JSON.stringify(value));
}
