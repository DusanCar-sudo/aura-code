#!/usr/bin/env python3
"""Build the multi-theme portfolio page."""
import os

# Read themes CSS
themes_path = os.path.join(os.path.dirname(__file__), 'themes.css')
with open(themes_path) as f:
    themes_css = f.read()

output_path = os.path.join(os.path.dirname(__file__), 'index.html')

html = f'''<!DOCTYPE html>
<html lang="en" data-design="neon-dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dušan Milosavljević — AI · Lean · Education</title>
  <meta name="description" content="Multidisciplinary AI Builder, Lean Practitioner, Educator. Bridging AI, Lean, and Human Potential.">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&family=Darker+Grotesque:wght@400;500;600;700;800;900&family=Audiowide&family=Space+Mono:wght@400;700&family=Macondo&family=Oswald:wght@400;500;600;700&family=Roboto:wght@300;400;500&family=STIX+Two+Text:wght@400;500;600;700&family=Source+Code+Pro:wght@400;500&family=Open+Sans:wght@300;400;500;600&family=Inconsolata:wght@400;500;700&family=Montserrat:wght@400;500;600;700&family=PT+Mono&family=Anonymous+Pro:wght@400;700&display=swap" rel="stylesheet">
  <style>
    *,*::before,*::after{{margin:0;padding:0;box-sizing:border-box}}
    html{{scroll-behavior:smooth;scrollbar-width:thin}}
    body{{font-family:var(--font-body);background:var(--bg);color:var(--text);line-height:1.7;overflow-x:hidden}}
    ::-webkit-scrollbar{{width:6px}}
    ::-webkit-scrollbar-track{{background:var(--bg)}}
    ::-webkit-scrollbar-thumb{{background:var(--accent);border-radius:3px}}

    /* Design Switcher */
    .design-switcher{{position:fixed;bottom:28px;right:28px;z-index:9999;display:flex;flex-direction:column;gap:6px;align-items:flex-end}}
    .design-switcher-btn{{background:var(--bg-card);border:1px solid var(--border);color:var(--text-secondary);padding:10px 20px;border-radius:24px;font-family:var(--font-mono);font-size:0.8rem;cursor:pointer;transition:all 250ms ease;white-space:nowrap;display:flex;align-items:center;gap:8px}}
    .design-switcher-btn:hover{{border-color:var(--accent);color:var(--accent);transform:translateX(-4px)}}
    .design-switcher-btn.active{{background:var(--accent);color:#fff;border-color:var(--accent)}}
    .design-switcher-btn .swatch{{width:12px;height:12px;border-radius:50%;display:inline-block}}
    #design-menu{{display:none;flex-direction:column;gap:4px;background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:8px;box-shadow:var(--shadow);margin-bottom:8px;max-height:400px;overflow-y:auto}}
    #design-menu.open{{display:flex}}

    /* Scroll Progress */
    #progress-bar{{position:fixed;top:0;left:0;height:3px;z-index:9998;width:0;transition:width 50ms linear;background:linear-gradient(90deg,var(--accent),var(--accent2))}}

    /* Sidebar */
    .sidebar{{position:fixed;left:28px;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:20px;z-index:1000}}
    .sidebar a{{display:flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:50%;background:var(--bg-card);border:1px solid var(--border);color:var(--text-secondary);text-decoration:none;font-size:18px;transition:all 350ms ease;position:relative}}
    .sidebar a:hover,.sidebar a.active{{color:var(--accent2);border-color:var(--accent2);box-shadow:var(--shadow-glow);transform:scale(1.1)}}
    .sidebar a .tooltip{{position:absolute;left:56px;top:50%;transform:translateY(-50%);background:var(--bg-card);color:var(--text);padding:6px 14px;border-radius:6px;font-size:13px;font-family:var(--font-mono);white-space:nowrap;opacity:0;pointer-events:none;transition:opacity 150ms ease;border:1px solid var(--border-glow)}}
    .sidebar a:hover .tooltip{{opacity:1}}

    /* Language Toggle */
    .lang-toggle{{position:fixed;top:24px;right:28px;z-index:1000;display:flex;gap:8px}}
    .lang-toggle button{{background:var(--bg-card);border:1px solid var(--border);color:var(--text-secondary);padding:8px 16px;border-radius:20px;font-family:var(--font-mono);font-size:13px;cursor:pointer;transition:all 350ms ease}}
    .lang-toggle button.active{{background:var(--accent);color:#fff;border-color:var(--accent)}}

    /* Hero */
    .hero{{min-height:100vh;display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden;padding:40px 24px}}
    .hero-bg{{position:absolute;inset:0;z-index:0;background:radial-gradient(ellipse at 20% 50%,var(--accent) 0%,transparent 60%),radial-gradient(ellipse at 80% 30%,var(--accent2) 0%,transparent 60%),radial-gradient(ellipse at 50% 80%,var(--accent3) 0%,transparent 50%);opacity:0.12}}
    .hero-content{{position:relative;z-index:2;text-align:center;max-width:800px}}
    .hero-symbol{{font-size:48px;color:var(--accent2);opacity:0.7;margin-bottom:24px;animation:symbolPulse 3s ease-in-out infinite}}
    @keyframes symbolPulse{{0%,100%{{opacity:0.5;transform:scale(1)}}50%{{opacity:1;transform:scale(1.08)}}}}
    .hero h1{{font-family:var(--font-display);font-size:clamp(3.2rem,8vw,7rem);font-weight:700;line-height:1.05;margin-bottom:16px;background:var(--hero-gradient,linear-gradient(135deg,#fff 0%,var(--accent2) 50%,var(--accent) 100%));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}}
    .hero .tagline{{font-family:var(--font-mono);font-size:clamp(1rem,2vw,1.3rem);color:var(--text-secondary);min-height:28px}}
    .hero .tagline .cursor-blink{{display:inline-block;width:2px;height:1.1em;background:var(--accent2);margin-left:2px;vertical-align:text-bottom;animation:blink 0.8s step-end infinite}}
    @keyframes blink{{50%{{opacity:0}}}}
    .hero-cta{{display:inline-flex;align-items:center;gap:10px;margin-top:36px;padding:16px 36px;background:transparent;border:1px solid var(--accent2);color:var(--accent2);border-radius:50px;font-family:var(--font-display);font-size:1rem;font-weight:600;cursor:pointer;text-decoration:none;transition:all 350ms ease;position:relative;overflow:hidden}}
    .hero-cta::before{{content:'';position:absolute;inset:0;background:linear-gradient(135deg,var(--accent),var(--accent2));opacity:0;transition:opacity 350ms ease}}
    .hero-cta:hover::before{{opacity:1}}
    .hero-cta:hover{{border-color:transparent;color:#fff;box-shadow:var(--shadow-glow)}}
    .hero-cta span{{position:relative;z-index:1}}
    .hero-grid{{position:absolute;inset:0;z-index:1;opacity:0.04;background-image:linear-gradient(var(--accent) 1px,transparent 1px),linear-gradient(90deg,var(--accent) 1px,transparent 1px);background-size:60px 60px}}
    .hero-nodes{{position:absolute;inset:0;z-index:1}}

    /* Sections */
    section{{padding:100px 24px;max-width:1100px;margin:0 auto;position:relative}}
    .section-header{{margin-bottom:60px}}
    .section-symbol{{font-size:28px;color:var(--accent2);margin-bottom:12px}}
    .section-title{{font-family:var(--font-display);font-size:clamp(2rem,5vw,3.2rem);font-weight:700;color:var(--text);margin-bottom:12px}}
    .section-subtitle{{font-family:var(--font-mono);font-size:0.95rem;color:var(--text-muted)}}
    .section-divider{{width:60px;height:3px;background:linear-gradient(90deg,var(--accent),var(--accent2));margin-top:20px;border-radius:2px}}

    /* Skills */
    .skills-marquee{{display:flex;gap:16px;flex-wrap:wrap;justify-content:center}}
    .skill-chip{{position:relative;padding:14px 26px;background:var(--bg-card);border:1px solid var(--border);border-radius:50px;font-family:var(--font-display);font-size:0.95rem;color:var(--text-secondary);cursor:pointer;transition:all 350ms ease;overflow:hidden}}
    .skill-chip::after{{content:'';position:absolute;inset:0;background:linear-gradient(135deg,var(--accent),var(--accent2));opacity:0;transition:opacity 350ms ease;border-radius:50px}}
    .skill-chip:hover{{transform:translateY(-4px);box-shadow:var(--shadow-glow);border-color:var(--border-glow)}}
    .skill-chip:hover::after{{opacity:0.12}}
    .skill-chip .chip-detail{{position:absolute;bottom:-48px;left:50%;transform:translateX(-50%);background:var(--bg-card);border:1px solid var(--border-glow);border-radius:8px;padding:8px 16px;font-size:0.8rem;font-family:var(--font-mono);color:var(--accent2);white-space:nowrap;opacity:0;transition:all 150ms ease;pointer-events:none}}
    .skill-chip:hover .chip-detail{{opacity:1;bottom:-40px}}

    /* Timeline */
    .timeline{{position:relative}}
    .timeline::before{{content:'';position:absolute;left:50%;top:0;bottom:0;width:2px;background:linear-gradient(180deg,var(--accent),var(--accent2),var(--accent));transform:translateX(-50%);opacity:0.3}}
    .timeline-item{{display:flex;align-items:flex-start;margin-bottom:48px;position:relative;gap:40px}}
    .timeline-item:nth-child(even){{flex-direction:row-reverse}}
    .timeline-dot{{position:absolute;left:50%;top:8px;transform:translateX(-50%);width:16px;height:16px;border-radius:50%;z-index:2;border:3px solid var(--bg-card);box-shadow:0 0 12px currentColor}}
    .timeline-dot.ai{{background:var(--accent);color:var(--accent)}}
    .timeline-dot.lean{{background:var(--accent2);color:var(--accent2)}}
    .timeline-dot.edu{{background:var(--accent3);color:var(--accent3)}}
    .timeline-dot.fit{{background:#FF2D95;color:#FF2D95}}
    .timeline-card{{flex:1;max-width:420px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-md);padding:28px;transition:all 350ms ease}}
    .timeline-card:hover{{transform:translateY(-4px);box-shadow:var(--shadow-glow);border-color:var(--border-glow)}}
    .timeline-card .role-badge{{display:inline-block;padding:4px 14px;border-radius:20px;font-family:var(--font-mono);font-size:0.75rem;font-weight:500;margin-bottom:12px}}
    .role-badge.ai{{background:rgba(139,92,246,0.15);color:var(--accent)}}
    .role-badge.lean{{background:rgba(0,212,255,0.12);color:var(--accent2)}}
    .role-badge.edu{{background:rgba(0,245,255,0.12);color:var(--accent3)}}
    .role-badge.fit{{background:rgba(255,45,149,0.12);color:#FF2D95}}
    .timeline-card h3{{font-family:var(--font-display);font-size:1.3rem;margin-bottom:4px}}
    .timeline-card .period{{font-family:var(--font-mono);font-size:0.8rem;color:var(--text-muted);margin-bottom:8px}}
    .timeline-card p{{color:var(--text-secondary);font-size:0.9rem}}

    /* Projects */
    .projects-stack{{perspective:1200px;display:flex;justify-content:center;flex-wrap:wrap;gap:32px}}
    .project-card{{width:340px;height:420px;position:relative;transform-style:preserve-3d;cursor:pointer}}
    .project-card-inner{{width:100%;height:100%;position:relative;transform-style:preserve-3d;transition:transform 0.7s cubic-bezier(0.4,0,0.2,1)}}
    .project-card.flipped .project-card-inner{{transform:rotateY(180deg)}}
    .project-face{{position:absolute;inset:0;backface-visibility:hidden;border-radius:var(--radius-lg);overflow:hidden;border:1px solid var(--border)}}
    .project-front{{background:var(--bg-card);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:36px;text-align:center}}
    .project-front .project-icon{{font-size:56px;margin-bottom:20px}}
    .project-front h3{{font-family:var(--font-display);font-size:1.6rem;margin-bottom:8px}}
    .project-front .project-tag{{font-family:var(--font-mono);font-size:0.75rem;color:var(--accent2);padding:4px 14px;border:1px solid var(--accent-glow);border-radius:20px}}
    .project-front .flip-hint{{position:absolute;bottom:20px;font-size:0.7rem;color:var(--text-muted);font-family:var(--font-mono);opacity:0.6}}
    .project-back{{background:var(--bg-card-hover);transform:rotateY(180deg);padding:36px;display:flex;flex-direction:column;justify-content:center;border-color:var(--border-glow)}}
    .project-back h3{{font-family:var(--font-display);font-size:1.4rem;margin-bottom:12px;color:var(--accent2)}}
    .project-back p{{color:var(--text-secondary);font-size:0.9rem;margin-bottom:16px;line-height:1.6}}
    .project-back .project-stats{{display:flex;gap:20px;margin-bottom:16px}}
    .project-stat{{text-align:center}}
    .project-stat .stat-value{{font-family:var(--font-display);font-size:1.4rem;font-weight:700;color:var(--accent)}}
    .project-stat .stat-label{{font-size:0.7rem;color:var(--text-muted);font-family:var(--font-mono)}}
    .project-back .project-link{{display:inline-flex;align-items:center;gap:8px;color:var(--accent2);text-decoration:none;font-family:var(--font-mono);font-size:0.85rem;padding:8px 0;transition:gap 150ms ease}}
    .project-back .project-link:hover{{gap:14px}}

    /* Certs */
    .certs-grid{{display:flex;flex-wrap:wrap;gap:24px;justify-content:center}}
    .cert-badge{{display:flex;align-items:center;gap:14px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-md);padding:20px 28px;transition:all 350ms ease;cursor:pointer}}
    .cert-badge:hover{{transform:translateY(-4px);box-shadow:var(--shadow-glow);border-color:var(--border-glow)}}
    .cert-badge .cert-icon{{font-size:36px}}
    .cert-badge .cert-info h4{{font-family:var(--font-display);font-size:1rem}}
    .cert-badge .cert-info span{{font-family:var(--font-mono);font-size:0.75rem;color:var(--text-muted)}}

    /* Contact */
    .contact-wrapper{{display:grid;grid-template-columns:1fr 1fr;gap:40px;align-items:center}}
    .contact-map{{position:relative;aspect-ratio:4/3;background:var(--bg-card);border-radius:var(--radius-lg);border:1px solid var(--border);overflow:hidden}}
    .contact-map svg{{width:100%;height:100%}}
    .map-pin circle{{transition:r 150ms ease}}
    .map-pin:hover circle{{r:8}}
    .map-label{{font-family:var(--font-mono);font-size:11px;fill:var(--text-secondary);opacity:0;transition:opacity 150ms ease}}
    .map-pin:hover .map-label{{opacity:1}}
    .contact-info{{display:flex;flex-direction:column;gap:24px}}
    .contact-item{{display:flex;align-items:center;gap:16px;padding:18px 24px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-md);transition:all 350ms ease;cursor:pointer;text-decoration:none;color:inherit}}
    .contact-item:hover{{transform:translateX(8px);border-color:var(--border-glow);box-shadow:var(--shadow-glow)}}
    .contact-item .ci-symbol{{font-size:24px;color:var(--accent2)}}
    .contact-item .ci-text h4{{font-family:var(--font-display);font-size:0.95rem}}
    .contact-item .ci-text span{{font-family:var(--font-mono);font-size:0.8rem;color:var(--text-muted)}}

    /* Footer + Tooltips */
    footer{{text-align:center;padding:48px 24px;border-top:1px solid var(--border)}}
    footer p{{font-family:var(--font-mono);font-size:0.8rem;color:var(--text-muted)}}
    footer .footer-symbols{{margin-bottom:16px;font-size:20px;letter-spacing:16px;color:var(--text-muted)}}
    abbr{{text-decoration:none;border-bottom:1px dashed var(--text-muted);cursor:help;position:relative}}
    abbr::after{{content:attr(data-tooltip);position:absolute;bottom:calc(100% + 8px);left:50%;transform:translateX(-50%);background:var(--bg-card);border:1px solid var(--border-glow);color:var(--accent2);padding:4px 10px;border-radius:6px;font-family:var(--font-mono);font-size:0.7rem;white-space:nowrap;opacity:0;pointer-events:none;transition:opacity 150ms ease}}
    abbr:hover::after{{opacity:1}}

    /* Konami rain */
    .symbol-rain{{position:fixed;inset:0;pointer-events:none;z-index:99990}}
    .rain-sym{{position:absolute;font-size:32px;animation:rainDrop linear forwards;opacity:0.7}}
    @keyframes rainDrop{{0%{{transform:translateY(-10vh) rotate(0deg);opacity:1}}100%{{transform:translateY(110vh) rotate(720deg);opacity:0}}}}

    /* Responsive */
    @media(max-width:768px){{
      .sidebar{{left:8px;gap:12px}}
      .sidebar a{{width:36px;height:36px;font-size:15px}}
      .sidebar a .tooltip{{display:none}}
      .timeline::before{{left:24px}}
      .timeline-item,.timeline-item:nth-child(even){{flex-direction:column;padding-left:52px}}
      .timeline-dot{{left:24px!important}}
      .timeline-card{{max-width:100%}}
      .contact-wrapper{{grid-template-columns:1fr}}
      .project-card{{width:280px;height:360px}}
      .hero h1{{font-size:2.6rem}}
      .design-switcher{{bottom:16px;right:12px}}
    }}
    @media(max-width:480px){{
      .sidebar{{display:none}}
      .lang-toggle{{top:12px;right:12px}}
      section{{padding:60px 16px}}
      .project-card{{width:100%;max-width:300px}}
      .skills-marquee{{gap:10px}}
      .skill-chip{{padding:10px 18px;font-size:0.8rem}}
    }}

    {themes_css}
  </style>
</head>
<body>

  <div id="progress-bar"></div>

  <div class="lang-toggle">
    <button id="lang-en" class="active" onclick="switchLang('en')">EN</button>
    <button id="lang-sr" onclick="switchLang('sr')">SR</button>
  </div>

  <nav class="sidebar">
    <a href="#hero" class="active" aria-label="Home"><span class="tooltip">◆ Home</span>◆</a>
    <a href="#skills" aria-label="Skills"><span class="tooltip">⚙ Skills</span>⚙</a>
    <a href="#experience" aria-label="Experience"><span class="tooltip">⌘ Experience</span>⌘</a>
    <a href="#projects" aria-label="Projects"><span class="tooltip">◈ Projects</span>◈</a>
    <a href="#certs" aria-label="Certifications"><span class="tooltip">✦ Certs</span>✦</a>
    <a href="#contact" aria-label="Contact"><span class="tooltip">✆ Contact</span>✆</a>
  </nav>

  <!-- DESIGN SWITCHER -->
  <div class="design-switcher">
    <div id="design-menu">
      <button class="design-switcher-btn active" onclick="setDesign('neon-dark')"><span class="swatch" style="background:linear-gradient(135deg,#8B5CF6,#00D4FF)"></span> Neon Dark</button>
      <button class="design-switcher-btn" onclick="setDesign('brutalism')"><span class="swatch" style="background:#DD614C"></span> Brutalism</button>
      <button class="design-switcher-btn" onclick="setDesign('cosmic')"><span class="swatch" style="background:linear-gradient(135deg,#3B82F6,#8B5CF6)"></span> Cosmic</button>
      <button class="design-switcher-btn" onclick="setDesign('matrix')"><span class="swatch" style="background:#2DB58A"></span> Matrix</button>
      <button class="design-switcher-btn" onclick="setDesign('retro')"><span class="swatch" style="background:#D4742C"></span> Retro</button>
      <button class="design-switcher-btn" onclick="setDesign('luxury')"><span class="swatch" style="background:#000;border:1px solid #C8A45C"></span> Luxury</button>
      <button class="design-switcher-btn" onclick="setDesign('neon')"><span class="swatch" style="background:#BBF351"></span> Neon</button>
      <button class="design-switcher-btn" onclick="setDesign('minimal')"><span class="swatch" style="background:#F4F4F1;border:1px solid #312C85"></span> Minimal</button>
      <button class="design-switcher-btn" onclick="setDesign('paper')"><span class="swatch" style="background:#FAF9F6;border:1px solid #111"></span> Paper</button>
      <button class="design-switcher-btn" onclick="setDesign('futuristic')"><span class="swatch" style="background:linear-gradient(135deg,#3B82F6,#06B6D4)"></span> Futuristic</button>
    </div>
    <button class="design-switcher-btn" id="design-toggle" onclick="toggleDesignMenu()">🎨 <span id="design-label">Neon Dark</span></button>
  </div>

  <!-- HERO -->
  <section class="hero" id="hero">
    <div class="hero-bg"></div>
    <div class="hero-grid"></div>
    <canvas class="hero-nodes" id="nodeCanvas"></canvas>
    <div class="hero-content">
      <div class="hero-symbol">⌖</div>
      <h1 data-en="Dušan Milosavljević" data-sr="Душан Милосављевић">Dušan Milosavljević</h1>
      <div class="tagline"><span id="typewriter"></span><span class="cursor-blink"></span></div>
      <a href="#projects" class="hero-cta"><span data-en="◆ Explore My Work" data-sr="◆ Истражи мој рад">◆ Explore My Work</span></a>
    </div>
  </section>

  <!-- SKILLS -->
  <section id="skills">
    <div class="section-header">
      <div class="section-symbol">⚙</div>
      <h2 class="section-title" data-en="Core Skills" data-sr="Кључне вештине">Core Skills</h2>
      <p class="section-subtitle" data-en="Technologies, methodologies &amp; domains I work across" data-sr="Технологије, методологије и домени у којима радим">Technologies, methodologies &amp; domains I work across</p>
      <div class="section-divider"></div>
    </div>
    <div class="skills-marquee">
      <div class="skill-chip"><span class="chip-icon">◆</span> TypeScript<span class="chip-detail">aura-code · Node.js APIs</span></div>
      <div class="skill-chip"><span class="chip-icon">◆</span> AI / LLMs<span class="chip-detail">Claude · GPT · Gemini · MiMo</span></div>
      <div class="skill-chip"><span class="chip-icon">◆</span> Lean Six Sigma<span class="chip-detail"><abbr data-tooltip="Plan-Do-Check-Act">PDCA</abbr> · Kaizen · VSM</span></div>
      <div class="skill-chip"><span class="chip-icon">◆</span> Python<span class="chip-detail">Automation · Data · Scripts</span></div>
      <div class="skill-chip"><span class="chip-icon">◆</span> Education<span class="chip-detail">TEFL · Curriculum Design</span></div>
      <div class="skill-chip"><span class="chip-icon">◆</span> Fitness<span class="chip-detail">Coaching · Program Design</span></div>
      <div class="skill-chip"><span class="chip-icon">◆</span> Git / CI/CD<span class="chip-detail">GitHub Actions · Vitest</span></div>
      <div class="skill-chip"><span class="chip-icon">◆</span> System Design<span class="chip-detail">Multi-Agent Orchestration</span></div>
    </div>
  </section>

  <!-- EXPERIENCE -->
  <section id="experience">
    <div class="section-header">
      <div class="section-symbol">⌘</div>
      <h2 class="section-title" data-en="Experience" data-sr="Искуство">Experience</h2>
      <p class="section-subtitle" data-en="A multidisciplinary journey across AI, Lean, Education &amp; Fitness" data-sr="Мултидисциплинарно путовање кроз АИ, Lean, образовање и фитнес">A multidisciplinary journey across AI, Lean, Education &amp; Fitness</p>
      <div class="section-divider"></div>
    </div>
    <div class="timeline">
      <div class="timeline-item">
        <div class="timeline-dot ai"></div>
        <div class="timeline-card">
          <span class="role-badge ai">AI / Engineering</span>
          <h3 data-en="Creator of aura-code" data-sr="Креатор aura-code">Creator of aura-code</h3>
          <div class="period">2025 — Present</div>
          <p data-en="Built a model-agnostic autonomous coding agent. Multi-agent orchestration, 1,035+ tests, 6 LLM providers. MIT licensed open-source project." data-sr="Направио модел-агностичког аутономног кодинг агента. 1035+ тестова, 6 LLM провајдера. MIT лиценциран.">Built a model-agnostic autonomous coding agent. Multi-agent orchestration, 1,035+ tests, 6 LLM providers. MIT licensed open-source project.</p>
        </div>
        <div style="flex:1;max-width:420px"></div>
      </div>
      <div class="timeline-item">
        <div class="timeline-dot lean"></div>
        <div style="flex:1;max-width:420px"></div>
        <div class="timeline-card">
          <span class="role-badge lean">Lean Practitioner</span>
          <h3 data-en="Process Optimization" data-sr="Оптимизација процеса">Process Optimization</h3>
          <div class="period">2020 — Present</div>
          <p data-en="Applied <abbr data-tooltip='Plan-Do-Check-Act'>PDCA</abbr>, Kaizen, and Value Stream Mapping across education and tech workflows. Continuous improvement specialist." data-sr="Примењивао PDCA, Kaizen и Value Stream Mapping. Специјалиста за континуирано унапређење.">Applied <abbr data-tooltip="Plan-Do-Check-Act">PDCA</abbr>, Kaizen, and Value Stream Mapping across education and tech workflows. Continuous improvement specialist.</p>
        </div>
      </div>
      <div class="timeline-item">
        <div class="timeline-dot edu"></div>
        <div class="timeline-card">
          <span class="role-badge edu">Education</span>
          <h3 data-en="TEFL Educator &amp; Curriculum Designer" data-sr="TEFL предавач и дизајнер курикулума">TEFL Educator &amp; Curriculum Designer</h3>
          <div class="period">2018 — Present</div>
          <p data-en="Designed and delivered English language programs. Blended AI tools into pedagogy. Bilingual instruction (Serbian/English)." data-sr="Дизајнирао и изводио програме енглеског. Интегрисао АИ алате у педагогију. Двојезична настава.">Designed and delivered English language programs. Blended AI tools into pedagogy. Bilingual instruction (Serbian/English).</p>
        </div>
        <div style="flex:1;max-width:420px"></div>
      </div>
      <div class="timeline-item">
        <div class="timeline-dot fit"></div>
        <div style="flex:1;max-width:420px"></div>
        <div class="timeline-card">
          <span class="role-badge fit">Fitness</span>
          <h3 data-en="Fitness Coach &amp; Program Designer" data-sr="Фитнес тренер и дизајнер програма">Fitness Coach &amp; Program Designer</h3>
          <div class="period">2016 — Present</div>
          <p data-en="Certified fitness coach. Designed individualized training programs blending strength, mobility, and endurance principles." data-sr="Сертификовани фитнес тренер. Дизајнирао индивидуализоване програме — снага, мобилност, издржљивост.">Certified fitness coach. Designed individualized training programs blending strength, mobility, and endurance principles.</p>
        </div>
      </div>
    </div>
  </section>

  <!-- PROJECTS -->
  <section id="projects">
    <div class="section-header">
      <div class="section-symbol">◈</div>
      <h2 class="section-title" data-en="Projects" data-sr="Пројекти">Projects</h2>
      <p class="section-subtitle" data-en="Click to flip — see what's inside" data-sr="Кликни да окренеш — погледај шта је унутра">Click to flip — see what's inside</p>
      <div class="section-divider"></div>
    </div>
    <div class="projects-stack">
      <div class="project-card" id="project-aura" onclick="flipCard(this)">
        <div class="project-card-inner">
          <div class="project-face project-front">
            <div class="project-icon">◆</div><h3>aura-code</h3>
            <span class="project-tag">TypeScript · AI Agent</span>
            <span class="flip-hint">↻ click to flip</span>
          </div>
          <div class="project-face project-back">
            <h3>aura-code</h3>
            <p>Model-agnostic autonomous coding agent. Works with Claude, GPT, Gemini, MiMo, Ollama. Built by AI agents, orchestrated by humans.</p>
            <div class="project-stats">
              <div class="project-stat"><div class="stat-value" id="gh-stars">…</div><div class="stat-label">Stars</div></div>
              <div class="project-stat"><div class="stat-value">0</div><div class="stat-label">Open Issues</div></div>
              <div class="project-stat"><div class="stat-value">MIT</div><div class="stat-label">License</div></div>
            </div>
            <a href="https://github.com/milodule3-debug/aura-code" target="_blank" rel="noopener" class="project-link">View on GitHub →</a>
          </div>
        </div>
      </div>
      <div class="project-card" id="project-lean" onclick="flipCard(this)">
        <div class="project-card-inner">
          <div class="project-face project-front">
            <div class="project-icon">⌖</div><h3>Lean Progress IQ</h3>
            <span class="project-tag">Consulting · Lean</span>
            <span class="flip-hint">↻ click to flip</span>
          </div>
          <div class="project-face project-back">
            <h3>Lean Progress IQ</h3>
            <p>Continuous improvement consultancy bridging Lean methodologies with AI-powered tooling for education and business processes.</p>
            <div class="project-stats">
              <div class="project-stat"><div class="stat-value">◆</div><div class="stat-label">Method</div></div>
              <div class="project-stat"><div class="stat-value">B2B</div><div class="stat-label">Focus</div></div>
              <div class="project-stat"><div class="stat-value">Global</div><div class="stat-label">Reach</div></div>
            </div>
            <a href="https://lean-progress-iq-site.vercel.app" target="_blank" rel="noopener" class="project-link">Visit Site →</a>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- CERTS -->
  <section id="certs">
    <div class="section-header">
      <div class="section-symbol">✦</div>
      <h2 class="section-title" data-en="Certifications &amp; Languages" data-sr="Сертификати и језици">Certifications &amp; Languages</h2>
      <p class="section-subtitle" data-en="Formal qualifications and linguistic reach" data-sr="Формалне квалификације и језички домет">Formal qualifications and linguistic reach</p>
      <div class="section-divider"></div>
    </div>
    <div class="certs-grid">
      <div class="cert-badge"><div class="cert-icon">🏆</div><div class="cert-info"><h4>TEFL Certified</h4><span>Teaching English as a Foreign Language</span></div></div>
      <div class="cert-badge"><div class="cert-icon">🏋️</div><div class="cert-info"><h4>Fitness Coach</h4><span>Certified Personal Trainer</span></div></div>
      <div class="cert-badge"><div class="cert-icon">🎓</div><div class="cert-info"><h4>Lean Six Sigma</h4><span>Process Improvement</span></div></div>
      <div class="cert-badge"><div class="cert-icon">🗣️</div><div class="cert-info"><h4 data-en="Serbian (Native)" data-sr="Српски (матерњи)">Serbian (Native)</h4><span data-en="+ English (Fluent)" data-sr="+ Енглески (течно)">+ English (Fluent)</span></div></div>
    </div>
  </section>

  <!-- CONTACT -->
  <section id="contact">
    <div class="section-header">
      <div class="section-symbol">✆</div>
      <h2 class="section-title" data-en="Get in Touch" data-sr="Контакт">Get in Touch</h2>
      <p class="section-subtitle" data-en="Based in Da Nang &amp; Zrenjanin — available globally" data-sr="Базиран у Да Нангу и Зрењанину — доступан глобално">Based in Da Nang &amp; Zrenjanin — available globally</p>
      <div class="section-divider"></div>
    </div>
    <div class="contact-wrapper">
      <div class="contact-map">
        <svg viewBox="0 0 800 500" xmlns="http://www.w3.org/2000/svg">
          <rect width="800" height="500" fill="transparent"/>
          <g opacity="0.06"><ellipse cx="400" cy="180" rx="340" ry="120" fill="none" stroke="currentColor" stroke-width="1"/><line x1="400" y1="60" x2="400" y2="300" stroke="currentColor" stroke-width="0.5"/><line x1="60" y1="180" x2="740" y2="180" stroke="currentColor" stroke-width="0.5"/></g>
          <g class="map-pin" transform="translate(590,210)"><circle cx="0" cy="0" r="6" fill="var(--accent2)" stroke="var(--bg)" stroke-width="2"/><line x1="0" y1="6" x2="0" y2="18" stroke="var(--accent2)" stroke-width="1.5"/><text class="map-label" x="12" y="4">Da Nang, VN</text></g>
          <g class="map-pin" transform="translate(390,155)"><circle cx="0" cy="0" r="6" fill="#FF2D95" stroke="var(--bg)" stroke-width="2"/><line x1="0" y1="6" x2="0" y2="18" stroke="#FF2D95" stroke-width="1.5"/><text class="map-label" x="12" y="4">Zrenjanin, RS</text></g>
          <path d="M 390 155 Q 490 100 590 210" fill="none" stroke="var(--accent)" stroke-width="1" stroke-dasharray="6,4" opacity="0.4"/>
        </svg>
      </div>
      <div class="contact-info">
        <a href="mailto:leanproiq@gmail.com" class="contact-item"><div class="ci-symbol">✆</div><div class="ci-text"><h4>Email</h4><span>leanproiq@gmail.com</span></div></a>
        <a href="https://github.com/milodule3-debug" target="_blank" rel="noopener" class="contact-item"><div class="ci-symbol">⌘</div><div class="ci-text"><h4>GitHub</h4><span>milodule3-debug</span></div></a>
        <a href="https://lean-progress-iq-site.vercel.app" target="_blank" rel="noopener" class="contact-item"><div class="ci-symbol">◈</div><div class="ci-text"><h4>Website</h4><span>lean-progress-iq-site.vercel.app</span></div></a>
        <div class="contact-item"><div class="ci-symbol">◆</div><div class="ci-text"><h4 data-en="Location" data-sr="Локација">Location</h4><span>Da Nang, Vietnam · Zrenjanin, Serbia</span></div></div>
      </div>
    </div>
  </section>

  <footer>
    <div class="footer-symbols">◆ ⌖ ✆ ◈ ⌘</div>
    <p>© 2025 Dušan Milosavljević · Built with ◆ · Open source</p>
  </footer>

  <script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/ScrollTrigger.min.js"></script>
  <script>
    console.log('%c◆ %cLean Progress IQ %c◆','color:#00F5FF;font-size:24px;','color:#f0e6ff;font-size:18px;font-family:serif;','color:#00F5FF;font-size:24px;');
    console.log('%cOptimizing the future, one line of code at a time.','color:#b8a9d4;font-style:italic;');
    console.log('%chttps://github.com/milodule3-debug/aura-code','color:#8B5CF6;');

    // Scroll progress
    const progressBar=document.getElementById('progress-bar');
    window.addEventListener('scroll',()=>{{const s=window.scrollY,d=document.documentElement.scrollHeight-window.innerHeight;progressBar.style.width=(d>0?(s/d)*100:0)+'%'}});

    // Typewriter
    const phrases=['Multidisciplinary AI Builder | Lean Practitioner | Educator','Bridging AI, Lean, and Human Potential','Building agentic systems that verify, not try','Мултидисциплинарни АИ инжењер | Lean практичар | Едукатор'];
    let pi=0,ci=0,del=false,sp=70;
    function typeLoop(){{
      const el=document.getElementById('typewriter'),cur=phrases[pi];
      if(!del){{el.textContent=cur.substring(0,ci+1);ci++;if(ci===cur.length){{del=true;sp=2000}}else{{sp=50+Math.random()*40}}}}
      else{{el.textContent=cur.substring(0,ci-1);ci--;if(ci===0){{del=false;pi=(pi+1)%phrases.length;sp=200}}else{{sp=25}}}}
      setTimeout(typeLoop,sp);
    }}setTimeout(typeLoop,800);

    // Node canvas
    (function(){{
      const c=document.getElementById('nodeCanvas'),ctx=c.getContext('2d');
      let nodes=[],N=40;
      function rs(){{c.width=c.offsetWidth;c.height=c.offsetHeight}}rs();window.addEventListener('resize',rs);
      for(let i=0;i<N;i++)nodes.push({{x:Math.random()*c.width,y:Math.random()*c.height,vx:(Math.random()-0.5)*0.4,vy:(Math.random()-0.5)*0.4,r:1.5+Math.random()*2}});
      function draw(){{
        ctx.clearRect(0,0,c.width,c.height);
        for(let i=0;i<N;i++)for(let j=i+1;j<N;j++){{const dx=nodes[i].x-nodes[j].x,dy=nodes[i].y-nodes[j].y,dist=Math.sqrt(dx*dx+dy*dy);if(dist<160){{ctx.beginPath();ctx.moveTo(nodes[i].x,nodes[i].y);ctx.lineTo(nodes[j].x,nodes[j].y);ctx.strokeStyle='rgba(139,92,246,'+(0.12*(1-dist/160))+')';ctx.lineWidth=0.5;ctx.stroke()}}}}
        nodes.forEach(n=>{{ctx.beginPath();ctx.arc(n.x,n.y,n.r,0,Math.PI*2);ctx.fillStyle='rgba(139,92,246,0.35)';ctx.fill()}});
      }}
      function upd(){{nodes.forEach(n=>{{n.x+=n.vx;n.y+=n.vy;if(n.x<0||n.x>c.width)n.vx*=-1;if(n.y<0||n.y>c.height)n.vy*=-1}});draw();requestAnimationFrame(upd)}}upd();
    }})();

    // Project flip
    function flipCard(card){{card.classList.toggle('flipped')}}

    // GitHub API
    (async function(){{
      try{{const r=await fetch('https://api.github.com/repos/milodule3-debug/aura-code');if(r.ok){{const d=await r.json();document.getElementById('gh-stars').textContent=d.stargazers_count}}}}
      catch(e){{document.getElementById('gh-stars').textContent='2'}}
    }})();

    // Konami
    (function(){{
      const code=[38,38,40,40,37,39,37,39,66,65];let pos=0;
      document.addEventListener('keydown',e=>{{
        if(e.keyCode===code[pos]){{pos++;if(pos===code.length){{triggerRain();pos=0}}}}else{{pos=0}}
      }});
      function triggerRain(){{
        const ct=document.createElement('div');ct.className='symbol-rain';document.body.appendChild(ct);
        const sym=['◆','⌖','◈','✦','⚙','◉','⬡','△'];
        for(let i=0;i<40;i++)setTimeout(()=>{{const s=document.createElement('span');s.className='rain-sym';s.textContent=sym[Math.floor(Math.random()*sym.length)];s.style.left=(Math.random()*100)+'%';s.style.animationDuration=(2+Math.random()*3)+'s';s.style.color=['#00F5FF','#8B5CF6','#FF2D95','#00D4FF'][Math.floor(Math.random()*4)];ct.appendChild(s);setTimeout(()=>s.remove(),4000)}},i*60);
        setTimeout(()=>ct.remove(),5000);
      }}
    }})();

    // Language toggle
    let currentLang='en';
    window.switchLang=function(lang){{
      currentLang=lang;
      document.querySelectorAll('[data-en][data-sr]').forEach(el=>{{el.textContent=el.getAttribute('data-'+lang)}});
      document.getElementById('lang-en').classList.toggle('active',lang==='en');
      document.getElementById('lang-sr').classList.toggle('active',lang==='sr');
      document.documentElement.lang=lang==='sr'?'sr':'en';
      const h1=document.querySelector('.hero h1');
      if(h1)h1.textContent=h1.getAttribute('data-'+lang);
    }};

    // Design switcher
    window.toggleDesignMenu=function(){{document.getElementById('design-menu').classList.toggle('open')}};
    window.setDesign=function(name){{
      document.documentElement.setAttribute('data-design',name);
      document.getElementById('design-label').textContent=name.split('-').map(w=>w.charAt(0).toUpperCase()+w.slice(1)).join(' ');
      document.querySelectorAll('#design-menu .design-switcher-btn').forEach(b=>b.classList.remove('active'));
      document.querySelector('#design-menu .design-switcher-btn[onclick*="'+name+'"]').classList.add('active');
      document.getElementById('design-menu').classList.remove('open');
    }};

    // GSAP animations
    gsap.registerPlugin(ScrollTrigger);
    document.querySelectorAll('section').forEach(s=>gsap.from(s,{{scrollTrigger:{{trigger:s,start:'top 80%',toggleActions:'play none none none'}},opacity:0,y:40,duration:0.8,ease:'power3.out'}}));
    gsap.from('.timeline-card',{{scrollTrigger:{{trigger:'#experience',start:'top 70%'}},opacity:0,x:-30,stagger:0.2,duration:0.7,ease:'power3.out'}});
    gsap.from('.skill-chip',{{scrollTrigger:{{trigger:'#skills',start:'top 75%'}},opacity:0,y:20,scale:0.9,stagger:0.06,duration:0.5,ease:'back.out(1.5)'}});
    gsap.from('.cert-badge',{{scrollTrigger:{{trigger:'#certs',start:'top 80%'}},opacity:0,y:20,stagger:0.1,duration:0.5,ease:'power3.out'}});

    // Sidebar active tracking
    const sections=document.querySelectorAll('section[id]'),navLinks=document.querySelectorAll('.sidebar a');
    window.addEventListener('scroll',()=>{{let cur='';sections.forEach(s=>{{if(window.scrollY>=s.offsetTop-200)cur=s.getAttribute('id')}});navLinks.forEach(a=>a.classList.toggle('active',a.getAttribute('href')==='#'+cur))}});
  </script>
</body>
</html>'''

with open(output_path, 'w') as f:
    f.write(html)

print(f"Written {output_path} ({len(html)} bytes)")
