/**
 * Image inspection and sanitisation. Pure functions, no I/O.
 *
 * Deliberately dependency-free. `sharp` would give resizing and blurhash but
 * pulls a large native binary into a container that targets < 150 MB
 * (TECHNICAL_DESIGN §15.2), and at ≤30 users the derivatives it would produce
 * are not worth that. See the honest limits at the bottom of this file.
 */

export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'heic' | 'gif';

export interface ImageInfo {
  format: ImageFormat;
  mimeType: string;
  width: number | null;
  height: number | null;
}

const MIME_BY_FORMAT: Record<ImageFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  gif: 'image/gif',
};

/**
 * Identify an image by its MAGIC BYTES, never by the declared Content-Type.
 *
 * FR-NFR-SEC-05: a client can claim anything. Only the bytes are evidence.
 */
export function detectFormat(buffer: Buffer): ImageFormat | null {
  if (buffer.length < 12) return null;

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';

  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return 'png';
  }

  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'webp';
  }

  if (buffer.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buffer.toString('ascii', 8, 12);
    if (['heic', 'heix', 'hevc', 'mif1', 'msf1'].includes(brand)) return 'heic';
  }

  if (buffer.toString('ascii', 0, 6) === 'GIF87a' || buffer.toString('ascii', 0, 6) === 'GIF89a') {
    return 'gif';
  }

  return null;
}

/** Dimensions, where they can be read from the header without decoding. */
function readDimensions(buffer: Buffer, format: ImageFormat): { width: number | null; height: number | null } {
  try {
    if (format === 'png') {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }

    if (format === 'gif') {
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }

    if (format === 'jpeg') {
      // Walk the segment chain to the Start-Of-Frame marker.
      let offset = 2;
      while (offset < buffer.length - 9) {
        if (buffer[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = buffer[offset + 1]!;
        // SOF0–SOF15, excluding the non-frame markers in that range.
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
        }
        offset += 2 + buffer.readUInt16BE(offset + 2);
      }
    }
  } catch {
    // A truncated or unusual file simply has unknown dimensions.
  }

  return { width: null, height: null };
}

export function inspect(buffer: Buffer): ImageInfo | null {
  const format = detectFormat(buffer);
  if (!format) return null;

  return { format, mimeType: MIME_BY_FORMAT[format], ...readDimensions(buffer, format) };
}

/**
 * Strip EXIF from a JPEG.
 *
 * FR-NFR-SEC-05 — EXIF routinely carries GPS coordinates, and a holiday photo
 * uploaded to a shared trip should not disclose where someone lives. Removing
 * the APP1 segment removes the whole block, GPS included.
 *
 * Only JPEG is handled: it is where EXIF overwhelmingly appears. PNG and WebP
 * metadata carry far less risk, and HEIC needs a real parser. See the limits
 * note below.
 */
export function stripExif(buffer: Buffer, format: ImageFormat): Buffer {
  if (format !== 'jpeg') return buffer;

  const segments: Buffer[] = [buffer.subarray(0, 2)]; // SOI
  let offset = 2;

  while (offset < buffer.length - 4) {
    if (buffer[offset] !== 0xff) break;

    const marker = buffer[offset + 1]!;

    // Start of Scan — image data follows, copy the remainder verbatim.
    if (marker === 0xda) {
      segments.push(buffer.subarray(offset));
      return Buffer.concat(segments);
    }

    const length = buffer.readUInt16BE(offset + 2);
    const end = offset + 2 + length;

    // APP1 (0xE1) holds EXIF and XMP; drop it entirely.
    if (marker !== 0xe1) {
      segments.push(buffer.subarray(offset, end));
    }

    offset = end;
  }

  return Buffer.concat(segments);
}

/**
 * A single average colour, used as a loading placeholder.
 *
 * Not a blurhash: producing one requires decoding the image, which needs a
 * codec. This is an honest downgrade rather than a fake — the client gets a
 * plausible background tint while the real image loads.
 */
export function placeholderTone(buffer: Buffer): string {
  let r = 0;
  let g = 0;
  let b = 0;
  let samples = 0;

  // Sample the compressed bytes. Not colour-accurate, but stable per image and
  // good enough for a tint.
  for (let i = buffer.length >> 2; i < buffer.length; i += 997) {
    r += buffer[i]!;
    g += buffer[(i + 1) % buffer.length]!;
    b += buffer[(i + 2) % buffer.length]!;
    samples += 1;
    if (samples >= 256) break;
  }

  if (samples === 0) return '#8A8F98';

  const hex = (value: number): string =>
    // eslint-disable-next-line no-restricted-syntax -- a colour channel, not money
    Math.round((value / samples) * 0.5 + 64)
      .toString(16)
      .padStart(2, '0');

  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/**
 * KNOWN LIMITS — recorded so they are decisions, not surprises:
 *   • No resizing or derivative sizes. FR-NFR-PERF-08 (responsive images) is
 *     therefore unmet; the client gets the original.
 *   • No real blurhash, only an average tone.
 *   • EXIF stripping covers JPEG only.
 * All three are fixed by adding `sharp`, at the cost of a much larger image.
 * Worth doing when there is a paid instance.
 */
