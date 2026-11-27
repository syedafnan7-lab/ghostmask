import { Session } from "./session.ts";
import { ChromeBrowser } from "./browser.ts";
import {
  SafeError,
  type Category,
  type SafeErrorCode,
  type Rect,
} from "./contracts.ts";
import { rectIntersects } from "./disclosure.ts";
import type { Route } from "./gateway.ts";
import { safeFields } from "./sanitizer.ts";

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error("UI_ELEMENT_MISSING");
  return node as T;
}
const button = (id: string) => element<HTMLButtonElement>(id);
const tab = element<HTMLSelectElement>("tab");
const route = element<HTMLSelectElement>("route");
const profile = element<HTMLSelectElement>("profile");
const purpose = element<HTMLSelectElement>("purpose");
const model = element<HTMLInputElement>("model");
const ocr = element<HTMLInputElement>("ocr");
const target = element<HTMLSelectElement>("target");
const localValue = element<HTMLInputElement>("value");
const exclusions = element<HTMLTextAreaElement>("exclusions");
const privateTerms = element<HTMLTextAreaElement>("private-terms");
const originalDetails = element<HTMLDetailsElement>("original-details");
const canvas = element<HTMLCanvasElement>("mask-canvas");
const batchSection = element<HTMLDivElement>("batch-autofill-section");
const batchFields = element<HTMLDivElement>("batch-fields");
const batchCount = element<HTMLSpanElement>("batch-count");
const batchBtn = element<HTMLButtonElement>("batch-autofill-btn");

let lastRenderedFieldKeys = "";
let session: Session | undefined;
let browser: ChromeBrowser | undefined;
let busy = false;
let reviewedId = "";
let selectedTabId: number | undefined;
let activeAllowed: Category[] = ["contact"];
let activeConfigSnapshot = "";
let hoveredMaskIndex = -1;
let copyResetTimer: ReturnType<typeof setTimeout> | undefined;
let selectedPurpose: "fill-approved-fields" | "summarize-page" =
  "fill-approved-fields";
let drag:
  | {
      start: { x: number; y: number };
      end: { x: number; y: number };
      artifact: string;
    }
  | undefined;

const explanations: Partial<Record<SafeErrorCode, string>> = {
  CAPTURE_FAILED:
    "Capture or local image processing failed. Keep the selected page visible, then resume and capture again.",
  STALE_CAPTURE:
    "The page changed. This capture cannot be sent or exported. Resume and capture again.",
  POLICY_DENIED:
    "This action is not allowed by the current permissions or task state.",
  PERMISSION_REQUIRED:
    "Chrome blocked screenshot capture because tab permission isn't active yet. Click Grant site access below (or click the GhostMask toolbar icon on the page), then Resume and Capture.",
  INVALID_ARTIFACT:
    "This version cannot be used. Capture and review a fresh payload.",
  TOKEN_DENIED:
    "The local approval expired or no longer matches. Capture again and approve a fresh value.",
  MODEL_FAILED:
    "The model failed or returned an unsupported reply. Check the local server and model name, then resume.",
  INSERT_FAILED:
    "Insertion could not be verified. Check the page locally before trying again.",
  TASK_PAUSED:
    "The task is paused. Resume and capture again before continuing.",
  UNSUPPORTED:
    "This page is outside the supported scope. Try a simple English HTML page or strict mode.",
  INVALID_INPUT:
    "Check the entries. Provide at least one value, valid CSS selectors, or mask boxes inside the page.",
};

function currentConfigSnapshot(): string {
  const allowed = Array.from(
    document.querySelectorAll<HTMLInputElement>("#categories input:checked"),
  )
    .map((input) => input.value)
    .sort()
    .join(",");
  return JSON.stringify([
    tab.value,
    profile.value,
    purpose.value,
    route.value,
    ocr.checked,
    allowed,
  ]);
}

function sampleValueForField(field: { label: string; kind: string }): string {
  if (/email/i.test(field.label) || field.kind === "email")
    return "taylor@example.test";
  if (/phone|mobile|tel/i.test(field.label) || field.kind === "tel")
    return "+1-555-0142";
  if (/name/i.test(field.label)) return "Taylor Example";
  if (/message|note|comment/i.test(field.label) || field.kind === "textarea")
    return "Synthetic reimbursement note";
  return "Synthetic value";
}

function status(message: string, error = false) {
  const node = element("status");
  node.textContent = message;
  node.dataset.error = String(error);
}

function option(value: string, label: string) {
  const node = document.createElement("option");
  node.value = value;
  node.textContent = label;
  return node;
}

function routeHint() {
  element("route-hint").textContent =
    route.value === "ollama"
      ? "Start Ollama on 127.0.0.1:11434 and load the selected model. Only reviewed content is sent."
      : route.value === "lmstudio"
        ? "Start the LM Studio local server on 127.0.0.1:1234. Enter the exact identifier of a loaded model."
        : "The simulator checks the workflow without using a model.";
  model.disabled = busy || route.value === "simulator";
  button("check-route").disabled = busy || route.value === "simulator";
}

async function refreshTabs() {
  const tabs = await chrome.tabs.query({});
  const previous = tab.value;
  tab.replaceChildren();
  for (const candidate of tabs) {
    if (candidate.id === undefined || !candidate.url) continue;
    try {
      const url = new URL(candidate.url);
      if (!["http:", "https:"].includes(url.protocol)) continue;
      tab.append(
        option(
          String(candidate.id),
          `Tab ${candidate.id}: ${url.origin}${candidate.active ? " (active)" : ""}`,
        ),
      );
    } catch {
      /* Unavailable tab metadata is omitted. */
    }
  }
  if ([...tab.options].some((item) => item.value === previous))
    tab.value = previous;
  else {
    const active = tabs.find(
      (item) =>
        item.active &&
        [...tab.options].some((opt) => opt.value === String(item.id)),
    );
    if (active) tab.value = String(active.id);
    else if (tab.options.length > 0 && tab.options[0].value)
      tab.value = tab.options[0].value;
  }
  if (tab.options.length === 0)
    tab.append(option("", "Open a supported page, then click GhostMask"));
  element("access-prompt").hidden = tab.options.length > 0 && Boolean(tab.value);
  render();
}

function renderOriginal() {
  const image = element<HTMLImageElement>("original");
  const list = element<HTMLUListElement>("local-fields");
  list.replaceChildren();
  const view = session?.view();
  if (originalDetails.open && view?.original) {
    image.src = view.original;
    image.hidden = false;
    view.fields.forEach((field, index) => {
      const row = document.createElement("li");
      row.textContent = `field-${index + 1} — ${field.label || "Unlabelled field"}; current value: ${field.value || "(empty)"}`;
      list.append(row);
    });
  } else {
    image.removeAttribute("src");
    image.hidden = true;
  }
}

function drawSelection() {
  const view = session?.view();
  const viewport = view?.viewport;
  if (!viewport) return;
  if (canvas.width !== viewport.width || canvas.height !== viewport.height) {
    canvas.width = viewport.width;
    canvas.height = viewport.height;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const scale = Math.max(
    1,
    canvas.width / Math.max(1, canvas.getBoundingClientRect().width),
  );

  if (hoveredMaskIndex >= 0) {
    const hovered = view?.privacy.manualMasks[hoveredMaskIndex];
    if (hovered) {
      ctx.save();
      ctx.strokeStyle = "#1f44e8";
      ctx.fillStyle = "rgba(31, 68, 232, 0.16)";
      ctx.lineWidth = Math.max(2, scale * 2.5);
      ctx.fillRect(hovered.x, hovered.y, hovered.width, hovered.height);
      ctx.strokeRect(hovered.x, hovered.y, hovered.width, hovered.height);
      ctx.restore();
    }
  }

  if (drag && drag.artifact === view.artifactId) {
    const r = dragRect();
    ctx.save();
    ctx.strokeStyle = "#dc2626";
    ctx.fillStyle = "rgba(220, 38, 38, 0.18)";
    ctx.lineWidth = Math.max(2, scale * 2);
    ctx.fillRect(r.x, r.y, r.width, r.height);
    ctx.strokeRect(r.x, r.y, r.width, r.height);

    const badge = `${Math.round(r.width)} × ${Math.round(r.height)} px`;
    const fontSize = Math.round(11 * scale);
    ctx.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    const metrics = ctx.measureText(badge);
    const padX = 6 * scale;
    const boxW = metrics.width + padX * 2;
    const boxH = 20 * scale;
    const boxX = Math.min(canvas.width - boxW - 2, Math.max(2, r.x));
    const boxY = r.y > boxH + 4 ? r.y - boxH - 4 : r.y + 4;
    ctx.fillStyle = "#0b0e14";
    ctx.fillRect(boxX, boxY, boxW, boxH);
    ctx.fillStyle = "#f8fafc";
    ctx.textBaseline = "middle";
    ctx.fillText(badge, boxX + padX, boxY + boxH / 2);
    ctx.restore();
  }
}

function updateStepper(
  hasCapture: boolean,
  hasActions: boolean,
  hasVerified: boolean,
) {
  const s1 = element("nav-step-1");
  const s2 = element("nav-step-2");
  const s3 = element("nav-step-3");
  const onStep1 = !hasCapture;
  const onStep3 = hasCapture && hasActions;
  const onStep2 = hasCapture && !onStep3;
  s1.classList.toggle("active", onStep1);
  s1.classList.toggle("done", hasCapture);
  s2.classList.toggle("active", onStep2);
  s2.classList.toggle("done", hasActions || hasVerified);
  s3.classList.toggle("active", onStep3);
  s3.classList.toggle("done", hasVerified);
}

function render() {
  const view = session?.view();
  const ready = view?.state === "ready";
  const hasCapture = Boolean(view?.image);
  const selective = view?.privacy.profile === "reviewed";
  if (reviewedId !== view?.payloadId) reviewedId = "";
  if (drag && drag.artifact !== view?.artifactId) drag = undefined;

  const stateCode = view?.state ?? "idle";
  const stateEl = element("state");
  stateEl.textContent = view?.state ?? "No task";
  stateEl.dataset.state = stateCode;
  element("state-dot").dataset.state = stateCode;

  const startBtn = button("start");
  const captureBtn = button("capture");
  const isDirty =
    Boolean(view) &&
    view?.state !== "aborted" &&
    activeConfigSnapshot !== "" &&
    currentConfigSnapshot() !== activeConfigSnapshot;
  element("config-dirty").hidden = !isDirty;

  startBtn.disabled = busy || !tab.value;
  captureBtn.disabled = busy || !ready;
  const startNeedsFocus = !view || view.state === "aborted" || isDirty;
  startBtn.classList.toggle("btn-primary", startNeedsFocus);
  startBtn.classList.toggle("quiet", !startNeedsFocus);
  captureBtn.classList.toggle("btn-primary", !startNeedsFocus);
  captureBtn.classList.toggle("quiet", startNeedsFocus);

  button("refresh-tabs").disabled = busy;
  tab.disabled = busy;
  route.disabled = busy;
  profile.disabled = busy;
  purpose.disabled = busy;
  ocr.disabled = busy || profile.value === "strict";
  routeHint();
  element<HTMLFieldSetElement>("categories").disabled = busy;
  exclusions.disabled = busy || !ready;
  button("pause").disabled = !ready;
  button("resume").disabled = busy || view?.state !== "paused";
  button("abort").disabled = !view || view.state === "aborted";
  button("clear").disabled = busy || !view;

  element("destination").textContent = view
    ? `Bound tab ${selectedTabId}. Destination: ${view.origin || "not captured yet"}.`
    : "No destination selected.";
  element("capture-info").textContent = hasCapture
    ? `Capture ${view!.capture}. Page changes need a new capture.`
    : "No capture yet.";

  const disclosure = view?.disclosure;
  element("coverage-summary").textContent = disclosure
    ? disclosure.profile === "strict"
      ? "Strict mode: all original pixels and page text are hidden. Only generated field structure is available."
      : `${disclosure.masks.length} masking regions. ${disclosure.retainedCharacters} page-text characters retained. Local image-text check: ${disclosure.ocrStatus === "complete" ? "complete" : "not requested"}. Review is still required.`
    : "No page has been captured.";

  element("mask-stats").hidden = !disclosure;
  if (disclosure) {
    const manualCount = view?.privacy.manualMasks.length ?? 0;
    const autoCount = Math.max(0, disclosure.masks.length - manualCount);
    element("stat-auto").textContent = String(autoCount);
    element("stat-manual").textContent = String(manualCount);
    element("stat-chars").textContent = String(disclosure.retainedCharacters);
  }

  const unsupported = element<HTMLUListElement>("unsupported");
  unsupported.replaceChildren();
  for (const reason of disclosure?.warnings ?? view?.unsupported ?? []) {
    const li = document.createElement("li");
    li.textContent = reason;
    unsupported.append(li);
  }

  const sanitized = element<HTMLImageElement>("sanitized");
  if (view?.image) {
    if (sanitized.getAttribute("src") !== view.image)
      sanitized.src = view.image;
    sanitized.hidden = false;
  } else {
    sanitized.removeAttribute("src");
    sanitized.hidden = true;
  }
  element("image-stage").hidden = !hasCapture;
  element("sanitized-empty").hidden = hasCapture;
  canvas.dataset.disabled = String(busy || !ready || !hasCapture || !selective);
  for (const id of ["mask-x", "mask-y", "mask-width", "mask-height"])
    element<HTMLInputElement>(id).disabled =
      busy || !ready || !hasCapture || !selective;
  button("add-mask").disabled = busy || !ready || !hasCapture || !selective;
  button("clear-masks").disabled =
    busy || !ready || !view?.privacy.manualMasks.length;
  privateTerms.disabled = busy || !ready;
  button("apply-privacy").disabled = busy || !ready || !hasCapture;

  const masks = element<HTMLUListElement>("manual-masks");
  masks.replaceChildren();
  view?.privacy.manualMasks.forEach((r, index) => {
    const li = document.createElement("li");
    const text = document.createElement("span");
    text.textContent = `Region ${index + 1}: ${Math.round(r.x)}, ${Math.round(r.y)}; ${Math.round(r.width)} × ${Math.round(r.height)} px`;
    li.addEventListener("pointerenter", () => {
      hoveredMaskIndex = index;
      drawSelection();
    });
    li.addEventListener("pointerleave", () => {
      if (hoveredMaskIndex === index) {
        hoveredMaskIndex = -1;
        drawSelection();
      }
    });
    const remove = document.createElement("button");
    remove.className = "quiet";
    remove.type = "button";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove region ${index + 1}`);
    remove.disabled = busy || !ready;
    remove.addEventListener("click", () => {
      hoveredMaskIndex = -1;
      void act(async () => {
        if (!session) throw new SafeError("TASK_PAUSED");
        const next = session
          .view()
          .privacy.manualMasks.filter((_r, i) => i !== index);
        await session.configurePrivacy({ manualMasks: next });
        reviewedId = "";
      }, "Region removed. Review the updated image and text.");
    });
    li.append(text, remove);
    masks.append(li);
  });

  element("sanitized-text").textContent =
    disclosure?.text ||
    (hasCapture
      ? "No page text is disclosed in this capture."
      : "No page text yet.");
  element("structure").textContent = hasCapture
    ? JSON.stringify(
        disclosure?.fields ?? safeFields(view?.fields ?? []),
        null,
        2,
      )
    : "No field structure yet.";

  const previous = target.value;
  target.replaceChildren();
  view?.fields.forEach((field, i) =>
    target.append(
      option(
        `field-${i + 1}`,
        `field-${i + 1}: ${field.kind} / ${field.category}`,
      ),
    ),
  );
  if ([...target.options].some((item) => item.value === previous))
    target.value = previous;

  const hasFields = Boolean(view?.fields && view.fields.length > 0);
  batchSection.hidden =
    !hasCapture || !hasFields || selectedPurpose === "summarize-page";
  batchCount.textContent = `${view?.fields?.length ?? 0} ${view?.fields?.length === 1 ? "field" : "fields"}`;
  batchBtn.disabled = busy || !ready || !hasFields;

  const manualMasks = view?.privacy.manualMasks ?? [];
  const fieldSignature = (view?.fields ?? [])
    .map((f) => {
      const masked = manualMasks.some((m) => rectIntersects(m, f.rect));
      const allowed =
        activeAllowed.includes(f.category) &&
        f.category !== "secret" &&
        ["text", "email", "tel", "textarea", "select"].includes(f.kind);
      return `${f.key}:${masked ? "M" : "U"}:${allowed ? "A" : "L"}`;
    })
    .join(",");

  if (fieldSignature !== lastRenderedFieldKeys) {
    const preserved = new Map<string, { value: string; checked: boolean }>();
    batchFields
      .querySelectorAll<HTMLElement>(".batch-row")
      .forEach((row) => {
        const inp = row.querySelector<
          HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
        >(".batch-input");
        const chk = row.querySelector<HTMLInputElement>(".batch-check");
        if (inp?.dataset.target) {
          preserved.set(inp.dataset.target, {
            value: inp.value,
            checked: chk?.checked ?? true,
          });
        }
      });

    lastRenderedFieldKeys = fieldSignature;
    batchFields.replaceChildren();
    view?.fields.forEach((field, i) => {
      const targetId = `field-${i + 1}`;
      const isMasked = manualMasks.some((m) => rectIntersects(m, field.rect));
      const isPermitted =
        activeAllowed.includes(field.category) &&
        field.category !== "secret" &&
        ["text", "email", "tel", "textarea", "select"].includes(field.kind);
      const locked = isMasked || !isPermitted;

      const row = document.createElement("div");
      row.className = "batch-row";
      row.dataset.locked = String(locked);

      const labelBar = document.createElement("div");
      labelBar.className = "batch-row-label";

      const checkLabel = document.createElement("label");
      checkLabel.className = "batch-row-check";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "batch-check";
      checkbox.dataset.target = targetId;
      checkbox.disabled = locked;
      const old = preserved.get(targetId);
      checkbox.checked = locked ? false : (old?.checked ?? true);

      const title = document.createElement("span");
      title.className = "batch-row-title";
      title.textContent = `${targetId}: ${field.label || "Field"}`;
      checkLabel.append(checkbox, title);

      const kind = document.createElement("span");
      kind.className = "batch-row-kind";
      kind.dataset.locked = String(locked);
      kind.textContent = isMasked
        ? "masked"
        : !isPermitted
          ? `locked · ${field.category}`
          : `${field.kind} · ${field.category}`;

      labelBar.append(checkLabel, kind);

      const input =
        field.kind === "textarea"
          ? document.createElement("textarea")
          : document.createElement("input");
      input.className = "batch-input";
      input.dataset.target = targetId;
      input.placeholder = locked
        ? isMasked
          ? "Region is masked — unmask to fill"
          : `Enable "${field.category}" in Step 1 settings to fill`
        : `Enter test value for ${field.label || targetId}`;
      input.spellcheck = false;
      if (input instanceof HTMLInputElement) input.autocomplete = "off";
      if (input instanceof HTMLTextAreaElement) input.rows = 2;
      input.disabled = locked;

      if (old !== undefined) {
        input.value = old.value;
      } else if (!locked) {
        input.value = sampleValueForField(field);
      }

      row.append(labelBar, input);
      batchFields.append(row);
    });
  }

  target.disabled = busy || !ready || !target.options.length;
  localValue.disabled = target.disabled;
  button("toggle-value-visibility").disabled = target.disabled;
  button("approve").disabled = target.disabled;
  element("insertion-controls").hidden = selectedPurpose === "summarize-page";
  element("grants").textContent = view?.grants.length
    ? `Approved for local use: ${view.grants.map((g) => g.target).join(", ")}.`
    : "No insertion approved.";

  element<HTMLTextAreaElement>("payload").value = view?.payload ?? "";
  button("copy-payload").disabled = !view?.payload;
  element("payload-id").textContent = view?.payloadId
    ? `Payload ${view.payloadId}. ${view.route === "simulator" ? "Simulator only; no network request." : `Reviewed request to local ${view.route === "ollama" ? "Ollama" : "LM Studio"}.`}`
    : "No payload ready.";

  element("payload-summary").hidden = !view?.payloadId;
  if (view?.payloadId) {
    element("pay-fields").textContent = String(
      disclosure?.fields.length ?? view.fields.length,
    );
    element("pay-grants").textContent = String(view.grants.length);
    element("pay-chars").textContent = String(
      disclosure?.retainedCharacters ?? 0,
    );
  }

  button("review").disabled =
    busy || !ready || !view?.payloadId || !!view?.sent;
  button("review").textContent = reviewedId
    ? "Payload reviewed"
    : "I reviewed this payload";
  button("propose").disabled = busy || !ready || !reviewedId || !!view?.sent;
  button("propose").textContent =
    selectedPurpose === "summarize-page"
      ? "Ask for page summary"
      : "Ask for action proposal";
  for (const id of ["export-image", "export-text", "export-receipt"])
    button(id).disabled = busy || !ready || !reviewedId;

  element("proposal").textContent =
    view?.proposal?.type === "insert"
      ? `Proposed: insert the approved local value into ${view.proposal.target}. Not executed yet.`
      : view?.proposal?.type === "batch_insert"
        ? `Proposed: insert approved values into ${view.proposal.insertions.map((ins) => ins.target).join(", ")}. Not executed yet.`
        : view?.proposal?.type === "summary"
          ? `Model summary — verify against the source\n\n${view.proposal.text}`
          : view?.proposal?.type === "stop"
            ? "The model proposed no insertion. No form action was taken."
            : "No action proposed.";
  button("execute").disabled =
    busy ||
    !ready ||
    (view?.proposal?.type !== "insert" &&
      view?.proposal?.type !== "batch_insert");
  button("execute").hidden = selectedPurpose === "summarize-page";

  const receipts = element<HTMLOListElement>("receipts");
  receipts.replaceChildren();
  for (const receipt of view?.receipts ?? []) {
    const li = document.createElement("li");
    li.textContent = `${receipt.time} — ${receipt.event}${receipt.code ? ` (${receipt.code})` : ""}; ${receipt.route}; policy ${receipt.policyVersion}`;
    receipts.append(li);
  }
  const rc = view?.receipts.length ?? 0;
  element("receipt-count").textContent = `${rc} ${rc === 1 ? "event" : "events"}`;

  const hasActions = Boolean(
    reviewedId || view?.grants.length || view?.proposal,
  );
  const hasVerified = Boolean(
    view?.receipts.some((r) => r.event === "verified"),
  );
  updateStepper(hasCapture, hasActions, hasVerified);

  renderOriginal();
  drawSelection();
}

async function act(work: () => Promise<void> | void, success: string) {
  if (busy) return;
  busy = true;
  status("Working locally…");
  render();
  try {
    await work();
    if (session?.view().state === "aborted")
      status("Aborted. Local values and approvals were cleared.");
    else if (session?.view().state === "paused")
      status("Paused. Capture again before continuing.");
    else status(success);
  } catch (error) {
    if (error instanceof SafeError && error.code === "PERMISSION_REQUIRED") {
      element("access-prompt").hidden = false;
    }
    status(
      error instanceof SafeError
        ? (explanations[error.code] ??
            "The operation was blocked. Resume and capture again.")
        : "The operation failed. No raw error details are shown.",
      true,
    );
  } finally {
    busy = false;
    render();
  }
}

function dragRect(): Rect {
  if (!drag) throw new SafeError("INVALID_INPUT");
  return {
    x: Math.min(drag.start.x, drag.end.x),
    y: Math.min(drag.start.y, drag.end.y),
    width: Math.abs(drag.end.x - drag.start.x),
    height: Math.abs(drag.end.y - drag.start.y),
  };
}

function point(event: PointerEvent) {
  const v = session?.view().viewport;
  const r = canvas.getBoundingClientRect();
  if (!v || r.width <= 0 || r.height <= 0) throw new SafeError("INVALID_INPUT");
  return {
    x: Math.max(
      0,
      Math.min(v.width, ((event.clientX - r.left) / r.width) * v.width),
    ),
    y: Math.max(
      0,
      Math.min(v.height, ((event.clientY - r.top) / r.height) * v.height),
    ),
  };
}

async function addMask(rect: Rect) {
  if (!session) throw new SafeError("TASK_PAUSED");
  await session.configurePrivacy({
    manualMasks: [...session.view().privacy.manualMasks, rect],
  });
  reviewedId = "";
}

canvas.addEventListener("pointerdown", (event) => {
  if (busy || canvas.dataset.disabled === "true" || !session) return;
  const p = point(event);
  drag = { start: p, end: p, artifact: session.view().artifactId };
  canvas.setPointerCapture(event.pointerId);
  drawSelection();
});
canvas.addEventListener("pointermove", (event) => {
  if (!drag) return;
  drag.end = point(event);
  drawSelection();
});
canvas.addEventListener("pointerup", (event) => {
  if (!drag) return;
  drag.end = point(event);
  const rect = dragRect();
  const artifact = drag.artifact;
  drag = undefined;
  if (canvas.hasPointerCapture(event.pointerId))
    canvas.releasePointerCapture(event.pointerId);
  drawSelection();
  if (rect.width < 2 || rect.height < 2) return;
  void act(async () => {
    if (session?.view().artifactId !== artifact)
      throw new SafeError("STALE_CAPTURE");
    await addMask(rect);
  }, "Region masked in the actual image and text. Review this new version.");
});
canvas.addEventListener("pointercancel", () => {
  drag = undefined;
  drawSelection();
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && drag) {
    drag = undefined;
    drawSelection();
  }
});

element<HTMLImageElement>("sanitized").addEventListener("load", drawSelection);
button("add-mask").addEventListener("click", () => {
  void act(async () => {
    await addMask({
      x: Number(element<HTMLInputElement>("mask-x").value),
      y: Number(element<HTMLInputElement>("mask-y").value),
      width: Number(element<HTMLInputElement>("mask-width").value),
      height: Number(element<HTMLInputElement>("mask-height").value),
    });
  }, "Region masked. Review this new version.");
});
button("clear-masks").addEventListener("click", () => {
  hoveredMaskIndex = -1;
  void act(async () => {
    if (!session) throw new SafeError("TASK_PAUSED");
    await session.configurePrivacy({ manualMasks: [] });
    reviewedId = "";
  }, "Drawn regions cleared. Automatic masks remain. Review again.");
});
button("apply-privacy").addEventListener("click", () => {
  void act(async () => {
    if (!session) throw new SafeError("TASK_PAUSED");
    await session.configurePrivacy({
      privateTerms: privateTerms.value
        .split("\n")
        .map((t) => t.trim())
        .filter(Boolean),
    });
    reviewedId = "";
    localValue.value = "";
  }, "Protected phrases applied locally. Review the updated image and text.");
});
button("refresh-tabs").addEventListener("click", () => {
  void act(refreshTabs, "Tab list refreshed.");
});

button("grant-access").addEventListener("click", () => {
  void act(async () => {
    if (!chrome.permissions?.request) throw new SafeError("UNSUPPORTED");
    const granted = await chrome.permissions.request({
      origins: ["<all_urls>"],
    });
    if (!granted) throw new SafeError("POLICY_DENIED");
    if (session?.view().state === "paused") session.resume();
    await refreshTabs();
  }, "Site access granted. Click Capture & Protect Page to continue.");
});

for (const control of [tab, profile, purpose, route, ocr]) {
  control.addEventListener("change", () => render());
}
element("categories").addEventListener("change", () => render());

route.addEventListener("change", () => {
  element("route-check-status").hidden = true;
  element("model-suggestions").replaceChildren();
  if (route.value === "lmstudio") model.value = "";
  else if (route.value === "ollama") model.value = "qwen3:0.6b";
  routeHint();
});

button("check-route").addEventListener("click", async () => {
  const statusEl = element("route-check-status");
  const suggestions = element<HTMLDataListElement>("model-suggestions");
  if (route.value === "simulator") return;
  statusEl.hidden = false;
  statusEl.dataset.ok = "";
  statusEl.textContent = "Checking local endpoint…";
  try {
    const endpoint =
      route.value === "ollama"
        ? "http://127.0.0.1:11434/api/tags"
        : "http://127.0.0.1:1234/v1/models";
    const res = await fetch(endpoint, {
      signal: AbortSignal.timeout(4000),
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!res.ok) throw new Error();
    const data = (await res.json()) as {
      models?: { name?: string }[];
      data?: { id?: string }[];
    };
    const names =
      route.value === "ollama"
        ? (data.models ?? []).map((m) => m.name).filter((n): n is string => Boolean(n))
        : (data.data ?? []).map((m) => m.id).filter((n): n is string => Boolean(n));
    suggestions.replaceChildren();
    for (const name of names) {
      const opt = document.createElement("option");
      opt.value = name;
      suggestions.append(opt);
    }
    if (!model.value.trim() && names[0]) model.value = names[0];
    statusEl.dataset.ok = "true";
    statusEl.textContent = names.length
      ? `Connected. Found ${names.length} local ${names.length === 1 ? "model" : "models"} (${names.slice(0, 3).join(", ")}).`
      : "Connected, but no loaded models were reported.";
  } catch {
    statusEl.dataset.ok = "false";
    statusEl.textContent = `Could not reach ${route.value === "ollama" ? "Ollama on 127.0.0.1:11434" : "LM Studio on 127.0.0.1:1234"}. Start the local server first.`;
  }
});

function startTask() {
  const id = Number(tab.value);
  if (
    !Number.isInteger(id) ||
    !tab.value ||
    !["simulator", "ollama", "lmstudio"].includes(route.value) ||
    !["strict", "reviewed"].includes(profile.value) ||
    !["fill-approved-fields", "summarize-page"].includes(purpose.value)
  )
    throw new SafeError("INVALID_INPUT");
  if (route.value !== "simulator" && !model.value.trim()) {
    status("Enter the name of the model loaded in your local server.", true);
    throw new SafeError("INVALID_INPUT");
  }
  session?.abort();
  browser?.dispose();
  localValue.value = "";
  privateTerms.value = "";
  originalDetails.open = false;
  reviewedId = "";
  lastRenderedFieldKeys = "";
  hoveredMaskIndex = -1;
  drag = undefined;
  selectedTabId = id;
  selectedPurpose = purpose.value as typeof selectedPurpose;
  const allowed = Array.from(
    document.querySelectorAll<HTMLInputElement>("#categories input:checked"),
  ).map((input) => input.value as Category);
  activeAllowed = allowed;
  activeConfigSnapshot = currentConfigSnapshot();
  browser = new ChromeBrowser();
  session = new Session(
    browser,
    id,
    route.value as Route,
    allowed,
    undefined,
    undefined,
    {
      profile: profile.value as "strict" | "reviewed",
      ocr: profile.value === "reviewed" && ocr.checked,
      purpose: selectedPurpose,
      model: model.value.trim() || undefined,
    },
  );
}

button("start").addEventListener("click", () => {
  if (route.value !== "simulator" && !model.value.trim()) {
    status("Enter the name of the model loaded in your local server.", true);
    model.focus();
    return;
  }
  void act(startTask, "Task ready. Keep the selected tab active, then capture it.");
});

button("capture").addEventListener("click", () => {
  void act(async () => {
    if (!session) throw new SafeError("TASK_PAUSED");
    reviewedId = "";
    localValue.value = "";
    hoveredMaskIndex = -1;
    drag = undefined;
    await session.capture(
      exclusions.value
        .split("\n")
        .map((v) => v.trim())
        .filter(Boolean),
    );
  }, "Capture ready. Check the sanitized image and text, then add any missing masks.");
});

button("toggle-value-visibility").addEventListener("click", () => {
  const show = localValue.type === "password";
  localValue.type = show ? "text" : "password";
  button("toggle-value-visibility").setAttribute(
    "aria-label",
    show ? "Hide value" : "Show value",
  );
});

localValue.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !button("approve").disabled) {
    event.preventDefault();
    button("approve").click();
  }
});

button("approve").addEventListener("click", () => {
  void act(async () => {
    const value = localValue.value;
    localValue.value = "";
    if (!session) throw new SafeError("TASK_PAUSED");
    await session.approve(target.value, value);
    reviewedId = "";
  }, "One local insertion approved. Review the new payload before requesting a proposal.");
});

button("batch-fill-sample").addEventListener("click", () => {
  const view = session?.view();
  if (!view) return;
  batchFields.querySelectorAll<HTMLElement>(".batch-row").forEach((row, i) => {
    const inp = row.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      ".batch-input",
    );
    const chk = row.querySelector<HTMLInputElement>(".batch-check");
    const field = view.fields[i];
    if (inp && !inp.disabled && field) {
      inp.value = sampleValueForField(field);
      if (chk && !chk.disabled) chk.checked = true;
    }
  });
});

button("batch-clear").addEventListener("click", () => {
  batchFields
    .querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(".batch-input")
    .forEach((inp) => {
      if (!inp.disabled) inp.value = "";
    });
});

batchBtn.addEventListener("click", () => {
  void act(async () => {
    if (!session) throw new SafeError("TASK_PAUSED");
    const entries: { target: string; value: string }[] = [];
    batchFields.querySelectorAll<HTMLElement>(".batch-row").forEach((row) => {
      const chk = row.querySelector<HTMLInputElement>(".batch-check");
      const inp = row.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        ".batch-input",
      );
      if (!chk?.checked || !inp || inp.disabled) return;
      const val = inp.value.trim();
      if (val && inp.dataset.target) {
        entries.push({ target: inp.dataset.target, value: val });
      }
    });
    if (entries.length === 0) throw new SafeError("INVALID_INPUT");
    await session.approveBatch(entries);
    const id = session.view().payloadId;
    if (!id) throw new SafeError("INVALID_ARTIFACT");
    session.review(id);
    reviewedId = id;
    await session.propose();
    await session.execute();
  }, "Autofill verified locally. All approved fields populated without submitting form.");
});

button("copy-payload").addEventListener("click", async () => {
  const text = element<HTMLTextAreaElement>("payload").value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    const btn = button("copy-payload");
    btn.textContent = "Copied";
    clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(() => {
      btn.textContent = "Copy JSON";
    }, 1600);
  } catch {
    status("Clipboard write blocked. Copy from the payload box manually.", true);
  }
});

button("review").addEventListener("click", () => {
  void act(() => {
    const id = session?.view().payloadId;
    if (!session || !id) throw new SafeError("INVALID_ARTIFACT");
    session.review(id);
    reviewedId = id;
  }, "This version is reviewed. You may save its sanitized files or request a model reply.");
});

button("propose").addEventListener("click", () => {
  void act(async () => {
    if (!session) throw new SafeError("TASK_PAUSED");
    await session.propose();
  }, "Model reply received. Check it before taking any action.");
});

button("execute").addEventListener("click", () => {
  void act(async () => {
    if (!session) throw new SafeError("TASK_PAUSED");
    await session.execute();
  }, "Insertion verified locally. A fresh sanitized capture is ready. No form was submitted.");
});

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

for (const kind of ["image", "text", "receipt"] as const)
  button(`export-${kind}`).addEventListener("click", () => {
    void act(async () => {
      if (!session || !reviewedId) throw new SafeError("INVALID_ARTIFACT");
      const artifacts = await session.exportArtifacts(reviewedId);
      if (kind === "image") {
        if (!artifacts.image.startsWith("data:image/png;base64,"))
          throw new SafeError("INVALID_ARTIFACT");
        const bytes = Uint8Array.from(
          atob(artifacts.image.split(",")[1]),
          (c) => c.charCodeAt(0),
        );
        save(new Blob([bytes], { type: "image/png" }), "ghostmask-masked.png");
      } else if (kind === "text")
        save(
          new Blob([artifacts.text], { type: "text/plain;charset=utf-8" }),
          "ghostmask-masked.txt",
        );
      else
        save(
          new Blob([artifacts.receipt], { type: "application/json" }),
          "ghostmask-receipt.json",
        );
    }, "Sanitized file prepared for download. Original content was not exported.");
  });

button("pause").addEventListener("click", () => {
  session?.pause();
  localValue.value = "";
  reviewedId = "";
  hoveredMaskIndex = -1;
  drag = undefined;
  status("Paused. Local approvals were cleared.");
  render();
});

button("resume").addEventListener("click", () => {
  void act(() => {
    session?.resume();
    reviewedId = "";
  }, "Resumed. Capture again and approve a fresh value.");
});

button("abort").addEventListener("click", () => {
  session?.abort();
  browser?.dispose();
  localValue.value = "";
  privateTerms.value = "";
  originalDetails.open = false;
  reviewedId = "";
  lastRenderedFieldKeys = "";
  hoveredMaskIndex = -1;
  drag = undefined;
  status("Aborted. Local values, screenshots, and approvals were cleared.");
  render();
});

button("clear").addEventListener("click", () => {
  session?.clearReceipts();
  render();
  status("Receipts cleared from this panel.");
});

originalDetails.addEventListener("toggle", renderOriginal);
window.addEventListener("pagehide", () => {
  session?.abort();
  browser?.dispose();
  localValue.value = "";
  privateTerms.value = "";
});

const syncTabs = () => {
  if (!busy) void refreshTabs().catch(() => {});
};
chrome.tabs?.onActivated?.addListener(syncTabs);
chrome.tabs?.onRemoved?.addListener(syncTabs);
chrome.tabs?.onUpdated?.addListener((_id, info) => {
  if (info.url || info.status === "complete") syncTabs();
});

void refreshTabs().catch(() => {
  status(
    "Could not read tabs. Open GhostMask with its toolbar button on a supported page.",
    true,
  );
  render();
});
