# Agri Agent Stage 6 — Multi-Tenant x402 Interception, Algorithmic FinOps Governance, and Live Streamlit Upgrades

A production-grade, multi-agent diagnostic system extending the Stage 5 MCP agricultural advisory agent with active EIP-3009 x402 programmatic paywalls, Xpay relay integration, Algorithmic FinOps budget cap controls, Cosine semantic search CRAG + Tavily fallback, and a live Streamlit FinOps Governance telemetry center.

---

## Project Structure

```
agri-agent/
├── pyproject.toml                  ← uv workspace root
├── .env.example                    ← environment variable reference
├── README.md
├── REFLECTION_STAGE3.md
├── REFLECTION_STAGE4.md
├── REFLECTION_STAGE5.md
├── REFLECTION_STAGE6.md            ← Stage 6 conceptual analysis
├── migrate.py                      ← database migration script
├── cache_performance_audit.json    ← semantic cache audit record
├── explainability_audit_report.json ← compliance audit export
├── finops_compliance_audit.json    ← FinOps payment compliance trace
├── mcp_agent_system.log            ← sample log from test execution
├── uvd-x402-sdk-2.53.0.tgz         ← Ultravioleta x402 Javascript/Typescript SDK tarball
├── package/                        ← Ultravioleta x402 SDK source code
├── mcp_server/
│   ├── pyproject.toml
│   ├── main.py                     ← FastMCP server (with x402 paywall protection)
│   ├── knowledge_base.py           ← agricultural domain knowledge
│   └── .env
├── agent_client/
│   ├── pyproject.toml
│   ├── main.py                     ← LangChain agent (with paywall retries and budget cap check)
│   └── .env
└── analysis_dashboard/
    ├── pyproject.toml
    ├── agent.py                    ← Log Analysis Agent definitions
    ├── app.py                      ← Streamlit UI (with telemetry & invalidation hub)
    ├── explainability_engine.py    ← LIME/SHAP calculation engine with Redis caching
    ├── graph_nodes.py              ← StateGraph nodes (Postgres-backed)
    ├── graph_builder.py            ← StateGraph compiler
    ├── postgres_store.py           ← Postgres pgvector storage helper
    └── .env
```

---

## System Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Terminal 1 — MCP Server                         │
│  FastMCP · streamable-http · port 8000                                 │
│  CRAG resource + reflect_on_answer tool                                │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ streamable-http
┌───────────────────────────────────▼────────────────────────────────────┐
│                       Terminal 2 — Agent Client                        │
│  LangChain create_agent · FastMCP Client                               │
│  sampling_handler · server log relay                                   │
│  PostgresStore → Supabase (PostgreSQL + pgvector)                      │
│  Tier 1 Semantic Cache: RedisSemanticCache (MiniLM embeddings)         │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ reads Supabase & caches in Redis
┌───────────────────────────────────▼────────────────────────────────────┐
│                    Terminal 3 — Analysis Dashboard                     │
│  Log Analysis Agent (create_agent)                                     │
│    ├── semantic_log_search  (Supabase pgvector)                        │
│    ├── map_to_neo4j         (Neo4j Aura DB - Tier 2 cache)             │
│    └── compute_trend_metrics (PostgreSQL counts - Tier 3 cache)        │
│  Streamlit UI · http://localhost:8501 (Telemetry + Invalidation Hub)   │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Prerequisites

- Python 3.14+
- `uv` → https://astral.sh/uv
- OpenRouter API key → https://openrouter.ai
- Tavily API key → https://tavily.com
- Redis server (local or cloud-hosted instance)
- Supabase project (PostgreSQL database with pgvector extension enabled)
- Neo4j Aura DB free instance → https://neo4j.com/cloud/aura-free

---

## Installation

**1. Clone the repository**

```bash
git clone https://github.com/david_dozie/agri-agent.git
cd agri-agent
```

**2. Install all workspace dependencies**

```bash
uv sync
```

**3. Set up environment variables**

Copy `.env.example` as a reference and create `.env` files in root, `agent_client`, and `analysis_dashboard` packages:

```env
OPENROUTER_API_KEY=your_openrouter_key
TAVILY_API_KEY=your_tavily_key
HF_TOKEN=your_huggingface_token

# Redis Configuration
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# Supabase / PostgreSQL Configuration
SUPABASE_URL=https://xxxxxxxx.supabase.co/rest/v1/
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key
DATABASE_URL="postgresql://postgres.xxxxxx:password@aws-0-pooler.supabase.com:6543/postgres?pgbouncer=true"

# Neo4j Graph Settings
NEO4J_URI=neo4j+s://xxxxxxxx.databases.neo4j.io
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=your_neo4j_password
```

**4. Run Database Migration**
Run the migration script to migrate old SQLite logs to your new cloud-native Supabase PostgreSQL database:
```bash
uv run python migrate.py
```

---

## Running the System

You need **three terminal windows** open simultaneously.

### Option A: Unix / macOS / Linux Bash or Zsh
```bash
# Terminal 1: Initialize your MCP Server
uv run --package mcp-server python mcp_server/main.py

# Terminal 2: Initialize your resilient application engine (Agent Client)
uv run --package agent-client python agent_client/main.py

# Terminal 3: Initialize your edgeless XAI analytical control room (Streamlit)
uv run --package analysis-dashboard streamlit run analysis_dashboard/app.py
```

### Option B: Windows Command Prompt (CMD)
```cmd
:: Terminal 1: Initialize your MCP Server
uv run --package mcp-server python mcp_server/main.py

:: Terminal 2: Initialize your resilient application engine (Agent Client)
uv run --package agent-client python agent_client/main.py

:: Terminal 3: Initialize your edgeless XAI analytical control room (Streamlit)
uv run --package analysis-dashboard streamlit run analysis_dashboard/app.py
```

### Option C: Windows PowerShell
```powershell
# Terminal 1: Initialize your MCP Server
uv run --package mcp-server python mcp_server/main.py

# Terminal 2: Initialize your resilient application engine (Agent Client)
uv run --package agent-client python agent_client/main.py

# Terminal 3: Initialize your edgeless XAI analytical control room (Streamlit)
uv run --package analysis-dashboard streamlit run analysis_dashboard/app.py
```

After launching Terminal 3, open http://localhost:8501 in your browser to access the control room.

---

## Example Agent Queries

**Queries that hit the internal knowledge base:**

```
How do I improve soil health on my farm?
What is the best irrigation strategy for dry regions?
How do I protect my crops from pests without chemicals?
How do I store grain properly after harvest?
```

**Queries that trigger Tavily fallback:**

```
What are the latest government agricultural subsidy programs in Nigeria?
What are the newest drone technologies used in precision farming?
What is the current global price of wheat?
```

---

## Example Dashboard Queries

```
Find all tool invocation logs
Show me interaction type frequency as a chart
Find any error logs and summarize them
Show session activity metrics as a chart
Search for all sampling request logs
Map session <session_id> to Neo4j
```

---

## Tech Stack

| Component | Technology |
|---|---|
| MCP Server | FastMCP 3.3.1 |
| Agent Framework | LangChain + LangGraph |
| MCP Client | FastMCP Client |
| LLM Provider | OpenRouter (GPT-4o-mini) |
| Vector Log Store | LangGraph AsyncSqliteStore |
| Embeddings | HuggingFace sentence-transformers/all-MiniLM-L6-v2 |
| Graph Database | Neo4j Aura DB |
| Dashboard | Streamlit |
| Charts | Matplotlib + Seaborn |
| Web Fallback | Tavily Search API |
| Dependency Management | uv workspace |
| Transport | streamable-http |
| Payment Protocol | x402 CAIP-2 eip155:84532 (Base Sepolia USDC) |
| Payment Gateway | Xpay Staging Gateway / Facilitator |
| Cryptography | `web3`, `eth-account` (EIP-3009 TransferWithAuthorization) |
| Language | Python 3.14 |

---

## Log Files and Audit Artifacts

| File | Description |
|---|---|
| `mcp_agent_system.log` | Dual-stream log from agent client runs |
| `mcp_agent_log.db` | SQLite vector store with structured log entries |
| `analysis_dashboard/analysis_agent.log` | Log Analysis Agent execution log |
| `explainability_audit_report.json` | High-fidelity JSON export containing SHAP/LIME calculations and Neo4j path context |
| `finops_compliance_audit.json` | High-fidelity JSON export containing Stage 6 402 challenges, EIP-3009 signatures, and verified relayer transactions |

## Screenshots

### Terminal 1 — MCP Server Running
![MCP Server](screenshots/mcp_server.png)

### Terminal 2 — Agent Client Processing Query
![Agent Client](screenshots/agent_client.png)

### Terminal 3 — Streamlit Dashboard with Neo4j Sync
![Streamlit Dashboard](screenshots/analysis_dashboard1.png)
![Streamlit Dashboard](screenshots/analysis_dashboard2.png)
![Streamlit Dashboard](screenshots/analysis_dashboard3.png)

### Terminal 4 — Explainability Audit Report
![Explainability Audit Report](screenshots/audit_log1.png)
![Explainability Audit Report](screenshots/audit_log2.png)

### Terminal 5 — Semantic Cache Audit Report
![Semantic Cache Audit Report](screenshots/cache1.png)
![Semantic Cache Audit Report](screenshots/cache2.png)
![Semantic Cache Audit Report](screenshots/cache3.png)
![Semantic Cache Audit Report](screenshots/cache4.png)

### Terminal 6 — Agent with Budget Limit Exception
![Agent with Budget Limit Exception](screenshots/FinOps-1.png)
![Agent with Budget Limit Exception](screenshots/FinOps-2.png)
![Agent with Budget Limit Exception](screenshots/FinOps-3.png)
![Agent with Budget Limit Exception](screenshots/FinOps-4.png)
