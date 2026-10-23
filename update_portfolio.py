import re

with open('temp_portfolio.html', 'r', encoding='utf-8') as f:
    html = f.read()

# Replace Work Experience section
new_experience = """
        <div class="sec-header">
          <h2>Work Experience</h2>
          <span class="num">(03)</span>
        </div>

        <div class="item">
          <div class="item-header">
            <span class="item-title">Creator & Systems Architect</span>
            <span class="item-date">2024 &mdash; present</span>
          </div>
          <div class="item-subtitle">aura-code &mdash; Lean Progress IQ</div>
          <ul class="item-desc">
            <li>Designed a full agent loop &mdash; LLM streaming, tool execution, and human-in-the-loop confirmation</li>
            <li>Specified integration of 30 LLM providers with runtime switching; architected multi-agent orchestration</li>
            <li>Defined 25+ integrated tools and their permission/safety model (file, shell, browser, web, email, MCP)</li>
            <li>Held the system to 1,559 passing tests and a clean CodeQL security scan; published to npm (MIT)</li>
          </ul>
        </div>

        <div class="item">
          <div class="item-header">
            <span class="item-title">Online English Teacher</span>
            <span class="item-date">2021 &mdash; 2026</span>
          </div>
          <div class="item-subtitle">Learnlight</div>
          <ul class="item-desc">
            <li>Delivered tailored B2B English for corporate clients &mdash; presentations, negotiations, correspondence</li>
            <li>Virtual Coach across Learnlight Academy, Virtual Group, One-to-one and English SFP Group</li>
          </ul>
        </div>

        <div class="item">
          <div class="item-header">
            <span class="item-title">Manager of Logistics</span>
            <span class="item-date">2017 &mdash; 2024</span>
          </div>
          <div class="item-subtitle">Poljubac Prirode &mdash; Irig (food processing)</div>
          <ul class="item-desc">
            <li>Directed end-to-end logistics for a fruit-processing & preserves manufacturer (jams, juices, concentrates)</li>
            <li>Managed seasonal raw-material intake from growers and cold storage alongside packaging supply to meet production schedules</li>
            <li>Oversaw finished-goods warehousing and distribution to retail, HoReCa and export channels</li>
            <li>Enforced cold-chain and FIFO inventory discipline for perishable inputs and output</li>
            <li>Coordinated carriers, fleet and 3PL relationships; optimized routes and load planning</li>
            <li>Led and trained the logistics & warehouse team; reported KPIs to plant management</li>
          </ul>
        </div>

        <div class="item">
          <div class="item-header">
            <span class="item-title">Material & Production Planning Coordinator</span>
            <span class="item-date">2017</span>
          </div>
          <div class="item-subtitle">Yazaki Srbija d.o.o., Šabac</div>
          <ul class="item-desc">
            <li>SAP superuser through the module rollout &mdash; configured master data, validated transactions, trained staff</li>
            <li>Automated planning reports and data extracts, reconciling schedules against SAP material availability</li>
          </ul>
        </div>

        <div class="item">
          <div class="item-header">
            <span class="item-title">Micro Logistics Coordinator</span>
            <span class="item-date">2016</span>
          </div>
          <div class="item-subtitle">DAD Draexlmaier d.o.o.</div>
          <ul class="item-desc">
            <li>Implemented logistical processes in a greenfield investment; coordinated the logistics planning team</li>
            <li>Ran the SAP logistics implementation &mdash; process mapping, master-data migration, key-user training</li>
            <li>Specified and rolled out E-Kanban with barcode scanning and SAP integration (Romania/Serbia)</li>
          </ul>
        </div>

        <div class="item">
          <div class="item-header">
            <span class="item-title">Supervisor &mdash; Logistics</span>
            <span class="item-date">2015</span>
          </div>
          <div class="item-subtitle">DAD Draexlmaier d.o.o., Zrenjanin</div>
          <ul class="item-desc">
            <li>Supervised logistics operations, ensuring efficient material flow and on-time project delivery</li>
            <li>Owned the site's SAP logistics transactions and reporting</li>
          </ul>
        </div>

        <div class="item">
          <div class="item-header">
            <span class="item-title">Online English Teacher</span>
            <span class="item-date">2015 &mdash; present</span>
          </div>
          <div class="item-subtitle">Bibo Global Opportunity</div>
          <ul class="item-desc">
            <li>Conducted lessons for intermediate and advanced students with customized lesson plans</li>
          </ul>
        </div>

        <div class="item">
          <div class="item-header">
            <span class="item-title">IATA Travel Agent &mdash; IT & Systems</span>
            <span class="item-date">2001 &mdash; 2013</span>
          </div>
          <div class="item-subtitle">Milotours, Novi Sad</div>
          <ul class="item-desc">
            <li>Agency systems superuser for AMADEUS and Galileo &mdash; install, config and staff training</li>
            <li>Ran agency IT &mdash; workstations, network, GDS connectivity, back-office reporting</li>
            <li>"Friend of Malaysia" (Min. of Tourism, 2005); Lufthansa Experts Sales Award (2007)</li>
          </ul>
        </div>
"""

html = re.sub(
    r'<div class="sec-header">\s*<h2>Work Experience</h2>.*?(?=<section>|<div class="sec-header">)', 
    new_experience, 
    html, 
    flags=re.DOTALL
)

with open('temp_portfolio_1.html', 'w', encoding='utf-8') as f:
    f.write(html)
