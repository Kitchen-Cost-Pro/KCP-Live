export function emailAttachmentBytes(value) {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('Email attachment content must be text, an ArrayBuffer, or a typed byte array.');
}

export function encodeEmailAttachmentBase64(value) {
  const bytes = emailAttachmentBytes(value);
  let encoded = '';
  // Chunks are divisible by three so independently encoded blocks concatenate safely.
  const chunkSize = 0x6000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    let binary = '';
    for (let index = 0; index < chunk.length; index += 1) binary += String.fromCharCode(chunk[index]);
    encoded += btoa(binary);
  }
  return encoded;
}
