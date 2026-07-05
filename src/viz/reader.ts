import fs from 'fs';
import path from 'path';

/**
 * Reader renderer — turns a finished markdown doc (a :council verdict,
 * :research pass, or :dream) into a narrated "reading" experience: a
 * self-contained HTML page that speaks the text aloud, lights each word as
 * it's spoken, pops the **bold** terms in accent colour, and tracks the full
 * text in a column below.
 *
 * This is an OUTPUT renderer (a sibling of --html), not a pipeline stage. It
 * acts on whatever markdown a command already produced, so wiring `--reader`
 * into one command makes it trivial to add to the others.
 *
 * Segmentation is deterministic and dependency-free: the source markdown
 * already encodes emphasis (**bold**) and structure (# headings), so no extra
 * model call is needed. Matches the warm "Aura" theme used by
 * src/rem/render-html.ts and src/research/council.ts for visual consistency,
 * with a dark stage panel so narrated words stay legible.
 */

export interface ReaderSegment {
  text: string;
  emphasis: string[];
  heading?: boolean;
  pause?: number;
}

export interface ReaderDoc {
  title: string;
  segments: ReaderSegment[];
}

function dedupe(words: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words) {
    const key = w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}

/** Strip inline markdown from a chunk, capturing the words that were bold. */
function stripInline(raw: string): { text: string; emph: string[] } {
  const emph: string[] = [];
  let s = raw;
  // bold **...** or __...__  → keep inner text, mark words as emphasis
  s = s.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_m: string, a?: string, b?: string) => {
    const inner = (a ?? b ?? '');
    for (const w of inner.split(/\s+/)) if (w) emph.push(w);
    return inner;
  });
  // italic *...* or _..._  → keep text, no pop
  s = s.replace(/\*([^*]+)\*|_([^_]+)_/g, (_m: string, a?: string, b?: string) => (a ?? b ?? ''));
  // inline code, links, stray markers
  s = s.replace(/`([^`]+)`/g, '$1');
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  s = s.replace(/[*_`>]/g, '');
  return { text: s.replace(/\s+/g, ' ').trim(), emph };
}

function prettifyTitle(slug: string): string {
  return slug
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim() || 'Aura Reader';
}

/** Parse markdown into a narratable ReaderDoc. */
export function markdownToReader(md: string, fallbackTitle: string): ReaderDoc {
  const noCode = md.replace(/```[\s\S]*?```/g, ''); // drop fenced code
  const lines = noCode.split(/\r?\n/);

  let title = '';
  const segments: ReaderSegment[] = [];
  let para: string[] = [];

  const flushPara = () => {
    if (!para.length) return;
    const joined = para.join(' ').trim();
    para = [];
    if (!joined) return;
    const sentences = joined.split(/(?<=[.!?])\s+(?=[^a-z])/).map(x => x.trim()).filter(Boolean);
    for (const sent of sentences) {
      const { text, emph } = stripInline(sent);
      if (text) segments.push({ text, emphasis: dedupe(emph) });
    }
  };

  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara();
      const { text, emph } = stripInline(h[2]);
      if (!text) continue;
      if (!title && h[1].length <= 2) title = text; // first H1/H2 → doc title
      segments.push({
        text,
        emphasis: emph.length ? dedupe(emph) : text.split(/\s+/),
        heading: true,
        pause: 650,
      });
      continue;
    }
    const isHr = /^\s*([-*_])\1{2,}\s*$/.test(line);
    const isTable = /^\s*\|/.test(line);
    if (isHr || isTable) { flushPara(); continue; }
    if (line.trim() === '') { flushPara(); continue; }
    const cleaned = line.replace(/^\s*([-*+]|\d+\.)\s+/, ''); // drop list markers
    para.push(cleaned);
  }
  flushPara();

  return { title: title || prettifyTitle(fallbackTitle), segments };
}

/** Read a markdown file, render the player beside it, return the html path. */
export function renderReaderFromMarkdown(mdPath: string): string {
  const md = fs.readFileSync(mdPath, 'utf8');
  const base = path.basename(mdPath).replace(/\.md$/i, '');
  const doc = markdownToReader(md, prettifyTitle(base));
  const html = wrapReaderHtml(doc);
  const outPath = mdPath.replace(/\.md$/i, '.reader.html');
  fs.writeFileSync(outPath, html, 'utf8');
  return outPath;
}

/** Wrap a ReaderDoc into a standalone, themed, dependency-free HTML player. */
export function wrapReaderHtml(doc: ReaderDoc): string {
  const docJson = JSON.stringify(doc).replace(/</g, '\\u003c');

  // NOTE: the embedded player script below intentionally uses NO backticks and
  // NO ${...} so it can live inside this outer template literal untouched.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${doc.title.replace(/</g, '&lt;')} — Aura Reader</title>
<style>
  :root{
    --bg:#fdf6f0; --card:#fffaf5; --text:#3e2f24; --muted:#8a7768;
    --accent:#cc785c; --accent-2:#5a9e6e; --border:#e8d5c8; --hr:#e0cebc;
    --stage:#241d18; --stage-text:#ede0cc; --stage-dim:#6b5a4c;
    --serif:'Georgia','Times New Roman',serif;
    --sans:'Inter',system-ui,-apple-system,'Segoe UI',sans-serif;
    --mono:'JetBrains Mono','Fira Code','Consolas',monospace;
  }
  @media (prefers-color-scheme:dark){
    :root{ --bg:#1e1b18; --card:#26221e; --text:#ede0cc; --muted:#9e8e80;
      --accent:#e08a6e; --accent-2:#6db880; --border:#3a322a; --hr:#3a322a;
      --stage:#161210; --stage-text:#f1e7d6; --stage-dim:#5a4c40; }
  }
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%}
  body{background:var(--bg);color:var(--text);font-family:var(--serif);
    display:flex;flex-direction:column;min-height:100vh;-webkit-font-smoothing:antialiased}

  .stage{flex:0 0 44vh;display:flex;align-items:center;justify-content:center;
    padding:5vh 7vw;background:radial-gradient(120% 90% at 50% 0%,#2e251e 0%,var(--stage) 72%);
    border-bottom:1px solid var(--border);position:relative;overflow:hidden}
  .eyebrow{position:absolute;top:16px;left:0;right:0;text-align:center;
    font-family:var(--sans);font-size:.66rem;letter-spacing:.3em;text-transform:uppercase;color:var(--stage-dim)}
  .line{font-family:var(--serif);font-size:clamp(1.7rem,4.4vw,3.6rem);line-height:1.2;
    text-align:center;max-width:20ch;text-wrap:balance;color:var(--stage-dim)}
  .line.head{font-family:var(--sans);font-weight:700;letter-spacing:-.01em}
  .line .w{color:var(--stage-dim);display:inline-block;
    transition:color .25s ease,text-shadow .35s ease,transform .35s ease}
  .line .w.lit{color:var(--stage-text)}
  .line .w.emph.lit{color:var(--accent);text-shadow:0 0 24px rgba(204,120,92,.5);
    transform:translateY(-2px) scale(1.04)}

  .read-wrap{flex:1 1 auto;overflow-y:auto;padding:6vh 7vw 16vh;scroll-behavior:smooth}
  .read{max-width:44rem;margin:0 auto;font-size:clamp(1.02rem,1.4vw,1.25rem);line-height:1.85}
  .read p,.read h3{color:var(--muted);opacity:.5;transition:opacity .4s ease,color .4s ease;
    margin:0 0 1.05em;cursor:pointer}
  .read h3{font-family:var(--sans);font-weight:700;color:var(--accent);
    font-size:1.05em;margin-top:1.4em;letter-spacing:-.01em}
  .read p.active,.read h3.active{opacity:1;color:var(--text)}
  .read h3.active{color:var(--accent)}
  .read .e{color:inherit;font-weight:700}
  .read .active .e{color:var(--accent)}

  .bar{position:fixed;left:0;right:0;bottom:0;background:color-mix(in srgb,var(--card) 88%,transparent);
    backdrop-filter:blur(10px);border-top:1px solid var(--border);display:flex;align-items:center;gap:12px;
    padding:11px clamp(14px,4vw,26px);font-family:var(--sans);z-index:5}
  button,select{font-family:var(--sans);font-size:.8rem;color:var(--text);background:transparent;
    border:1px solid var(--border);border-radius:999px;padding:7px 15px;cursor:pointer;
    transition:border-color .2s,color .2s}
  button:hover,select:hover{border-color:var(--accent);color:var(--accent)}
  button:focus-visible,select:focus-visible{outline:2px solid var(--accent-2);outline-offset:2px}
  .play{border-color:var(--accent);color:var(--accent);min-width:94px;font-weight:600}
  .spacer{flex:1}
  .meta{color:var(--muted);font-size:.72rem;letter-spacing:.06em}
  label{color:var(--muted);font-size:.72rem;letter-spacing:.06em}

  @media (prefers-reduced-motion:reduce){
    *{transition:none!important;scroll-behavior:auto!important}
    .line .w.emph.lit{transform:none}
  }
  @media (max-width:640px){ .stage{flex-basis:38vh} .meta,.lbl{display:none} }
</style>
</head>
<body>
<section class="stage">
  <div class="eyebrow" id="eyebrow"></div>
  <div class="line" id="line"></div>
</section>
<div class="read-wrap" id="readWrap"><div class="read" id="read"></div></div>
<div class="bar">
  <button class="play" id="play">▶ Play</button>
  <button id="restart">↺</button>
  <label class="lbl">speed</label>
  <select id="rate">
    <option value="0.8">0.8×</option><option value="0.9">0.9×</option>
    <option value="1" selected>1.0×</option><option value="1.1">1.1×</option>
    <option value="1.25">1.25×</option>
  </select>
  <select id="voice" title="Narration voice"></select>
  <span class="spacer"></span>
  <span class="meta" id="meta"></span>
</div>
<script>
const DOC = ${docJson};

var idx = 0, playing = false;
var synth = window.speechSynthesis, voices = [];
var $ = function(s){ return document.querySelector(s); };
var lineEl = $('#line'), readEl = $('#read'), readWrap = $('#readWrap');
var eyebrow = $('#eyebrow'), meta = $('#meta'), playBtn = $('#play');
var rateSel = $('#rate'), voiceSel = $('#voice');

function norm(s){ return s.toLowerCase().replace(/[^a-z0-9\\u00C0-\\u024F\\u0400-\\u04FF]/g,''); }
function isEmph(word, seg){
  var set = (seg.emphasis || []).map(norm);
  return set.indexOf(norm(word)) !== -1;
}

function buildReading(){
  eyebrow.textContent = DOC.title || '';
  readEl.innerHTML = '';
  DOC.segments.forEach(function(seg, i){
    var p = document.createElement(seg.heading ? 'h3' : 'p');
    p.setAttribute('data-i', i);
    seg.text.split(/(\\s+)/).forEach(function(tok){
      if(/^\\s+$/.test(tok)){ p.appendChild(document.createTextNode(tok)); return; }
      var span = document.createElement('span');
      span.textContent = tok;
      if(isEmph(tok, seg)) span.className = 'e';
      p.appendChild(span);
    });
    p.addEventListener('click', function(){ stop(); idx = i; play(); });
    readEl.appendChild(p);
  });
}

function renderLine(seg){
  lineEl.innerHTML = '';
  lineEl.className = 'line' + (seg.heading ? ' head' : '');
  var words = [];
  seg.text.split(/(\\s+)/).forEach(function(tok){
    if(/^\\s+$/.test(tok)){ lineEl.appendChild(document.createTextNode(' ')); return; }
    var span = document.createElement('span');
    span.className = 'w' + (isEmph(tok, seg) ? ' emph' : '');
    span.textContent = tok;
    lineEl.appendChild(span);
    words.push({ el: span, start: 0 });
  });
  var cursor = 0, wi = 0;
  seg.text.split(/(\\s+)/).forEach(function(tok){
    if(!/^\\s+$/.test(tok) && tok.length){ words[wi].start = cursor; wi++; }
    cursor += tok.length;
  });
  return words;
}

function markActive(i){
  var nodes = readEl.querySelectorAll('[data-i]');
  for(var k=0;k<nodes.length;k++){
    nodes[k].classList.toggle('active', Number(nodes[k].getAttribute('data-i')) === i);
  }
  var active = readEl.querySelector('.active');
  if(active){
    var wr = readWrap.getBoundingClientRect(), ar = active.getBoundingClientRect();
    if(ar.top < wr.top + 60 || ar.bottom > wr.bottom - 60){
      readWrap.scrollTop += (ar.top - wr.top) - wr.height * 0.36;
    }
  }
  meta.textContent = (i + 1) + ' / ' + DOC.segments.length;
}

function speak(seg, words){
  return new Promise(function(resolve){
    var rate = parseFloat(rateSel.value);
    var u = new SpeechSynthesisUtterance(seg.text);
    u.rate = rate;
    var v = voices[voiceSel.value]; if(v) u.voice = v;
    var perWord = 60000 / (170 * rate), tIdx = 0;
    var tick = setInterval(function(){
      tIdx++;
      for(var k=0;k<Math.min(tIdx, words.length);k++) words[k].el.classList.add('lit');
    }, perWord);
    u.onboundary = function(e){
      if(e.name && e.name !== 'word') return;
      var n = 0;
      for(var k=0;k<words.length;k++){ if(words[k].start <= e.charIndex) n = k; }
      for(var j=0;j<=n;j++) words[j].el.classList.add('lit');
    };
    u.onend = function(){
      clearInterval(tick);
      for(var k=0;k<words.length;k++) words[k].el.classList.add('lit');
      setTimeout(resolve, seg.pause || 280);
    };
    u.onerror = function(){ clearInterval(tick); resolve(); };
    synth.speak(u);
  });
}

async function play(){
  if(playing) return;
  playing = true; playBtn.textContent = '❚❚ Pause';
  for(; idx < DOC.segments.length; idx++){
    if(!playing) break;
    var seg = DOC.segments[idx];
    var words = renderLine(seg);
    markActive(idx);
    await speak(seg, words);
    if(!playing) break;
  }
  if(idx >= DOC.segments.length){ playing = false; idx = 0; playBtn.textContent = '▶ Replay'; }
}

function stop(){ playing = false; synth.cancel(); playBtn.textContent = '▶ Play'; }

function loadVoices(){
  voices = synth.getVoices();
  voiceSel.innerHTML = '';
  voices.forEach(function(v, i){
    var o = document.createElement('option');
    o.value = i; o.textContent = v.name + ' (' + v.lang + ')';
    voiceSel.appendChild(o);
  });
  var def = -1;
  for(var i=0;i<voices.length;i++){ if(/^en/i.test(voices[i].lang)){ def = i; break; } }
  if(def >= 0) voiceSel.value = def;
}
synth.onvoiceschanged = loadVoices;

playBtn.onclick = function(){ playing ? stop() : play(); };
$('#restart').onclick = function(){ stop(); idx = 0; buildReading(); renderLine(DOC.segments[0]); markActive(0); play(); };

loadVoices();
buildReading();
if(DOC.segments.length){ renderLine(DOC.segments[0]); markActive(0); }
</script>
</body>
</html>`;
}
