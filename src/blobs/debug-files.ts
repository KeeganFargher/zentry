// Debug files in R2 (DESIGN.md §20.4). This file owns two key layouts:
//
// - `chunks/{organization_id}/{sha1}`: pieces of a sentry-cli upload, kept
//   until the file they make up is assembled. Per organization, as Sentry's
//   chunk store is: the CLI asks which chunks are missing across a whole
//   upload, before it says which project the files are for. A lifecycle rule
//   removes chunks an abandoned upload left behind after a day.
// - `source-bundles/{project_id}/{debug_id}`: an assembled source bundle, read
//   by the consumer for the source context of frames with that debug id. Kept
//   with no expiry: a build can run for months, and its events need its
//   bundle for as long as it does.

function chunkKey(organizationId: number, checksum: string): string {
  return `chunks/${organizationId}/${checksum}`;
}

function bundleKey(projectId: number, debugId: string): string {
  return `source-bundles/${projectId}/${debugId}`;
}

export class DebugFileBlobs {
  readonly #bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.#bucket = bucket;
  }

  async putChunk(organizationId: number, checksum: string, data: Uint8Array): Promise<void> {
    await this.#bucket.put(chunkKey(organizationId, checksum), data);
  }

  /** The checksums of these chunks that are not stored. */
  async missingChunks(organizationId: number, checksums: string[]): Promise<string[]> {
    const heads = await Promise.all(
      checksums.map((checksum) => this.#bucket.head(chunkKey(organizationId, checksum))),
    );

    return checksums.filter((_, index) => heads[index] === null);
  }

  /**
   * The chunks joined in order. Null when one has gone, which happens only
   * when an upload outlives the lifecycle rule or races a delete; the caller
   * then asks the CLI for the missing chunks again.
   */
  async joinChunks(organizationId: number, checksums: string[]): Promise<Uint8Array | null> {
    const objects = await Promise.all(
      checksums.map((checksum) => this.#bucket.get(chunkKey(organizationId, checksum))),
    );

    const present = objects.filter((object) => object !== null);

    if (present.length !== objects.length) {
      return null;
    }

    const parts = await Promise.all(present.map((object) => object.bytes()));
    const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;

    for (const part of parts) {
      joined.set(part, offset);
      offset += part.length;
    }

    return joined;
  }

  async deleteChunks(organizationId: number, checksums: string[]): Promise<void> {
    if (checksums.length > 0) {
      await this.#bucket.delete(checksums.map((checksum) => chunkKey(organizationId, checksum)));
    }
  }

  async putBundle(projectId: number, debugId: string, data: Uint8Array): Promise<void> {
    await this.#bucket.put(bundleKey(projectId, debugId), data);
  }

  async getBundle(projectId: number, debugId: string): Promise<Uint8Array | null> {
    const object = await this.#bucket.get(bundleKey(projectId, debugId));

    return object === null ? null : object.bytes();
  }
}
