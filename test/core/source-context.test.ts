import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { InvalidSourceBundle, parseSourceBundle } from "@/core/source-bundle";
import { sourceRequest, withSourceContext } from "@/core/source-context";
import type { StoredEvent, StoredFrame } from "@/shared/contract";

import { normalize } from "./helpers";

const DEBUG_ID = "f8f62cc3-cb15-42c7-bc14-5ef93b12ff18-e40df841";
const PATH = "/src/App/Checkout.cs";
const SOURCE = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\r\n");

/** A .NET-shaped event: frames relative to an image in debug_meta, as the SDK sends them. */
function dotnetEvent(frame: Record<string, string | number | boolean>): StoredEvent {
  return normalize({
    platform: "csharp",
    exception: {
      values: [
        {
          type: "System.OverflowException",
          stacktrace: {
            frames: [
              {
                function: "Run",
                abs_path: PATH,
                lineno: 3,
                in_app: true,
                addr_mode: "rel:1",
                ...frame,
              },
            ],
          },
        },
      ],
    },
    // The first image is invalid; frames still find the second by its position.
    debug_meta: {
      images: [{ debug_id: 7 }, { type: "pe_dotnet", debug_id: DEBUG_ID.toUpperCase() }],
    },
  });
}

function onlyFrame(event: StoredEvent): StoredFrame {
  const frame = event.exceptions[0]?.frames[0];

  if (frame === undefined) {
    throw new Error("event has no frame");
  }

  return frame;
}

const lookup = (debugId: string, path: string): string | null =>
  debugId === DEBUG_ID && path === PATH ? SOURCE : null;

describe("source context", () => {
  it("takes the frame's debug id from the image its address is relative to", () => {
    const event = dotnetEvent({});

    expect(onlyFrame(event).debugId).toBe(DEBUG_ID);
    expect(sourceRequest(event)).toEqual(new Map([[DEBUG_ID, new Set([PATH])]]));
  });

  it("adds five lines either side, cut short at the start of the file", () => {
    const frame = onlyFrame(withSourceContext(dotnetEvent({}), lookup));

    expect(frame.contextLine).toBe("line 3");
    expect(frame.preContext).toEqual(["line 1", "line 2"]);
    expect(frame.postContext).toEqual(["line 4", "line 5", "line 6", "line 7", "line 8"]);
  });

  it("adds nothing when the line is past the end of the file", () => {
    const frame = onlyFrame(withSourceContext(dotnetEvent({ lineno: 21 }), lookup));

    expect(frame.contextLine).toBeNull();
  });

  it("keeps context the SDK sent, and leaves library frames alone", () => {
    const sent = dotnetEvent({ context_line: "from the SDK" });
    const library = dotnetEvent({ in_app: false });

    expect(sourceRequest(sent).size).toBe(0);
    expect(sourceRequest(library).size).toBe(0);
    expect(onlyFrame(withSourceContext(sent, lookup)).contextLine).toBe("from the SDK");
  });

  it("has no debug id for an address that is not relative to an image", () => {
    expect(onlyFrame(dotnetEvent({ addr_mode: "abs" })).debugId).toBeNull();
    expect(onlyFrame(dotnetEvent({ addr_mode: "rel:9" })).debugId).toBeNull();
  });
});

describe("parseSourceBundle", () => {
  it("refuses a plain ZIP, which has no source bundle header", () => {
    const zip = zipSync({ "manifest.json": new TextEncoder().encode("{}") });

    expect(() => parseSourceBundle(zip)).toThrow(InvalidSourceBundle);
  });

  it("refuses a header followed by something that is not a ZIP", () => {
    const bytes = new Uint8Array([...new TextEncoder().encode("SYSB"), 2, 0, 0, 0, 1, 2, 3]);

    expect(() => parseSourceBundle(bytes)).toThrow(/could not be read/);
  });
});
