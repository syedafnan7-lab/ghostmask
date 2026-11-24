import { test } from "node:test";
import assert from "node:assert/strict";
import { Session } from "../src/session.ts";
import type { Observation, BrowserPort, Identity } from "../src/contracts.ts";
const identity: Identity = {
  tabId: 1,
  windowId: 1,
  documentId: "document-1",
  origin: "https://example.test",
  generation: 0,
  urlKey: "abc",
  viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0, dpr: 1 },
  zoom: 1,
};
function fixture() {
  let state = structuredClone(identity);
  let inserted = "";
  let failing = false;
  const browser: BrowserPort = {
    current: async () => structuredClone(state),
    capture: async () => {
      if (failing) throw new Error("RAW-SECRET");
      return {
        identity: structuredClone(state),
        capturedAt: Date.now(),
        image: "data:image/png;base64,RAWSECRET",
        text: "hidden RAW-SECRET",
        fields: [
          {
            key: "private-key",
            kind: "email",
            category: "contact",
            value: "RAW-SECRET",
            label: "RAW-SECRET",
            rect: { x: 0, y: 0, width: 100, height: 20 },
          },
        ],
        masks: [],
        unsupported: [],
      };
    },
    insert: async (_i, _f, value) => {
      inserted = value;
      state.generation++;
      return true;
    },
  };
  return {
    browser,
    change: () => state.generation++,
    fail: () => {
      failing = true;
    },
    inserted: () => inserted,
  };
}
const raster = async () => "data:image/png;base64,SAFE";
test("actual provider body excludes seeded text, original image, URL and approved insertion value", async () => {
  const f = fixture();
  let body = "";
  const session = new Session(
    f.browser,
    1,
    "ollama",
    ["contact"],
    raster,
    async (_url, options) => {
      body = options!.body as string;
      const request = JSON.parse(JSON.parse(body).messages[1].content);
      return new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({ type: "insert", ...request.grants[0] }),
          },
        }),
      );
    },
  );
  await session.capture();
  await session.approve("field-1", "insert@example.test");
  session.review(session.view().payloadId);
  const preview = session.view().payload;
  await session.propose();
  assert.equal(body, preview);
  for (const seed of [
    "RAW-SECRET",
    "RAWSECRET",
    "private-key",
    "example.test",
    "document-1",
  ])
    assert.ok(!body.includes(seed));
  await session.execute();
  assert.equal(f.inserted(), "insert@example.test");
  assert.ok(session.receipts().some((r) => r.event === "verified"));
  assert.ok(
    !JSON.stringify(session.receipts()).includes("insert@example.test"),
  );
  assert.ok(!session.view().proposal);
});
test("stale capture blocks provider and requires fresh capture after resume", async () => {
  const f = fixture();
  let requests = 0;
  const s = new Session(
    f.browser,
    1,
    "ollama",
    ["contact"],
    raster,
    async () => {
      requests++;
      return new Response("{}");
    },
  );
  await s.capture();
  s.review(s.view().payloadId);
  f.change();
  await assert.rejects(s.propose(), /STALE_CAPTURE/);
  assert.equal(requests, 0);
  assert.equal(s.view().state, "paused");
  s.resume();
  await assert.rejects(s.propose(), /INVALID_ARTIFACT/);
});
test("sanitizer failure cannot send raw fallback and safe receipt hides exception text", async () => {
  const f = fixture();
  let requests = 0;
  const s = new Session(
    f.browser,
    1,
    "ollama",
    ["contact"],
    async () => {
      throw new Error("SEED-ERROR");
    },
    async () => {
      requests++;
      return new Response("{}");
    },
  );
  await assert.rejects(s.capture(), /CAPTURE_FAILED/);
  await assert.rejects(s.propose());
  assert.equal(requests, 0);
  assert.ok(!JSON.stringify(s.receipts()).includes("SEED"));
});
test("malicious model cannot nominate another token or arbitrary fields", async () => {
  const f = fixture();
  const s = new Session(
    f.browser,
    1,
    "ollama",
    ["contact"],
    raster,
    async () =>
      new Response(
        JSON.stringify({
          message: {
            content: JSON.stringify({
              type: "insert",
              target: "field-1",
              token: crypto.randomUUID(),
            }),
          },
        }),
      ),
  );
  await s.capture();
  await s.approve("field-1", "test@example.test");
  s.review(s.view().payloadId);
  await assert.rejects(s.propose(), /POLICY_DENIED/);
  assert.equal(f.inserted(), "");
});
test("pause invalidates tokens and reviewed payload; abort discards raw local preview", async () => {
  const f = fixture();
  const s = new Session(f.browser, 1, "simulator", ["contact"], raster);
  await s.capture();
  await s.approve("field-1", "test@example.test");
  s.review(s.view().payloadId);
  s.pause();
  await assert.rejects(s.propose());
  s.resume();
  await s.capture();
  assert.equal(s.view().grants.length, 0);
  s.abort();
  assert.equal(s.view().original, "");
  assert.equal(s.view().fields.length, 0);
});
test("page change between model proposal and execution blocks insertion", async () => {
  const f = fixture();
  const s = new Session(f.browser, 1, "simulator", ["contact"], raster);
  await s.capture();
  await s.approve("field-1", "test@example.test");
  s.review(s.view().payloadId);
  await s.propose();
  f.change();
  await assert.rejects(s.execute(), /STALE_CAPTURE/);
  assert.equal(f.inserted(), "");
});
test("permission categories are copied and cannot be expanded by caller mutation", async () => {
  const f = fixture();
  const allowed: "contact"[] = [];
  const s = new Session(f.browser, 1, "simulator", allowed, raster);
  allowed.push("contact");
  await s.capture();
  await assert.rejects(
    () => s.approve("field-1", "test@example.test"),
    /POLICY_DENIED/,
  );
});
test("abort during a pending model response prevents later action acceptance", async () => {
  const f = fixture();
  let finish!: (value: Response) => void;
  let started!: (value: void) => void;
  const requested = new Promise<void>((r) => (started = r));
  const s = new Session(
    f.browser,
    1,
    "ollama",
    ["contact"],
    raster,
    async () => {
      started();
      return new Promise<Response>((r) => (finish = r));
    },
  );
  await s.capture();
  s.review(s.view().payloadId);
  const pending = s.propose();
  await requested;
  s.abort();
  finish(
    new Response(JSON.stringify({ message: { content: '{"type":"stop"}' } })),
  );
  await assert.rejects(pending, /TASK_PAUSED/);
  assert.equal(s.view().state, "aborted");
  assert.equal(s.view().proposal, undefined);
});
test("manual exclusions survive post-insertion automatic recapture", async () => {
  const f = fixture();
  const calls: string[][] = [];
  const original = f.browser.capture;
  f.browser.capture = async (tab, exclusions) => {
    calls.push([...exclusions]);
    return original(tab, exclusions);
  };
  const s = new Session(f.browser, 1, "simulator", ["contact"], raster);
  await s.capture(["#private"]);
  await s.approve("field-1", "test@example.test");
  s.review(s.view().payloadId);
  await s.propose();
  await s.execute();
  assert.deepEqual(calls, [["#private"], ["#private"]]);
});
test("a page change during model inference rejects the stale proposal itself", async () => {
  const f = fixture();
  const s = new Session(
    f.browser,
    1,
    "ollama",
    ["contact"],
    raster,
    async () => {
      f.change();
      return new Response(
        JSON.stringify({ message: { content: '{"type":"stop"}' } }),
      );
    },
  );
  await s.capture();
  s.review(s.view().payloadId);
  await assert.rejects(s.propose(), /STALE_CAPTURE/);
  assert.equal(s.view().proposal, undefined);
});

test("multi-field batch approval and insertion fills multiple fields atomically", async () => {
  let state = structuredClone(identity);
  const inserted: Record<string, string> = {};
  const multiBrowser: BrowserPort = {
    current: async () => structuredClone(state),
    capture: async () => ({
      identity: structuredClone(state),
      capturedAt: Date.now(),
      image: "data:image/png;base64,RAWSECRET",
      text: "test form",
      fields: [
        {
          key: "name-key",
          kind: "text",
          category: "contact",
          value: "",
          label: "Full Name",
          rect: { x: 0, y: 0, width: 100, height: 20 },
        },
        {
          key: "email-key",
          kind: "email",
          category: "contact",
          value: "",
          label: "Email Address",
          rect: { x: 0, y: 30, width: 100, height: 20 },
        },
      ],
      masks: [],
      unsupported: [],
    }),
    insert: async (_i, key, value) => {
      inserted[key] = value;
      state.generation++;
      return true;
    },
  };
  const s = new Session(multiBrowser, 1, "simulator", ["contact"], raster);
  await s.capture();
  await s.approveBatch([
    { target: "field-1", value: "Taylor Example" },
    { target: "field-2", value: "taylor@example.test" },
  ]);
  assert.equal(s.view().grants.length, 2);
  s.review(s.view().payloadId);
  const proposal = await s.propose();
  assert.equal(proposal.type, "batch_insert");
  if (proposal.type === "batch_insert") {
    assert.equal(proposal.insertions.length, 2);
    assert.equal(proposal.insertions[0].target, "field-1");
    assert.equal(proposal.insertions[1].target, "field-2");
  }
  await s.execute();
  assert.equal(inserted["name-key"], "Taylor Example");
  assert.equal(inserted["email-key"], "taylor@example.test");
  assert.equal(s.view().grants.length, 0);
});

