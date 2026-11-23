// Source bundles: the archive `sentry-cli debug-files bundle-sources` builds
// from a debug file (a .NET portable PDB, an ELF, a dSYM), holding the source
// files that debug file points at. Zentry reads them the way Sentry's
// symbolic crate does (symbolic-debuginfo/src/sourcebundle):
//
// - an 8-byte header, the magic "SYSB" and a little-endian u32 version (2);
// - then a ZIP whose `manifest.json` maps each entry to the build path it was
//   read from: `{"files": {"files/repo/Core/Foo.cs": {"type": "source",
//   "path": "/repo/Core/Foo.cs"}}, "debug_id": "…", "object_name": "Core.pdb",
//   "arch": "unknown"}`.
//
// The ZIP's offsets count from the start of the file, header included, so the
// whole buffer goes to the unzipper, not the part after the header.

import { unzipSync } from "fflate";
import { z } from "zod";

import { jsonText } from "@/shared/json";

const MAGIC = "SYSB";
const VERSION = 2;
const HEADER_BYTES = 8;
const MANIFEST = "manifest.json";

/**
 * Bigger source files are skipped. Generated code can be megabytes, and the
 * consumer inflates every file a batch needs into memory at once.
 */
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

export class InvalidSourceBundle extends Error {}

const Manifest = jsonText(
  z.object({
    files: z.record(z.string(), z.object({ type: z.string(), path: z.string().optional() })),
    debug_id: z.string().min(1),
    object_name: z.string().optional(),
    arch: z.string().optional(),
  }),
);

export type SourceBundle = {
  /** Lower-cased, the form debug ids are compared in. */
  debugId: string;
  objectName: string | null;
  arch: string | null;
  /** Build path of each source file, mapped to its ZIP entry. */
  entries: Map<string, string>;
  bytes: Uint8Array;
};

function hasHeader(bytes: Uint8Array): boolean {
  if (bytes.length < HEADER_BYTES) {
    return false;
  }

  const magic = new TextDecoder().decode(bytes.subarray(0, MAGIC.length));
  const version = new DataView(bytes.buffer, bytes.byteOffset + MAGIC.length, 4).getUint32(0, true);

  return magic === MAGIC && version === VERSION;
}

function unzip(bytes: Uint8Array, wanted: (name: string, size: number) => boolean) {
  try {
    return unzipSync(bytes, { filter: (file) => wanted(file.name, file.originalSize) });
  } catch (cause) {
    throw new InvalidSourceBundle(`the archive could not be read: ${String(cause)}`);
  }
}

function readManifest(bytes: Uint8Array): z.output<typeof Manifest> {
  const text = unzip(bytes, (name) => name === MANIFEST)[MANIFEST];

  if (text === undefined) {
    throw new InvalidSourceBundle("it has no manifest.json");
  }

  const manifest = Manifest.safeParse(new TextDecoder().decode(text));

  if (!manifest.success) {
    throw new InvalidSourceBundle(
      `its manifest.json is not valid: ${z.prettifyError(manifest.error)}`,
    );
  }

  return manifest.data;
}

/**
 * Reads a bundle's manifest. Throws `InvalidSourceBundle` for anything that is
 * not a version 2 source bundle with a debug id: that is the only kind of
 * debug file Zentry keeps, and an upload of anything else is refused rather
 * than stored where it would never be used.
 */
export function parseSourceBundle(bytes: Uint8Array): SourceBundle {
  if (!hasHeader(bytes)) {
    throw new InvalidSourceBundle(
      "it is not a source bundle. Zentry stores source bundles only: upload them with " +
        "`sentry-cli debug-files bundle-sources` and `sentry-cli debug-files upload -t sourcebundle`",
    );
  }

  const manifest = readManifest(bytes);
  const entries = new Map<string, string>();

  for (const [name, info] of Object.entries(manifest.files)) {
    if (info.type === "source" && info.path !== undefined) {
      entries.set(info.path, name);
    }
  }

  return {
    debugId: manifest.debug_id.toLowerCase(),
    objectName: manifest.object_name ?? null,
    arch: manifest.arch ?? null,
    entries,
    bytes,
  };
}

/**
 * The text of the source files at these build paths. A path the bundle does
 * not hold, or a file over the size limit, is absent from the result.
 */
export function readSources(bundle: SourceBundle, paths: Iterable<string>): Map<string, string> {
  const names = new Map<string, string>();

  for (const path of paths) {
    const name = bundle.entries.get(path);

    if (name !== undefined) {
      names.set(name, path);
    }
  }

  if (names.size === 0) {
    return new Map();
  }

  const files = unzip(bundle.bytes, (name, size) => names.has(name) && size <= MAX_SOURCE_BYTES);
  const decoder = new TextDecoder();

  return new Map(
    Object.entries(files).map(([name, data]) => [names.get(name) ?? name, decoder.decode(data)]),
  );
}
