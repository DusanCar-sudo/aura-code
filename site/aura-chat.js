/*
 * aura-chat.js — "Ask Aura" on any of our websites.
 *
 *   <script src="aura-kb.js"></script>
 *   <script src="aura-chat.js" data-product="Aura Code" defer></script>
 *
 * Free for us to run: the AI goes through Puter (puter.com), user-pays —
 * each visitor signs in to Puter once and their own account covers the
 * chat. No API key lives in this file. Aura's knowledge of every product
 * comes from aura-kb.js (build-kb.sh; see it for what is included).
 *
 * data-product  which site this is (Aura answers with it in mind)
 * data-model    Puter model id (default deepseek/deepseek-v4-flash)
 */
(function () {
  "use strict";
  if (window.__auraChat) return;
  window.__auraChat = true;

  var me = document.currentScript;
  var PRODUCT = (me && me.dataset.product) || "Aura";
  var MODEL = (me && me.dataset.model) || "deepseek/deepseek-v4-flash";
  var PUTER_SRC = "https://js.puter.com/v2/";

  var SYSTEM =
    "You are Aura, the assistant on the " + PRODUCT + " website. Aura is a family of " +
    "products built by Dusan Milosavljevic: Aura Code (model-agnostic AI coding agent), " +
    "Aura OS (an agentic Arch Linux + sway operating system), Aura Droid, Aura Mic, " +
    "Aura Pulse, Powerboard and more.\n" +
    "Answer at whatever depth the visitor asks, from a first-time user to a PhD " +
    "engineer: exact commands, flags, architecture, protocols and trade-offs. Use the " +
    "knowledge below as ground truth. If it doesn't cover something, say so plainly " +
    "and point to the GitHub repo; never invent features, prices or benchmarks. " +
    "Be concise; use markdown code blocks for commands and code.\n\n" +
    "=== KNOWLEDGE ===\n" + (window.AURA_KB || "(knowledge base not loaded)");

  // ── UI (shadow DOM: the host site's CSS can't touch it, ours can't leak) ──
  var host = document.createElement("div");
  host.id = "aura-chat";
  document.body.appendChild(host);
  var root = host.attachShadow({ mode: "open" });
  root.innerHTML =
    '<style>' +
    ':host{all:initial}' +
    '*{box-sizing:border-box;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}' +
    '.w{--bg:#faf9f5;--fg:#141413;--mut:#6b6860;--line:#e3e0d6;--acc:#d97757;--me:#f2d3c4;--code:#f0eee6}' +
    '@media (prefers-color-scheme:dark){.w{--bg:#1f1e1d;--fg:#e8e6dc;--mut:#9c998f;--line:#3a3834;--acc:#d97757;--me:#5a3a2e;--code:#2b2a27}}' +
    '.btn{position:fixed;right:18px;bottom:14px;z-index:2147483000;border:0;background:none;padding:0;' +
    'width:72px;height:66px;cursor:pointer;filter:drop-shadow(0 6px 14px rgba(0,0,0,.3));transition:transform .15s}' +
    '.btn:hover{transform:translateY(-2px) scale(1.05)}.btn svg{width:100%;height:100%;display:block}' +
    '.p{position:fixed;right:20px;bottom:88px;z-index:2147483000;width:min(420px,calc(100vw - 32px));' +
    'height:min(620px,calc(100vh - 110px));display:none;flex-direction:column;background:var(--bg);color:var(--fg);' +
    'border:1px solid var(--line);border-radius:14px;box-shadow:0 12px 48px rgba(0,0,0,.3);overflow:hidden}' +
    '.p.open{display:flex}' +
    '.h{padding:12px 14px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:8px}' +
    '.h b{flex:1;font-size:15px}.h small{color:var(--mut);font-size:12px}' +
    '.x{background:none;border:0;color:var(--mut);font-size:20px;cursor:pointer;line-height:1}' +
    '.log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;font-size:14px;line-height:1.5}' +
    '.m{max-width:92%;padding:9px 12px;border-radius:12px;white-space:pre-wrap;word-wrap:break-word}' +
    '.u{align-self:flex-end;background:var(--me)}' +
    '.a{align-self:flex-start;background:var(--code)}' +
    '.a pre{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px;overflow-x:auto;white-space:pre;margin:6px 0}' +
    '.a code{font-family:ui-monospace,"JetBrains Mono",monospace;font-size:13px}' +
    '.note{color:var(--mut);font-size:12px;text-align:center}' +
    '.f{display:flex;gap:8px;padding:10px;border-top:1px solid var(--line)}' +
    '.f textarea{flex:1;resize:none;height:44px;border:1px solid var(--line);border-radius:10px;padding:10px;' +
    'background:var(--bg);color:var(--fg);font-size:14px}' +
    '.f button{border:0;border-radius:10px;background:var(--acc);color:#fff;padding:0 16px;font-weight:600;cursor:pointer}' +
    '.f button:disabled{opacity:.5;cursor:default}' +
    '@media (max-width:480px){.p{right:8px;left:8px;width:auto;bottom:84px}.btn{right:10px;bottom:10px}}' +
    '</style>' +
    '<div class="w">' +
    '<button class="btn" part="button" aria-label="Ask Aura" title="Ask Aura">' +
    // a speech cloud with a tail and a question mark
    '<svg viewBox="0 0 72 66" aria-hidden="true">' +
    '<path fill="var(--acc)" d="M36 4c17.7 0 32 11.2 32 25s-14.3 25-32 25c-3.3 0-6.5-.4-9.5-1.1L12 62l3.3-13.2C8.4 44.3 4 37.1 4 29 4 15.2 18.3 4 36 4z"/>' +
    '<text x="36" y="40" text-anchor="middle" font-size="30" font-weight="700" fill="#fff" ' +
    'font-family="ui-sans-serif,system-ui,sans-serif">?</text></svg></button>' +
    '<div class="p" role="dialog" aria-label="Ask Aura">' +
    '<div class="h"><b>Aura</b><small>free · via Puter</small><button class="x" aria-label="Close">×</button></div>' +
    '<div class="log"><div class="note">Ask anything about ' + esc(PRODUCT) +
    ' or any Aura product.<br>The first message asks you to sign in to Puter (free); ' +
    'your Puter account covers the chat.</div></div>' +
    '<form class="f"><textarea placeholder="How does Aura Code sandbox tools?" aria-label="Message"></textarea>' +
    '<button type="submit">Send</button></form>' +
    '</div></div>';

  var $ = function (s) { return root.querySelector(s); };
  var panel = $(".p"), log = $(".log"), form = $(".f"), input = $("textarea"), send = $(".f button");
  $(".btn").onclick = function () { panel.classList.toggle("open"); if (panel.classList.contains("open")) input.focus(); };
  $(".x").onclick = function () { panel.classList.remove("open"); };
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });

  var history = [];
  var puterReady = null;

  function loadPuter() {
    if (window.puter) return Promise.resolve();
    if (puterReady) return puterReady;
    puterReady = new Promise(function (ok, fail) {
      var s = document.createElement("script");
      s.src = PUTER_SRC;
      s.onload = ok;
      s.onerror = function () { puterReady = null; fail(new Error("Could not load Puter")); };
      document.head.appendChild(s);
    });
    return puterReady;
  }

  form.onsubmit = async function (e) {
    e.preventDefault();
    var q = input.value.trim();
    if (!q || send.disabled) return;
    input.value = "";
    add("u", q);
    history.push({ role: "user", content: q });
    var bubble = add("a", "…");
    send.disabled = true;
    var text = "";
    try {
      await loadPuter();
      var msgs = [{ role: "system", content: SYSTEM }].concat(history.slice(-12));
      var stream = await window.puter.ai.chat(msgs, { model: MODEL, stream: true });
      for await (var part of stream) {
        if (part && part.text) { text += part.text; render(bubble, text); }
      }
      if (!text) throw new Error("empty answer");
      history.push({ role: "assistant", content: text });
    } catch (err) {
      history.pop();
      render(bubble, "Aura couldn't answer: " + ((err && (err.message || err.error && err.error.message)) || err) +
        "\nIf a Puter sign-in window was blocked, allow pop-ups and try again.");
    } finally {
      send.disabled = false;
      input.focus();
    }
  };

  function add(cls, t) {
    var d = document.createElement("div");
    d.className = "m " + cls;
    render(d, t);
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }

  // Minimal, safe markdown: code blocks + inline code; everything escaped.
  function render(el, t) {
    var parts = String(t).split(/```[\w-]*\n?/);
    var html = parts.map(function (p, i) {
      return i % 2 ? "<pre><code>" + esc(p.replace(/\n$/, "")) + "</code></pre>"
                   : esc(p).replace(/`([^`\n]+)`/g, "<code>$1</code>");
    }).join("");
    el.innerHTML = html;
    log.scrollTop = log.scrollHeight;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
})();
