const DEFAULTS = { overlay: true, sound: true, desktop: true };

chrome.storage.sync.get(DEFAULTS, (s) => {
  for (const key of Object.keys(DEFAULTS)) {
    const box = document.getElementById(key);
    box.checked = s[key];
    box.addEventListener("change", () => chrome.storage.sync.set({ [key]: box.checked }));
  }
});

chrome.storage.local.get({ unread: 0, lastNotification: null }, ({ unread, lastNotification }) => {
  document.getElementById("count").textContent = unread;
  if (lastNotification) {
    const when = new Date(lastNotification.at).toLocaleTimeString();
    document.getElementById("last").textContent =
      `${lastNotification.title}${lastNotification.body ? " — " + lastNotification.body : ""} (${when})`;
  }
});

document.getElementById("test").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && /fiverr\.com/.test(tab.url || "")) {
    chrome.tabs.sendMessage(tab.id, { type: "test" });
  } else {
    document.getElementById("last").textContent = "Open a fiverr.com tab to test.";
  }
});

document.getElementById("clear").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "clear" });
  document.getElementById("count").textContent = "0";
});
