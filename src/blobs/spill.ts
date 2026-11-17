// Raw payloads too large for a queue message. This file owns the `spill/`
// key layout. A lifecycle rule removes anything left behind after 7 days.

function spillKey(projectId: number, eventId: string): string {
  return `spill/${projectId}/${eventId}.json`;
}

export class SpillStore {
  readonly #bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.#bucket = bucket;
  }

  /** Stores the payload and returns the key to put in the queue message. */
  async put(projectId: number, eventId: string, payload: string): Promise<string> {
    const key = spillKey(projectId, eventId);

    await this.#bucket.put(key, payload);

    return key;
  }

  async get(key: string): Promise<string | null> {
    const object = await this.#bucket.get(key);

    return object === null ? null : object.text();
  }

  async deleteAll(keys: string[]): Promise<void> {
    if (keys.length > 0) {
      await this.#bucket.delete(keys);
    }
  }
}
