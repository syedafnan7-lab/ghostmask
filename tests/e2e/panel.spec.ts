import { test, expect, chromium } from "@playwright/test";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
test("panel controls operate the simulator, verify insertion, pause and clear", async () => {
  const ext = resolve("output/test-extension");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  try {
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent("serviceworker");
    const id = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto("http://127.0.0.1:4173");
    const opened = context.waitForEvent("page");
    await worker.evaluate(async (url) => {
      await chrome.windows.create({
        url,
        type: "popup",
        width: 450,
        height: 900,
      });
    }, `chrome-extension://${id}/panel.html`);
    const panel = await opened;
    await panel.setViewportSize({ width: 390, height: 844 });
    await expect(panel.locator("#start")).toBeEnabled();
    await panel.locator("#profile").selectOption("strict");
    await panel.locator("#start").click();
    await page.bringToFront();
    await panel.locator("#capture").dispatchEvent("click");
    await expect(panel.locator("#status")).toContainText("Capture ready");
    await expect(panel.locator("#original")).toBeHidden();
    await expect(panel.locator("#target option")).toHaveCount(3);
    await panel.locator("#target").selectOption("field-2");
    await panel.locator("#value").fill("panel@example.test");
    await panel.locator("#approve").click();
    await expect(panel.locator("#value")).toHaveValue("");
    expect(await panel.locator("#payload").inputValue()).not.toContain(
      "panel@example.test",
    );
    await panel.locator("#review").click();
    await panel.locator("#propose").click();
    await expect(panel.locator("#proposal")).toContainText("Not executed yet");
    await page.bringToFront();
    await panel.locator("#execute").dispatchEvent("click");
    await expect(panel.locator("#status")).toContainText(
      "Insertion verified locally",
    );
    await expect(page.locator("[name=email]")).toHaveValue(
      "panel@example.test",
    );
    await panel.locator("#pause").click();
    await expect(panel.locator("#state")).toHaveText("paused");
    await panel.locator("#resume").click();
    await expect(panel.locator("#capture")).toBeEnabled();
    await panel.locator("#abort").click();
    await expect(panel.locator("#state")).toHaveText("aborted");
    await expect(panel.locator("#payload")).toHaveValue("");
    await panel.locator("#clear").click();
    await expect(panel.locator("#receipts li")).toHaveCount(0);
    await mkdir("output/playwright", { recursive: true });
    await panel.screenshot({
      path: "output/playwright/panel.png",
      fullPage: true,
    });
    expect(
      await panel.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
  } finally {
    await context.close();
  }
});

test('selective panel applies private phrases and downloads the reviewed text',async()=>{
 const ext=resolve('output/test-extension');const context=await chromium.launchPersistentContext('',{channel:'chromium',headless:true,acceptDownloads:true,args:[`--disable-extensions-except=${ext}`,`--load-extension=${ext}`]});
 try{
 const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');const id=new URL(worker.url()).host;
 const page=await context.newPage();await page.goto('http://127.0.0.1:4173');await page.evaluate(()=>{document.body.innerHTML='<h1>Public policy</h1><p>Returns accepted within 14 days.</p><p>contact@example.test</p>';});
 const opened=context.waitForEvent('page');await worker.evaluate(async url=>{await chrome.windows.create({url,type:'popup',width:800,height:1000});},`chrome-extension://${id}/panel.html`);const panel=await opened;
 await panel.locator('#purpose').selectOption('summarize-page');await panel.locator('#start').click();await page.bringToFront();await panel.locator('#capture').dispatchEvent('click');await expect(panel.locator('#status')).toContainText('Capture ready');
 await panel.getByText('Protect extra phrases — kept local',{exact:true}).click();await panel.locator('#private-terms').fill('14 days');await panel.locator('#apply-privacy').click();await expect(panel.locator('#review')).toBeEnabled();
 expect(await panel.locator('#payload').inputValue()).not.toContain('14 days');await panel.locator('#review').click();
 const download=panel.waitForEvent('download',{timeout:10000});await panel.locator('#export-text').click();const file=await download;expect(file.suggestedFilename()).toBe('ghostmask-masked.txt');
 await panel.screenshot({path:'output/playwright/reviewed-panel.png',fullPage:true});
 }finally{await context.close();}
});

test("panel batch autofill inserts multiple permitted fields atomically via ChromeBrowser", async () => {
  const ext = resolve("output/test-extension");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    const id = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto("http://127.0.0.1:4173");
    const opened = context.waitForEvent("page");
    await worker.evaluate(async (url) => {
      await chrome.windows.create({
        url,
        type: "popup",
        width: 450,
        height: 900,
      });
    }, `chrome-extension://${id}/panel.html`);
    const panel = await opened;
    await panel.setViewportSize({ width: 390, height: 844 });
    await panel.locator("#profile").selectOption("strict");
    await panel.locator("#start").click();
    await page.bringToFront();
    await panel.locator("#capture").dispatchEvent("click");
    await expect(panel.locator("#status")).toContainText("Capture ready");
    await expect(panel.locator("#batch-autofill-section")).toBeVisible();
    await expect(panel.locator(".batch-check[data-target='field-1']")).toBeChecked();
    await expect(panel.locator(".batch-check[data-target='field-2']")).toBeChecked();
    await expect(panel.locator(".batch-check[data-target='field-3']")).toBeDisabled();
    await panel.locator(".batch-input[data-target='field-1']").fill("Alex Synthetic");
    await panel.locator(".batch-input[data-target='field-2']").fill("batch@example.test");
    await page.bringToFront();
    await panel.locator("#batch-autofill-btn").dispatchEvent("click");
    await expect(panel.locator("#status")).toContainText("Autofill verified locally");
    await expect(page.locator("[name=contactName]")).toHaveValue("Alex Synthetic");
    await expect(page.locator("[name=email]")).toHaveValue("batch@example.test");
    expect(
      await panel.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
  } finally {
    await context.close();
  }
});
