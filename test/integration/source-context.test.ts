// Source context from uploaded source bundles (DESIGN.md §20.4): sentry-cli's
// chunked upload as the CLI drives it, and the consumer filling a .NET
// event's frames from the bundle. The event and bundle are real ones, made by
// the .NET SDK and sentry-cli (dotnet-fixture.ts).

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { handleApi, Sessions } from "@/api/router";
import { DebugFileBlobs } from "@/blobs/debug-files";
import { EventBlobs } from "@/blobs/events";
import { processMessages } from "@/consumer/handler";
import { parseSourceBundle, readSources } from "@/core/source-bundle";
import type { ApiCliTokenCreated, Json, StoredEvent, StoredFrame } from "@/shared/contract";
import { sha1Hex } from "@/shared/ids";

import { api, apiDeps } from "./api-helpers";
import { DEMO_DEBUG_ID, demoBundle, DOTNET_EVENT, FINGERPRINT_SOURCE } from "./dotnet-fixture";
import { consumerDeps, createProject, eventId, message } from "./helpers";

const INGEST = "https://ingest.zentry.test";
const FINGERPRINT = "/src/Demo/Scoring/Fingerprint.cs";

type Call = { method?: string; body?: BodyInit; token: string };

async function cli(path: string, call: Call): Promise<Response> {
  return handleApi(
    new Request(`${INGEST}/api/0${path}`, {
      method: call.method ?? "GET",
      headers: { authorization: `Bearer ${call.token}` },
      body: call.body ?? null,
    }),
    apiDeps(),
    new Sessions(),
  );
}

async function token(): Promise<string> {
  const response = await api("/organizations/default/cli-tokens/", {
    method: "POST",
    body: { name: "CI" },
  });

  return (await response.json<ApiCliTokenCreated>()).token;
}

async function gzip(data: Uint8Array): Promise<Blob> {
  return new Response(new Blob([data]).stream().pipeThrough(new CompressionStream("gzip"))).blob();
}

type Chunked = { checksum: string; chunks: { checksum: string; data: Uint8Array }[] };

/** The file cut into `size`-byte chunks, each named by its SHA-1, as the CLI does. */
async function chunked(data: Uint8Array, size: number): Promise<Chunked> {
  const pieces: Uint8Array[] = [];

  for (let offset = 0; offset < data.length; offset += size) {
    pieces.push(data.subarray(offset, offset + size));
  }

  const chunks = await Promise.all(
    pieces.map(async (piece) => ({ checksum: await sha1Hex(piece), data: piece })),
  );

  return { checksum: await sha1Hex(data), chunks };
}

type FileResponse = {
  state: string;
  missingChunks: string[];
  detail: string | null;
  dif: { debugId: string; objectName: string } | null;
};

async function assemble(slug: string, file: Chunked, auth: string): Promise<FileResponse> {
  const body: Json = {
    [file.checksum]: { name: "Demo.src.zip", chunks: file.chunks.map((chunk) => chunk.checksum) },
  };

  const response = await cli(`/projects/default/${slug}/files/difs/assemble/`, {
    method: "POST",
    body: JSON.stringify(body),
    token: auth,
  });

  expect(response.status).toBe(200);

  const answer = await response.json<Record<string, FileResponse>>();
  const result = answer[file.checksum];

  if (result === undefined) {
    throw new Error(`no answer for ${file.checksum}`);
  }

  return result;
}

async function uploadChunks(file: Chunked, auth: string): Promise<Response> {
  const form = new FormData();

  for (const chunk of file.chunks) {
    form.append("file_gzip", await gzip(chunk.data), chunk.checksum);
  }

  return cli("/organizations/default/chunk-upload/", { method: "POST", body: form, token: auth });
}

/** Uploads the file the way sentry-cli does: assemble, send what is missing, assemble again. */
async function upload(slug: string, data: Uint8Array, auth: string): Promise<FileResponse> {
  const file = await chunked(data, 1024);
  const first = await assemble(slug, file, auth);

  expect(first.state).toBe("not_found");
  expect(first.missingChunks).toEqual(file.chunks.map((chunk) => chunk.checksum));
  expect((await uploadChunks(file, auth)).status).toBe(200);

  return assemble(slug, file, auth);
}

async function storedEvent(projectId: number, index: number): Promise<StoredEvent> {
  const json = await new EventBlobs(env.BLOBS).getJson(projectId, eventId(index));

  if (json === null) {
    throw new Error("event was not stored");
  }

  return new Response(json).json<StoredEvent>();
}

function fingerprintFrames(event: StoredEvent): StoredFrame[] {
  return (event.exceptions.at(-1)?.frames ?? []).filter((frame) => frame.absPath === FINGERPRINT);
}

describe("source bundles", () => {
  it("reads a bundle sentry-cli made", () => {
    const bundle = parseSourceBundle(demoBundle());

    expect(bundle.debugId).toBe(DEMO_DEBUG_ID);
    expect(bundle.objectName).toBe("Demo.pdb");
    expect(readSources(bundle, [FINGERPRINT, "/src/Demo/Missing.cs"])).toEqual(
      new Map([[FINGERPRINT, FINGERPRINT_SOURCE]]),
    );
  });
});

describe("sentry-cli debug-files upload", () => {
  it("offers chunked upload of source bundles", async () => {
    const response = await cli("/organizations/default/chunk-upload/", { token: await token() });
    const options = await response.json<{ url: string; accept: string[]; compression: string[] }>();

    expect(options.url).toBe(`${INGEST}/api/0/organizations/default/chunk-upload/`);
    expect(options.accept).toEqual(["debug_files", "sources"]);
    expect(options.compression).toEqual(["gzip"]);
  });

  it("assembles a source bundle from its chunks, then answers ok again without them", async () => {
    const project = await createProject();
    const auth = await token();
    const done = await upload(project.slug, demoBundle(), auth);

    expect(done.state).toBe("ok");
    expect(done.dif?.debugId).toBe(DEMO_DEBUG_ID);
    expect(done.dif?.objectName).toBe("Demo.pdb");

    // The chunks are gone once assembled; the row answers the CLI's repeat.
    const file = await chunked(demoBundle(), 1024);
    const checksums = file.chunks.map((chunk) => chunk.checksum);

    expect(await new DebugFileBlobs(env.BLOBS).missingChunks(1, checksums)).toEqual(checksums);
    expect((await assemble(project.slug, file, auth)).state).toBe("ok");
  });

  it("refuses a file that is not a source bundle", async () => {
    const project = await createProject();
    const notBundle = new TextEncoder().encode("MZ not a bundle");
    const done = await upload(project.slug, notBundle, await token());

    expect(done.state).toBe("error");
    expect(done.detail).toContain("Zentry stores source bundles only");
  });

  it("refuses a chunk whose content does not match its name", async () => {
    const form = new FormData();

    form.append("file_gzip", await gzip(new Uint8Array([1, 2, 3])), "0".repeat(40));

    const response = await cli("/organizations/default/chunk-upload/", {
      method: "POST",
      body: form,
      token: await token(),
    });

    expect(response.status).toBe(400);
  });

  it("answers 404 for a project the organization does not have", async () => {
    const file = await chunked(demoBundle(), 1024);

    const response = await cli("/projects/default/no-such-project/files/difs/assemble/", {
      method: "POST",
      body: JSON.stringify({ [file.checksum]: { name: "x", chunks: [] } }),
      token: await token(),
    });

    expect(response.status).toBe(404);
  });
});

describe("source context in the consumer", () => {
  it("fills a .NET event's in-app frames from the project's bundle", async () => {
    const project = await createProject();

    await upload(project.slug, demoBundle(), await token());
    await processMessages(
      [message({ projectId: project.id, index: 1, event: DOTNET_EVENT })],
      consumerDeps(),
    );

    const [build, lambda] = fingerprintFrames(await storedEvent(project.id, 1));

    expect(build?.debugId).toBe(DEMO_DEBUG_ID);
    expect(build?.contextLine).toBe("        return CountRegex.Replace(title, match =>");
    expect(lambda?.contextLine).toBe(
      "            var count = int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture);",
    );
    expect(lambda?.preContext).toEqual(FINGERPRINT_SOURCE.split("\n").slice(8, 13));
    expect(lambda?.postContext).toEqual(FINGERPRINT_SOURCE.split("\n").slice(14, 19));
  });

  it("leaves frames without source when no bundle was uploaded for their build", async () => {
    const project = await createProject();
    const other = await createProject();

    // Another project's bundle does not apply: debug ids are looked up per project.
    await upload(other.slug, demoBundle(), await token());
    await processMessages(
      [message({ projectId: project.id, index: 2, event: DOTNET_EVENT })],
      consumerDeps(),
    );

    const frames = fingerprintFrames(await storedEvent(project.id, 2));

    expect(frames).toHaveLength(2);
    expect(frames.map((frame) => frame.contextLine)).toEqual([null, null]);
  });
});
