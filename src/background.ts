// No raw observations or tokens live in the restartable service worker.
if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
}

// Fallback action click handler: guarantees GhostMask opens in Brave and Chromium variants
chrome.action?.onClicked?.addListener(async (tab) => {
  if (chrome.sidePanel?.open && tab.windowId) {
    try {
      await chrome.sidePanel.open({ windowId: tab.windowId });
      return;
    } catch {
      // Fall through to window popup
    }
  }

  try {
    await chrome.windows.create({
      url: "panel.html",
      type: "popup",
      width: 440,
      height: 820,
    });
  } catch {}
});

