/** Content hashing for the staged-save guard and draft check-in
 *  (docs/atomic-save.md decisions 11–12). SHA-256 to match the server side's
 *  `sha256sum`; WebCrypto is hardware-fast and off the main thread. */

const encoder = new TextEncoder();

/** Lowercase hex SHA-256 of a text buffer — comparable to `sha256sum`. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
