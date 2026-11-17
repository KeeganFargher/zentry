// Reads a request body with optional decompression and a hard size cap that
// is enforced while streaming, so a compressed bomb is cut off early.

export type BodyResult = { bytes: Uint8Array } | { status: number; detail: string };

type Encoding = "gzip" | "deflate";

// Brotli is not offered: the Workers runtime's DecompressionStream has no "br".
function supportedEncoding(encoding: string): Encoding | null {
  if (encoding === "gzip" || encoding === "deflate") {
    return encoding;
  }

  return null;
}

function decoded(request: Request): ReadableStream<Uint8Array> | null {
  const encoding = (request.headers.get("content-encoding") ?? "identity").trim().toLowerCase();
  const body = request.body ?? new Blob([]).stream();
  const supported = supportedEncoding(encoding);

  if (encoding === "identity" || encoding === "") {
    return body;
  }

  return supported === null ? null : body.pipeThrough(new DecompressionStream(supported));
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  return bytes;
}

async function readCapped(stream: ReadableStream<Uint8Array>, limit: number): Promise<BodyResult> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      return { bytes: concat(chunks, total) };
    }

    total += value.length;
    chunks.push(value);

    if (total > limit) {
      await reader.cancel();

      return { status: 413, detail: "payload too large" };
    }
  }
}

export async function readBody(request: Request, limit: number): Promise<BodyResult> {
  const stream = decoded(request);

  if (stream === null) {
    return { status: 415, detail: "unsupported content encoding" };
  }

  try {
    return await readCapped(stream, limit);
  } catch {
    return { status: 400, detail: "could not decode request body" };
  }
}
