#!/usr/bin/env python3
"""
Practess — Professional Project Showcase PDF Generator
Generates a dark-themed, modern one-pager using reportlab.
"""

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm, cm
from reportlab.lib.colors import Color, HexColor, white, black
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT, TA_JUSTIFY
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    PageBreak, Frame, PageTemplate, KeepTogether
)
from reportlab.graphics.shapes import Drawing, Rect, Line, Circle, String, Group
from reportlab.graphics import renderPDF
from reportlab.pdfgen import canvas
import os

# ─── Color Palette ──────────────────────────────────────────────────────────
BG_DARK      = HexColor('#1a1a2e')    # Main background — deep navy-charcoal
BG_SECTION   = HexColor('#16213e')    # Slightly lighter section bg
BG_CARD      = HexColor('#0f3460')    # Card / stat box background
RUBY_RED     = HexColor('#cc0033')    # Accent — ruby red
RUBY_DARK    = HexColor('#8b0023')    # Darker ruby for depth
RUBY_LIGHT   = HexColor('#ff1a4d')    # Lighter ruby for highlights
TEXT_WHITE   = HexColor('#f0f0f0')    # Primary text
TEXT_GRAY    = HexColor('#b0b0c0')    # Secondary text
TEXT_DIM     = HexColor('#6b6b80')    # Muted / subtle text
BORDER_GRAY  = HexColor('#2a2a4a')    # Subtle borders
GOLD         = HexColor('#ffd700')    # Stat accent
CYAN_ACCENT  = HexColor('#00d4ff')    # Tech accent
GREEN_ACCENT = HexColor('#00cc88')    # Success / tests green

WIDTH, HEIGHT = A4  # 595.27 x 841.89 points


class PractessDocTemplate(SimpleDocTemplate):
    """Custom document template with dark background and page decorations."""

    def __init__(self, filename, **kw):
        super().__init__(filename, **kw)
        self.page_count = 0

    def afterPage(self):
        self.page_count += 1


def draw_background(canvas_obj, doc):
    """Draw the full-page dark background and decorative elements."""
    canvas_obj.saveState()

    # Main background fill
    canvas_obj.setFillColor(BG_DARK)
    canvas_obj.rect(0, 0, WIDTH, HEIGHT, fill=1, stroke=0)

    # Top gradient strip (subtle)
    for i in range(40):
        alpha = 0.08 - (i * 0.002)
        if alpha > 0:
            canvas_obj.setFillColor(Color(0.08, 0.02, 0.15, alpha))
            canvas_obj.rect(0, HEIGHT - i, WIDTH, 1, fill=1, stroke=0)

    # Ruby accent line at top
    canvas_obj.setFillColor(RUBY_RED)
    canvas_obj.rect(0, HEIGHT - 3, WIDTH, 3, fill=1, stroke=0)

    # Bottom accent line
    canvas_obj.setFillColor(RUBY_RED)
    canvas_obj.rect(0, 0, WIDTH, 2, fill=1, stroke=0)

    # Side decorative lines (subtle)
    canvas_obj.setStrokeColor(Color(0.78, 0, 0.2, 0.15))
    canvas_obj.setLineWidth(0.5)
    canvas_obj.line(30, 50, 30, HEIGHT - 50)
    canvas_obj.line(WIDTH - 30, 50, WIDTH - 30, HEIGHT - 50)

    # Corner accents
    canvas_obj.setFillColor(RUBY_RED)
    canvas_obj.rect(0, HEIGHT - 3, 80, 3, fill=1, stroke=0)
    canvas_obj.rect(WIDTH - 80, HEIGHT - 3, 80, 3, fill=1, stroke=0)

    # Subtle dot pattern in background (every 30pt)
    canvas_obj.setFillColor(Color(1, 1, 1, 0.015))
    for x in range(0, int(WIDTH), 30):
        for y in range(0, int(HEIGHT), 30):
            canvas_obj.circle(x, y, 0.5, fill=1, stroke=0)

    canvas_obj.restoreState()


def create_ruby_gem_drawing():
    """Create a small ruby gem icon as a Drawing."""
    d = Drawing(30, 30)
    # Diamond shape
    points = [15, 28, 4, 15, 15, 2, 26, 15]
    from reportlab.graphics.shapes import Polygon
    gem = Polygon(points, fillColor=RUBY_RED, strokeColor=RUBY_LIGHT, strokeWidth=0.5)
    d.add(gem)
    # Inner facet
    inner = Polygon([15, 24, 8, 15, 15, 6, 22, 15],
                    fillColor=Color(1, 0, 0.2, 0.3), strokeColor=Color(1, 0.3, 0.4, 0.4), strokeWidth=0.3)
    d.add(inner)
    return d


def build_pdf():
    """Build the complete PDF document."""
    output_path = '/home/dusan/ruby-code/Practess.pdf'

    doc = PractessDocTemplate(
        output_path,
        pagesize=A4,
        leftMargin=40,
        rightMargin=40,
        topMargin=50,
        bottomMargin=50,
    )

    # ─── Styles ──────────────────────────────────────────────────────────────
    styles = getSampleStyleSheet()

    s_title = ParagraphStyle(
        'RubyTitle',
        parent=styles['Title'],
        fontSize=36,
        leading=42,
        textColor=TEXT_WHITE,
        alignment=TA_CENTER,
        spaceAfter=4,
        fontName='Helvetica-Bold',
    )

    s_subtitle = ParagraphStyle(
        'RubySubtitle',
        parent=styles['Normal'],
        fontSize=11,
        leading=14,
        textColor=TEXT_GRAY,
        alignment=TA_CENTER,
        spaceAfter=2,
        fontName='Helvetica',
    )

    s_tagline = ParagraphStyle(
        'RubyTagline',
        parent=styles['Normal'],
        fontSize=14,
        leading=18,
        textColor=RUBY_LIGHT,
        alignment=TA_CENTER,
        spaceAfter=6,
        fontName='Helvetica-BoldOblique',
    )

    s_section_header = ParagraphStyle(
        'SectionHeader',
        parent=styles['Heading2'],
        fontSize=16,
        leading=20,
        textColor=RUBY_RED,
        spaceBefore=16,
        spaceAfter=8,
        fontName='Helvetica-Bold',
    )

    s_body = ParagraphStyle(
        'RubyBody',
        parent=styles['Normal'],
        fontSize=10,
        leading=14,
        textColor=TEXT_WHITE,
        alignment=TA_LEFT,
        fontName='Helvetica',
    )

    s_body_center = ParagraphStyle(
        'RubyBodyCenter',
        parent=s_body,
        alignment=TA_CENTER,
    )

    s_body_dim = ParagraphStyle(
        'RubyBodyDim',
        parent=s_body,
        textColor=TEXT_GRAY,
        fontSize=9,
        leading=12,
    )

    s_stat_number = ParagraphStyle(
        'StatNumber',
        parent=styles['Normal'],
        fontSize=28,
        leading=32,
        textColor=TEXT_WHITE,
        alignment=TA_CENTER,
        fontName='Helvetica-Bold',
    )

    s_stat_label = ParagraphStyle(
        'StatLabel',
        parent=styles['Normal'],
        fontSize=8,
        leading=10,
        textColor=TEXT_GRAY,
        alignment=TA_CENTER,
        fontName='Helvetica',
    )

    s_small = ParagraphStyle(
        'Small',
        parent=styles['Normal'],
        fontSize=8,
        leading=10,
        textColor=TEXT_DIM,
        alignment=TA_CENTER,
    )

    s_feature_title = ParagraphStyle(
        'FeatureTitle',
        parent=styles['Normal'],
        fontSize=11,
        leading=14,
        textColor=TEXT_WHITE,
        fontName='Helvetica-Bold',
    )

    s_feature_body = ParagraphStyle(
        'FeatureBody',
        parent=styles['Normal'],
        fontSize=9,
        leading=12,
        textColor=TEXT_GRAY,
    )

    s_arch_text = ParagraphStyle(
        'ArchText',
        parent=styles['Normal'],
        fontSize=9,
        leading=13,
        textColor=CYAN_ACCENT,
        alignment=TA_LEFT,
        fontName='Courier',
    )

    s_table_header = ParagraphStyle(
        'TableHeader',
        parent=styles['Normal'],
        fontSize=9,
        leading=11,
        textColor=TEXT_WHITE,
        fontName='Helvetica-Bold',
    )

    s_table_cell = ParagraphStyle(
        'TableCell',
        parent=styles['Normal'],
        fontSize=9,
        leading=11,
        textColor=TEXT_GRAY,
        fontName='Helvetica',
    )

    s_table_cell_center = ParagraphStyle(
        'TableCellCenter',
        parent=s_table_cell,
        alignment=TA_CENTER,
    )

    s_footer = ParagraphStyle(
        'Footer',
        parent=styles['Normal'],
        fontSize=8,
        leading=10,
        textColor=TEXT_DIM,
        alignment=TA_CENTER,
        fontName='Helvetica',
    )

    # ─── Helper: Section Divider ─────────────────────────────────────────────
    def make_divider():
        """Create a thin horizontal divider line."""
        d = Drawing(WIDTH - 80, 6)
        line = Line(0, 3, WIDTH - 80, 3, strokeColor=BORDER_GRAY, strokeWidth=0.5)
        d.add(line)
        # Ruby dot in center
        cx = (WIDTH - 80) / 2
        dot = Circle(cx, 3, 2, fillColor=RUBY_RED, strokeColor=None)
        d.add(dot)
        return d

    # ─── Helper: Stat Box ───────────────────────────────────────────────────
    def make_stat_box(number, label, color=TEXT_WHITE):
        """Create a stat box cell."""
        num_style = ParagraphStyle(
            'SN', parent=s_stat_number, textColor=color
        )
        return [
            Paragraph(str(number), num_style),
            Paragraph(label, s_stat_label),
        ]

    # ─── Build Story ─────────────────────────────────────────────────────────
    story = []

    # ── Header Section ──
    story.append(Spacer(1, 10))

    # Ruby gem icon + title row
    title_text = '◆ Practess'
    story.append(Paragraph(title_text, s_title))
    story.append(Spacer(1, 4))

    # Tagline
    story.append(Paragraph('"I don\'t try. I verify."', s_tagline))
    story.append(Spacer(1, 4))

    # Subtitle description
    story.append(Paragraph(
        'An autonomous coding agent, built entirely by AI agents, for everyone.',
        s_subtitle
    ))
    story.append(Paragraph(
        '<font color="#6b6b80">Open Source  •  TypeScript  •  MIT License</font>',
        ParagraphStyle('sub2', parent=s_subtitle, fontSize=9, textColor=TEXT_DIM)
    ))

    story.append(Spacer(1, 14))
    story.append(make_divider())
    story.append(Spacer(1, 10))

    # ── Key Stats Section ──
    story.append(Paragraph('KEY METRICS', s_section_header))

    stat_data = [[
        Paragraph('<font color="#00cc88"><b>566</b></font>', s_stat_number),
        Paragraph('<font color="#00d4ff"><b>141</b></font>', s_stat_number),
        Paragraph('<font color="#cc0033"><b>5</b></font>', s_stat_number),
        Paragraph('<font color="#ffd700"><b>87%</b></font>', s_stat_number),
        Paragraph('<font color="#ff6b6b"><b>92%</b></font>', s_stat_number),
    ], [
        Paragraph('Passing Tests', s_stat_label),
        Paragraph('Knowledge Nodes', s_stat_label),
        Paragraph('AI Providers', s_stat_label),
        Paragraph('Orchestration Coverage', s_stat_label),
        Paragraph('Utilities Coverage', s_stat_label),
    ]]

    col_w = (WIDTH - 100) / 5
    stat_table = Table(stat_data, colWidths=[col_w] * 5)
    stat_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), BG_SECTION),
        ('ROUNDEDCORNERS', [6, 6, 6, 6]),
        ('TOPPADDING', (0, 0), (-1, 0), 14),
        ('BOTTOMPADDING', (0, 1), (-1, 1), 10),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('RIGHTPADDING', (0, 0), (-1, -1), 6),
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('LINEBELOW', (0, 0), (-1, 0), 0.5, BORDER_GRAY),
    ]))
    story.append(stat_table)

    story.append(Spacer(1, 6))

    # Additional stats row
    extra_stats_data = [[
        Paragraph('<font color="#00cc88"><b>142</b></font>', ParagraphStyle('es', parent=s_stat_number, fontSize=18)),
        Paragraph('<font color="#00d4ff"><b>1/7</b></font>', ParagraphStyle('es2', parent=s_stat_number, fontSize=18)),
        Paragraph('<font color="#ffd700"><b>100%</b></font>', ParagraphStyle('es3', parent=s_stat_number, fontSize=18)),
    ], [
        Paragraph('Knowledge Graph Edges', s_stat_label),
        Paragraph('Cost vs Claude Opus', s_stat_label),
        Paragraph('AI-Built (No Human Code)', s_stat_label),
    ]]

    extra_col_w = (WIDTH - 100) / 3
    extra_table = Table(extra_stats_data, colWidths=[extra_col_w] * 3)
    extra_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), BG_SECTION),
        ('TOPPADDING', (0, 0), (-1, 0), 10),
        ('BOTTOMPADDING', (0, 1), (-1, 1), 10),
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
    ]))
    story.append(extra_table)

    story.append(Spacer(1, 12))
    story.append(make_divider())
    story.append(Spacer(1, 10))

    # ── Two-Column Layout: Architecture + Features ──
    # Architecture Diagram (left)
    arch_content = []
    arch_content.append(Paragraph('ARCHITECTURE', s_section_header))
    arch_content.append(Spacer(1, 4))

    # Text-based architecture diagram
    arch_lines = [
        '<font color="#00d4ff">┌─────────────────────────────────┐</font>',
        '<font color="#00d4ff">│</font>  <font color="#ffffff"><b>MULTI-AGENT PIPELINE</b></font>             <font color="#00d4ff">│</font>',
        '<font color="#00d4ff">│</font>                                 <font color="#00d4ff">│</font>',
        '<font color="#00d4ff">│</font>  <font color="#ff6b6b">◆ Researcher</font>                    <font color="#00d4ff">│</font>',
        '<font color="#00d4ff">│</font>     <font color="#b0b0c0">│</font>                          <font color="#00d4ff">│</font>',
        '<font color="#00d4ff">│</font>     <font color="#b0b0c0">▼</font>                          <font color="#00d4ff">│</font>',
        '<font color="#00d4ff">│</font>  <font color="#ff6b6b">◆ Coder</font>                        <font color="#00d4ff">│</font>',
        '<font color="#00d4ff">│</font>     <font color="#b0b0c0">│</font>                          <font color="#00d4ff">│</font>',
        '<font color="#00d4ff">│</font>     <font color="#b0b0c0">▼</font>                          <font color="#00d4ff">│</font>',
        '<font color="#00d4ff">│</font>  <font color="#ff6b6b">◆ Reviewer</font>                    <font color="#00d4ff">│</font>',
        '<font color="#00d4ff">│</font>                                 <font color="#00d4ff">│</font>',
        '<font color="#00d4ff">└─────────────────────────────────┘</font>',
        '',
        '<font color="#ffffff"><b>SINGLE AGENT MODE</b></font>',
        '',
        '<font color="#00cc88">  Task</font> <font color="#b0b0c0">→</font> <font color="#00cc88">Read</font> <font color="#b0b0c0">→</font> <font color="#00cc88">Plan</font> <font color="#b0b0c0">→</font> <font color="#00cc88">Execute</font> <font color="#b0b0c0">→</font> <font color="#00cc88">Verify</font>',
    ]

    for line in arch_lines:
        arch_content.append(Paragraph(line, s_arch_text))

    # Features (right)
    features_content = []
    features_content.append(Paragraph('FEATURES', s_section_header))
    features_content.append(Spacer(1, 4))

    features = [
        ('⚙ Agent Orchestration',
         'Multi-agent pipeline with Researcher → Coder → Reviewer roles. Intelligent task decomposition and delegation.'),
        ('🧠 Persistent Memory',
         'Knowledge graph with 141 nodes and 142 edges, auto-extracted from codebase interactions and learned patterns.'),
        ('🔌 Provider Independence',
         'Seamless switching between Claude, GPT, Gemini, MiMo, and local Ollama models. No vendor lock-in.'),
        ('📈 Self-Improvement',
         'The agent learns from its own verification results, improving code quality and test accuracy over time.'),
        ('💰 Cost Efficient',
         'Runs on Xiaomi MiMo at 1/7 the cost of Claude Opus, making autonomous coding accessible to everyone.'),
        ('🤖 AI-Built',
         'Written entirely by AI agents — Claude, OpenCode, Pi, and Grok orchestrated together. A project by AI, for humans.'),
    ]

    for title, desc in features:
        features_content.append(Paragraph(title, s_feature_title))
        features_content.append(Paragraph(desc, s_feature_body))
        features_content.append(Spacer(1, 6))

    left_w = (WIDTH - 100) * 0.45
    right_w = (WIDTH - 100) * 0.55

    # Architecture as a standalone block
    # Wrap architecture in a single-cell table for styling
    arch_wrapper = Table([[arch_content]], colWidths=[left_w])
    arch_wrapper.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), BG_SECTION),
        ('ROUNDEDCORNERS', [6, 6, 6, 6]),
        ('TOPPADDING', (0, 0), (-1, -1), 12),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 12),
        ('LEFTPADDING', (0, 0), (-1, -1), 14),
        ('RIGHTPADDING', (0, 0), (-1, -1), 14),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
    ]))

    # Features as a standalone block
    features_wrapper = Table([[features_content]], colWidths=[right_w])
    features_wrapper.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), BG_SECTION),
        ('ROUNDEDCORNERS', [6, 6, 6, 6]),
        ('TOPPADDING', (0, 0), (-1, -1), 12),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 12),
        ('LEFTPADDING', (0, 0), (-1, -1), 14),
        ('RIGHTPADDING', (0, 0), (-1, -1), 14),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
    ]))

    # Use a nested table for the two-column layout
    two_col_data = [[arch_wrapper, features_wrapper]]
    two_col_table = Table(two_col_data, colWidths=[left_w, right_w])
    two_col_table.setStyle(TableStyle([
        ('TOPPADDING', (0, 0), (-1, -1), 0),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 0),
        ('LEFTPADDING', (0, 0), (-1, -1), 0),
        ('RIGHTPADDING', (0, 0), (-1, -1), 0),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LINEBEFORE', (1, 0), (1, 0), 0.5, BORDER_GRAY),
    ]))
    story.append(two_col_table)

    story.append(Spacer(1, 12))
    story.append(make_divider())
    story.append(Spacer(1, 10))

    # ── Supported Models Table ──
    story.append(Paragraph('SUPPORTED AI MODELS', s_section_header))
    story.append(Spacer(1, 4))

    model_header = [
        Paragraph('<font color="#ffffff"><b>Provider</b></font>', s_table_header),
        Paragraph('<font color="#ffffff"><b>Model</b></font>', s_table_header),
        Paragraph('<font color="#ffffff"><b>Type</b></font>', s_table_header),
        Paragraph('<font color="#ffffff"><b>Cost Tier</b></font>', s_table_header),
    ]

    model_rows = [
        ['Anthropic', 'Claude (Opus / Sonnet)', 'Cloud', '$$$$$'],
        ['OpenAI', 'GPT-4o / GPT-4.1', 'Cloud', '$$$$'],
        ['Google', 'Gemini 2.5 Pro / Flash', 'Cloud', '$$$'],
        ['Xiaomi', 'MiMo v2.5 (Free tier)', 'Cloud', '$'],
        ['Ollama', 'Llama / Qwen / Local', 'Local', 'Free'],
    ]

    models_data = [model_header]
    for row in model_rows:
        color = '#00cc88' if row[3] == 'Free' else ('#ffd700' if '$' in row[3] and len(row[3]) <= 2 else TEXT_GRAY)
        models_data.append([
            Paragraph(row[0], s_table_cell),
            Paragraph(row[1], s_table_cell),
            Paragraph(row[2], s_table_cell_center),
            Paragraph(f'<font color="{color}">{row[3]}</font>', s_table_cell_center),
        ])

    models_table = Table(models_data, colWidths=[left_w * 0.3, left_w * 0.7, right_w * 0.2, right_w * 0.2])
    models_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), BG_CARD),
        ('BACKGROUND', (0, 1), (-1, -1), BG_SECTION),
        ('ROUNDEDCORNERS', [4, 4, 4, 4]),
        ('TOPPADDING', (0, 0), (-1, -1), 7),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 7),
        ('LEFTPADDING', (0, 0), (-1, -1), 10),
        ('RIGHTPADDING', (0, 0), (-1, -1), 10),
        ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
        ('LINEBELOW', (0, 0), (-1, -2), 0.5, BORDER_GRAY),
        ('LINEBELOW', (0, -1), (-1, -1), 0.5, BORDER_GRAY),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [BG_SECTION, BG_CARD]),
    ]))
    story.append(models_table)

    story.append(Spacer(1, 16))
    story.append(make_divider())
    story.append(Spacer(1, 12))

    # ── Built By Section ──
    story.append(Paragraph('BUILT BY AI AGENTS', s_section_header))
    story.append(Spacer(1, 4))

    ai_agents_text = [
        '<font color="#ffffff">Practess was written entirely by a team of AI agents working in concert:</font>',
        '',
        '<font color="#00d4ff">◆</font>  <font color="#ffffff"><b>Claude</b></font> <font color="#b0b0c0">— Architecture design, core logic, test strategy</font>',
        '<font color="#00d4ff">◆</font>  <font color="#ffffff"><b>OpenCode</b></font> <font color="#b0b0c0">— Code generation, refactoring, debugging</font>',
        '<font color="#00d4ff">◆</font>  <font color="#ffffff"><b>Pi</b></font> <font color="#b0b0c0">— Knowledge graph construction, documentation</font>',
        '<font color="#00d4ff">◆</font>  <font color="#ffffff"><b>Grok</b></font> <font color="#b0b0c0">— Orchestration patterns, provider integration</font>',
    ]
    for line in ai_agents_text:
        story.append(Paragraph(line, ParagraphStyle(
            'ai_line', parent=s_body, leading=15, spaceAfter=2
        )))

    story.append(Spacer(1, 16))
    story.append(make_divider())
    story.append(Spacer(1, 12))

    # ── Contact / Footer ──
    story.append(Paragraph('GET STARTED', s_section_header))
    story.append(Spacer(1, 4))

    contact_style = ParagraphStyle(
        'Contact', parent=s_body, fontSize=10, leading=14, textColor=TEXT_WHITE, alignment=TA_CENTER
    )
    link_style = ParagraphStyle(
        'Link', parent=s_body, fontSize=10, leading=14, textColor=CYAN_ACCENT, alignment=TA_CENTER
    )

    story.append(Paragraph('Open Source  •  MIT License  •  TypeScript', contact_style))
    story.append(Spacer(1, 4))
    story.append(Paragraph('★ Star us on GitHub  •  Fork & Contribute  •  Open an Issue', ParagraphStyle(
        'cta', parent=contact_style, textColor=RUBY_LIGHT, fontName='Helvetica-Bold'
    )))

    story.append(Spacer(1, 16))

    # Author block
    author_box_data = [[
        Paragraph(
            '<font color="#ffffff"><b>Dusan</b></font>  <font color="#6b6b80">|</font>  '
            '<font color="#b0b0c0">leanproiq@gmail.com</font>',
            ParagraphStyle('author', parent=s_body, alignment=TA_CENTER, fontSize=10)
        )
    ]]
    author_table = Table(author_box_data, colWidths=[WIDTH - 100])
    author_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), BG_CARD),
        ('ROUNDEDCORNERS', [4, 4, 4, 4]),
        ('TOPPADDING', (0, 0), (-1, -1), 10),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 10),
        ('ALIGN', (0, 0), (-1, -1), 'CENTER'),
        ('BOX', (0, 0), (-1, -1), 0.5, BORDER_GRAY),
    ]))
    story.append(author_table)

    story.append(Spacer(1, 20))

    # Footer text
    story.append(Paragraph(
        '<font color="#6b6b80">◆ Practess — An AI-built autonomous coding agent</font>',
        s_small
    ))
    story.append(Paragraph(
        '<font color="#4a4a5a">This document was generated programmatically with ReportLab.</font>',
        s_small
    ))

    # ─── Build ──
    doc.build(story, onFirstPage=draw_background, onLaterPages=draw_background)
    print(f'PDF generated: {output_path}')
    print(f'File size: {os.path.getsize(output_path):,} bytes')


if __name__ == '__main__':
    build_pdf()
