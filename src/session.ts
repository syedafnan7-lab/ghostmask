import {
  SafeError,
  sameIdentity,
  type BrowserPort,
  type Category,
  type Observation,
  type SafeErrorCode,
} from "./contracts.ts";
import { safeFields, sanitizeImage } from "./sanitizer.ts";
import {
  defaultDisclosure,
  rectIntersects,
  type Disclosure,
  type DisclosureOptions,
} from "./disclosure.ts";
import { prepareDisclosure } from "./prepare.ts";
import { redactText } from "./detection.ts";
import { TokenStore } from "./tokens.ts";
import { Gateway, type Ticket, type Route, type Proposal } from "./gateway.ts";
type Event =
  | "captured"
  | "approved"
  | "reviewed"
  | "request-attempted"
  | "proposal"
  | "attempted"
  | "verified"
  | "failed"
  | "blocked"
  | "paused"
  | "resumed"
  | "aborted"
  | "privacy-updated"
  | "exported";
export type Receipt = {
  time: string;
  task: string;
  capture?: string;
  event: Event;
  code?: SafeErrorCode;
  route: Route;
  policyVersion: number;
  profile?: string;
  maskCount?: number;
  retainedCharacters?: number;
};
export type SessionOptions = {
  profile?: "strict" | "reviewed";
  ocr?: boolean;
  purpose?: "fill-approved-fields" | "summarize-page";
  model?: string;
};
export class Session {
  #task = crypto.randomUUID();
  #version = 1;
  #epoch = 0;
  #tokens = new TokenStore();
  #gateway: Gateway;
  #observation?: Observation;
  #image = "";
  #capture = "";
  #ticket?: Ticket;
  #lastTicket?: Ticket;
  #disclosure?: Disclosure;
  #privacy: DisclosureOptions = {
    ...defaultDisclosure,
    privateTerms: [],
    manualMasks: [],
    blockedBlocks: [],
  };
  #purpose: "fill-approved-fields" | "summarize-page" = "fill-approved-fields";
  #model = "qwen3:0.6b";
  #reviewed = "";
  #grants: { target: string; token: string }[] = [];
  #proposal?: Proposal;
  #events: Receipt[] = [];
  #abort = new AbortController();
  #busy = false;
  #exclusions: string[] = [];
  #state: "ready" | "paused" | "aborted" = "ready";
  constructor(
    private browser: BrowserPort,
    private tabId: number,
    private route: Route = "simulator",
    private allowed: Category[] = ["contact"],
    private raster: (o: Observation) => Promise<string> = sanitizeImage,
    network: typeof fetch = fetch.bind(globalThis),
    options: SessionOptions = {},
  ) {
    this.#gateway = new Gateway(network);
    this.allowed = [...allowed];
    this.#privacy.profile = options.profile ?? "strict";
    this.#privacy.ocr = options.ocr ?? false;
    this.#purpose = options.purpose ?? "fill-approved-fields";
    this.#model = options.model ?? "qwen3:0.6b";
    if (!["fill-approved-fields", "summarize-page"].includes(this.#purpose))
      throw new SafeError("INVALID_INPUT");
  }
  #record(event: Event, code?: SafeErrorCode) {
    this.#events.push({
      time: new Date().toISOString(),
      task: this.#task,
      capture: this.#capture || undefined,
      event,
      code,
      route: this.route,
      policyVersion: this.#version,
      profile: this.#privacy.profile,
      maskCount: this.#disclosure?.masks.length,
      retainedCharacters: this.#disclosure?.retainedCharacters,
    });
  }
  #check(epoch = this.#epoch) {
    if (this.#state !== "ready" || epoch !== this.#epoch)
      throw new SafeError("TASK_PAUSED");
  }
  #invalidate() {
    this.#ticket = undefined;
    this.#lastTicket = undefined;
    this.#reviewed = "";
    this.#proposal = undefined;
  }
  #scope(field: string) {
    const o = this.#observation;
    if (!o) throw new SafeError("TOKEN_DENIED");
    return {
      task: this.#task,
      origin: o.identity.origin,
      document: o.identity.documentId,
      field,
      version: this.#version,
    };
  }
  #refresh() {
    const o = this.#observation;
    if (!o || !this.#image) throw new SafeError("INVALID_ARTIFACT");
    this.#ticket = this.#gateway.issue(
      {
        version: 1,
        task: this.#task,
        capture: this.#capture,
        purpose: this.#purpose,
        text: this.#disclosure?.text,
        fields: this.#disclosure?.fields ?? safeFields(o.fields),
        grants: this.#grants,
        image: this.#image,
        coverage:
          this.#privacy.profile === "strict"
            ? "all-source-pixels-suppressed"
            : "reviewed-selective",
      },
      this.route,
      this.#model,
    );
    this.#lastTicket = undefined;
    this.#reviewed = "";
    this.#proposal = undefined;
  }
  async #guard<T>(operation: () => Promise<T>): Promise<T> {
    this.#check();
    if (this.#busy) throw new SafeError("POLICY_DENIED");
    this.#busy = true;
    try {
      return await operation();
    } catch (error) {
      this.#invalidate();
      this.#state = this.#state === "aborted" ? "aborted" : "paused";
      const code = error instanceof SafeError ? error.code : "CAPTURE_FAILED";
      this.#record("blocked", code);
      throw new SafeError(code);
    } finally {
      this.#busy = false;
    }
  }
  async capture(exclusions?: string[]) {
    return this.#guard(async () => {
      if (exclusions) this.#exclusions = [...exclusions];
      const epoch = this.#epoch;
      this.#invalidate();
      this.#tokens.clear();
      this.#grants = [];
      this.#observation = undefined;
      this.#image = "";
      this.#disclosure = undefined;
      this.#privacy.manualMasks = [];
      this.#privacy.blockedBlocks = [];
      const observation = await this.browser.capture(
        this.tabId,
        this.#exclusions,
      );
      this.#check(epoch);
      if (
        !Number.isFinite(observation.capturedAt) ||
        Date.now() - observation.capturedAt > 30_000
      )
        throw new SafeError("STALE_CAPTURE");
      let image: string;
      if (this.#privacy.profile === "strict") {
        image = await this.raster(observation);
      } else {
        const prepared = await prepareDisclosure(
          observation,
          this.#privacy,
          this.#abort.signal,
        );
        image = prepared.image;
        this.#disclosure = prepared.disclosure;
      }
      this.#check(epoch);
      if (
        !image.startsWith("data:image/png;base64,") ||
        !sameIdentity(
          observation.identity,
          await this.browser.current(this.tabId),
        )
      )
        throw new SafeError("STALE_CAPTURE");
      this.#check(epoch);
      this.#observation = structuredClone(observation);
      this.#image = image;
      this.#capture = crypto.randomUUID();
      this.#refresh();
      this.#record("captured");
      return this.view();
    });
  }
  async approve(target: string, value: string) {
    this.#check();
    if (this.#busy) throw new SafeError("POLICY_DENIED");
    const f = this.#field(target);
    if (
      !this.allowed.includes(f.category) ||
      f.category === "secret" ||
      !["text", "email", "tel", "textarea", "select"].includes(f.kind) ||
      this.#privacy.manualMasks.some((r) => rectIntersects(r, f.rect)) ||
      this.#purpose !== "fill-approved-fields"
    )
      throw new SafeError("POLICY_DENIED");
    if (this.#privacy.profile === "reviewed") {
      await this.configurePrivacy({
        privateTerms: [...new Set([...this.#privacy.privateTerms, value])],
      });
      this.#check();
    }
    const token = this.#tokens.issue(value, this.#scope(f.key));
    this.#grants = this.#grants.filter((g) => g.target !== target);
    this.#grants.push({ target, token });
    this.#refresh();
    this.#record("approved");
  }
  async approveBatch(entries: { target: string; value: string }[]) {
    this.#check();
    if (!this.#observation) throw new SafeError("INVALID_ARTIFACT");
    if (this.#purpose !== "fill-approved-fields" || entries.length === 0)
      throw new SafeError("POLICY_DENIED");
    for (const { target } of entries) {
      const f = this.#field(target);
      if (
        !this.allowed.includes(f.category) ||
        f.category === "secret" ||
        !["text", "email", "tel", "textarea", "select"].includes(f.kind) ||
        this.#privacy.manualMasks.some((r) => rectIntersects(r, f.rect))
      )
        throw new SafeError("POLICY_DENIED");
    }
    if (this.#privacy.profile === "reviewed") {
      const values = entries.map((e) => e.value).filter(Boolean);
      await this.configurePrivacy({
        privateTerms: [...new Set([...this.#privacy.privateTerms, ...values])],
      });
      this.#check();
    }
    for (const { target, value } of entries) {
      const f = this.#field(target);
      const token = this.#tokens.issue(value, this.#scope(f.key));
      this.#grants = this.#grants.filter((g) => g.target !== target);
      this.#grants.push({ target, token });
    }
    this.#refresh();
    this.#record("approved");
  }
  #field(target: string) {
    if (!/^field-[1-9]\d{0,2}$/.test(target))
      throw new SafeError("POLICY_DENIED");
    const f = this.#observation?.fields[Number(target.slice(6)) - 1];
    if (!f) throw new SafeError("POLICY_DENIED");
    return f;
  }
  review(id: string) {
    this.#check();
    if (this.#busy || this.#ticket?.id !== id)
      throw new SafeError("INVALID_ARTIFACT");
    this.#reviewed = id;
    this.#record("reviewed");
  }
  async propose() {
    return this.#guard(async () => {
      const epoch = this.#epoch;
      const ticket = this.#ticket;
      const o = this.#observation;
      if (!ticket || !o || this.#reviewed !== ticket.id)
        throw new SafeError("INVALID_ARTIFACT");
      this.#record("request-attempted");
      this.#ticket = undefined;
      this.#lastTicket = ticket;
      const proposal = await this.#gateway.send(
        ticket,
        async () =>
          this.#state === "ready" &&
          epoch === this.#epoch &&
          Date.now() - o.capturedAt < 60_000 &&
          sameIdentity(o.identity, await this.browser.current(this.tabId)),
        this.#abort.signal,
      );
      this.#check(epoch);
      if (!sameIdentity(o.identity, await this.browser.current(this.tabId)))
        throw new SafeError("STALE_CAPTURE");
      this.#check(epoch);
      if (
        proposal.type === "insert" &&
        !this.#grants.some(
          (g) => g.target === proposal.target && g.token === proposal.token,
        )
      )
        throw new SafeError("POLICY_DENIED");
      if (proposal.type === "batch_insert") {
        if (
          proposal.insertions.length === 0 ||
          proposal.insertions.some(
            (ins) =>
              !this.#grants.some(
                (g) => g.target === ins.target && g.token === ins.token,
              ),
          )
        )
          throw new SafeError("POLICY_DENIED");
      }
      if (
        (this.#purpose === "summarize-page" && proposal.type !== "summary") ||
        (this.#purpose === "fill-approved-fields" &&
          proposal.type === "summary")
      )
        throw new SafeError("POLICY_DENIED");
      if (proposal.type === "summary")
        proposal.text = redactText(proposal.text, {
          privateTerms: [
            ...this.#privacy.privateTerms,
            ...(o.privateValues ?? []),
            ...o.fields.map((f) => f.value).filter(Boolean),
          ],
        }).text;
      this.#proposal = proposal;
      this.#record("proposal");
      return structuredClone(proposal);
    });
  }
  async execute() {
    await this.#guard(async () => {
      const epoch = this.#epoch;
      const p = this.#proposal;
      this.#proposal = undefined;
      const o = this.#observation;
      if (!p || (p.type !== "insert" && p.type !== "batch_insert") || !o)
        throw new SafeError("POLICY_DENIED");
      if (!sameIdentity(o.identity, await this.browser.current(this.tabId)))
        throw new SafeError("STALE_CAPTURE");
      this.#check(epoch);
      const plan: { target: string; token: string }[] =
        p.type === "batch_insert" ? p.insertions : [p];
      for (const item of plan) {
        const f = this.#field(item.target);
        if (
          !this.allowed.includes(f.category) ||
          !this.#grants.some(
            (g) => g.token === item.token && g.target === item.target,
          )
        )
          throw new SafeError("POLICY_DENIED");
        const value = this.#tokens.consume(item.token, this.#scope(f.key));
        this.#grants = this.#grants.filter((g) => g.token !== item.token);
        this.#record("attempted");
        const success = await this.browser.insert(o.identity, f.key, value);
        this.#check(epoch);
        if (!success) throw new SafeError("INSERT_FAILED");
        this.#record("verified");
      }
      this.#invalidate();
    });
    await this.capture();
  }
  pause() {
    if (this.#state === "aborted") return;
    this.#epoch++;
    this.#abort.abort();
    this.#tokens.clear();
    this.#grants = [];
    this.#invalidate();
    this.#state = "paused";
    this.#record("paused");
  }
  resume() {
    if (this.#state !== "paused" || this.#busy)
      throw new SafeError("POLICY_DENIED");
    this.#version++;
    this.#epoch++;
    this.#abort = new AbortController();
    this.#state = "ready";
    this.#observation = undefined;
    this.#image = "";
    this.#disclosure = undefined;
    this.#record("resumed");
  }
  abort() {
    this.pause();
    this.#state = "aborted";
    this.#observation = undefined;
    this.#image = "";
    this.#disclosure = undefined;
    this.#privacy.privateTerms = [];
    this.#privacy.manualMasks = [];
    this.#privacy.blockedBlocks = [];
    this.#record("aborted");
  }
  async configurePrivacy(
    patch: Partial<
      Pick<DisclosureOptions, "privateTerms" | "manualMasks" | "blockedBlocks">
    >,
  ) {
    return this.#guard(async () => {
      const epoch = this.#epoch;
      const o = this.#observation;
      if (!o) throw new SafeError("INVALID_ARTIFACT");
      if (
        Object.keys(patch).some(
          (k) => !["privateTerms", "manualMasks", "blockedBlocks"].includes(k),
        )
      )
        throw new SafeError("INVALID_INPUT");
      this.#invalidate();
      this.#tokens.clear();
      this.#grants = [];
      this.#version++;
      const privacy = { ...this.#privacy, ...structuredClone(patch) };
      if (
        privacy.privateTerms.length > 100 ||
        privacy.privateTerms.some(
          (t) => typeof t !== "string" || t.length > 4096,
        )
      )
        throw new SafeError("INVALID_INPUT");
      if (!sameIdentity(o.identity, await this.browser.current(this.tabId)))
        throw new SafeError("STALE_CAPTURE");
      this.#check(epoch);
      const prepared = await prepareDisclosure(o, privacy, this.#abort.signal);
      this.#check(epoch);
      if (!sameIdentity(o.identity, await this.browser.current(this.tabId)))
        throw new SafeError("STALE_CAPTURE");
      this.#check(epoch);
      this.#privacy = privacy;
      this.#image = prepared.image;
      this.#disclosure = prepared.disclosure;
      this.#refresh();
      this.#record("privacy-updated");
      return this.view();
    });
  }
  async exportArtifacts(payloadId: string) {
    return this.#guard(async () => {
      const epoch = this.#epoch;
      const ticket = this.#ticket ?? this.#lastTicket;
      const o = this.#observation;
      if (
        !ticket ||
        ticket.id !== payloadId ||
        this.#reviewed !== payloadId ||
        !o
      )
        throw new SafeError("INVALID_ARTIFACT");
      if (!sameIdentity(o.identity, await this.browser.current(this.tabId)))
        throw new SafeError("STALE_CAPTURE");
      this.#check(epoch);
      this.#record("exported");
      return {
        image: this.#image,
        text:
          this.#disclosure?.text ??
          JSON.stringify(safeFields(o.fields), null, 2),
        receipt: JSON.stringify(
          {
            task: this.#task,
            capture: this.#capture,
            payloadId,
            coverage: this.#privacy.profile,
            events: this.receipts(),
          },
          null,
          2,
        ),
      };
    });
  }
  clearReceipts() {
    this.#events = [];
  }
  receipts() {
    return structuredClone(this.#events);
  }
  view() {
    return {
      task: this.#task,
      state: this.#state,
      route: this.route,
      capture: this.#capture,
      original: this.#observation?.image ?? "",
      image: this.#image,
      fields: structuredClone(this.#observation?.fields ?? []),
      unsupported: structuredClone(this.#observation?.unsupported ?? []),
      origin: this.#observation?.identity.origin ?? "",
      disclosure: this.#disclosure
        ? structuredClone(this.#disclosure)
        : undefined,
      viewport: this.#observation
        ? structuredClone(this.#observation.identity.viewport)
        : undefined,
      privacy: structuredClone(this.#privacy),
      artifactId: this.#capture,
      sent: !this.#ticket && !!this.#lastTicket,
      payload: (this.#ticket ?? this.#lastTicket)?.wire ?? "",
      payloadId: (this.#ticket ?? this.#lastTicket)?.id ?? "",
      proposal: this.#proposal ? structuredClone(this.#proposal) : undefined,
      grants: this.#grants.map((g) => ({ target: g.target })),
      receipts: this.receipts(),
    };
  }
}
