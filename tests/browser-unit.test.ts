import test from "node:test";
import assert from "node:assert/strict";
import { ChromeBrowser } from "../src/browser.ts";

test("capture rejects an inactive selected tab without taking a screenshot", async () => {
  let screenshots = 0;
  const api = {
    tabs: {
      get: async () => ({ id: 7, windowId: 2, active: false }),
      query: async () => [{ id: 8 }],
      captureVisibleTab: async () => {
        screenshots++;
        return "data:image/png;base64,AAAA";
      },
    },
  };
  const browser = new ChromeBrowser(api as never);
  await assert.rejects(browser.capture(7, []), /STALE_CAPTURE/);
  assert.equal(screenshots, 0);
});

function apiFixture(options: { change?: boolean; throwSecret?: boolean } = {}) {
  let observation = 0,
    screenshots = 0;
  const snapshot = {
    origin: "http://localhost:4173",
    generation: 0,
    urlKey: "url-hash",
    viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0, dpr: 2 },
    fields: [],
    masks: [],
    unsupported: [],
  };
  const api = {
    tabs: {
      get: async () => ({
        id: 7,
        windowId: 2,
        active: true,
        status: "complete",
      }),
      query: async () => [{ id: 7 }],
      getZoom: async () => 1,
      captureVisibleTab: async () => {
        screenshots++;
        if (options.throwSecret) throw Error("secret@example.invalid");
        return "data:image/png;base64,AAAA";
      },
    },
    scripting: {
      executeScript: async () => [
        {
          frameId: 0,
          documentId: "doc-A",
          result: {
            ...snapshot,
            generation: options.change ? observation++ : 0,
          },
        },
      ],
    },
  };
  return { api: api as never, count: () => screenshots };
}
test("a stable selected page returns local screenshot and bound identity", async () => {
  const fixture = apiFixture(),
    browser = new ChromeBrowser(fixture.api);
  const capture = await browser.capture(7, []);
  assert.equal(capture.identity.documentId, "doc-A");
  assert.equal(capture.identity.viewport.dpr, 2);
  assert.equal(capture.text, "");
  assert.equal(fixture.count(), 1);
});
test("repeated changes exhaust bounded retries and return no screenshot artifact", async () => {
  const fixture = apiFixture({ change: true }),
    browser = new ChromeBrowser(fixture.api);
  await assert.rejects(browser.capture(7, []), /STALE_CAPTURE/);
  assert.equal(fixture.count(), 3);
});
test("browser error messages cannot expose raw page data", async () => {
  const fixture = apiFixture({ throwSecret: true }),
    browser = new ChromeBrowser(fixture.api);
  await assert.rejects(
    browser.capture(7, []),
    (error) => error instanceof Error && error.message === "CAPTURE_FAILED",
  );
});
test("insertion refuses stale navigation before sending a value to the page", async () => {
  const fixture = apiFixture(),
    browser = new ChromeBrowser(fixture.api);
  const identity = await browser.current(7);
  await assert.rejects(
    browser.insert(
      { ...identity, documentId: "old-document" },
      "field-A",
      "synthetic secret",
    ),
    /STALE_CAPTURE/,
  );
});
test("insertion is not verified if a later observation shows the value changed", async () => {
  const fixture = apiFixture();
  let calls = 0;
  const api = fixture.api as any;
  const base = api.scripting.executeScript;
  api.scripting.executeScript = async (...args: any[]) => {
    calls++;
    if (calls === 3) return [{ frameId: 0, documentId: "doc-A", result: true }];
    const result = await base(...args);
    result[0].result.fields = [
      {
        key: "field-A",
        value: "rewritten by page",
        kind: "text",
        category: "contact",
        label: "Name",
        rect: { x: 0, y: 0, width: 100, height: 30 },
      },
    ];
    return result;
  };
  const browser = new ChromeBrowser(api);
  const identity = await browser.current(7);
  assert.equal(
    await browser.insert(identity, "field-A", "expected synthetic value"),
    false,
  );
});

test("a real DOM excludes an entire private section from capture and insertion", async () => {
  const { chromium } = await import("@playwright/test");
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      '<main><section id="private"><label>Private name<input id="privateName" value="Synthetic Ada"></label></section><label>Email<input id="publicEmail" type="email"></label></main>',
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const chromiumBrowser = await chromium.launch({ headless: true });
  try {
    const page = await chromiumBrowser.newPage({
      viewport: { width: 800, height: 600 },
    });
    await page.goto("http://127.0.0.1:" + port);
    const api = {
      tabs: {
        get: async () => ({
          id: 7,
          windowId: 2,
          active: true,
          status: "complete",
        }),
        query: async () => [{ id: 7 }],
        getZoom: async () => 1,
        captureVisibleTab: async () =>
          "data:image/png;base64," +
          (await page.screenshot({ caret: "initial" })).toString("base64"),
      },
      scripting: {
        executeScript: async (request: any) => {
          const result = await page.evaluate(
            async ({ source, args }) => {
              (globalThis as any).__name = (value: any) => value;
              return await (0, eval)("(" + source + ")")(...args);
            },
            {
              source: request.func.toString(),
              args: JSON.parse(
                JSON.stringify(request.args, (_key, value) =>
                  value && typeof value === "object" && !Array.isArray(value)
                    ? Object.fromEntries(
                        Object.entries(value).sort(([a], [b]) =>
                          a.localeCompare(b),
                        ),
                      )
                    : value,
                ),
              ),
            },
          );
          return [{ frameId: 0, documentId: "doc-A", result }];
        },
      },
    };
    const browser = new ChromeBrowser(api as never);
    const first = await browser.capture(7, []);
    assert.equal(first.fields.length, 2);
    const retainedSignature = await page.evaluate(
      () => (globalThis as any).__ghostmaskCaptureV1.signature,
    );
    assert.match(retainedSignature, /^[a-f0-9]{64}$/);
    assert.equal(retainedSignature.includes("Synthetic Ada"), false);
    const privateKey = first.fields.find(
      (f) => f.value === "Synthetic Ada",
    )!.key;
    const excluded = await browser.capture(7, ["#private"]);
    assert.equal(excluded.fields.length, 1);
    assert.equal(
      await browser.insert(excluded.identity, privateKey, "must not insert"),
      false,
    );
    assert.equal(
      await page.locator("#privateName").inputValue(),
      "Synthetic Ada",
    );
    assert.equal(
      await browser.insert(
        await browser.current(7),
        excluded.fields[0].key,
        "demo@example.invalid",
      ),
      true,
    );
    assert.equal(
      await page.locator("#publicEmail").inputValue(),
      "demo@example.invalid",
    );
  } finally {
    await chromiumBrowser.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("disposing a browser removes listeners and blocks further capture", async () => {
  const callbacks = new Set<unknown>();
  const event = {
    addListener: (listener: unknown) => callbacks.add(listener),
    removeListener: (listener: unknown) => callbacks.delete(listener),
  };
  const fixture = apiFixture();
  const api = fixture.api as any;
  api.tabs.onActivated = event;
  api.tabs.onRemoved = event;
  api.tabs.onUpdated = event;
  const browser = new ChromeBrowser(api);
  assert.equal(callbacks.size, 3);
  browser.dispose();
  assert.equal(callbacks.size, 0);
  await assert.rejects(browser.current(7), /TASK_PAUSED/);
});

async function withRealDom(
  html: string,
  run: (
    browser: ChromeBrowser,
    page: import("@playwright/test").Page,
  ) => Promise<void>,
) {
  const { chromium } = await import("@playwright/test");
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const engine = await chromium.launch({ headless: true });
  try {
    const page = await engine.newPage({
      viewport: { width: 800, height: 600 },
    });
    await page.goto(
      "http://127.0.0.1:" + (server.address() as { port: number }).port,
    );
    const api = {
      tabs: {
        get: async () => ({
          id: 7,
          windowId: 2,
          active: true,
          status: "complete",
        }),
        query: async () => [{ id: 7 }],
        getZoom: async () => 1,
        captureVisibleTab: async () =>
          "data:image/png;base64," +
          (await page.screenshot({ caret: "initial" })).toString("base64"),
      },
      scripting: {
        executeScript: async (request: any) => {
          const result = await page.evaluate(
            async ({ source, args }) => {
              (globalThis as any).__name = (x: any) => x;
              return await (0, eval)("(" + source + ")")(...args);
            },
            {
              source: request.func.toString(),
              args: JSON.parse(JSON.stringify(request.args)),
            },
          );
          return [{ frameId: 0, documentId: "doc-A", result }];
        },
      },
    };
    const browser = new ChromeBrowser(api as never);
    try {
      await run(browser, page);
    } finally {
      browser.dispose();
    }
  } finally {
    await engine.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("visible text blocks retain public context while private and hidden text stay excluded", async () => {
  await withRealDom(
    `<style>body{font:16px Arial}#hidden{display:none}#transparent{opacity:0}</style><h1>Contact support</h1><p>We reply within two days.</p><section id="private"><p>Sensitive note stays local</p></section><p id="hidden">Hidden secret never appears</p><div id="transparent"><p>Transparent secret</p></div><label>Email<input name="email" value="person@example.test"></label>`,
    async (browser) => {
      const result = await browser.capture(7, ["#private"]);
      assert.ok(result.blocks);
      const text = result.blocks.map((b) => b.text).join(" ");
      assert.ok(text.includes("Contact support"));
      assert.ok(text.includes("We reply within two days."));
      assert.ok(!text.includes("Sensitive note"));
      assert.ok(!text.includes("Hidden secret"));
      assert.ok(!text.includes("Transparent secret"));
      assert.ok(!text.includes("person@example.test"));
      assert.ok(result.blocks.some((b) => b.excluded));
      assert.ok(result.protectedMasks!.length > 0);
      const heading = result.blocks.find((b) => b.text === "Contact support")!;
      assert.ok(
        heading.rects.every(
          (r) => r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0,
        ),
      );
      assert.ok(
        !result.protectedMasks!.some(
          (r) =>
            r.x <= heading.rects[0].x &&
            r.y <= heading.rects[0].y &&
            r.x + r.width >= heading.rects[0].x + heading.rects[0].width &&
            r.y + r.height >= heading.rects[0].y + heading.rects[0].height,
        ),
      );
    },
  );
});

test("select insertion accepts only an existing enabled single-select option", async () => {
  await withRealDom(
    '<label>Contact method<select name="contactMethod"><option value="email">Email</option><option value="phone">Phone</option><option value="disabled" disabled>Disabled</option><optgroup label="Locked" disabled><option value="locked">Locked</option></optgroup></select></label>',
    async (browser, page) => {
      const capture = await browser.capture(7, []);
      const key = capture.fields[0].key;
      assert.equal(
        await browser.insert(capture.identity, key, "missing"),
        false,
      );
      assert.equal(
        await browser.insert(await browser.current(7), key, "disabled"),
        false,
      );
      assert.equal(
        await browser.insert(await browser.current(7), key, "locked"),
        false,
      );
      assert.equal(
        await browser.insert(await browser.current(7), key, "phone"),
        true,
      );
      assert.equal(await page.locator("select").inputValue(), "phone");
    },
  );
});

test("CSSOM-only geometry changes invalidate text-block capture identity", async () => {
  await withRealDom(
    '<style id="rules"></style><p id="text">Public delivery information</p>',
    async (browser, page) => {
      const capture = await browser.capture(7, []);
      await page.evaluate(() => {
        (
          document.querySelector("#rules") as HTMLStyleElement
        ).sheet!.insertRule("#text { margin-left: 100px; }");
      });
      const current = await browser.current(7);
      assert.notEqual(current.generation, capture.identity.generation);
    },
  );
});
test("partly clipped text is masked without disclosing unseen characters", async () => {
  await withRealDom(
    '<div style="width:30px;height:20px;overflow:hidden;white-space:nowrap">Hidden-tail-sensitive-phrase</div>',
    async (browser) => {
      const capture = await browser.capture(7, []);
      assert.ok(capture.blocks!.some((b) => b.excluded));
      assert.ok(capture.blocks!.every((b) => !b.text.includes("Hidden-tail")));
      assert.ok(capture.protectedMasks!.length > 0);
    },
  );
});
test("oversized visible text input fails closed rather than truncating coverage", async () => {
  await withRealDom(
    "<style>span{display:inline-block;width:8px}</style><div>" +
      Array.from({ length: 1001 }, () => "<span>x</span>").join("") +
      "</div>",
    async (browser) => {
      await assert.rejects(
        browser.capture(7, []),
        /CAPTURE_FAILED|UNSUPPORTED/,
      );
    },
  );
});

test("known private values include hidden and excluded controls for repeated-value masking", async () => {
  await withRealDom(
    '<input type="hidden" value="private-key-734"><section id="private"><input value="private-name-529"><p>private-note-812</p><p hidden>hidden-private-note-911</p></section><p>Repeated value: private-key-734</p>',
    async (browser) => {
      const capture = await browser.capture(7, ["#private"]);
      assert.ok(capture.privateValues?.includes("private-key-734"));
      assert.ok(capture.privateValues?.includes("private-name-529"));
      assert.ok(capture.privateValues?.includes("private-note-812"));
      assert.ok(capture.privateValues?.includes("hidden-private-note-911"));
      assert.ok(capture.blocks!.some((b) => b.text.includes("Repeated value")));
      assert.equal(capture.fields.length, 0);
    },
  );
});

test("oversized private control values are rejected rather than truncated", async () => {
  await withRealDom(
    '<input type="hidden" value="' + "a".repeat(4097) + '">',
    async (browser) => {
      await assert.rejects(
        browser.capture(7, []),
        /CAPTURE_FAILED|UNSUPPORTED/,
      );
    },
  );
});
test("a programmatic hidden-value change invalidates capture identity", async () => {
  await withRealDom(
    '<input id="private" type="hidden" value="old-private-value"><p>Public context</p>',
    async (browser, page) => {
      const capture = await browser.capture(7, []);
      await page.locator("#private").evaluate((element: HTMLInputElement) => {
        element.value = "new-private-value";
      });
      const current = await browser.current(7);
      assert.notEqual(current.generation, capture.identity.generation);
    },
  );
});

test("missing activeTab or <all_urls> permission surfaces PERMISSION_REQUIRED cleanly", async () => {
  const fixture = apiFixture();
  const api = fixture.api as any;
  api.tabs.captureVisibleTab = async () => {
    throw new Error(
      "Either the '<all_urls>' or 'activeTab' permission is required.",
    );
  };
  const browser = new ChromeBrowser(api);
  await assert.rejects(browser.capture(7, []), /PERMISSION_REQUIRED/);
});
