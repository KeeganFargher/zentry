// Full event JSON in R2. This file owns the `events/` key layout.

export type EventBlob = { projectId: number; eventId: string; json: string };

const PUT_CONCURRENCY = 10;
const DELETE_CHUNK = 1000;

function eventKey(projectId: number, eventId: string): string {
  return `events/${projectId}/${eventId}.json.gz`;
}

async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));

  return new Response(stream).arrayBuffer();
}

async function gunzip(body: ReadableStream): Promise<string> {
  return new Response(body.pipeThrough(new DecompressionStream("gzip"))).text();
}

export class EventBlobs {
  readonly #bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.#bucket = bucket;
  }

  async #put(blob: EventBlob): Promise<void> {
    await this.#bucket.put(eventKey(blob.projectId, blob.eventId), await gzip(blob.json), {
      httpMetadata: { contentType: "application/json", contentEncoding: "gzip" },
    });
  }

  /** Writes every blob, a few at a time. Rejects if any write fails. */
  async putAll(blobs: EventBlob[]): Promise<void> {
    for (let start = 0; start < blobs.length; start += PUT_CONCURRENCY) {
      const chunk = blobs.slice(start, start + PUT_CONCURRENCY);

      await Promise.all(chunk.map((blob) => this.#put(blob)));
    }
  }

  /** The stored event as JSON text, or null when it is gone. */
  async getJson(projectId: number, eventId: string): Promise<string | null> {
    const object = await this.#bucket.get(eventKey(projectId, eventId));

    return object === null ? null : gunzip(object.body);
  }

  async deleteAll(projectId: number, eventIds: string[]): Promise<void> {
    for (let start = 0; start < eventIds.length; start += DELETE_CHUNK) {
      const keys = eventIds.slice(start, start + DELETE_CHUNK).map((id) => eventKey(projectId, id));

      await this.#bucket.delete(keys);
    }
  }
}
