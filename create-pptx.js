const pptxgen = require("pptxgenjs");

const pres = new pptxgen();

// ─── Configuration ───
pres.layout = "LAYOUT_16x9";

const NAVY = "1A1A2E";
const NAVY_LIGHT = "232344";
const NAVY_MID = "2A2A4A";
const RUBY = "CC0033";
const RUBY_DARK = "990026";
const RUBY_LIGHT = "E63956";
const WHITE = "FFFFFF";
const GRAY = "8899AA";
const LIGHT_GRAY = "C0CCD8";
const GOLD = "FFB800";
const TEAL = "00D4AA";

// ═══════════════════════════════════════════════════════
// SLIDE 1: TITLE
// ═══════════════════════════════════════════════════════
const slide1 = pres.addSlide();
slide1.background = { color: NAVY };

// Large ruby red circle accent (top-right)
slide1.addShape(pres.ShapeType.ellipse, {
  x: 8.2, y: -1.5, w: 3.5, h: 3.5,
  fill: { color: RUBY, transparency: 70 },
});

// Smaller accent circle (bottom-left)
slide1.addShape(pres.ShapeType.ellipse, {
  x: -0.8, y: 4.5, w: 2.5, h: 2.5,
  fill: { color: RUBY, transparency: 80 },
});

// Ruby red accent bar - top
slide1.addShape(pres.ShapeType.rect, {
  x: 0.6, y: 1.4, w: 0.08, h: 1.8,
  fill: { color: RUBY },
});

// Main title
slide1.addText("Her Rubyness", {
  x: 1.0, y: 1.4, w: 8, h: 1.2,
  fontSize: 54, fontFace: "Arial Black", color: WHITE,
  bold: true, align: "left",
});

// Tagline
slide1.addText("I don't try. I verify.", {
  x: 1.0, y: 2.6, w: 8, h: 0.7,
  fontSize: 28, fontFace: "Arial", color: RUBY_LIGHT,
  italic: true, align: "left",
});

// Subtitle
slide1.addText("An AI Coding Agent — Built Entirely by AI Agents", {
  x: 1.0, y: 3.5, w: 8, h: 0.5,
  fontSize: 16, fontFace: "Arial", color: GRAY,
  align: "left",
});

// Bottom bar
slide1.addShape(pres.ShapeType.rect, {
  x: 0, y: 7.0, w: "100%", h: 0.05,
  fill: { color: RUBY },
});

// Version info
slide1.addText("TypeScript  •  MIT License  •  Open Source", {
  x: 1.0, y: 4.2, w: 8, h: 0.4,
  fontSize: 13, fontFace: "Arial", color: GRAY,
  align: "left",
});

// ═══════════════════════════════════════════════════════
// SLIDE 2: THE PROBLEM
// ═══════════════════════════════════════════════════════
const slide2 = pres.addSlide();
slide2.background = { color: NAVY };

// Top accent line
slide2.addShape(pres.ShapeType.rect, {
  x: 0, y: 0, w: "100%", h: 0.06,
  fill: { color: RUBY },
});

// Section label
slide2.addText("THE PROBLEM", {
  x: 0.6, y: 0.4, w: 4, h: 0.4,
  fontSize: 12, fontFace: "Arial", color: RUBY_LIGHT,
  bold: true, charSpacing: 4,
});

// Title
slide2.addText("AI Coding Is Broken", {
  x: 0.6, y: 0.8, w: 9, h: 0.8,
  fontSize: 40, fontFace: "Arial Black", color: WHITE,
  bold: true,
});

// Problem cards
const problems = [
  { title: "Expensive", desc: "Claude Opus costs $15/M input tokens\nfor every single coding task", icon: "$" },
  { title: "Inconsistent", desc: "Same prompt, different results.\nNo verification, no guarantees.", icon: "?" },
  { title: "Siloed", desc: "One model can't see the whole picture.\nNo memory across sessions.", icon: "!" },
];

problems.forEach((p, i) => {
  const xPos = 0.6 + i * 3.1;
  
  // Card background
  slide2.addShape(pres.ShapeType.rect, {
    x: xPos, y: 2.0, w: 2.8, h: 3.2,
    fill: { color: NAVY_MID },
    rectRadius: 0.1,
  });

  // Icon circle
  slide2.addShape(pres.ShapeType.ellipse, {
    x: xPos + 0.9, y: 2.2, w: 1.0, h: 1.0,
    fill: { color: RUBY, transparency: 30 },
  });

  // Icon text
  slide2.addText(p.icon, {
    x: xPos + 0.9, y: 2.2, w: 1.0, h: 1.0,
    fontSize: 32, fontFace: "Arial Black", color: WHITE,
    align: "center", valign: "middle",
  });

  // Card title
  slide2.addText(p.title, {
    x: xPos + 0.2, y: 3.3, w: 2.4, h: 0.5,
    fontSize: 18, fontFace: "Arial Black", color: WHITE,
    bold: true, align: "center",
  });

  // Card description
  slide2.addText(p.desc, {
    x: xPos + 0.2, y: 3.8, w: 2.4, h: 1.2,
    fontSize: 12, fontFace: "Arial", color: LIGHT_GRAY,
    align: "center", valign: "top",
  });
});

// Bottom stat
slide2.addText("70% of developers say AI coding tools don't meet their expectations", {
  x: 0.6, y: 5.8, w: 9, h: 0.4,
  fontSize: 13, fontFace: "Arial", color: GRAY,
  italic: true, align: "center",
});

// ═══════════════════════════════════════════════════════
// SLIDE 3: THE SOLUTION
// ═══════════════════════════════════════════════════════
const slide3 = pres.addSlide();
slide3.background = { color: NAVY };

// Top accent line
slide3.addShape(pres.ShapeType.rect, {
  x: 0, y: 0, w: "100%", h: 0.06,
  fill: { color: RUBY },
});

// Section label
slide3.addText("THE SOLUTION", {
  x: 0.6, y: 0.4, w: 4, h: 0.4,
  fontSize: 12, fontFace: "Arial", color: RUBY_LIGHT,
  bold: true, charSpacing: 4,
});

// Title
slide3.addText("Her Rubyness", {
  x: 0.6, y: 0.8, w: 9, h: 0.8,
  fontSize: 40, fontFace: "Arial Black", color: WHITE,
  bold: true,
});

slide3.addText("I don't try. I verify.", {
  x: 0.6, y: 1.5, w: 5, h: 0.5,
  fontSize: 20, fontFace: "Arial", color: RUBY_LIGHT,
  italic: true,
});

// Solution feature boxes - 2 rows of 3
const features = [
  { title: "Multi-Model\nSupport", desc: "Claude, GPT, Gemini,\nMiMo, Ollama" },
  { title: "Knowledge\nGraph", desc: "141 nodes, 142 edges\nof contextual memory" },
  { title: "Multi-Agent\nArchitecture", desc: "Researcher, Coder,\nReviewer work together" },
  { title: "87% Code\nCoverage", desc: "566 tests passing.\nQuality by design." },
  { title: "7× Cheaper\nThan Opus", desc: "MiMo delivers premium\nresults at budget cost" },
  { title: "Built by\nAI Agents", desc: "The ultimate proof:\nAI building AI tools" },
];

features.forEach((f, i) => {
  const row = Math.floor(i / 3);
  const col = i % 3;
  const xPos = 0.6 + col * 3.1;
  const yPos = 2.2 + row * 2.2;

  // Card bg
  slide3.addShape(pres.ShapeType.rect, {
    x: xPos, y: yPos, w: 2.8, h: 1.9,
    fill: { color: NAVY_MID },
    rectRadius: 0.1,
  });

  // Left accent
  slide3.addShape(pres.ShapeType.rect, {
    x: xPos, y: yPos, w: 0.06, h: 1.9,
    fill: { color: RUBY },
  });

  // Title
  slide3.addText(f.title, {
    x: xPos + 0.2, y: yPos + 0.15, w: 2.4, h: 0.8,
    fontSize: 15, fontFace: "Arial Black", color: WHITE,
    bold: true, align: "left", valign: "top",
  });

  // Description
  slide3.addText(f.desc, {
    x: xPos + 0.2, y: yPos + 1.0, w: 2.4, h: 0.7,
    fontSize: 11, fontFace: "Arial", color: GRAY,
    align: "left", valign: "top",
  });
});

// ═══════════════════════════════════════════════════════
// SLIDE 4: ARCHITECTURE
// ═══════════════════════════════════════════════════════
const slide4 = pres.addSlide();
slide4.background = { color: NAVY };

// Top accent
slide4.addShape(pres.ShapeType.rect, {
  x: 0, y: 0, w: "100%", h: 0.06,
  fill: { color: RUBY },
});

// Section label
slide4.addText("ARCHITECTURE", {
  x: 0.6, y: 0.3, w: 4, h: 0.35,
  fontSize: 12, fontFace: "Arial", color: RUBY_LIGHT,
  bold: true, charSpacing: 4,
});

// Title
slide4.addText("How It's Built", {
  x: 0.6, y: 0.65, w: 9, h: 0.7,
  fontSize: 36, fontFace: "Arial Black", color: WHITE,
  bold: true,
});

// Architecture flow diagram - horizontal pipeline
const archSteps = [
  { label: "CLI\nInterface", color: GRAY },
  { label: "Router", color: "4466AA" },
  { label: "Agent Loop\nOrchestrator", color: RUBY },
  { label: "Memory\nLayer", color: "448866" },
  { label: "Knowledge\nGraph", color: GOLD },
  { label: "LLM\nProviders", color: "6644AA" },
];

archSteps.forEach((step, i) => {
  const xPos = 0.4 + i * 1.62;
  
  // Box
  slide4.addShape(pres.ShapeType.rect, {
    x: xPos, y: 1.7, w: 1.42, h: 1.3,
    fill: { color: step.color, transparency: 20 },
    line: { color: step.color, width: 2 },
    rectRadius: 0.08,
  });

  // Label
  slide4.addText(step.label, {
    x: xPos, y: 1.7, w: 1.42, h: 1.3,
    fontSize: 12, fontFace: "Arial", color: WHITE,
    bold: true, align: "center", valign: "middle",
  });

  // Arrow (except last)
  if (i < archSteps.length - 1) {
    slide4.addText("→", {
      x: xPos + 1.42, y: 1.7, w: 0.2, h: 1.3,
      fontSize: 20, color: RUBY_LIGHT, align: "center", valign: "middle",
    });
  }
});

// Multi-agent section
slide4.addText("MULTI-AGENT PIPELINE", {
  x: 0.6, y: 3.5, w: 5, h: 0.35,
  fontSize: 12, fontFace: "Arial", color: RUBY_LIGHT,
  bold: true, charSpacing: 3,
});

const agents = [
  { label: "Researcher", desc: "Analyzes codebase & context", color: "4488CC", icon: "🔍" },
  { label: "Coder", desc: "Generates & implements changes", color: RUBY, icon: "⚡" },
  { label: "Reviewer", desc: "Validates & verifies output", color: "44AA66", icon: "✓" },
];

agents.forEach((agent, i) => {
  const xPos = 0.6 + i * 3.1;
  
  // Agent card
  slide4.addShape(pres.ShapeType.rect, {
    x: xPos, y: 4.1, w: 2.8, h: 1.6,
    fill: { color: NAVY_MID },
    rectRadius: 0.1,
  });

  // Colored top bar
  slide4.addShape(pres.ShapeType.rect, {
    x: xPos, y: 4.1, w: 2.8, h: 0.08,
    fill: { color: agent.color },
  });

  // Icon
  slide4.addText(agent.icon, {
    x: xPos + 0.15, y: 4.3, w: 0.5, h: 0.5,
    fontSize: 22, align: "center", valign: "middle",
  });

  // Agent name
  slide4.addText(agent.label, {
    x: xPos + 0.6, y: 4.3, w: 2.0, h: 0.45,
    fontSize: 16, fontFace: "Arial Black", color: WHITE,
    bold: true, valign: "middle",
  });

  // Agent description
  slide4.addText(agent.desc, {
    x: xPos + 0.15, y: 5.0, w: 2.5, h: 0.5,
    fontSize: 12, fontFace: "Arial", color: GRAY,
  });

  // Arrow between agents
  if (i < agents.length - 1) {
    slide4.addText("→", {
      x: xPos + 2.8, y: 4.5, w: 0.3, h: 0.6,
      fontSize: 22, color: RUBY_LIGHT, align: "center", valign: "middle",
    });
  }
});

// Flow description at bottom
slide4.addText("Each task flows through specialized agents — research first, then code, then review — ensuring quality at every step.", {
  x: 0.6, y: 6.0, w: 9, h: 0.5,
  fontSize: 12, fontFace: "Arial", color: GRAY,
  italic: true, align: "center",
});

// ═══════════════════════════════════════════════════════
// SLIDE 5: FEATURES
// ═══════════════════════════════════════════════════════
const slide5 = pres.addSlide();
slide5.background = { color: NAVY };

// Top accent
slide5.addShape(pres.ShapeType.rect, {
  x: 0, y: 0, w: "100%", h: 0.06,
  fill: { color: RUBY },
});

// Section label
slide5.addText("FEATURES", {
  x: 0.6, y: 0.4, w: 4, h: 0.35,
  fontSize: 12, fontFace: "Arial", color: RUBY_LIGHT,
  bold: true, charSpacing: 4,
});

// Title
slide5.addText("Built for Developers", {
  x: 0.6, y: 0.8, w: 9, h: 0.7,
  fontSize: 36, fontFace: "Arial Black", color: WHITE,
  bold: true,
});

// Feature grid - 2 columns
const featureList = [
  { title: "Knowledge Graph Memory", desc: "Contextual understanding of your entire codebase. 141 interconnected nodes remember everything.", color: GOLD },
  { title: "Multi-Model Flexibility", desc: "Switch between Claude, GPT, Gemini, MiMo, or Ollama. Use the right model for each task.", color: "4488CC" },
  { title: "Verification-First", desc: "566 tests and 87% coverage aren't just numbers — they're the philosophy. Verify, then trust.", color: RUBY },
  { title: "Agent Orchestration", desc: "Research, code, review — specialized agents collaborate like a senior engineering team.", color: TEAL },
  { title: "Cost Intelligence", desc: "MiMo delivers 1/7 the cost of Claude Opus without sacrificing quality on most tasks.", color: "AA66CC" },
  { title: "Open & Extensible", desc: "MIT licensed. TypeScript. Community-driven. Fork it, extend it, make it yours.", color: "44AA66" },
];

featureList.forEach((f, i) => {
  const row = Math.floor(i / 2);
  const col = i % 2;
  const xPos = 0.6 + col * 4.7;
  const yPos = 1.7 + row * 1.6;

  // Card
  slide5.addShape(pres.ShapeType.rect, {
    x: xPos, y: yPos, w: 4.4, h: 1.35,
    fill: { color: NAVY_MID },
    rectRadius: 0.08,
  });

  // Left color bar
  slide5.addShape(pres.ShapeType.rect, {
    x: xPos, y: yPos, w: 0.06, h: 1.35,
    fill: { color: f.color },
  });

  // Title
  slide5.addText(f.title, {
    x: xPos + 0.25, y: yPos + 0.1, w: 3.9, h: 0.4,
    fontSize: 15, fontFace: "Arial Black", color: WHITE,
    bold: true,
  });

  // Description
  slide5.addText(f.desc, {
    x: xPos + 0.25, y: yPos + 0.55, w: 3.9, h: 0.65,
    fontSize: 11, fontFace: "Arial", color: LIGHT_GRAY,
    valign: "top",
  });
});

// ═══════════════════════════════════════════════════════
// SLIDE 6: SUPPORTED MODELS
// ═══════════════════════════════════════════════════════
const slide6 = pres.addSlide();
slide6.background = { color: NAVY };

// Top accent
slide6.addShape(pres.ShapeType.rect, {
  x: 0, y: 0, w: "100%", h: 0.06,
  fill: { color: RUBY },
});

// Section label
slide6.addText("SUPPORTED MODELS", {
  x: 0.6, y: 0.4, w: 5, h: 0.35,
  fontSize: 12, fontFace: "Arial", color: RUBY_LIGHT,
  bold: true, charSpacing: 4,
});

// Title
slide6.addText("Your Model, Your Rules", {
  x: 0.6, y: 0.8, w: 9, h: 0.7,
  fontSize: 36, fontFace: "Arial Black", color: WHITE,
  bold: true,
});

const models = [
  { name: "Claude", provider: "Anthropic", color: "CC8844", desc: "Best reasoning & code quality", tier: "Premium" },
  { name: "GPT-4", provider: "OpenAI", color: "44AA88", desc: "Broad capability & ecosystem", tier: "Premium" },
  { name: "Gemini", provider: "Google", color: "4488CC", desc: "Multimodal & fast inference", tier: "Premium" },
  { name: "MiMo", provider: "Xiaomi", color: RUBY, desc: "1/7 cost of Opus, great for code", tier: "Best Value" },
  { name: "Ollama", provider: "Local", color: "666688", desc: "Run fully offline, zero cost", tier: "Free" },
];

models.forEach((m, i) => {
  const xPos = 0.4 + i * 1.9;
  
  // Card
  slide6.addShape(pres.ShapeType.rect, {
    x: xPos, y: 1.7, w: 1.7, h: 3.8,
    fill: { color: NAVY_MID },
    rectRadius: 0.1,
  });

  // Color top bar
  slide6.addShape(pres.ShapeType.rect, {
    x: xPos, y: 1.7, w: 1.7, h: 0.08,
    fill: { color: m.color },
  });

  // Model name
  slide6.addText(m.name, {
    x: xPos, y: 2.0, w: 1.7, h: 0.6,
    fontSize: 20, fontFace: "Arial Black", color: WHITE,
    bold: true, align: "center",
  });

  // Provider
  slide6.addText(m.provider, {
    x: xPos, y: 2.6, w: 1.7, h: 0.35,
    fontSize: 11, fontFace: "Arial", color: GRAY,
    align: "center",
  });

  // Divider
  slide6.addShape(pres.ShapeType.rect, {
    x: xPos + 0.3, y: 3.1, w: 1.1, h: 0.02,
    fill: { color: m.color, transparency: 50 },
  });

  // Description
  slide6.addText(m.desc, {
    x: xPos + 0.1, y: 3.3, w: 1.5, h: 0.8,
    fontSize: 10, fontFace: "Arial", color: LIGHT_GRAY,
    align: "center", valign: "top",
  });

  // Tier badge
  slide6.addShape(pres.ShapeType.rect, {
    x: xPos + 0.2, y: 4.8, w: 1.3, h: 0.4,
    fill: { color: m.color, transparency: 70 },
    rectRadius: 0.05,
  });

  slide6.addText(m.tier, {
    x: xPos + 0.2, y: 4.8, w: 1.3, h: 0.4,
    fontSize: 10, fontFace: "Arial", color: WHITE,
    bold: true, align: "center", valign: "middle",
  });
});

// Cost comparison bar
slide6.addText("COST COMPARISON (relative)", {
  x: 0.6, y: 5.9, w: 5, h: 0.3,
  fontSize: 11, fontFace: "Arial", color: RUBY_LIGHT,
  bold: true, charSpacing: 2,
});

// Cost bars
const costs = [
  { name: "Claude Opus", pct: 1.0, color: "CC8844" },
  { name: "GPT-4", pct: 0.7, color: "44AA88" },
  { name: "MiMo", pct: 0.14, color: RUBY },
  { name: "Ollama", pct: 0.0, color: "666688" },
];

costs.forEach((c, i) => {
  const yPos = 6.25 + i * 0.22;
  
  // Label
  slide6.addText(c.name, {
    x: 0.6, y: yPos, w: 1.3, h: 0.2,
    fontSize: 9, fontFace: "Arial", color: GRAY,
    align: "right",
  });

  // Bar bg
  slide6.addShape(pres.ShapeType.rect, {
    x: 2.1, y: yPos + 0.02, w: 7.2, h: 0.15,
    fill: { color: NAVY_MID },
    rectRadius: 0.03,
  });

  // Bar fill
  if (c.pct > 0) {
    slide6.addShape(pres.ShapeType.rect, {
      x: 2.1, y: yPos + 0.02, w: 7.2 * c.pct, h: 0.15,
      fill: { color: c.color },
      rectRadius: 0.03,
    });
  }
});

// ═══════════════════════════════════════════════════════
// SLIDE 7: STATS & METRICS
// ═══════════════════════════════════════════════════════
const slide7 = pres.addSlide();
slide7.background = { color: NAVY };

// Top accent
slide7.addShape(pres.ShapeType.rect, {
  x: 0, y: 0, w: "100%", h: 0.06,
  fill: { color: RUBY },
});

// Section label
slide7.addText("BY THE NUMBERS", {
  x: 0.6, y: 0.4, w: 5, h: 0.35,
  fontSize: 12, fontFace: "Arial", color: RUBY_LIGHT,
  bold: true, charSpacing: 4,
});

// Title
slide7.addText("Quality You Can Measure", {
  x: 0.6, y: 0.8, w: 9, h: 0.7,
  fontSize: 36, fontFace: "Arial Black", color: WHITE,
  bold: true,
});

// Big stat cards
const stats = [
  { number: "566", label: "Tests Passing", sub: "Automated & verified", color: RUBY },
  { number: "87%", label: "Code Coverage", sub: "Thorough by design", color: TEAL },
  { number: "141", label: "KG Nodes", sub: "Knowledge graph entities", color: GOLD },
  { number: "142", label: "KG Edges", sub: "Relationships mapped", color: "AA66CC" },
];

stats.forEach((s, i) => {
  const xPos = 0.5 + i * 2.35;
  
  // Card
  slide7.addShape(pres.ShapeType.rect, {
    x: xPos, y: 1.7, w: 2.15, h: 2.8,
    fill: { color: NAVY_MID },
    rectRadius: 0.12,
  });

  // Big number
  slide7.addText(s.number, {
    x: xPos, y: 1.9, w: 2.15, h: 1.2,
    fontSize: 48, fontFace: "Arial Black", color: s.color,
    bold: true, align: "center", valign: "middle",
  });

  // Label
  slide7.addText(s.label, {
    x: xPos, y: 3.1, w: 2.15, h: 0.5,
    fontSize: 14, fontFace: "Arial Black", color: WHITE,
    bold: true, align: "center",
  });

  // Sub
  slide7.addText(s.sub, {
    x: xPos, y: 3.5, w: 2.15, h: 0.4,
    fontSize: 10, fontFace: "Arial", color: GRAY,
    align: "center",
  });
});

// Chart area - bar chart simulation
slide7.addText("TEST COVERAGE BREAKDOWN", {
  x: 0.6, y: 4.8, w: 5, h: 0.35,
  fontSize: 11, fontFace: "Arial", color: RUBY_LIGHT,
  bold: true, charSpacing: 2,
});

const coverageData = [
  { label: "Unit Tests", pct: 0.92, color: RUBY },
  { label: "Integration", pct: 0.85, color: TEAL },
  { label: "E2E", pct: 0.78, color: GOLD },
  { label: "Overall", pct: 0.87, color: "AA66CC" },
];

coverageData.forEach((c, i) => {
  const yPos = 5.3 + i * 0.35;
  
  slide7.addText(c.label, {
    x: 0.6, y: yPos, w: 1.5, h: 0.3,
    fontSize: 11, fontFace: "Arial", color: LIGHT_GRAY,
    align: "right",
  });

  // Bar bg
  slide7.addShape(pres.ShapeType.rect, {
    x: 2.3, y: yPos + 0.03, w: 6.8, h: 0.22,
    fill: { color: NAVY_MID },
    rectRadius: 0.04,
  });

  // Bar fill
  slide7.addShape(pres.ShapeType.rect, {
    x: 2.3, y: yPos + 0.03, w: 6.8 * c.pct, h: 0.22,
    fill: { color: c.color },
    rectRadius: 0.04,
  });

  // Percentage label
  slide7.addText(Math.round(c.pct * 100) + "%", {
    x: 2.3 + 6.8 * c.pct + 0.1, y: yPos, w: 0.6, h: 0.3,
    fontSize: 10, fontFace: "Arial", color: c.color,
    bold: true,
  });
});

// ═══════════════════════════════════════════════════════
// SLIDE 8: HOW IT WORKS
// ═══════════════════════════════════════════════════════
const slide8 = pres.addSlide();
slide8.background = { color: NAVY };

// Top accent
slide8.addShape(pres.ShapeType.rect, {
  x: 0, y: 0, w: "100%", h: 0.06,
  fill: { color: RUBY },
});

// Section label
slide8.addText("HOW IT WORKS", {
  x: 0.6, y: 0.4, w: 4, h: 0.35,
  fontSize: 12, fontFace: "Arial", color: RUBY_LIGHT,
  bold: true, charSpacing: 4,
});

// Title
slide8.addText("From Prompt to Verified Code", {
  x: 0.6, y: 0.8, w: 9, h: 0.7,
  fontSize: 36, fontFace: "Arial Black", color: WHITE,
  bold: true,
});

// Step-by-step flow
const steps = [
  { num: "01", title: "You Ask", desc: "Natural language request\nthrough the CLI interface", color: GRAY },
  { num: "02", title: "Route", desc: "Router selects optimal model\nbased on task complexity", color: "4466AA" },
  { num: "03", title: "Research", desc: "Researcher agent scans your\ncodebase & knowledge graph", color: "4488CC" },
  { num: "04", title: "Code", desc: "Coder agent generates changes\nwith full context awareness", color: RUBY },
  { num: "05", title: "Review", desc: "Reviewer agent validates,\nruns tests, verifies quality", color: TEAL },
  { num: "06", title: "Deliver", desc: "Verified, tested code\nready for your approval", color: GOLD },
];

steps.forEach((s, i) => {
  const xPos = 0.3 + i * 1.6;
  
  // Step card
  slide8.addShape(pres.ShapeType.rect, {
    x: xPos, y: 1.7, w: 1.4, h: 4.2,
    fill: { color: NAVY_MID },
    rectRadius: 0.1,
  });

  // Number circle
  slide8.addShape(pres.ShapeType.ellipse, {
    x: xPos + 0.35, y: 1.9, w: 0.7, h: 0.7,
    fill: { color: s.color },
  });

  slide8.addText(s.num, {
    x: xPos + 0.35, y: 1.9, w: 0.7, h: 0.7,
    fontSize: 18, fontFace: "Arial Black", color: WHITE,
    bold: true, align: "center", valign: "middle",
  });

  // Step title
  slide8.addText(s.title, {
    x: xPos + 0.05, y: 2.8, w: 1.3, h: 0.5,
    fontSize: 14, fontFace: "Arial Black", color: WHITE,
    bold: true, align: "center",
  });

  // Step description
  slide8.addText(s.desc, {
    x: xPos + 0.05, y: 3.4, w: 1.3, h: 1.5,
    fontSize: 10, fontFace: "Arial", color: LIGHT_GRAY,
    align: "center", valign: "top",
  });

  // Arrow connector (except last)
  if (i < steps.length - 1) {
    slide8.addText("▸", {
      x: xPos + 1.4, y: 3.3, w: 0.2, h: 0.8,
      fontSize: 18, color: RUBY_LIGHT, align: "center", valign: "middle",
    });
  }
});

// Verification callout
slide8.addShape(pres.ShapeType.rect, {
  x: 0.6, y: 6.2, w: 8.8, h: 0.7,
  fill: { color: RUBY, transparency: 80 },
  line: { color: RUBY, width: 1 },
  rectRadius: 0.08,
});

slide8.addText("✦  Every output is automatically tested against 566 test cases before delivery  ✦", {
  x: 0.6, y: 6.2, w: 8.8, h: 0.7,
  fontSize: 14, fontFace: "Arial", color: WHITE,
  bold: true, align: "center", valign: "middle",
});

// ═══════════════════════════════════════════════════════
// SLIDE 9: KNOWLEDGE GRAPH DEEP DIVE
// ═══════════════════════════════════════════════════════
const slide9 = pres.addSlide();
slide9.background = { color: NAVY };

// Top accent
slide9.addShape(pres.ShapeType.rect, {
  x: 0, y: 0, w: "100%", h: 0.06,
  fill: { color: RUBY },
});

// Section label
slide9.addText("KNOWLEDGE GRAPH", {
  x: 0.6, y: 0.4, w: 5, h: 0.35,
  fontSize: 12, fontFace: "Arial", color: RUBY_LIGHT,
  bold: true, charSpacing: 4,
});

// Title
slide9.addText("The Brain Behind the Agent", {
  x: 0.6, y: 0.8, w: 9, h: 0.7,
  fontSize: 36, fontFace: "Arial Black", color: WHITE,
  bold: true,
});

// Central node visualization (stylized)
// Central "Her Rubyness" node
slide9.addShape(pres.ShapeType.ellipse, {
  x: 3.8, y: 2.3, w: 2.4, h: 2.4,
  fill: { color: RUBY },
  shadow: { type: "outer", blur: 20, offset: 0, color: RUBY, opacity: 0.5 },
});

slide9.addText("Her\nRubyness", {
  x: 3.8, y: 2.3, w: 2.4, h: 2.4,
  fontSize: 18, fontFace: "Arial Black", color: WHITE,
  bold: true, align: "center", valign: "middle",
});

// Surrounding nodes
const kgNodes = [
  { label: "Codebase\nUnderstanding", x: 1.0, y: 1.8, color: GOLD },
  { label: "Project\nContext", x: 7.0, y: 1.8, color: TEAL },
  { label: "Dependencies", x: 0.8, y: 3.8, color: "4488CC" },
  { label: "Patterns", x: 7.2, y: 3.8, color: "AA66CC" },
  { label: "Best\nPractices", x: 2.5, y: 5.2, color: "44AA66" },
  { label: "Error\nKnowledge", x: 5.5, y: 5.2, color: "CC8844" },
];

kgNodes.forEach((n) => {
  // Node circle
  slide9.addShape(pres.ShapeType.ellipse, {
    x: n.x, y: n.y, w: 1.6, h: 1.2,
    fill: { color: n.color, transparency: 30 },
    line: { color: n.color, width: 1.5 },
  });

  // Node label
  slide9.addText(n.label, {
    x: n.x, y: n.y, w: 1.6, h: 1.2,
    fontSize: 10, fontFace: "Arial", color: WHITE,
    bold: true, align: "center", valign: "middle",
  });
});

// Stats sidebar
slide9.addShape(pres.ShapeType.rect, {
  x: 0.6, y: 5.0, w: 1.8, h: 1.6,
  fill: { color: NAVY_MID },
  rectRadius: 0.1,
});

slide9.addText([
  { text: "141", options: { fontSize: 30, fontFace: "Arial Black", color: GOLD, bold: true, breakLine: true } },
  { text: "nodes in graph", options: { fontSize: 10, fontFace: "Arial", color: GRAY, breakLine: true } },
  { text: "142", options: { fontSize: 30, fontFace: "Arial Black", color: TEAL, bold: true, breakLine: true } },
  { text: "edges mapped", options: { fontSize: 10, fontFace: "Arial", color: GRAY } },
], {
  x: 0.7, y: 5.1, w: 1.6, h: 1.4,
  align: "center", valign: "middle",
});

// Right info panel
slide9.addShape(pres.ShapeType.rect, {
  x: 7.4, y: 5.0, w: 2.2, h: 1.6,
  fill: { color: NAVY_MID },
  rectRadius: 0.1,
});

slide9.addText([
  { text: "Contextual", options: { fontSize: 14, fontFace: "Arial Black", color: RUBY, bold: true, breakLine: true } },
  { text: "Memory", options: { fontSize: 14, fontFace: "Arial Black", color: WHITE, bold: true, breakLine: true } },
  { text: " ", options: { fontSize: 6, breakLine: true } },
  { text: "Every interaction enriches\nthe knowledge graph", options: { fontSize: 10, fontFace: "Arial", color: GRAY } },
], {
  x: 7.5, y: 5.1, w: 2.0, h: 1.4,
  align: "center", valign: "middle",
});

// ═══════════════════════════════════════════════════════
// SLIDE 10: CALL TO ACTION
// ═══════════════════════════════════════════════════════
const slide10 = pres.addSlide();
slide10.background = { color: NAVY };

// Large ruby circle accent (background)
slide10.addShape(pres.ShapeType.ellipse, {
  x: 2.5, y: 0.5, w: 5, h: 5,
  fill: { color: RUBY, transparency: 85 },
});

slide10.addShape(pres.ShapeType.ellipse, {
  x: 5.0, y: 2.5, w: 6, h: 6,
  fill: { color: RUBY, transparency: 90 },
});

// Top accent
slide10.addShape(pres.ShapeType.rect, {
  x: 0, y: 0, w: "100%", h: 0.06,
  fill: { color: RUBY },
});

// Section label
slide10.addText("GET STARTED", {
  x: 0.6, y: 0.4, w: 4, h: 0.35,
  fontSize: 12, fontFace: "Arial", color: RUBY_LIGHT,
  bold: true, charSpacing: 4,
});

// Main CTA text
slide10.addText("I don't try.\nI verify.", {
  x: 0.6, y: 1.2, w: 9, h: 2.0,
  fontSize: 54, fontFace: "Arial Black", color: WHITE,
  bold: true, align: "center", valign: "middle",
  lineSpacingMultiple: 1.1,
});

// Tagline
slide10.addText("The AI coding agent that actually delivers.", {
  x: 0.6, y: 3.0, w: 9, h: 0.6,
  fontSize: 20, fontFace: "Arial", color: LIGHT_GRAY,
  align: "center",
});

// CTA button
slide10.addShape(pres.ShapeType.rect, {
  x: 3.5, y: 4.0, w: 3, h: 0.8,
  fill: { color: RUBY },
  shadow: { type: "outer", blur: 10, offset: 3, color: RUBY, opacity: 0.5 },
  rectRadius: 0.1,
});

slide10.addText("npm install her-rubyness", {
  x: 3.5, y: 4.0, w: 3, h: 0.8,
  fontSize: 16, fontFace: "Courier New", color: WHITE,
  bold: true, align: "center", valign: "middle",
});

// Links row
slide10.addText("github.com/her-rubyness", {
  x: 0.6, y: 5.2, w: 3, h: 0.4,
  fontSize: 14, fontFace: "Arial", color: RUBY_LIGHT,
  align: "center",
});

slide10.addText("TypeScript  •  MIT License  •  Open Source", {
  x: 3.5, y: 5.2, w: 3, h: 0.4,
  fontSize: 12, fontFace: "Arial", color: GRAY,
  align: "center",
});

slide10.addText("566 tests  •  87% coverage", {
  x: 6.5, y: 5.2, w: 3, h: 0.4,
  fontSize: 12, fontFace: "Arial", color: GRAY,
  align: "center",
});

// Bottom accent bar
slide10.addShape(pres.ShapeType.rect, {
  x: 0, y: 7.0, w: "100%", h: 0.06,
  fill: { color: RUBY },
});

// Final message
slide10.addText("Built by AI agents. Verified by tests. Ready for you.", {
  x: 0.6, y: 5.8, w: 9, h: 0.5,
  fontSize: 14, fontFace: "Arial", color: GRAY,
  italic: true, align: "center",
});

// ─── Save ───
pres.writeFile({ fileName: "/home/dusan/ruby-code/Her-Rubyness.pptx" })
  .then(() => {
    console.log("✓ Presentation saved to /home/dusan/ruby-code/Her-Rubyness.pptx");
    console.log("  Slides: " + pres.slides.length);
  })
  .catch(err => {
    console.error("Error:", err);
  });
