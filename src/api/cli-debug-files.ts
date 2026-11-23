// `sentry-cli debug-files upload` (DESIGN.md §20.4): Sentry's chunked upload,
// for source bundles only. The CLI's flow, from src/utils/dif_upload and
// src/utils/chunks/upload.rs in sentry-cli:
//
// 1. `GET /organizations/{org}/chunk-upload/` for the server's limits. The
//    CLI cuts each file into `chunkSize` pieces and names every piece and
//    every file by its SHA-1.
// 2. `POST /projects/{org}/{project}/files/difs/assemble/` with each file's
//    checksum and chunk list. The answer says, per file, which chunks the
//    server lacks (`not_found`), or that it is done (`ok`) or failed (`error`).
// 3. `POST` the missing chunks to the chunk-upload URL, gzipped, as multipart
//    parts named `file_gzip` with the chunk's SHA-1 as the file name.
// 4. Assemble again, and poll until every file is `ok` or `error`.
//
// Assembling here is synchronous: a source bundle is a few megabytes, so
// joining and checking it fits in the request, and the second assemble call
// already answers `ok`. Sentry queues it and answers `created` meanwhile.
//
// Only source bundles are kept, the one kind of debug file Zentry uses (for
// source context, core/source-context.ts). Anything else assembles to
// `error`, so a misconfigured upload fails the build instead of storing files
// that do nothing.

import { z } from "zod";

import { InvalidSourceBundle, parseSourceBundle } from "@/core/source-bundle";
import type { SourceBundle } from "@/core/source-bundle";
import type { DebugFileRecord } from "@/db/debug-files";
import type { ProjectRecord } from "@/db/projects";
import { sha1Hex } from "@/shared/ids";

import type { CliContext, CliHandler } from "./context";
import { badRequest, InvalidRequest, notFound, readBody, readParams } from "./http";

const MIB = 1024 * 1024;

/**
 * The limits the CLI is given. A file is joined in memory to be checked, so
 * its cap stays well inside a Worker's 128 MB; a request stays inside the
 * 100 MB body limit.
 */
const LIMITS = {
  chunkSize: 8 * MIB,
  chunksPerRequest: 16,
  maxRequestSize: 32 * MIB,
  maxFileSize: 32 * MIB,
  concurrency: 4,
};

const MAX_FILES_PER_ASSEMBLE = 100;

/** What the CLI may upload. `debug_files` turns chunked upload on; `sources` allows bundles. */
const ACCEPT = ["debug_files", "sources"];

const Sha1 = z.string().regex(/^[0-9a-f]{40}$/, "must be a SHA-1 in lower-case hex");

const AssembleRequest = z
  .record(
    Sha1,
    z.object({
      name: z.string().min(1),
      chunks: z.array(Sha1).max(Math.ceil(LIMITS.maxFileSize / LIMITS.chunkSize)),
    }),
  )
  .refine((files) => Object.keys(files).length <= MAX_FILES_PER_ASSEMBLE, {
    message: `at most ${MAX_FILES_PER_ASSEMBLE} files per request`,
  });

type FileRequest = z.output<typeof AssembleRequest>[string];

type FileState = "ok" | "not_found" | "error";

/** sentry-cli's DebugInfoFile: what it prints for a finished file. */
type DebugInfoFile = {
  id: string;
  uuid: string;
  debugId: string;
  objectName: string;
  cpuName: string;
  sha1: string;
  size: number;
  dateCreated: string;
  data: { features: string[] };
};

type FileResponse = {
  state: FileState;
  missingChunks: string[];
  detail: string | null;
  dif: DebugInfoFile | null;
};

function chunkUploadUrl(context: CliContext): string {
  return `${context.url.origin}/api/0/organizations/${context.caller.organization.slug}/chunk-upload/`;
}

/** `GET /api/0/organizations/{org}/chunk-upload/`. */
export const chunkUploadOptions: CliHandler = async (context) =>
  Response.json({
    url: chunkUploadUrl(context),
    ...LIMITS,
    hashAlgorithm: "sha1",
    compression: ["gzip"],
    accept: ACCEPT,
  });

/** The part's bytes, gunzipped when it was sent as `file_gzip`; null past the chunk size. */
async function chunkBytes(field: string, part: File): Promise<Uint8Array | null> {
  const stream =
    field === "file_gzip"
      ? part.stream().pipeThrough(new DecompressionStream("gzip"))
      : part.stream();

  const pieces: Uint8Array[] = [];
  let size = 0;

  // Read as a stream so a part that inflates past the limit is refused
  // without first being inflated whole.
  for await (const piece of stream) {
    size += piece.length;

    if (size > LIMITS.chunkSize) {
      return null;
    }

    pieces.push(piece);
  }

  return new Uint8Array(await new Blob(pieces).arrayBuffer());
}

type Chunk = { checksum: string; data: Uint8Array };

async function readChunk(field: string, part: File | string): Promise<Chunk> {
  if ((field !== "file" && field !== "file_gzip") || !(part instanceof File)) {
    throw new InvalidRequest(
      `unexpected form field ${field}; chunks are sent as file or file_gzip`,
    );
  }

  const data = await chunkBytes(field, part);

  if (data === null) {
    throw new InvalidRequest(`chunk ${part.name} is larger than ${LIMITS.chunkSize} bytes`);
  }

  if ((await sha1Hex(data)) !== part.name) {
    throw new InvalidRequest(`chunk ${part.name} does not match its SHA-1`);
  }

  return { checksum: part.name, data };
}

/** `POST /api/0/organizations/{org}/chunk-upload/`: stores chunks after checking each one's SHA-1. */
export const uploadChunks: CliHandler = async (context) => {
  const form = await context.request.formData();
  const parts = [...form.entries()];

  if (parts.length > LIMITS.chunksPerRequest) {
    return badRequest(`at most ${LIMITS.chunksPerRequest} chunks per request`);
  }

  // Every chunk is checked before any is stored, so a bad request stores nothing.
  const chunks = await Promise.all(parts.map(([field, part]) => readChunk(field, part)));
  const organizationId = context.caller.organization.id;

  await Promise.all(
    chunks.map((chunk) =>
      context.deps.debugFiles.putChunk(organizationId, chunk.checksum, chunk.data),
    ),
  );

  return new Response(null, { status: 200 });
};

function difOf(file: DebugFileRecord): DebugInfoFile {
  return {
    id: String(file.id),
    uuid: file.debugId,
    debugId: file.debugId,
    objectName: file.objectName,
    cpuName: file.arch,
    sha1: file.checksum,
    size: file.size,
    dateCreated: new Date(file.createdAt).toISOString(),
    // No `type`: the CLI parses it as one of symbolic's object kinds, which
    // have no name for a source bundle. Its absence is what Sentry sends too.
    data: { features: ["sources"] },
  };
}

const done = (file: DebugFileRecord): FileResponse => ({
  state: "ok",
  missingChunks: [],
  detail: null,
  dif: difOf(file),
});

const failed = (detail: string): FileResponse => ({
  state: "error",
  missingChunks: [],
  detail,
  dif: null,
});

const missing = (chunks: string[]): FileResponse => ({
  state: "not_found",
  missingChunks: chunks,
  detail: null,
  dif: null,
});

type Assembly = { context: CliContext; project: ProjectRecord; checksum: string };

type Parsed = { ok: true; bundle: SourceBundle } | { ok: false; reason: string };

/** The parsed bundle, or why the file is not one. Any other failure is ours and throws. */
function bundleOf(data: Uint8Array): Parsed {
  try {
    return { ok: true, bundle: parseSourceBundle(data) };
  } catch (cause) {
    if (cause instanceof InvalidSourceBundle) {
      return { ok: false, reason: cause.message };
    }

    throw cause;
  }
}

/** Joins, checks and stores one file whose chunks are all uploaded. */
async function store(assembly: Assembly, data: Uint8Array): Promise<FileResponse> {
  const { context, project, checksum } = assembly;

  if ((await sha1Hex(data)) !== checksum) {
    return failed("the joined chunks do not match the file's SHA-1");
  }

  const parsed = bundleOf(data);

  if (!parsed.ok) {
    return failed(`Zentry did not store this file: ${parsed.reason}`);
  }

  const { bundle } = parsed;

  await context.deps.debugFiles.putBundle(project.id, bundle.debugId, data);

  return done(
    await context.deps.debugFileRecords.insert({
      projectId: project.id,
      checksum,
      debugId: bundle.debugId,
      objectName: bundle.objectName ?? "unknown",
      arch: bundle.arch ?? "any",
      size: data.length,
      createdAt: context.now,
    }),
  );
}

async function assembleFile(assembly: Assembly, file: FileRequest): Promise<FileResponse> {
  const { context, project, checksum } = assembly;
  const existing = await context.deps.debugFileRecords.find(project.id, checksum);

  if (existing !== null) {
    return done(existing);
  }

  if (file.chunks.length === 0) {
    return failed("the file is empty");
  }

  const organizationId = context.caller.organization.id;
  const absent = await context.deps.debugFiles.missingChunks(organizationId, file.chunks);

  if (absent.length > 0) {
    return missing(absent);
  }

  const data = await context.deps.debugFiles.joinChunks(organizationId, file.chunks);

  if (data === null) {
    return missing(await context.deps.debugFiles.missingChunks(organizationId, file.chunks));
  }

  if (data.length > LIMITS.maxFileSize) {
    return failed(`the file is larger than ${LIMITS.maxFileSize} bytes`);
  }

  const response = await store(assembly, data);

  // Kept after an error too: the CLI does not upload the same chunks again,
  // and the lifecycle rule removes them.
  if (response.state === "ok") {
    await context.deps.debugFiles.deleteChunks(organizationId, file.chunks);
  }

  return response;
}

/** `POST /api/0/projects/{org}/{project}/files/difs/assemble/`. */
export const assembleDifs: CliHandler = async (context, args) => {
  const [slug] = readParams(args, z.tuple([z.string()]));
  const project = await context.deps.projects.findBySlug(context.caller.organization.id, slug);

  if (project === null) {
    return notFound();
  }

  const files = await readBody(context.request, AssembleRequest);
  const responses: Record<string, FileResponse> = {};

  // One at a time: each file is held in memory while it is checked.
  for (const [checksum, file] of Object.entries(files)) {
    responses[checksum] = await assembleFile({ context, project, checksum }, file);
  }

  return Response.json(responses);
};
