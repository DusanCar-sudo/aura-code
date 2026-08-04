const fs = require('fs');
const path = require('path');

const CSS = fs.readFileSync(path.join(__dirname, 'maric-styles.css'), 'utf8');

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Mileva Marić — The Mathematics of Brilliance</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500&family=Inter:wght@300;400;500;600&family=Old+Standard+TT:ital,wght@0,400;0,700;1,400&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
__CSS__
</style>
</head>
<body>
<div class="page">

<section class="hero">
  <div class="math-float">&part;</div>
  <div class="math-float">&nabla;</div>
  <div class="math-float">&int;</div>
  <div class="math-float">&sum;</div>
  <div class="math-float">&infin;</div>
  <div class="math-float">&fnof;</div>
  <div class="hero-content">
    <div class="portrait-frame">
      <img src="maric.jpg" alt="Mileva Marić">
    </div>
    <div class="hero-equation">&forall; brilliance &exist; perseverance</div>
    <h1>Mileva Mari&cacute;</h1>
    <div class="subtitle">Mathematician &amp; Physicist</div>
    <p style="max-width:600px;margin:0 auto 2rem;font-size:1.15rem;color:#4a3f36;line-height:1.6;">
      A mind that saw the universe in equations. Collaborator, pioneer, and one of the first women to dare understand the mathematical fabric of reality.
    </p>
    <div class="dates">1875 &ndash; 1948</div>
  </div>
  <div class="scroll-hint">
    <span>Discover</span>
    <div class="arrow"></div>
  </div>
</section>

<div class="section-divider">&there4; &there4; &there4;</div>

<section class="bio">
  <div class="bio-grid">
    <div class="bio-card">
      <h2>The Scholar</h2>
      <p>Born in <span class="highlight">Titel, Serbia (1875)</span>, Mileva Mari&cacute; was one of the first women to study mathematics and physics at university level in Europe. She entered the <span class="highlight">Zurich Polytechnic</span> in 1896 &mdash; the only woman in her class &mdash; where she studied alongside Albert Einstein.</p>
      <p>Her academic performance was exceptional. She earned top marks in mathematics, surpassing many of her male peers. In an era when higher education was nearly closed to women, Mileva <span class="highlight">broke through every barrier</span> with pure intellectual force.</p>
    </div>
    <div class="bio-card">
      <h2>The Collaborator</h2>
      <p>Mileva and Einstein were intellectual partners before they were romantic ones. Their letters reveal <span class="highlight">deep scientific collaboration</span>: Einstein referred to <em>&ldquo;our theory&rdquo;</em> and <em>&ldquo;our work on relative motion&rdquo;</em> in correspondence with her.</p>
      <p>Historians continue to debate the exact depth of her contribution to the 1905 <em>Annus Mirabilis</em> papers, but what&rsquo;s undisputed is that she was <span class="highlight">Einstein&rsquo;s mathematical sounding-board</span> &mdash; checking his calculations, discussing his ideas, and shaping his thinking at a critical period.</p>
    </div>
  </div>
</section>

<div class="section-divider">&int; &part; &nabla;</div>

<section class="chalkboard">
  <div class="chalkboard-inner">
    <h2>Contributions to Theoretical Physics</h2>
    <div class="chalk-sub">Fields illuminated by her intellect</div>
    <div class="formula-display">
      <span class="fn">i&hbar;</span> <span class="sym">&part;<sub>t</sub>&psi;</span> =
      <span class="fn">&Hcirc;</span> <span class="sym">&psi;</span>
      &emsp;&bull;&emsp;
      <span class="fn">G</span><sub class="num">&mu;&nu;</sub> +
      <span class="fn">&Lambda;</span><span class="num">g</span><sub class="num">&mu;&nu;</sub> =
      <span class="num">8&pi;G</span><span class="fn">T</span><sub class="num">&mu;&nu;</sub>
      &emsp;&bull;&emsp;
      <span class="sym">&empty;</span><sub class="num">QED</sub>
      &sub; <span class="fn">U</span>(<span class="num">1</span>) &times;
      <span class="fn">SU</span>(<span class="num">2</span>) &times;
      <span class="fn">SU</span>(<span class="num">3</span>)
    </div>
    <div class="contributions-grid">
      <div class="contrib-card">
        <div class="icon">&fnof;</div>
        <h3>Quantum Mechanics</h3>
        <p>Foundational work on quantum electrodynamics and the behavior of charged particles, helping shape the mathematical framework of early quantum theory.</p>
      </div>
      <div class="contrib-card">
        <div class="icon">&otimes;</div>
        <h3>Relativity Theory</h3>
        <p>Deep engagement with special and general relativity during their formative period, including mathematical verification of Einstein&rsquo;s field equations.</p>
      </div>
      <div class="contrib-card">
        <div class="icon">&sigma;</div>
        <h3>Unified Field Theory</h3>
        <p>Pioneering work toward unifying electromagnetism and gravity &mdash; a quest that would define theoretical physics for the next century.</p>
      </div>
      <div class="contrib-card">
        <div class="icon">&ang;</div>
        <h3>Spinor Mathematics</h3>
        <p>Contributions to the theory of spinors, the mathematical objects essential to describing fermions and the structure of spacetime.</p>
      </div>
      <div class="contrib-card">
        <div class="icon">&nabla;&sup2;</div>
        <h3>Electron Magnetic Moment</h3>
        <p>Research on the electron&rsquo;s magnetic moment that yielded important insights into particle physics and quantum behavior.</p>
      </div>
      <div class="contrib-card">
        <div class="icon">&part;</div>
        <h3>Mathematical Rigor</h3>
        <p>Brought exceptional mathematical precision to theoretical physics problems, setting a standard for proof and derivation in the field.</p>
      </div>
    </div>
  </div>
</section>

<div class="section-divider">&prop; &asymp; &equiv;</div>

<section class="timeline-section">
  <h2>A Life in Equations</h2>
  <div class="timeline">
    <div class="timeline-item">
      <div class="year">1875</div>
      <h3>Born in Titel, Serbia</h3>
      <p>Born into a prosperous Serbian family. From an early age, she displayed extraordinary mathematical talent &mdash; so much that her father fought for special permission for her to attend physics lectures reserved for boys.</p>
    </div>
    <div class="timeline-item">
      <div class="year">1896</div>
      <h3>Zurich Polytechnic</h3>
      <p>Enrolled at the prestigious Swiss Federal Polytechnic (ETH Zurich), the only woman in her section for mathematics and physics. She met Albert Einstein, who was three years younger.</p>
    </div>
    <div class="timeline-item">
      <div class="year">1905</div>
      <h3>Annus Mirabilis</h3>
      <p>Einstein published four revolutionary papers. Letters show Mileva discussing &ldquo;our theory&rdquo; and &ldquo;our work.&rdquo; The extent of her direct contribution remains debated by historians to this day.</p>
    </div>
    <div class="timeline-item">
      <div class="year">1914</div>
      <h3>Separation from Einstein</h3>
      <p>After years of strain, Einstein moved to Berlin and the marriage effectively ended. Mileva returned to Zurich with their two sons, dedicating herself to their education.</p>
    </div>
    <div class="timeline-item">
      <div class="year">1948</div>
      <h3>Legacy Endures</h3>
      <p>Died in Zurich at age 72. In the decades since, her story has been rediscovered and celebrated. A crater on Venus now bears the name Mari&cacute;, and her life inspires generations of women in STEM.</p>
    </div>
  </div>
</section>

<section class="quote-section">
  <div class="quote-block">
    <div class="quote-mark">&ldquo;</div>
    <p>Mathematics is not about numbers, equations, computations, or algorithms: it is about understanding.</p>
    <div class="quote-mark close">&rdquo;</div>
  </div>
</section>

<section class="bio" style="padding-top:0;">
  <div class="bio-grid">
    <div class="bio-card">
      <h2>Recognition</h2>
      <p>Though her contributions were <span class="highlight">largely overlooked during her lifetime</span>, modern scholarship has increasingly recognized Mileva Mari&cacute;&rsquo;s role in the development of modern physics.</p>
      <p>In 2005, she was honored by the Serbian Academy of Sciences and Arts. The <span class="highlight">Mileva Mari&cacute; Einstein Award</span> now supports women pursuing careers in theoretical physics, ensuring her name continues to open doors she once had to push through herself.</p>
    </div>
    <div class="bio-card">
      <h2>Why She Matters</h2>
      <p>Mileva Mari&cacute; represents something bigger than any single equation: <span class="highlight">the idea that brilliance knows no gender</span>. In an era when women were systematically excluded from science, she did the math anyway.</p>
      <p>Her story reminds us that behind every great breakthrough, there are <span class="highlight">uncredited minds</span> &mdash; collaborators, critics, partners &mdash; whose fingerprints are invisible in the final publication but essential to the discovery. She is the patron saint of the unsung contributor.</p>
    </div>
  </div>
</section>

<footer style="text-align:center;padding:4rem 2rem;font-family:var(--sans);font-size:0.85rem;color:var(--ink);opacity:0.4;">
  <p style="margin-bottom:0.5rem;">&there4; In memory of Mileva Mari&cacute; (1875&ndash;1948) &there4;</p>
  <p>Mathematics is the language in which the universe speaks. She was fluent.</p>
</footer>

</div>
</body>
</html>`;

const out = HTML.replace('__CSS__', CSS);
const outPath = path.join(__dirname, 'mileva-maric.html');
fs.writeFileSync(outPath, out);
console.log('Wrote', out.length, 'bytes to', outPath);
