# PRD v1.0
## Sentinel
**Founder Intelligence Slackbot for Newton School**

**Status:** Draft v1.0  
**Owner:** TBD  
**Users:** Founders only  
**Mode:** Internal-only, read-only, Q&A-first

---

## 1. Executive summary

Sentinel is an internal Slackbot plus backend intelligence system for Newton School founders. It gives founders a single place to ask high-value questions about what is happening across the company and receive concise, grounded answers synthesized from multiple internal systems.

Sentinel is designed for a leadership context where critical signals are fragmented across tools such as Slack, email, meeting transcripts, calendar, Jira, Metabase, and GitHub. Instead of founders manually stitching together updates from people, dashboards, and threads, Sentinel retrieves the relevant data, reasons across it, and returns an answer in Slack.

In v1, Sentinel is:
- founders-only
- internal-only
- read-only
- Q&A only
- evidence-backed where raw evidence links are possible

Sentinel is not a general employee assistant and does not take actions in v1.

---

## 2. Problem statement

Founders need fast answers to questions like:
- What is going on in placements right now?
- What changed in admissions this week?
- Are there any student health or experience risks that need attention?
- What is slipping in product execution?
- Are there any financial anomalies or concerns?
- What should I know about NST operations?

Today, those answers require manually checking multiple systems, asking multiple people, reading long threads, and reconciling inconsistent narratives. This creates:
- slow decision-making
- incomplete situational awareness
- dependence on manual status gathering
- weak visibility into cross-functional issues

Newton School’s operating model spans admissions, learning, placements, student support, product, execution, finance, and NST operations. Leadership questions often cross those boundaries, but the information lives in disconnected systems.

Sentinel solves this by becoming the founder-facing query layer over the company’s internal operating data.

---

## 3. Product vision

Sentinel should feel like a trusted internal command interface for founders.

A founder should be able to ask natural-language questions in Slack, such as:
- What are the biggest risks in placements this week?
- Why is admissions conversion down?
- What are teams blocked on in product?
- What did we decide in important meetings this week?
- What is the latest on NST operations?
- What finance changes should I know about?

Sentinel should:
1. understand the question
2. identify which internal systems matter
3. retrieve relevant evidence
4. synthesize a clear answer
5. include raw evidence links where possible
6. clearly state uncertainty when evidence is weak or conflicting

---

## 4. Goals

### Primary goals
- Give founders a single Slack interface for company-level intelligence
- Reduce time spent collecting updates manually
- Improve visibility into risks, blockers, and important changes
- Support fast cross-functional investigation across company systems
- Provide grounded answers with evidence where possible

### Secondary goals
- Create a reusable internal intelligence layer for future executive workflows
- Standardize how leadership questions are answered across domains
- Reduce dependence on ad hoc status pings

---

## 5. Non-goals for v1

Sentinel v1 will not:
- support company-wide access
- automate decisions
- take actions in external systems
- send scheduled digests or proactive alerts
- replace dashboards as a primary analytics tool
- guarantee complete coverage of every company system
- serve as a compliance or audit tool

---

## 6. Users and access model

### Users
- Founders only

### Access model
- Access will be allowlist-based
- Only explicitly approved founder accounts can query Sentinel
- Sentinel will operate only in approved Slack surfaces such as DMs with the bot and optionally a private founder channel

### Read/write model
- Read-only in v1
- Sentinel will not send emails, create Jira tickets, post updates, or modify records in source systems

### Data scope
- No explicit out-of-bounds domain is defined for now
- However, because Sentinel spans sensitive internal data, the system must still implement strong security, authentication, audit logging, and source-level controls from day one

---

## 7. Top founder question categories

The initial product should be optimized around these six categories:

1. **Placements**
   - placement performance
   - rejection patterns
   - employer activity
   - bottlenecks in candidate readiness
   - escalations and risks

2. **Admissions**
   - funnel movement
   - conversion drops
   - counselor or process bottlenecks
   - campus or cohort-level trends
   - lead-to-enrollment issues

3. **Student health**
   - support escalations
   - negative sentiment patterns
   - dropout risk indicators
   - unresolved student issues
   - repeated experience complaints

4. **Product execution**
   - roadmap slippage
   - engineering blockers
   - launch risks
   - unresolved Jira themes
   - execution drift between discussions and delivery

5. **Finance**
   - anomalous movement in key metrics
   - spend or collections concerns
   - revenue-related changes
   - budget-related discussion signals

6. **NST operations**
   - campus operations concerns
   - internship readiness or outcomes
   - academic or schedule issues
   - cohort health and risk signals
   - operational escalations

---

## 8. v1 data sources

The following systems are confirmed for v1:
- Slack
- email
- meeting transcripts
- calendar
- Jira
- Metabase
- GitHub

### Expected usage by source

**Slack**
- threads
- status discussions
- escalations
- leadership updates
- team sentiment and blockers

**Email**
- important discussions
- escalation chains
- operational follow-ups
- external stakeholder threads if in founder inboxes or accessible mailboxes

**Meeting transcripts**
- decisions
- action items
- unresolved concerns
- recurring themes

**Calendar**
- contextual awareness of important meetings
- meeting grouping and timeline context
- mapping decisions to events

**Jira**
- initiative status
- blockers
- execution drift
- overdue work
- risk in delivery

**Metabase**
- metrics lookup
- trend analysis
- anomaly detection
- funnel and business KPI validation

**GitHub**
- engineering activity
- PR movement
- code delivery signals
- releases and deployment-adjacent context if available

---

## 9. Core use cases

### A. Executive pulse queries
Examples:
- What should I pay attention to today?
- What changed in the company since Monday?
- What are the top issues I should know right now?

### B. Domain-specific status queries
Examples:
- What is happening in placements this week?
- What changed in admissions yesterday?
- What is the latest on NST operations?

### C. Root-cause and investigation queries
Examples:
- Why is admissions conversion down?
- Why is initiative X slipping?
- Why are student escalations increasing?

### D. Risk and blocker discovery
Examples:
- What are the biggest product risks right now?
- Which teams or projects are blocked?
- What execution risks are not getting attention?

### E. Meeting intelligence queries
Examples:
- What decisions were made in leadership meetings this week?
- What unresolved action items came out of admissions reviews?
- What concerns were repeated across meetings?

### F. Cross-source synthesis
Examples:
- What explains this drop in placements?
- Are product blockers affecting student outcomes?
- Is there evidence connecting support complaints with a product issue?

---

## 10. User experience

## 10.1 Primary interface
- Slack DM with Sentinel
- Optional private founder channel in later setup

## 10.2 Query style
Sentinel should accept natural language questions without requiring command syntax.

Examples:
- What is going on in placements this week?
- What did we decide in leadership meetings?
- Why are admissions down?
- What is slipping in product?
- What should I know about NST today?

## 10.3 Response format
Each answer should follow a predictable structure:

### Response template
- **Answer**: direct response in 2 to 6 sentences
- **Why this answer**: key reasoning summary
- **Evidence checked**: source summary plus raw evidence links where possible
- **Confidence**: high, medium, or low
- **Unknowns**: what could not be verified or what data conflicts

### Example
**Answer**  
Admissions conversion is down primarily in the counselor follow-up stage over the last 5 days, with the sharpest drop visible for one segment in Metabase and repeated response-delay concerns discussed in Slack.

**Why this answer**  
Metabase shows a measurable drop in stage progression, while Slack and meeting notes indicate counselor response delays and unresolved ownership in follow-up workflows.

**Evidence checked**  
Metabase dashboard link, two Slack threads, one admissions review transcript.

**Confidence**  
Medium

**Unknowns**  
Email follow-up completeness could not be fully verified for all counselors.

---

## 11. Product requirements

## 11.1 Access control
- Only allowlisted founder accounts can use Sentinel
- Requests from non-approved users must be denied
- All requests must be authenticated through Slack identity

## 11.2 Query classification
Sentinel must classify incoming questions into one or more intent types such as:
- summary
- status
- anomaly
- root-cause
- trend
- risk
- blocker
- meeting decision extraction
- cross-source investigation

## 11.3 Source routing
Sentinel must decide which systems to query based on intent and topic.

Examples:
- placements question → Slack + email + transcripts + Metabase
- product execution question → Jira + Slack + GitHub + meeting transcripts
- finance question → Metabase + email + relevant Slack discussions
- NST question → Slack + calendar + transcripts + Metabase + Jira where applicable

## 11.4 Evidence grounding
- Important claims must be grounded in retrieved evidence
- Raw evidence links should be included where technically possible
- If raw evidence links are not possible, Sentinel should cite the system and timestamp/source context in text
- Unsupported claims must not be presented as fact

## 11.5 Read-only behavior
- Sentinel must not mutate any external system
- No task creation, message sending, or workflow automation in v1

## 11.6 Multi-turn context
- Sentinel should support follow-up questions within the same Slack thread or DM context
- It should carry forward the prior query context for short conversational chains

## 11.7 System transparency
- Sentinel should indicate which sources were checked
- It should explicitly say when a source was unavailable or not queried

## 11.8 Time awareness
- Sentinel should reason over time windows such as today, yesterday, this week, last week
- It should prefer recent evidence unless the query explicitly asks for historical context

---

## 12. Functional scope for v1

### In scope
- founders-only Slack Q&A
- retrieval from Slack, email, meeting transcripts, calendar, Jira, Metabase, GitHub
- synthesized answers
- raw evidence links where possible
- read-only behavior
- query logging and audit history
- basic conversational follow-up support

### Out of scope
- proactive alerts
- scheduled summaries
- task generation
- action-taking in source systems
- broad employee rollout
- write-back workflows

---

## 13. Intelligence and reasoning model

Sentinel should use a hybrid reasoning model:

### A. Retrieval
Pull relevant records, threads, transcripts, tickets, metrics, and engineering signals from source systems.

### B. Enrichment
Where feasible, preprocess or derive:
- summaries
- decisions
- action items
- recurring issues
- named entities
- source timestamps
- simple risk or anomaly indicators

### C. Synthesis
Compose a final answer that separates:
- observed facts
- likely interpretation
- confidence
- missing information

This separation is critical to trust.

---

## 14. Non-functional requirements

## 14.1 Trust
- answers must be evidence-backed
- hallucinated specifics are unacceptable
- confidence must be surfaced
- conflicting evidence must be acknowledged

## 14.2 Freshness
- Slack, email, and calendar context should be near real-time or regularly refreshed
- Metabase should reflect its own source refresh cadence
- recent changes should be prioritized for most leadership queries

## 14.3 Security
- strict authentication and authorization
- encryption for stored tokens and secrets
- audit logging for every query and answer
- role-restricted access to sensitive connectors

## 14.4 Reliability
- graceful degradation when a source is unavailable
- clear response when evidence is incomplete
- timeout handling and partial-answer support where needed

## 14.5 Performance
- typical response latency should feel conversational
- long-running investigations should still return a useful answer rather than fail silently

---

## 15. Success metrics

## Usage
- number of founder queries per week
- founder weekly active usage
- repeat usage rate

## Efficiency
- time saved per leadership investigation
- reduction in manual status gathering
- reduction in ad hoc information requests to teams

## Quality
- founder helpfulness rating
- percentage of answers marked trustworthy
- percentage of answers with usable evidence
- follow-up rate due to incomplete or unclear answers

## Strategic value
- number of leadership questions answered without manual coordination
- number of risks surfaced earlier than traditional reporting loops

---

## 16. Risks and mitigations

### Risk 1: Trust collapse due to incorrect answers
**Mitigation:** evidence-first responses, confidence labels, explicit unknowns, no unsupported claims.

### Risk 2: Sensitive data exposure
**Mitigation:** founders-only access, strict allowlist, source-level restrictions, audit logs, secure secret handling.

### Risk 3: Weak cross-source reasoning
**Mitigation:** start with high-value query categories, use explicit source routing, define canonical systems where needed.

### Risk 4: Conflicting truths across systems
**Mitigation:** identify canonical source by domain, surface conflicts clearly, avoid forcing false certainty.

### Risk 5: Too much noise
**Mitigation:** concise answer structure, prioritization, limit unnecessary detail, expose evidence only when useful.

---

## 17. High-level architecture

## Components
1. **Slack app layer**
   - founder authentication
   - incoming question handling
   - response delivery

2. **Backend orchestration service**
   - query classification
   - source routing
   - permissions enforcement
   - answer generation
   - audit logging

3. **Connector layer**
   - Slack
   - email
   - meeting transcript system
   - calendar
   - Jira
   - Metabase
   - GitHub

4. **Retrieval and indexing layer**
   - metadata store
   - optional search index / vector index
   - cached summaries or extracted artifacts where useful

5. **LLM reasoning layer**
   - query understanding
   - evidence synthesis
   - response formatting

## Recommended technical approach
- hybrid retrieval strategy
- live retrieval for freshness
- lightweight preprocessing for transcripts, decisions, action items, and key metadata

---

## 18. Rollout plan

## Phase 0: Design and alignment
- finalize founder user list
- finalize Slack surface
- define top 20 founder questions
- identify canonical source per domain
- define connector access and credentials

## Phase 1: MVP
- Slack DM experience
- founders-only access control
- support the six priority categories
- integrate Slack, email, meeting transcripts, calendar, Jira, Metabase, GitHub
- deliver grounded Q&A answers with evidence links where possible
- implement query and audit logging

## Phase 2: Hardening
- improve source routing
- improve response quality and confidence handling
- add better summarization of transcript and thread evidence
- tune domain-specific prompts for placements, admissions, student health, finance, product, and NST

## Future phases
- scheduled digests
- proactive alerts
- workflow suggestions
- action-taking capabilities with approval flows

---

## 19. Open product decisions

These are not blockers, but they should be resolved during design:

1. **Slack surface**
   - DM only, or DM plus private founder channel?

2. **Canonical metrics policy**
   - Which finance, admissions, and placement numbers are authoritative in case of conflict?

3. **Email scope**
   - Founder inboxes only, or shared/team mailboxes too?

4. **Meeting transcript source**
   - Which system is primary, and how are recordings/transcripts accessed?

5. **Evidence link behavior**
   - Should links always be shown when available, or only on request?

6. **Retention and audit**
   - How long should queries, retrieved evidence references, and answer logs be stored?

---

## 20. MVP definition

Sentinel v1 is successful if a founder can ask a high-value question in Slack about placements, admissions, student health, product execution, finance, or NST operations, and receive within a conversational time frame a concise, useful, grounded, read-only answer synthesized from multiple internal systems, with raw evidence links where possible.

---

## 21. One-line positioning

**Sentinel is the founders-only internal Slack intelligence layer for Newton School.**

