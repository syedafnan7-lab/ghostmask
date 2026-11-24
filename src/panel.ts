import { Session } from "./session.ts";
import { ChromeBrowser } from "./browser.ts";
import {
  SafeError,
  type Category,
  type SafeErrorCode,
  type Rect,
} from "./contracts.ts";
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
let session: Session | undefined;
let browser: ChromeBrowser | undefined;
let busy = false;
let reviewedId = "";
let selectedTabId: number | undefined;
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
    "This page is outside the supported scope. Try a simple English HTML page or the strict mode.",
  INVALID_INPUT:
    "Check the entries. Mask boxes must fit inside the captured page; CSS selectors must be valid.",
};
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
  if (drag && drag.artifact === view.artifactId) {
    const r = dragRect();
    ctx.strokeStyle = "#a63745";
    ctx.fillStyle = "rgba(166,55,69,.2)";
    ctx.lineWidth = Math.max(
      2,
      (canvas.width / Math.max(1, canvas.getBoundingClientRect().width)) * 2,
    );
    ctx.fillRect(r.x, r.y, r.width, r.height);
    ctx.strokeRect(r.x, r.y, r.width, r.height);
  }
}
function render() {
  const view = session?.view();
  const ready = view?.state === "ready";
  const hasCapture = Boolean(view?.image);
  const selective = view?.privacy.profile === "reviewed";
  if (reviewedId !== view?.payloadId) reviewedId = "";
  if (drag && drag.artifact !== view?.artifactId) drag = undefined;
  element("state").textContent = view?.state ?? "No task";
  button("start").disabled = busy || !tab.value;
  button("refresh-tabs").disabled = busy;
  tab.disabled = busy;
  route.disabled = busy;
  profile.disabled = busy;
  purpose.disabled = busy;
  ocr.disabled = busy || profile.value === "strict";
  routeHint();
  element<HTMLFieldSetElement>("categories").disabled = busy;
  exclusions.disabled = busy || !ready;
  button("capture").disabled = busy || !ready;
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
    const remove = document.createElement("button");
    remove.className = "quiet";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove region ${index + 1}`);
    remove.disabled = busy || !ready;
    remove.addEventListener("click", () => {
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
  target.disabled = busy || !ready || !target.options.length;
  localValue.disabled = target.disabled;
  button("approve").disabled = target.disabled;
  element("insertion-controls").hidden = selectedPurpose === "summarize-page";
  element("grants").textContent = view?.grants.length
    ? `Approved for one local use: ${view.grants.map((g) => g.target).join(", ")}.`
    : "No insertion approved.";
  element<HTMLTextAreaElement>("payload").value = view?.payload ?? "";
  element("payload-id").textContent = view?.payloadId
    ? `Payload ${view.payloadId}. ${view.route === "simulator" ? "Simulator only; no network request." : `Reviewed request to local ${view.route === "ollama" ? "Ollama" : "LM Studio"}.`}`
    : "No payload ready.";
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
      : view?.proposal?.type === "summary"
        ? `Model summary — verify against the source\n\n${view.proposal.text}`
        : view?.proposal?.type === "stop"
          ? "The model proposed no insertion. No form action was taken."
          : "No action proposed.";
  button("execute").disabled =
    busy || !ready || view?.proposal?.type !== "insert";
  button("execute").hidden = selectedPurpose === "summarize-page";
  const receipts = element<HTMLOListElement>("receipts");
  receipts.replaceChildren();
  for (const receipt of view?.receipts ?? []) {
    const li = document.createElement("li");
    li.textContent = `${receipt.time} — ${receipt.event}${receipt.code ? ` (${receipt.code})` : ""}; ${receipt.route}; policy ${receipt.policyVersion}`;
    receipts.append(li);
  }
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
route.addEventListener("change", () => {
  if (route.value === "lmstudio") model.value = "";
  else if (route.value === "ollama") model.value = "qwen3:0.6b";
  routeHint();
});
profile.addEventListener("change", () => {
  ocr.disabled = busy || profile.value === "strict";
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
  drag = undefined;
  selectedTabId = id;
  selectedPurpose = purpose.value as typeof selectedPurpose;
  const allowed = Array.from(
    document.querySelectorAll<HTMLInputElement>("#categories input:checked"),
  ).map((input) => input.value as Category);
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
    drag = undefined;
    await session.capture(
      exclusions.value
        .split("\n")
        .map((v) => v.trim())
        .filter(Boolean),
    );
  }, "Capture ready. Check the sanitized image and text, then add any missing masks.");
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
void refreshTabs().catch(() => {
  status(
    "Could not read tabs. Open GhostMask with its toolbar button on a supported page.",
    true,
  );
  render();
});
