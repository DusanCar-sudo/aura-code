#!/usr/bin/env python3
import sys
import json
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm, cm
from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak, KeepTogether, ListFlowable, ListItem

BG_DARK = HexColor('#ffffff')
TEXT_PRIMARY = HexColor('#333333')
TEXT_SECONDARY = HexColor('#555555')
ACCENT_COLOR = HexColor('#005b9f')
LINE_COLOR = HexColor('#cccccc')

def build_lesson_pdf(json_path, output_path):
    with open(json_path, 'r', encoding='utf-8') as f:
        data = json.load(f)

    doc = SimpleDocTemplate(
        output_path,
        pagesize=A4,
        leftMargin=20*mm,
        rightMargin=20*mm,
        topMargin=20*mm,
        bottomMargin=20*mm,
    )

    styles = getSampleStyleSheet()

    s_title = ParagraphStyle('Title', parent=styles['Title'], fontSize=24, textColor=ACCENT_COLOR, alignment=TA_LEFT, spaceAfter=6, fontName='Helvetica-Bold')
    s_subtitle = ParagraphStyle('Subtitle', parent=styles['Normal'], fontSize=14, textColor=TEXT_SECONDARY, alignment=TA_LEFT, spaceAfter=20, fontName='Helvetica-Oblique')
    s_section = ParagraphStyle('Section', parent=styles['Heading2'], fontSize=16, textColor=ACCENT_COLOR, spaceBefore=15, spaceAfter=10, fontName='Helvetica-Bold')
    s_subsection = ParagraphStyle('Subsection', parent=styles['Heading3'], fontSize=12, textColor=TEXT_PRIMARY, spaceBefore=10, spaceAfter=5, fontName='Helvetica-Bold')
    s_body = ParagraphStyle('Body', parent=styles['Normal'], fontSize=11, leading=15, textColor=TEXT_PRIMARY, spaceAfter=6, fontName='Helvetica')
    s_bullet = ParagraphStyle('Bullet', parent=s_body, leftIndent=10)

    story = []

    # Title
    story.append(Paragraph(data.get('title', 'Lesson Material'), s_title))
    story.append(Paragraph(f"Level: {data.get('level', '')} | {data.get('subtitle', '')}", s_subtitle))

    def add_section(title, content_list, is_bullet=True):
        if not content_list: return
        story.append(Paragraph(title, s_section))
        for item in content_list:
            if is_bullet:
                story.append(Paragraph(f"• {item}", s_bullet))
            else:
                story.append(Paragraph(item, s_body))
        story.append(Spacer(1, 10))

    bws = data.get('beforeWeStart', {})
    story.append(Paragraph("Before we start", s_section))
    story.append(Paragraph("Key language:", s_subsection))
    story.append(Paragraph(", ".join(bws.get('keyLanguage', [])), s_body))
    story.append(Spacer(1, 5))
    for q in bws.get('questions', []):
        story.append(Paragraph(f"• {q}", s_bullet))

    vb = data.get('vocabularyBoost', {})
    story.append(Paragraph("Vocabulary boost", s_section))
    story.append(Paragraph(vb.get('title', ''), s_subsection))
    for w in vb.get('words', []):
        story.append(Paragraph(f"• {w}", s_bullet))
    story.append(Spacer(1, 5))
    for q in vb.get('questions', []):
        story.append(Paragraph(f"• {q}", s_bullet))

    se = data.get('shareExperience', {})
    story.append(Paragraph("Share your experience", s_section))
    story.append(Paragraph(se.get('title', ''), s_subsection))
    for q in se.get('questions', []):
        story.append(Paragraph(f"• {q}", s_bullet))

    story.append(PageBreak())

    dl = data.get('discoverAndLearn', {})
    story.append(Paragraph("Discover and learn", s_section))
    story.append(Paragraph(dl.get('title', ''), s_subsection))
    for e in dl.get('exercises', []):
        story.append(Paragraph(f"• {e}", s_bullet))

    sp = data.get('spotlight', {})
    story.append(Paragraph("Spotlight", s_section))
    story.append(Paragraph(sp.get('title', ''), s_subsection))
    for idx, t in enumerate(sp.get('tips', [])):
        story.append(Paragraph(f"{idx+1}. {t}", s_bullet))

    yt = data.get('yourTurn', {})
    story.append(Paragraph("Your turn", s_section))
    story.append(Paragraph(yt.get('title', ''), s_subsection))
    for s in yt.get('scenarios', []):
        story.append(Paragraph(f"• {s}", s_bullet))

    doc.build(story)

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: generate_lesson_pdf.py <input.json> <output.pdf>")
        sys.exit(1)
    build_lesson_pdf(sys.argv[1], sys.argv[2])
