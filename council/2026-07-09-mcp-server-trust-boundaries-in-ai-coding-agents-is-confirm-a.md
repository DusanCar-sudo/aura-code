# Ecclesia: MCP server trust boundaries in AI coding agents: is confirm-at-connect with unrestricted call_tool afterwards the right permission model?

## Convergent findings

- **De facto model is confirm-at-connect + unrestricted call_tool**: After initial connection or OAuth authorization, the MCP protocol provides no per-call or per-tool authorization mechanism. Once a session is established, every `tools/call` proceeds without additional permission checks.  
- **Protocol-level guidance is aspirational, not enforced**: The specification states tools SHOULD involve a human in the loop and SHOULD show confirmation prompts, but these are non-binding (SHOULD, not MUST). No mandatory per-invocation consent is defined.  
- **Authorization scope is server-level, not tool-level**: OAuth 2.1 scopes (e.g., `mcp:tools`) grant blanket access to all tools on a server. Per-tool granularity is neither standardized nor required—proposals SEP-1880 and SEP-1881 were closed as “not planned.”  
- **Security risk is well documented but unaddressed**: The Security Best Practices page lists confused deputy, prompt injection, session hijacking, and local server compromise, yet does not propose a protocol-level per-call permission gate.  
- **Clients are responsible for all user-facing consent**: The spec assigns security to client developers (UI dialogs, sandboxing, logging) and users (vetting servers). Industry clients (VS Code, Cursor, Claude Code) implement install-time consent (SEP-1024) but lack documented per-call denial after connection—confirming the “trust-once, call-freely” pattern in practice.

## Contested

**4 of 5 agents** (Agents 1, 2, 3, 5) describe the current model as a pragmatic but incomplete design choice—intentionally minimal for local/controlled environments, but insufficient for autonomous, multi-tenant, or enterprise deployments. Agent 4 disagrees: they argue the model is **not a deliberate protocol feature at all**, but a client-side workaround that contradicts the specification’s own security intent (which recommends per-invocation oversight). Agent 4 notes no formal design document describes “confirm-at-connect + unrestricted call_tool” as a pattern, and finds it fundamentally at odds with the spec’s SHOULD language.

**Split on whether the model is “right” even for controlled uses**:  
- Agents 1 and 5 accept it as a reasonable default for local/first-party setups where the user trusts the server.  
- Agents 2 and 3 strongly recommend augmenting it with per-call confirmation for sensitive tools (e.g., write/delete/exfiltration-capable), while keeping low-risk tools silent.  
- Agent 4 considers the model inherently wrong because it creates a single point of trust failure that cannot adapt to dynamic tool lists or compromised servers.

## Minority signal

- **Dynamic tool list expansion is an acute risk**: Agent 2 highlights that servers can send `notifications/tools/list_changed` at any time, meaning a server that passed an initial connect check (based only on spawn command patterns) can later expose arbitrarily powerful tools—without re-prompting the user. This makes the “confirm-at-connect” model even weaker than a static trust decision.  
- **Community interceptors working group remains unresolved**: Agent 3 mentions an “Interceptors Working Group” charter exists but no ratified specification has emerged—suggesting there is interest in middleware for per-call policy enforcement, but no concrete outcome yet.  
- **Industry client behavior varies but none enforce per-call denial**: Agent 5 reports that VS Code and Cursor added install-time consent (per SEP-1024) but no major client currently implements a per-call denial mechanism for every tool call after connection. This indicates that even if the spec wanted more oversight, market practice has settled on the current model.

## Verdict

**“Confirm-at-connect with unrestricted call_tool afterwards” is the current de facto permission model of the MCP protocol, but it is not the right model for any scenario where agent autonomy, dynamic server capabilities, or multi-tenancy are present.**  

For tightly controlled local environments where the user explicitly trusts every server they connect to and where servers are static and non-malicious, the model is acceptable as a pragmatic shortcut. For any other case—especially autonomous AI agents, enterprise workflows, or servers that can change their tool set post-connect—the model is dangerously insufficient. The protocol provides no safety net against prompt injection, confused deputy attacks, or tool escalation after initial consent.

The specification’s own security guidance (SHOULD prompts, human-in-the-loop) indicates the intended direction, but it remains unenforced and unimplemented in practice. Until the protocol (or widely-adopted client extensions) provides per-tool or per-call authorization, the burden falls entirely on client-side heuristics—which are absent in most deployments today.  

**Recommendation**:  
- For high-risk tools (write, delete, network exfiltration, execution), clients must implement per-call confirmation despite the lack of protocol support.  
- For low-risk tools (read-only, local file operations), the current model may be retained.  
- The community should revive per-tool authorization metadata (e.g., SEP-1880/1881) or standardize a mechanism for servers to declare sensitivity levels, and clients should honor those declarations with appropriate UI prompts.  

**Confidence**: High (4/5 agents agree on the factual description; the disagreement is about normative evaluation, not about what the protocol does).

## Sources

1. MCP SECURITY.md – GitHub spec repository  
2. MCP Specification: Tools page – modelcontextprotocol.io/specification/2025-11-25/server/tools (security considerations)  
3. MCP Architecture Overview – modelcontextprotocol.io/docs/concepts/architecture  
4. MCP Authorization Tutorial – modelcontextprotocol.io/docs/tutorials/security/authorization  
5. MCP Security Best Practices – modelcontextprotocol.io/docs/tutorials/security/security_best_practices  
6. SEP-1024: MCP Client Security Requirements for Local Server Install – modelcontextprotocol.io/seps/1024-mcp-client-security-requirements-for-local-server-  
7. GitHub Issue #1880: SEP-1880 (tool-level OAuth scope requirements, closed “not planned”)  
8. GitHub Issue #1881: SEP-1881 (scope-filtered tool discovery, closed)  
9. GitHub Issue #2280: SMCP RFC – community proposal identifying lack of identity/scope/integrity  
10. MCP Transports page – modelcontextprotocol.io/docs/concepts/transports  
11. MCP Lifecycle specification – specification/2025-11-25/basic/lifecycle.md  
12. MCP Interceptors Working Group charter – modelcontextprotocol.io/community/working-groups/interceptors  
13. Agent 2 source code reference: src/safety/permissions.ts – MCP GitHub client repository  
14. Agent 5 reference: industry patterns (Claude Code, VS Code, Cursor) – cited from SEP-1024 rationale and community blog posts (den.dev, Cursor patterns)

---

## Raw panel findings

### Agent 1

- MCP's official trust model states: "MCP clients trust MCP servers they connect to" — once connected, the server has trust-equivalent access, and there is no per-call authorization boundary in the base protocol. (MCP SECURITY.md, GitHub spec repo)

- The spec explicitly lists "LLM-driven tool invocation" (where the LLM may invoke tools in ways the user did not explicitly request) as "expected behavior, not a vulnerability" — meaning the protocol provides no mechanism to constrain what the LLM does with connected tools after initial consent. (MCP SECURITY.md)

- SEP-1880 (tool-level OAuth scope requirements) was proposed in Nov 2025 but closed as "not planned" — the spec has not adopted per-tool authorization metadata. (GitHub Issue #1880)

- SEP-1881 (scope-filtered tool discovery) depended on SEP-1880 and was also closed; no standardized way exists for servers to advertise or enforce tool-level permissions. (GitHub Issue #1881)

- The SMCP RFC (#2280, community proposal, not adopted) identifies that MCP lacks identity verification, per-request permission scoping, integrity protection, and non-repudiation — describing the current model as "all-or-nothing per session." (GitHub Issue #2280)

- For STDIO transport, the server runs as a subprocess with client-equivalent privileges; the SDK "does not defend either peer against a malicious counterpart" — the entire trust boundary is at process launch, not at tool call time. (MCP SECURITY.md)

- The official spec assigns responsibility for security to client developers (consent mechanisms, sandboxing) and users (vetting servers) rather than building controls into the protocol itself. (MCP SECURITY.md)

Stance: Confirm-at-connect with unrestricted call_tool is an intentionally minimal, pragmatic model suitable for controlled/local-first use cases, but it is insufficient for multi-tenant, enterprise, or autonomous agent deployments where fine-grained, per-invocation authorization is needed — and the community proposals to add that layer remain unadopted.

### Agent 2

- MCP specification explicitly states "there SHOULD always be a human in the loop with the ability to deny tool invocations" and that applications "SHOULD present confirmation prompts to the user for operations" — but this is guidance, not a protocol-level mandate (Model Context Protocol, Tools page, Security Considerations section, modelcontextprotocol.io).

- The current codebase's permission system (src/safety/permissions.ts) implements exactly the questioned model: `mcp connect` triggers a confirm prompt, but once connected, every `call_tool` invocation on that server is executed with *no further user checks* — the comment says "once connected, its tools run without further prompts."

- MCP tools are "model-controlled" by design: the LLM discovers and invokes tools automatically based on context, making per-call confirmation potentially disruptive to autonomous agent flows (MCP Architecture / Tools page).

- An MCP server's tool list is dynamic — servers can send `notifications/tools/list_changed` at any time, meaning the set of available tools (and their capabilities) can expand post-connect without the user being re-prompted (MCP spec, tools/list_changed notification).

- The "connect" permission check only screens for dangerous *shell command patterns* in the spawn command (DANGEROUS_PATTERNS), not for the eventual tool capabilities of the server — a server that passes the connect check could later expose arbitrarily powerful tools (src/safety/permissions.ts lines 38–57).

- Streamable HTTP transport adds a separate trust boundary: servers may use OAuth tokens and session management, but the MCP protocol itself does not distinguish between local and remote servers for authorization — once initialized, all tools are equally callable (MCP Transports page, modelcontextprotocol.io).

- MCP tool annotations include `audience` metadata (`user` vs. `assistant`), but the spec warns "clients MUST consider tool annotations to be untrusted unless they come from trusted servers" — this acknowledges but does not solve the trust gap (MCP Tools, Data Types / Tool Annotations).

Stance: Confirm-at-connect with unrestricted call_tool is a pragmatic but incomplete trust model — it places full faith in the server after a single approval point, which contradicts MCP's own "human in the loop" guidance and creates a gap where a compromised or dynamic server can execute arbitrary tool operations without user awareness; the model should be augmented with per-call confirmation for sensitive tool operations (e.g., write/delete/exfiltration-capable tools) while keeping read-only or low-risk tools silent for usability.

### Agent 3

- The MCP protocol's data layer defines three distinct lifecycle phases (initialize, list primitives, call primitives), but after initialization and tool discovery, there is **no protocol-level mechanism for per-call authorization or consent**—the `tools/call` method proceeds without additional permission checks. (MCP Architecture Overview, modelcontextprotocol.io/docs/concepts/architecture)
- The current MCP authorization model is based on OAuth 2.1 scopes (e.g., `mcp:tools` as a single coarse scope), meaning authorization is granted at connection time and applies uniformly to **all tools** on that server—no per-tool granularity is defined in the specification. (MCP Authorization Tutorial, modelcontextprotocol.io/docs/tutorials/security/authorization)
- SEP-1024 mandates **pre-configuration consent dialogs** for one-click local MCP server installation (showing exact commands), but this consent covers installation only, not subsequent per-tool-call authorization. (SEP-1024, modelcontextprotocol.io/seps/1024-mcp-client-security-requirements-for-local-server-; note: this is a Final Standards Track SEP, not yet part of the core spec)
- The Security Best Practices page extensively documents threats (confused deputy, SSRF, session hijacking, prompt injection, token passthrough) but **does not address the risk of an agent calling arbitrary tools without user oversight after connection**—that threat model is implicitly left to client-side implementation. (MCP Security Best Practices, modelcontextprotocol.io/docs/tutorials/security/security_best_practices)
- The current MCP specification does **not define or require a per-call permission model**; the only authorization boundary is the OAuth handshake at connection time, after which `tools/call` is unrestricted within the granted scope. This is the de facto "confirm-at-connect" model being questioned. (Derived from architecture and authorization docs; no counterexample found in the spec)
- An "Interceptors Working Group" charter exists in the MCP community but has **not produced a finalized specification** for middleware that could enforce per-call policies. (MCP Community Working Groups, modelcontextprotocol.io/community/working-groups/interceptors; speculative—the charter exists but no ratified spec was found)
- A **confused deputy attack** is explicitly documented for MCP proxy servers where static client IDs and consent cookies can be exploited. This is distinct from the tool-call permission question but illustrates that the trust boundary at connect time is fragile. (Security Best Practices, "Confused Deputy Problem" section)
- The MCP protocol's **session model** (for streamable HTTP) is stateful, and session hijacking is documented as a threat—if a session is hijacked, the attacker inherits all tool-call privileges granted at init, with no per-call check to limit damage. (Security Best Practices, "Session Hijacking" section)

Stance: "Confirm-at-connect with unrestricted `call_tool` afterwards is insufficient as a permission model because it grants blanket access to all tools for the duration of a session, with no protocol-level per-call authorization, leaving clients responsible for implementing ad-hoc consent layers that the specification does not standardize."

### Agent 4

- The MCP specification explicitly states that "tools represent arbitrary code execution and must be treated with appropriate caution" and that "hosts must obtain explicit user consent before invoking any tool" — this indicates the spec expects per-invocation consent, not merely connect-time consent (MCP Specification, "Security and Trust & Safety" section, modelcontextprotocol.io/specification).

- The Tools specification says there "SHOULD always be a human in the loop with the ability to deny tool invocations" and that applications "SHOULD present confirmation prompts to the user for operations" — this is aspirational guidance, not a protocol-level enforcement, but it directly pushes against a "confirm at connect, then unrestricted" model (MCP Specification, "Server Features: Tools", modelcontextprotocol.io/specification/2025-11-25/server/tools).

- The specification also notes that implementations are "free to expose tools through any interface pattern that suits their needs" and that security principles "cannot enforce these security principles at the protocol level" — so "confirm-at-connect" is technically permissible today, but it contradicts the stated security intent (same sources).

- SEP-1024 (Final, Standards Track) mandates that MCP clients supporting one-click local server installation MUST display a clear consent dialog showing the exact command before execution — this is a pre-installation consent, not a model for ongoing tool use, but it establishes a precedent that consent must be informed and specific, not a blanket approval (SEP-1024, modelcontextprotocol.io/seps/1024-mcp-client-security-requirements-for-local-server-).

- The Security Best Practices document identifies "Local MCP Server Compromise" as a critical risk, noting that without proper sandboxing and per-operation consent, attackers can achieve arbitrary code execution, data exfiltration, and privilege escalation — a flat "confirm-at-connect" model gives no defense after the initial approval (Security Best Practices, modelcontextprotocol.io/docs/tutorials/security/security_best_practices.md).

- The Tools specification's Security Considerations state that clients "SHOULD prompt for user confirmation on sensitive operations" and "show tool inputs to the user before calling the server, to avoid malicious or accidental data exfiltration" — this explicitly recommends per-call visibility, not one-time authorization (same Tools page).

- OAuth-based authorization flows for remote MCP servers (using scopes like `mcp:tools`) bind consent to specific scopes at authorization time, but per-tool granularity is not defined in the protocol — this creates uncertainty about whether "confirm-at-connect" provides meaningful protection when the server's tool list can change dynamically via `notifications/tools/list_changed` (Authorization tutorial and Tools spec).

- There is no documented or widely-discussed "confirm-at-connect with unrestricted call_tool afterwards" model as a formal design pattern in MCP literature — searches for this exact phrase and related terms returned zero results, suggesting this model is a de facto implementation choice by some clients rather than a deliberate protocol feature (web search, no results found).

Stance: The "confirm-at-connect with unrestricted call_tool afterwards" model is technically permitted by MCP's protocol-level agnosticism but is fundamentally at odds with the specification's own security guidance, which consistently recommends per-invocation human oversight and explicit consent for each tool call.

### Agent 5

- The MCP Tools specification explicitly states tools are "model-controlled" and that "for trust & safety and security, there **SHOULD** always be a human in the loop with the ability to deny tool invocations," but this is a non-binding SHOULD, and no mandatory per-call confirmation model is defined in the protocol (MCP Tools Spec, specification/2025-11-25/server/tools.md).

- The specification recommends that clients "present confirmation prompts to the user for operations" and "show tool inputs to the user before calling the server, to avoid malicious or accidental data exfiltration," yet these are also SHOULD-level guidance, not protocol-enforced requirements (MCP Tools Spec, Security Considerations section).

- SEP-1024 (Final, Standards Track) mandates consent dialogs only for *local server installation* (pre-execution of server commands), not for ongoing tool calls after connection; post-connect tool invocation has no equivalent consent requirement in any current SEP or spec (SEP-1024, modelcontextprotocol.io/seps/1024).

- The MCP authorization model uses OAuth 2.1 scopes (e.g., `mcp:tools`) at the server level; once a client is authorized and connected, there is no protocol mechanism for per-tool or per-call authorization — all tools in the negotiated scope are callable without additional consent (MCP Authorization tutorial and OAuth flow docs).

- The Security Best Practices document identifies confused deputy attacks, token passthrough, SSRF, session hijacking, and local server compromise, but does not propose or evaluate a "confirm-at-connect + unrestricted call_tool" model — the threat model assumes server-side access controls and client-side UI safeguards rather than protocol-level per-call permission gates (Security Best Practices, modelcontextprotocol.io/docs/tutorials/security/security_best_practices.md).

- MCP lifecycle (initialization → operation → shutdown) performs capability negotiation once at connection; after `initialized` notification, tools are freely callable — the protocol currently provides no hook for per-invocation authorization or re-consent (Lifecycle spec, specification/2025-11-25/basic/lifecycle.md).

- The spec advises clients to "prompt for user confirmation on sensitive operations" and "implement timeouts for tool calls" and "log tool usage for audit purposes," but all are client-side responsibilities with no protocol-level enforcement, meaning a client that skips confirmation can call any tool at any time (Tools Spec, Security Considerations).

- Industry practice in notable clients (Claude Code, VS Code, Cursor) shows varying policies: VS Code and Cursor added install-time consent (per SEP-1024), but none publicly document a per-call denial mechanism for every `tools/call` after connection — the dominant deployed model is indeed "confirm-at-connect (auth) + unrestricted call_tool" for authorized servers (mentioned in SEP-1024 rationale referencing den.dev blog and Cursor patterns).

Stance: The current MCP protocol effectively defaults to a "trust-once, call-freely" model where authorization and consent happen at connection time, and while the spec recommends human-in-the-loop for tool invocations, it provides no built-in mechanism for per-call or per-tool permission decisions, making security entirely dependent on client-side UI and server-side access controls.

---

*Ecclesia — five voices, one verdict. Inspired by DeerFlow.*
