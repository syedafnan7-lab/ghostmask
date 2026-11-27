import {
  SafeError,
  sameIdentity,
  type BrowserPort,
  type Category,
  type Field,
  type Identity,
  type Observation,
  type Rect,
  type TextBlock,
} from "./contracts.ts";

type PageSnapshot = {
  origin: string;
  generation: number;
  urlKey: string;
  viewport: Identity["viewport"];
  fields: Field[];
  masks: Rect[];
  blocks: TextBlock[];
  protectedMasks: Rect[];
  privateValues: string[];
  unsupported: string[];
};
type PageState = {
  generation: number;
  keys: WeakMap<Element, string>;
  elements: Map<string, Element>;
  observer: MutationObserver;
  signature?: string;
  exclusions: string[];
};

/** Runs only in the extension's ISOLATED world; never attach values to DOM attributes. */
async function pageSnapshot(
  exclusions: string[] | null,
  expected?: {
    generation: number;
    origin: string;
    urlKey: string;
    viewport: Identity["viewport"];
  },
  insertion?: { key: string; value: string } | { key: string; value: string }[],
): Promise<PageSnapshot | boolean> {
  const host = globalThis as typeof globalThis & {
    __ghostmaskCaptureV1?: PageState;
  };
  let state = host.__ghostmaskCaptureV1;
  if (!state) {
    const observer = new MutationObserver((records) => {
      if (records.length) host.__ghostmaskCaptureV1!.generation++;
    });
    state = {
      generation: 0,
      keys: new WeakMap(),
      elements: new Map(),
      observer,
      exclusions: [],
    };
    host.__ghostmaskCaptureV1 = state;
    observer.observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    for (const event of [
      "input",
      "change",
      "scroll",
      "resize",
      "hashchange",
      "popstate",
    ])
      globalThis.addEventListener(
        event,
        () => {
          host.__ghostmaskCaptureV1!.generation++;
        },
        true,
      );
    visualViewport?.addEventListener("resize", () => {
      host.__ghostmaskCaptureV1!.generation++;
    });
    visualViewport?.addEventListener("scroll", () => {
      host.__ghostmaskCaptureV1!.generation++;
    });
  }
  if (
    exclusions !== null &&
    JSON.stringify(state.exclusions) !== JSON.stringify(exclusions)
  ) {
    state.exclusions = exclusions;
    state.generation++;
  }
  const excludedRoots: Element[] = [];
  for (const selector of state.exclusions) {
    try {
      excludedRoots.push(...document.querySelectorAll(selector));
    } catch {
      throw new Error("INVALID_INPUT");
    }
  }
  const isExcluded = (el: Element) =>
    excludedRoots.some((root) => root === el || root.contains(el));
  if (state.observer.takeRecords().length) state.generation++;
  const start = state.generation;
  const sameViewport = (a: Identity["viewport"], b: Identity["viewport"]) =>
    a.width === b.width &&
    a.height === b.height &&
    a.scrollX === b.scrollX &&
    a.scrollY === b.scrollY &&
    a.dpr === b.dpr;
  const readViewport = () => ({
    width: innerWidth,
    height: innerHeight,
    scrollX,
    scrollY,
    dpr: devicePixelRatio,
  });
  const viewport = readViewport();
  const capturedUrl = location.href;
  const urlBytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(capturedUrl),
  );
  const urlKey = Array.from(new Uint8Array(urlBytes), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
  const origin = location.origin;
  if (capturedUrl !== location.href || !sameViewport(viewport, readViewport()))
    throw new Error("STALE_CAPTURE");
  if (state.observer.takeRecords().length) state.generation++;
  // No asynchronous work between this last check and insertion. Page events may still mutate after insertion.
  if (
    expected &&
    (state.generation !== expected.generation ||
      origin !== expected.origin ||
      urlKey !== expected.urlKey ||
      !sameViewport(viewport, expected.viewport))
  )
    return false;
  if (insertion) {
    const list = Array.isArray(insertion) ? insertion : [insertion];
    if (!list.length) return false;
    const validateAndPrepare = (item: { key: string; value: string }) => {
      const el = state.elements.get(item.key);
      if (
        !el?.isConnected ||
        isExcluded(el) ||
        el.ownerDocument !== document ||
        document.visibilityState !== "visible"
      )
        return null;
      if (
        !(
          el instanceof HTMLInputElement ||
          el instanceof HTMLTextAreaElement ||
          el instanceof HTMLSelectElement
        )
      )
        return null;
      if (
        el.disabled ||
        (!(el instanceof HTMLSelectElement) && el.readOnly) ||
        el.closest("[inert]") ||
        el.getAttribute("aria-disabled") === "true"
      )
        return null;
      if (
        el instanceof HTMLInputElement &&
        !["text", "email", "tel", "search", "url"].includes(el.type)
      )
        return null;
      if (el instanceof HTMLSelectElement) {
        const options = Array.from(el.options).filter(
          (option) => option.value === item.value,
        );
        if (
          el.multiple ||
          options.length !== 1 ||
          options[0].disabled ||
          (options[0].parentElement instanceof HTMLOptGroupElement &&
            options[0].parentElement.disabled)
        )
          return null;
      }
      for (
        let ancestor: Element | null = el;
        ancestor;
        ancestor = ancestor.parentElement
      ) {
        const ancestorStyle = getComputedStyle(ancestor);
        if (
          ancestorStyle.display === "none" ||
          ancestorStyle.visibility !== "visible" ||
          Number(ancestorStyle.opacity) === 0 ||
          ancestorStyle.contentVisibility === "hidden"
        )
          return null;
      }
      const rect = el.getBoundingClientRect(),
        style = getComputedStyle(el);
      if (
        rect.width <= 0 ||
        rect.height <= 0 ||
        rect.top < 0 ||
        rect.left < 0 ||
        rect.bottom > innerHeight ||
        rect.right > innerWidth ||
        style.visibility !== "visible" ||
        style.display === "none" ||
        Number(style.opacity) === 0
      )
        return null;
      const top = document.elementFromPoint(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
      );
      if (top !== el) return null;
      const setter = Object.getOwnPropertyDescriptor(
        el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : el instanceof HTMLSelectElement
            ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype,
        "value",
      )?.set;
      if (!setter) return null;
      return { el, setter, item };
    };
    const prepared = [];
    for (const item of list) {
      const entry = validateAndPrepare(item);
      if (!entry) return false;
      prepared.push(entry);
    }
    for (const { el, setter, item } of prepared) {
      setter.call(el, item.value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (state.observer.takeRecords().length) state.generation++;
    return prepared.every(
      ({ el, item }) =>
        el.isConnected &&
        state.elements.get(item.key) === el &&
        el.value === item.value &&
        location.origin === origin,
    );
  }
  const masks: Rect[] = [];
  const protectedMasks: Rect[] = [];
  const blocks: TextBlock[] = [];
  const privateValues = new Set<string>();
  const privateControls: {
    element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    value: string;
  }[] = [];
  const rememberPrivate = (value: string) => {
    if (!value) return;
    if (value.length > 4096) throw new Error("UNSUPPORTED");
    privateValues.add(value);
    if (privateValues.size > 800) throw new Error("UNSUPPORTED");
  };
  const trackedText: { node: Node; value: string; rects: Rect[] }[] = [];
  const fields: Field[] = [];
  const unsupported = new Set<string>();
  const clipRect = (r: DOMRect): Rect | null => {
    const x = Math.max(0, r.x),
      y = Math.max(0, r.y),
      right = Math.min(innerWidth, r.right),
      bottom = Math.min(innerHeight, r.bottom);
    return right > x && bottom > y
      ? { x, y, width: right - x, height: bottom - y }
      : null;
  };
  const addRect = (r: DOMRect, protect = true) => {
    const rect = clipRect(r);
    if (!rect) return;
    masks.push(rect);
    if (protect) protectedMasks.push(rect);
  };
  const full = () => {
    const rect = { x: 0, y: 0, width: innerWidth, height: innerHeight };
    masks.push(rect);
    protectedMasks.push(rect);
  };
  if (
    !document.body ||
    innerWidth <= 0 ||
    innerHeight <= 0 ||
    innerWidth * innerHeight * devicePixelRatio ** 2 > 32_000_000
  )
    throw new Error("UNSUPPORTED");
  if (
    visualViewport &&
    (visualViewport.scale !== 1 ||
      visualViewport.offsetLeft !== 0 ||
      visualViewport.offsetTop !== 0)
  ) {
    unsupported.add("visual-viewport-transform");
    full();
  }
  if (document.getAnimations().some((a) => a.playState === "running")) {
    unsupported.add("active-animation");
    full();
  }
  if (document.fonts.status !== "loaded") throw new Error("STALE_CAPTURE");
  // Custom fonts may map characters to unrelated glyphs. Do not claim DOM-based visual coverage.
  if (document.fonts.size > 0) {
    unsupported.add("custom-fonts");
    full();
  }
  const all = [
    document.documentElement,
    document.body,
    ...document.body.querySelectorAll("*"),
  ];
  if (all.length > 15000) throw new Error("UNSUPPORTED");
  for (const el of all) {
    const r = el.getBoundingClientRect(),
      style = getComputedStyle(el);
    if (
      r.width <= 0 ||
      r.height <= 0 ||
      style.visibility === "hidden" ||
      style.display === "none"
    )
      continue;
    if (
      style.filter !== "none" ||
      style.textShadow !== "none" ||
      style.mixBlendMode !== "normal" ||
      style.backdropFilter !== "none" ||
      style.textTransform !== "none"
    ) {
      unsupported.add("visual-effects");
      full();
    }
    for (const pseudo of ["::before", "::after"]) {
      const s = getComputedStyle(el, pseudo);
      if (
        s.content !== "none" &&
        s.content !== "normal" &&
        s.content !== '""'
      ) {
        unsupported.add("generated-content");
        full();
      }
    }
    if (el.shadowRoot || el.tagName.includes("-")) {
      unsupported.add("shadow-content");
      full();
    }
    if (el.matches("img,canvas,iframe,video,svg,object,embed")) {
      unsupported.add(el.tagName.toLowerCase());
      addRect(r);
      if (el.tagName.toLowerCase() === "svg") full();
    }
    if (style.backgroundImage !== "none") {
      unsupported.add("background-image");
      addRect(r);
    }
  }
  const visible = (el: Element): boolean => {
    for (
      let ancestor: Element | null = el;
      ancestor;
      ancestor = ancestor.parentElement
    ) {
      const style = getComputedStyle(ancestor);
      if (
        style.display === "none" ||
        style.visibility !== "visible" ||
        Number(style.opacity) === 0 ||
        style.contentVisibility === "hidden"
      )
        return false;
    }
    return true;
  };
  const clippedByAncestor = (el: Element, rects: DOMRect[]): boolean => {
    for (
      let ancestor: Element | null = el;
      ancestor;
      ancestor = ancestor.parentElement
    ) {
      const style = getComputedStyle(ancestor);
      if (style.clipPath !== "none" || style.clip !== "auto") return true;
      const bound = ancestor.getBoundingClientRect();
      if (
        rects.some(
          (r) =>
            (["hidden", "clip", "auto", "scroll"].includes(style.overflowX) &&
              (r.left < bound.left || r.right > bound.right)) ||
            (["hidden", "clip", "auto", "scroll"].includes(style.overflowY) &&
              (r.top < bound.top || r.bottom > bound.bottom)),
        )
      )
        return true;
    }
    return false;
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  let textCount = 0,
    characterCount = 0;
  while ((node = walker.nextNode())) {
    if (++textCount > 20000) throw new Error("UNSUPPORTED");
    const parent = node.parentElement,
      raw = node.textContent ?? "";
    if (
      raw.trim() &&
      parent &&
      !parent.closest("script,style,noscript") &&
      (isExcluded(parent) || parent.closest("[data-private],[data-sensitive]"))
    )
      rememberPrivate(raw.trim());
    if (
      !raw.trim() ||
      !parent ||
      parent.closest("script,style,noscript") ||
      !visible(parent)
    )
      continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const originalRects = Array.from(range.getClientRects());
    const rects = originalRects
      .map(clipRect)
      .filter((r): r is Rect => r !== null);
    if (!rects.length) continue;
    const partial =
      originalRects.some(
        (r) =>
          r.left < 0 ||
          r.top < 0 ||
          r.right > innerWidth ||
          r.bottom > innerHeight,
      ) || clippedByAncestor(parent, originalRects);
    const excluded =
      isExcluded(parent) ||
      Boolean(
        parent.closest(
          "input,textarea,select,option,[data-private],[data-sensitive]",
        ),
      ) ||
      partial;
    for (const r of originalRects) addRect(r, excluded);
    const contextParts: string[] = [];
    let contextParent: Element | null = parent;
    for (
      let depth = 0;
      contextParent && depth < 3;
      depth++, contextParent = contextParent.parentElement
    ) {
      contextParts.push(
        ...[
          contextParent.tagName,
          contextParent.id,
          contextParent.className,
          contextParent.getAttribute("aria-label"),
          contextParent.getAttribute("data-private"),
          contextParent.getAttribute("data-sensitive"),
        ].filter((x): x is string => typeof x === "string"),
      );
    }
    const context = contextParts.join(" ").slice(0, 500);
    const text = excluded ? "" : raw.trim();
    if (excluded) rememberPrivate(raw.trim());
    characterCount += raw.length;
    if (blocks.length >= 1000 || characterCount > 100000)
      throw new Error("UNSUPPORTED");
    blocks.push({
      id: "text-" + (blocks.length + 1),
      text,
      rects,
      excluded,
      context: excluded ? "excluded" : context,
    });
    trackedText.push({ node, value: raw, rects });
  }
  for (const el of document.querySelectorAll("input,textarea,select")) {
    if (
      !(
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement
      )
    )
      continue;
    rememberPrivate(el.value);
    privateControls.push({ element: el, value: el.value });
    const r = el.getBoundingClientRect();
    addRect(r);
    if (!el.isConnected || r.width <= 0 || r.height <= 0) continue;
    if (isExcluded(el)) {
      const oldKey = state.keys.get(el);
      if (oldKey) state.elements.delete(oldKey);
      continue;
    }
    let key = state.keys.get(el);
    if (!key || !state.elements.has(key)) {
      key = crypto.randomUUID();
      state.keys.set(el, key);
      state.elements.set(key, el);
    }
    const meta = [
      el.getAttribute("autocomplete"),
      el.getAttribute("name"),
      el.id,
      el.getAttribute("type"),
      el.getAttribute("aria-label"),
      ...(el.labels ? Array.from(el.labels, (l) => l.textContent ?? "") : []),
    ]
      .join(" ")
      .toLowerCase();
    const category: Category = /password|secret|token|api.?key|cvv/.test(meta)
      ? "secret"
      : /ssn|aadhaar|passport|pan.?number|account|identity/.test(meta)
        ? "identity"
        : /name|email|phone|mobile|address|contact/.test(meta)
          ? "contact"
          : "unknown";
    fields.push({
      key,
      kind:
        el instanceof HTMLTextAreaElement
          ? "textarea"
          : el instanceof HTMLSelectElement
            ? "select"
            : el.type,
      category,
      value: el.value.slice(0, 10000),
      label: (
        el.labels?.[0]?.textContent ||
        el.getAttribute("aria-label") ||
        el.getAttribute("name") ||
        "Field"
      ).slice(0, 500),
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    });
  }
  for (const selector of state.exclusions) {
    let matches: NodeListOf<Element>;
    try {
      matches = document.querySelectorAll(selector);
    } catch {
      throw new Error("INVALID_INPUT");
    }
    for (const el of matches) addRect(el.getBoundingClientRect());
  }
  for (const [key, el] of state.elements)
    if (!el.isConnected) state.elements.delete(key);
  if (state.observer.takeRecords().length) state.generation++;
  if (state.generation !== start) throw new Error("STALE_CAPTURE");
  // Programmatic .value changes do not fire DOM mutations or input events. Include values and geometry in the revision.
  const signatureInput = new TextEncoder().encode(
    JSON.stringify([
      fields.map((f) => [f.key, f.kind, f.value, f.rect]),
      blocks,
      protectedMasks,
      [...privateValues],
    ]),
  );
  const digest = await crypto.subtle.digest("SHA-256", signatureInput);
  signatureInput.fill(0);
  const signature = Array.from(new Uint8Array(digest), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
  if (state.observer.takeRecords().length) state.generation++;
  if (
    state.generation !== start ||
    capturedUrl !== location.href ||
    !sameViewport(viewport, readViewport())
  )
    throw new Error("STALE_CAPTURE");
  // A property assignment can change a value without a MutationObserver record while hashing yielded.
  for (const field of fields) {
    const el = state.elements.get(field.key);
    if (
      !(
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement
      ) ||
      !el.isConnected ||
      el.value.slice(0, 10000) !== field.value
    )
      throw new Error("STALE_CAPTURE");
    const r = el.getBoundingClientRect();
    if (
      r.x !== field.rect.x ||
      r.y !== field.rect.y ||
      r.width !== field.rect.width ||
      r.height !== field.rect.height
    )
      throw new Error("STALE_CAPTURE");
  }

  for (const control of privateControls) {
    if (!control.element.isConnected || control.element.value !== control.value)
      throw new Error("STALE_CAPTURE");
  }
  for (const item of trackedText) {
    if (!item.node.isConnected || item.node.textContent !== item.value)
      throw new Error("STALE_CAPTURE");
    const range = document.createRange();
    range.selectNodeContents(item.node);
    const rects = Array.from(range.getClientRects())
      .map(clipRect)
      .filter((r): r is Rect => r !== null);
    if (JSON.stringify(rects) !== JSON.stringify(item.rects))
      throw new Error("STALE_CAPTURE");
  }
  if (state.signature !== undefined && state.signature !== signature)
    state.generation++;
  state.signature = signature;
  return {
    origin,
    generation: state.generation,
    urlKey,
    viewport,
    fields,
    masks,
    blocks,
    protectedMasks,
    privateValues: [...privateValues],
    unsupported: [...unsupported],
  };
}

/** Browser API boundary. Raw observations remain local and must go through the sanitizer. */
export class ChromeBrowser implements BrowserPort {
  private lastCapture = 0;
  private captureBusy = false;
  private activationEpoch = 0;
  private revision = 0;
  private disposed = false;
  private readonly activated = () => {
    this.activationEpoch++;
  };
  private readonly removed = () => {
    this.activationEpoch++;
  };
  private readonly updated = (
    _tabId: number,
    change: chrome.tabs.OnUpdatedInfo,
  ) => {
    if (change.status === "loading") this.activationEpoch++;
  };
  private revisions = new Map<
    number,
    { signature: string; generation: number; rawGeneration: number }
  >();
  constructor(private readonly api: typeof chrome = chrome) {
    // Switching away and back during capture must invalidate it even if the same tab is active afterward.
    api.tabs.onActivated?.addListener(this.activated);
    api.tabs.onRemoved?.addListener(this.removed);
    api.tabs.onUpdated?.addListener(this.updated);
  }

  dispose(): void {
    this.disposed = true;
    this.activationEpoch++;
    this.api.tabs.onActivated?.removeListener(this.activated);
    this.api.tabs.onRemoved?.removeListener(this.removed);
    this.api.tabs.onUpdated?.removeListener(this.updated);
    this.revisions.clear();
  }
  private async selected(tabId: number): Promise<chrome.tabs.Tab> {
    if (this.disposed) throw new SafeError("TASK_PAUSED");
    if (!Number.isSafeInteger(tabId) || tabId < 0)
      throw new SafeError("INVALID_INPUT");
    const tab = await this.api.tabs.get(tabId);
    const active = await this.api.tabs.query({
      active: true,
      windowId: tab.windowId,
    });
    if (
      !tab.active ||
      active.length !== 1 ||
      active[0].id !== tabId ||
      tab.discarded ||
      tab.status === "loading"
    )
      throw new SafeError("STALE_CAPTURE");
    return tab;
  }
  private async observe(
    tabId: number,
    exclusions: string[] | null = null,
  ): Promise<{ identity: Identity; snapshot: PageSnapshot }> {
    const tab = await this.selected(tabId);
    const zoom = await this.api.tabs.getZoom(tabId);
    const results = await this.api.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: "ISOLATED",
      func: pageSnapshot,
      args: [exclusions],
    });
    const result = results[0];
    if (
      results.length !== 1 ||
      result.frameId !== 0 ||
      !result.documentId ||
      !result.result ||
      typeof result.result === "boolean"
    )
      throw new SafeError("CAPTURE_FAILED");
    const s = result.result;
    if (!/^https?:\/\//.test(s.origin) || !Number.isFinite(zoom) || zoom <= 0)
      throw new SafeError("UNSUPPORTED");
    const signature = JSON.stringify([
      result.documentId,
      s.generation,
      s.urlKey,
      s.viewport,
      zoom,
      tab.windowId,
      this.activationEpoch,
    ]);
    const previous = this.revisions.get(tabId);
    const generation =
      previous?.signature === signature ? previous.generation : ++this.revision;
    this.revisions.set(tabId, {
      signature,
      generation,
      rawGeneration: s.generation,
    });
    return {
      identity: {
        tabId,
        windowId: tab.windowId,
        documentId: result.documentId,
        origin: s.origin,
        generation,
        urlKey: s.urlKey,
        viewport: s.viewport,
        zoom,
      },
      snapshot: s,
    };
  }
  async current(tabId: number): Promise<Identity> {
    try {
      return (await this.observe(tabId)).identity;
    } catch (e) {
      throw e instanceof SafeError ? e : new SafeError("CAPTURE_FAILED");
    }
  }
  async capture(tabId: number, exclusions: string[]): Promise<Observation> {
    if (this.captureBusy) throw new SafeError("CAPTURE_FAILED");
    if (
      exclusions.length > 100 ||
      exclusions.some((x) => typeof x !== "string" || x.length > 500)
    )
      throw new SafeError("INVALID_INPUT");
    this.captureBusy = true;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const wait = Math.max(0, 600 - (Date.now() - this.lastCapture));
        if (wait) await new Promise((r) => setTimeout(r, wait));
        const epoch = this.activationEpoch;
        const before = await this.observe(tabId, exclusions);
        await this.selected(tabId);
        this.lastCapture = Date.now();
        const image = await this.api.tabs.captureVisibleTab(
          before.identity.windowId,
          { format: "png" },
        );
        const after = await this.observe(tabId, exclusions);
        if (
          epoch !== this.activationEpoch ||
          !sameIdentity(before.identity, after.identity)
        )
          continue;
        if (
          !image.startsWith("data:image/png;base64,") ||
          image.length > 50_000_000
        )
          throw new SafeError("CAPTURE_FAILED");
        return {
          identity: before.identity,
          capturedAt: Date.now(),
          image,
          text: "",
          fields: before.snapshot.fields,
          masks: before.snapshot.masks,
          blocks: before.snapshot.blocks ?? [],
          privateValues: before.snapshot.privateValues ?? [],
          protectedMasks:
            before.snapshot.protectedMasks ?? before.snapshot.masks,
          unsupported: before.snapshot.unsupported,
        };
      }
      throw new SafeError("STALE_CAPTURE");
    } catch (e) {
      throw e instanceof SafeError ? e : new SafeError("CAPTURE_FAILED");
    } finally {
      this.captureBusy = false;
    }
  }
  async insert(
    identity: Identity,
    fieldKey: string,
    value: string,
  ): Promise<boolean> {
    return this.insertBatch(identity, [{ fieldKey, value }]);
  }
  async insertBatch(
    identity: Identity,
    insertions: { fieldKey: string; value: string }[],
  ): Promise<boolean> {
    try {
      if (!insertions.length || insertions.length > 100)
        throw new SafeError("INVALID_INPUT");
      for (const { fieldKey, value } of insertions) {
        if (
          !fieldKey ||
          fieldKey.length > 100 ||
          typeof value !== "string" ||
          value.length > 10000
        )
          throw new SafeError("INVALID_INPUT");
      }
      if (!sameIdentity(identity, await this.current(identity.tabId)))
        throw new SafeError("STALE_CAPTURE");
      const revision = this.revisions.get(identity.tabId);
      if (revision?.generation !== identity.generation)
        throw new SafeError("STALE_CAPTURE");
      const payload =
        insertions.length === 1
          ? { key: insertions[0].fieldKey, value: insertions[0].value }
          : insertions.map((item) => ({
              key: item.fieldKey,
              value: item.value,
            }));
      const result = await this.api.scripting.executeScript({
        target: { tabId: identity.tabId, documentIds: [identity.documentId] },
        world: "ISOLATED",
        func: pageSnapshot,
        args: [
          null,
          {
            generation: revision.rawGeneration,
            origin: identity.origin,
            urlKey: identity.urlKey,
            viewport: identity.viewport,
          },
          payload,
        ],
      });
      if (
        result.length !== 1 ||
        result[0].documentId !== identity.documentId ||
        result[0].result !== true
      )
        return false;
      const observed = await this.observe(identity.tabId);
      const after = observed.identity;
      return (
        after.documentId === identity.documentId &&
        after.origin === identity.origin &&
        after.urlKey === identity.urlKey &&
        after.windowId === identity.windowId &&
        after.zoom === identity.zoom &&
        insertions.every(({ fieldKey, value }) =>
          observed.snapshot.fields.some(
            (f) => f.key === fieldKey && f.value === value,
          ),
        )
      );
    } catch (e) {
      throw e instanceof SafeError ? e : new SafeError("INSERT_FAILED");
    }
  }
}
