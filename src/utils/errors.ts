/**
 * Extract a human-readable message from an unknown caught value.
 *
 * The SDK rejects with WasmSdkError, which is not an Error subclass, so
 * `String(error)` renders it as "[object Object]". Its kind (`name`) and
 * `code` (-1 when absent) are folded into the message so the UI shows what
 * Platform actually said. Plain objects without a message are serialized.
 */
export function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (error === null || typeof error !== 'object') return String(error);

  const { name, message, code } = error as { name?: unknown; message?: unknown; code?: unknown };

  if (message !== undefined && message !== null && String(message) !== '') {
    let text = String(message);
    if (typeof name === 'string' && name && name !== 'Error' && !text.startsWith(name)) {
      text = `${name}: ${text}`;
    }
    if ((typeof code === 'number' && code >= 0) || (typeof code === 'string' && code)) {
      text += ` (code ${code})`;
    }
    return text;
  }

  try {
    const json = JSON.stringify(error, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    );
    if (json && json !== '{}') return json;
  } catch {
    // Circular or otherwise unserializable.
  }
  return typeof name === 'string' && name ? name : 'Unknown error';
}
