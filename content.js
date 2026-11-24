// Detects new Fiverr notifications and shows an on-screen indicator.
// Detection sources:
//   1. Fiverr's in-page toast (bottom-right popup)
//   2. Red dot / count on the header bell & inbox icons
//   3. "Unread (N)" chip on the dashboard / inbox
(() => {
  const DEFAULTS = { overlay: true, sound: true, desktop: true };
  let settings = { ...DEFAULTS };

  chrome.storage.sync.get(DEFAULTS, (s) => (settings = s));
  chrome.storage.onChanged.addListener((changes) => {
    for (const [k, { newValue }] of Object.entries(changes)) settings[k] = newValue;
  });

  // ---------- Indicator UI ----------
  // Rendered inside a closed shadow root on a randomly named host element,
  // so the page has no fixed IDs/classes to look for and can't reach inside.
  const STYLE = `
    :host { all: initial; }
    .pill {
      position: fixed; top: 20px; right: 20px; z-index: 2147483647;
      display: flex; align-items: center; gap: 12px; max-width: 360px;
      padding: 14px 16px; border-radius: 14px; background: #1dbf73; color: #fff;
      font: 14px/1.35 -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
      box-shadow: 0 10px 30px rgba(0,0,0,.25); cursor: pointer;
      transform: translateX(130%); transition: transform .35s cubic-bezier(.2,.9,.3,1.2);
    }
    .pill.show { transform: translateX(0); animation: shake .6s ease .35s 2; }
    .dot { flex: none; width: 12px; height: 12px; border-radius: 50%; background: #fff;
      animation: pulse 1.2s ease-in-out infinite; }
    .text { display: flex; flex-direction: column; min-width: 0; }
    .title { font-weight: 700; }
    .body { opacity: .9; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .body:empty { display: none; }
    .close { flex: none; margin-left: 4px; border: 0; padding: 0; width: 24px; height: 24px;
      border-radius: 50%; background: rgba(255,255,255,.2); color: #fff;
      font-size: 16px; line-height: 24px; cursor: pointer; }
    .close:hover { background: rgba(255,255,255,.35); }
    .glow { position: fixed; inset: 0; z-index: 2147483646; pointer-events: none;
      opacity: 0; transition: opacity .4s ease; }
    .glow.show { opacity: 1; animation: glow 1s ease-in-out infinite; }
    @keyframes pulse { 0%,100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.5); opacity: .5; } }
    @keyframes glow { 0%,100% { box-shadow: inset 0 0 0 4px rgba(29,191,115,.9); }
      50% { box-shadow: inset 0 0 40px 8px rgba(29,191,115,.5); } }
    @keyframes shake { 0%,100% { transform: translateX(0); } 25% { transform: translateX(-6px); } 75% { transform: translateX(6px); } }
  `;

  let pill, glow, hideTimer;

  function ensureUI() {
    if (pill) return;
    const tag = "x-" + Math.random().toString(36).slice(2, 10);
    const host = document.createElement(tag);
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML =
      `<style>${STYLE}</style><div class="glow"></div>` +
      '<div class="pill"><span class="dot"></span><div class="text"><strong class="title"></strong>' +
      '<span class="body"></span></div><button class="close" title="Dismiss">&times;</button></div>';
    glow = root.querySelector(".glow");
    pill = root.querySelector(".pill");
    pill.querySelector(".close").addEventListener("click", (e) => {
      e.stopPropagation();
      dismiss();
    });
    pill.addEventListener("click", () => {
      const target = findHeaderTarget();
      if (target) target.click();
      dismiss();
    });
    document.documentElement.append(host);
  }

  function showIndicator(title, body) {
    if (!settings.overlay) return;
    ensureUI();
    pill.querySelector(".title").textContent = title;
    pill.querySelector(".body").textContent = body || "";
    pill.classList.add("show");
    glow.classList.add("show");
    clearTimeout(hideTimer);
    // Glow fades after a few seconds; pill stays until dismissed.
    hideTimer = setTimeout(() => glow.classList.remove("show"), 6000);
  }

  function dismiss() {
    pill && pill.classList.remove("show");
    glow && glow.classList.remove("show");
    chrome.runtime.sendMessage({ type: "clear" }).catch(() => {});
  }

  function beep() {
    if (!settings.sound) return;
    try {
      const ctx = new AudioContext();
      const play = (freq, start) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "sine";
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, ctx.currentTime + start);
        g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + start + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + 0.25);
        o.connect(g).connect(ctx.destination);
        o.start(ctx.currentTime + start);
        o.stop(ctx.currentTime + start + 0.3);
      };
      play(880, 0);
      play(1320, 0.18);
      setTimeout(() => ctx.close(), 800);
    } catch (_) {}
  }

  // ---------- Alert dispatch ----------
  // One incoming message can trip several detectors (toast, dot, unread chip).
  // Alerts within this window merge: no extra sound, richer text wins.
  const MERGE_MS = 4000;
  let lastAlertAt = 0, lastPriority = -1;
  function alertUser(title, body, count, priority = 0) {
    const now = Date.now();
    if (now - lastAlertAt < MERGE_MS) {
      if (priority >= lastPriority) {
        showIndicator(title, body);
        lastPriority = priority;
      }
      return;
    }
    lastAlertAt = now;
    lastPriority = priority;

    showIndicator(title, body);
    beep();
    chrome.runtime
      .sendMessage({ type: "notify", title, body, count, desktop: settings.desktop && document.hidden })
      .catch(() => {});
  }

  // ---------- Source 1: Fiverr's in-page toast ----------
  //   <div class="item-content-wrapper"><p class="content">
  //     <strong class="display-name">..</strong><span class="username">@jennifer_ne</span>
  //     whats up</p></div>
  const TOAST_SELECTOR = ".item-content-wrapper";
  const seenToasts = new WeakSet();

  function isFloating(el) {
    // Toasts live in a fixed-position layer; the bell dropdown lives in the header.
    if (el.closest("header")) return false;
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (getComputedStyle(n).position === "fixed") return true;
    }
    return false;
  }

  function readToast(wrapper) {
    const sender = (wrapper.querySelector(".username")?.textContent || "").trim().replace(/^@/, "");
    const name = (wrapper.querySelector(".display-name")?.textContent || "").trim();
    let text = (wrapper.textContent || "").replace(/\s+/g, " ").trim();
    for (const part of [name, "@" + sender, sender]) if (part) text = text.replace(part, "").trim();
    return { sender: sender || name, text };
  }

  function checkAddedNodes(mutations) {
    const found = [];
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches(TOAST_SELECTOR)) found.push(node);
        found.push(...node.querySelectorAll(TOAST_SELECTOR));
      }
    }
    // A big batch means a list was rendered (e.g. bell dropdown), not a toast.
    if (found.length === 0 || found.length > 3) return;
    for (const w of found) {
      if (seenToasts.has(w) || !isFloating(w)) continue;
      seenToasts.add(w);
      const { sender, text } = readToast(w);
      alertUser(sender ? `New message from ${sender}` : "New Fiverr message", text, undefined, 2);
    }
  }

  // ---------- Source 2: header bell / inbox icons ----------
  // Fiverr shows a small red dot, sometimes a number. Track each icon's "has unread" state.
  function iconLabel(host) {
    const hint = (
      (host.getAttribute("aria-label") || "") + " " +
      (host.getAttribute("href") || "") + " " +
      (host.getAttribute("title") || "") + " " +
      (typeof host.className === "string" ? host.className : "")
    ).toLowerCase();
    if (hint.includes("inbox") || hint.includes("message")) return "New message";
    if (hint.includes("order")) return "Order update";
    if (hint.includes("notification") || hint.includes("bell")) return "New notification";
    return null;
  }

  function isReddish(color) {
    const m = color && color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/);
    if (!m) return false;
    const [r, g, b, a] = [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
    return a > 0.5 && r > 170 && g < 140 && r - g > 80 && r - b > 20;
  }

  function hasDot(host) {
    const candidates = [host, ...host.querySelectorAll("*")].slice(0, 30);
    for (const el of candidates) {
      if (el instanceof SVGElement) continue;
      for (const pseudo of [null, "::before", "::after"]) {
        const cs = getComputedStyle(el, pseudo);
        if (pseudo && (cs.content === "none" || cs.content === "normal")) continue;
        if (!isReddish(cs.backgroundColor)) continue;
        const w = parseFloat(cs.width), h = parseFloat(cs.height);
        if (w > 0 && w <= 24 && h > 0 && h <= 24) return true;
      }
    }
    return false;
  }

  function readHeaderIcons() {
    const state = new Map();
    const header = document.querySelector("header") || document.body;
    for (const host of header.querySelectorAll("a, button")) {
      if (!host.querySelector("svg")) continue;
      const label = iconLabel(host);
      if (!label) continue;
      const num = parseInt((host.textContent || "").replace(/\D/g, ""), 10) || 0;
      const lit = num > 0 || hasDot(host);
      const prev = state.get(label) || { lit: false, num: 0 };
      state.set(label, { lit: prev.lit || lit, num: Math.max(prev.num, num) });
    }
    return state;
  }

  let lastIcons = readHeaderIcons();
  function checkHeaderIcons() {
    const now = readHeaderIcons();
    let anyLit = false;
    for (const [label, { lit, num }] of now) {
      anyLit = anyLit || lit;
      const prev = lastIcons.get(label) || { lit: false, num: 0 };
      if ((lit && !prev.lit) || num > prev.num) alertUser(label, num ? `${num} unread` : "");
    }
    const wasLit = [...lastIcons.values()].some((v) => v.lit);
    if (wasLit && !anyLit) chrome.runtime.sendMessage({ type: "clear" }).catch(() => {});
    lastIcons = now;
  }

  // ---------- Source 3: "Unread (44)" chip ----------
  function unreadChipCount() {
    const r = document.evaluate(
      "//*[not(*) and starts-with(normalize-space(.), 'Unread (')]",
      document.body, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
    ).singleNodeValue;
    const m = r && r.textContent.match(/\((\d+)\)/);
    return m ? parseInt(m[1], 10) : null;
  }
  let lastUnread = unreadChipCount();
  function checkUnreadChip() {
    const n = unreadChipCount();
    if (n !== null && lastUnread !== null && n > lastUnread) {
      alertUser("New message", `${n} unread conversations`, n);
    }
    if (n !== null) lastUnread = n;
  }

  function findHeaderTarget() {
    return (
      document.querySelector("header a[href*='inbox']") ||
      document.querySelector("header [aria-label*='otification' i]") ||
      null
    );
  }

  // ---------- Watchers ----------
  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      checkHeaderIcons();
      checkUnreadChip();
    }, 100);
  };

  new MutationObserver((mutations) => {
    checkAddedNodes(mutations); // toasts: handled immediately, no throttle
    schedule();
  }).observe(document.body, { childList: true, characterData: true, subtree: true });

  // Dots often appear via a class/style change only, so also watch header attributes
  const header = document.querySelector("header");
  if (header) new MutationObserver(schedule).observe(header, { attributes: true, subtree: true });
  setInterval(schedule, 3000); // safety net

  // Popup "Test" button
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "test") alertUser("Test notification", "This is how alerts will look");
  });
})();
