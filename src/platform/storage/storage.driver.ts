/**
 * Object storage.
 *
 * An interface with swappable drivers, so local development and CI need no
 * cloud account — the same reasoning as the email service. The Supabase driver
 * is used in production; the disk driver everywhere else.
 */

export interface StoredObject {
  readonly key: string;
  readonly size: number;
  readonly contentType: string;
}

export interface StorageDriver {
  readonly name: string;
  put(key: string, body: Buffer, contentType: string): Promise<StoredObject>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  /**
   * A URL the client can fetch the object from.
   *
   * Private assets get a short-lived signed URL where the driver supports it;
   * otherwise the API serves the bytes itself.
   */
  urlFor(key: string, expiresInSeconds: number): Promise<string>;
}
