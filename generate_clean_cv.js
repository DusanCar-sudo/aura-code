const fs = require('fs');

const originalHtml = fs.readFileSync('temp_cv.html', 'utf-8');

const newStyle = `
<style>
:root{
  --bg:#ffffff;
  --panel:#f3f4f6;
  --ink:#111827;
  --muted:#4b5563;
  --faint:#9ca3af;
  --line:#e5e7eb;
  --accent:#0052cc;
  --accent2:#003d99;
  --grad:linear-gradient(135deg,#0052cc,#003d99);
}
@page{size:A4;margin:0;}
@media print{.page{margin:0;box-shadow:none;}}
*{margin:0;padding:0;box-sizing:border-box;}
html{font-size:13px;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
body{
  font-family:'Inter','Helvetica Neue',system-ui,-apple-system,sans-serif;
  background:#f9fafb;
  color:var(--ink);
  line-height:1.45;
  -webkit-font-smoothing:antialiased;
}
.page{
  max-width:210mm;
  min-height:297mm;
  margin:10mm auto;
  background:var(--bg);
  display:grid;
  grid-template-columns:62mm 1fr;
  box-shadow:0 0 20px rgba(0,0,0,.05);
}
.page-break{page-break-after:always;break-after:page;}

/* ---------- SIDEBAR ---------- */
.sidebar{
  background:#f8fafc;
  border-right:1px solid var(--line);
  padding:11mm 6mm 9mm;
  display:flex;
  flex-direction:column;
}
.avatar{
  width:100%;
  height:52mm;
  border-radius:4px;
  background:#e2e8f0;
  border:1px solid var(--line);
  display:flex;align-items:flex-end;justify-content:flex-start;
  position:relative;overflow:hidden;margin-bottom:5mm;
}
.avatar .mono{
  font-size:30px;font-weight:800;letter-spacing:.06em;
  color:var(--accent);padding:6mm 5mm;
}
.side-h{
  font-size:.64rem;letter-spacing:.22em;text-transform:uppercase;
  color:var(--accent);margin:5.5mm 0 2.5mm;font-weight:700;
}
.side-h:first-of-type{margin-top:1mm;}
.side-ul{list-style:none;}
.side-ul li{font-size:.74rem;color:var(--muted);margin-bottom:2.6mm;line-height:1.35;}
.side-ul li b{color:var(--ink);font-weight:600;display:block;}
.side-ul li .sub{color:var(--faint);font-size:.68rem;display:block;margin-top:1px;}
.kv{font-size:.7rem;color:var(--muted);margin-bottom:1.3mm;word-break:break-word;}
.kv b{color:var(--ink);font-weight:600;}
.lang-row{margin-bottom:2.4mm;}
.lang-name{font-size:.72rem;color:var(--ink);font-weight:600;display:flex;justify-content:space-between;}
.lang-dot{display:flex;gap:3px;margin-top:2.5px;}
.lang-dot span{width:100%;height:3.5px;border-radius:2px;background:#cbd5e1;}
.lang-dot span.on{background:var(--accent);}

/* ---------- MAIN ---------- */
.main{padding:11mm 10mm 9mm;display:flex;flex-direction:column;}
.hero{margin-bottom:5.5mm;}
.hero h1{
  font-size:2rem;line-height:1.05;font-weight:800;letter-spacing:-.02em;color:var(--ink);
}
.hero h1 .sur{color:var(--accent);}
.hero .role{
  margin-top:2.4mm;font-size:.76rem;letter-spacing:.12em;text-transform:uppercase;
  color:var(--muted);font-weight:600;
}
.tagline{
  margin-top:4mm;font-size:.84rem;color:var(--ink);font-weight:500;
  border-left:3px solid var(--accent);padding-left:4.5mm;line-height:1.45;
}
.summary{font-size:.76rem;color:var(--muted);line-height:1.55;margin-top:3.6mm;}

.sec{margin-top:5.5mm;}
.sec-title{
  font-size:.66rem;letter-spacing:.22em;text-transform:uppercase;color:var(--accent);
  font-weight:700;padding-bottom:1.5mm;border-bottom:1.5px solid var(--line);margin-bottom:3.2mm;
}

/* Experience */
.exp{margin-bottom:4mm;page-break-inside:avoid;break-inside:avoid;}
.exp-top{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:1.4mm;line-height:1.3;}
.exp-role{font-size:.85rem;font-weight:700;color:var(--ink);}
.exp-org{font-size:.8rem;font-weight:500;color:var(--muted);}
.exp-date{font-size:.68rem;color:var(--faint);font-weight:500;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap;padding-left:3mm;}
.exp-ul{list-style:none;padding-left:0;}
.exp-ul li{
  position:relative;padding-left:3.4mm;font-size:.76rem;color:var(--muted);
  margin-bottom:1.4mm;line-height:1.45;
}
.exp-ul li::before{
  content:"•";position:absolute;left:0;top:-.5px;color:var(--accent);font-size:1.2em;
}
.tech{
  margin-top:2mm;font-size:.64rem;font-family:ui-monospace,monospace;letter-spacing:.02em;
  color:#334155;background:#f1f5f9;padding:1.4mm 2.4mm;border-radius:4px;
  border:1px solid #e2e8f0;display:inline-block;
}

/* Projects */
.proj{margin-bottom:3.5mm;page-break-inside:avoid;break-inside:avoid;}
.proj-name{font-size:.82rem;font-weight:700;color:var(--ink);margin-bottom:.5mm;}
.proj-desc{font-size:.74rem;color:var(--muted);line-height:1.45;margin-top:1mm;}
.proj-link{font-size:.66rem;color:var(--accent);text-decoration:none;word-break:break-all;}

.skill-tag{
  display:inline-block;font-size:.68rem;color:var(--muted);
  border:1px solid var(--line);background:#fff;
  padding:1.3mm 2.6mm;border-radius:4px;margin:0 1.4mm 1.4mm 0;
}
.skill-tag b{color:var(--ink);font-weight:600;}

table.dom{width:100%;border-collapse:collapse;margin-top:1.5mm;}
table.dom td{padding:1.8mm 0;border-bottom:1px solid var(--line);vertical-align:top;}
table.dom tr:last-child td{border-bottom:none;}
.dom-name{font-size:.78rem;font-weight:600;color:var(--ink);width:42%;}
.dom-ev{font-size:.74rem;color:var(--muted);line-height:1.45;}
.cert{font-size:.74rem;color:var(--muted);margin-bottom:1.4mm;}
.cert b{color:var(--ink);font-weight:600;}

.footer{
  margin-top:auto;padding-top:6mm;border-top:1px solid var(--line);
  text-align:center;font-size:.6rem;letter-spacing:.28em;text-transform:uppercase;color:var(--faint);
}
</style>
`;

let resultHtml = originalHtml.replace(/<style>[\s\S]*?<\/style>/i, newStyle);

fs.writeFileSync('/mnt/bigdata/aura/projects/cv-redesign/cv-modern-2026.html', resultHtml);
