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

  // \u2500\u2500 UI (shadow DOM: the host site's CSS can't touch it, ours can't leak) \u2500\u2500
  var host = document.createElement("div");
  host.id = "aura-chat";
  document.body.appendChild(host);
  var root = host.attachShadow({ mode: "open" });
  root.innerHTML =
    '<style>' +
    ':host{all:initial}' +
    // Aura OS popup look: square, hard 2px border, monospace, gruvbox
    '*{box-sizing:border-box;border-radius:0;font-family:"JetBrains Mono","JetBrainsMono Nerd Font",ui-monospace,"SF Mono",Menlo,Consolas,monospace}' +
    '.w{--bg:#1d2021;--bg2:#282828;--sel:#3c3836;--fg:#ebdbb2;--hi:#fbf1c7;--mut:#928374;--acc:#fe8019;--ok:#b8bb26;--y:#fabd2f}' +
    '.btn{position:fixed;right:18px;bottom:18px;z-index:2147483000;cursor:pointer;background:var(--bg);color:var(--acc);' +
    'border:2px solid var(--acc);padding:8px 12px;font-size:14px;font-weight:700;letter-spacing:.04em;' +
    'box-shadow:4px 4px 0 rgba(0,0,0,.45)}' +
    '.btn:hover,.btn[aria-expanded="true"]{background:var(--acc);color:var(--bg)}' +
    '.p{position:fixed;right:18px;bottom:66px;z-index:2147483000;width:min(460px,calc(100vw - 24px));' +
    'height:min(600px,calc(100vh - 96px));display:none;flex-direction:column;background:var(--bg);color:var(--fg);' +
    'border:2px solid var(--acc);box-shadow:6px 6px 0 rgba(0,0,0,.45);font-size:13px}' +
    '.p.open{display:flex}' +
    '.h{display:flex;align-items:center;background:var(--acc);color:var(--bg);font-weight:700;padding:3px 8px}' +
    '.h b{flex:1}.h small{font-weight:400;margin-right:10px;opacity:.8}' +
    '.x{background:none;border:0;color:var(--bg);font-size:14px;font-weight:700;cursor:pointer;padding:0 2px}' +
    '.x:hover{background:var(--bg);color:var(--acc)}' +
    '.log{flex:1;overflow-y:auto;padding:8px 10px;display:flex;flex-direction:column;gap:8px;line-height:1.5;' +
    'scrollbar-color:var(--sel) var(--bg)}' +
    '.m{white-space:pre-wrap;word-wrap:break-word;padding:0 0 0 10px;border-left:2px solid var(--sel)}' +
    '.m::before{display:block;font-weight:700;margin-bottom:1px}' +
    '.u{border-left-color:var(--y);color:var(--hi)}.u::before{content:"you";color:var(--y)}' +
    '.a{border-left-color:var(--acc)}.a::before{content:"aura";color:var(--acc)}' +
    '.a pre{background:var(--bg2);border:1px solid var(--sel);padding:6px 8px;overflow-x:auto;white-space:pre;margin:4px 0}' +
    '.a code{color:var(--ok)}' +
    '.note{color:var(--mut);border:1px dashed var(--sel);padding:6px 8px}' +
    '.f{display:flex;border-top:2px solid var(--acc)}' +
    '.f span{color:var(--acc);padding:9px 0 0 8px;font-weight:700}' +
    '.f textarea{flex:1;resize:none;height:40px;border:0;outline:0;padding:9px 8px;background:var(--bg);color:var(--hi);font-size:13px}' +
    '.f button{border:0;border-left:2px solid var(--acc);background:var(--bg);color:var(--acc);padding:0 14px;font-weight:700;cursor:pointer}' +
    '.f button:hover{background:var(--acc);color:var(--bg)}' +
    '.f button:disabled{color:var(--mut);cursor:default;background:var(--bg)}' +
    '@media (max-width:480px){.p{right:6px;left:6px;width:auto;bottom:62px}.btn{right:10px;bottom:10px}}' +
    '</style>' +
    '<div class="w">' +
    '<button class="btn" part="button" aria-label="Ask Aura" aria-expanded="false">[?] ASK AURA</button>' +
    '<div class="p" role="dialog" aria-label="Ask Aura">' +
    '<div class="h"><b>\u258c ASK AURA</b><small>free \u00b7 puter</small><button class="x" aria-label="Close">[x]</button></div>' +
    '<div class="log"><div class="note">Ask anything about ' + esc(PRODUCT) +
    ' or any Aura product.\nFirst message: sign in to Puter (free) \u2014 your Puter account covers the chat.</div></div>' +
    '<form class="f"><span>&gt;</span><textarea placeholder="how does aura code sandbox tools?" aria-label="Message"></textarea>' +
    '<button type="submit">SEND</button></form>' +
    '</div></div>';

  var $ = function (s) { return root.querySelector(s); };
  var panel = $(".p"), log = $(".log"), form = $(".f"), input = $("textarea"), send = $(".f button");
  var btn = $(".btn");
  function setOpen(on) {
    panel.classList.toggle("open", on);
    btn.setAttribute("aria-expanded", on ? "true" : "false");
    if (on) input.focus();
  }
  btn.onclick = function () { setOpen(!panel.classList.contains("open")); };
  $(".x").onclick = function () { setOpen(false); };
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
    var bubble = add("a", "\u2026");
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
