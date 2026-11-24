// Keeps the toolbar badge in sync and raises desktop notifications
// when the Fiverr tab isn't visible.
let unread = 0;

function updateBadge() {
  chrome.action.setBadgeBackgroundColor({ color: "#1dbf73" });
  chrome.action.setBadgeText({ text: unread > 0 ? String(unread > 99 ? "99+" : unread) : "" });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "notify") {
    unread = msg.count ? Math.max(unread + 1, msg.count) : unread + 1;
    updateBadge();
    chrome.storage.local.set({
      lastNotification: { title: msg.title, body: msg.body, at: Date.now() },
      unread,
    });

    if (msg.desktop) {
      chrome.notifications.create(`fnr-${Date.now()}`, {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: msg.title || "Fiverr",
        message: msg.body || "You have new activity on Fiverr",
        priority: 2,
        requireInteraction: true,
      });
    }
  } else if (msg.type === "clear") {
    unread = 0;
    updateBadge();
    chrome.storage.local.set({ unread });
  }
});

// Clicking a desktop notification focuses the Fiverr tab
chrome.notifications.onClicked.addListener(async (id) => {
  chrome.notifications.clear(id);
  const tabs = await chrome.tabs.query({ url: "*://*.fiverr.com/*" });
  const tab = tabs[0];
  if (tab) {
    chrome.tabs.update(tab.id, { active: true });
    chrome.windows.update(tab.windowId, { focused: true });
  }
});
