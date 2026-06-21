# Agri Agent Stage 4 — Resilient Execution, Edgeless StateGraph Analysis, and Contextual XAI

A production-grade, multi-agent diagnostic system extending the Stage 3 MCP agricultural advisory agent with strict execution resilience (RunnableWithRetry & RunnableWithFallbacks), an edgeless LangGraph StateGraph, and local explainability audits (SHAP/LIME).

---

## Project Structure

```
agri-agent/
├── pyproject.toml                  ← uv workspace root
├── .env.example                    ← environment variable reference
├── README.md
├── REFLECTION_STAGE3.md
├── REFLECTION_STAGE4.md            ← Stage 4 conceptual analysis
├── explainability_audit_report.json ← compliance audit export
├── mcp_agent_system.log            ← sample log from test execution
├── mcp_agent_log.db                ← SQLite vector log store
├── mcp_server/
│   ├── pyproject.toml
│   ├── main.py                     ← FastMCP server
│   ├── knowledge_base.py           ← agricultural domain knowledge
│   └── .env
├── agent_client/
│   ├── pyproject.toml
│   ├── main.py                     ← LangChain agent with fallback & retries
│   └── .env
└── analysis_dashboard/
    ├── pyproject.toml
    ├── agent.py                    ← Log Analysis Agent definitions
    ├── app.py                      ← Streamlit UI (chat + XAI tabs)
    ├── explainability_engine.py    ← LIME/SHAP calculation engine
    ├── graph_nodes.py              ← StateGraph nodes (edgeless)
    ├── graph_builder.py            ← StateGraph compiler
    ├── analysis_agent.log          ← sample analysis agent log
    └── .env
```

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Terminal 1 — MCP Server                  │
│  FastMCP · streamable-http · port 8000                      │
│  CRAG resource + reflect_on_answer tool                     │
│  ctx.sample() → delegates LLM to client                     │
└──────────────────────────┬──────────────────────────────────┘
                           │ streamable-http
┌──────────────────────────▼──────────────────────────────────┐
│                   Terminal 2 — Agent Client                 │
│  LangChain create_agent · FastMCP Client                    │
│  sampling_handler · server log relay                        │
│  AsyncSqliteStore → mcp_agent_log.db                        │
│  Hierarchical namespaces + HuggingFace embeddings           │
└──────────────────────────┬──────────────────────────────────┘
                           │ reads mcp_agent_log.db
┌──────────────────────────▼──────────────────────────────────┐
│               Terminal 3 — Analysis Dashboard               │
│  Log Analysis Agent (create_agent)                          │
│    ├── semantic_log_search  (vector search)                 │
│    ├── map_to_neo4j         (Neo4j Aura DB)                 │
│    ├── compute_trend_metrics (operational metrics)          │
│    └── generate_chart       (matplotlib/seaborn)            │
│  Streamlit UI · http://localhost:8501                       │
└─────────────────────────────────────────────────────────────┘
```

---

## Prerequisites

- Python 3.14+
- `uv` → https://astral.sh/uv
- OpenRouter API key → https://openrouter.ai
- Tavily API key → https://tavily.com
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

Copy `.env.example` as a reference and create `.env` files in each package:

`mcp_server/.env`:
```env
TAVILY_API_KEY=your_tavily_key
MCP_HOST=0.0.0.0
MCP_PORT=8000
```

`agent_client/.env`:
```env
OPENROUTER_API_KEY=your_openrouter_key
SQLITE_DB_PATH=mcp_agent_log.db
HF_TOKEN=your_huggingface_token
```

`analysis_dashboard/.env`:
```env
OPENROUTER_API_KEY=your_openrouter_key
NEO4J_URI=neo4j+s://xxxxxxxx.databases.neo4j.io
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=your_neo4j_password
SQLITE_DB_PATH=mcp_agent_log.db
HF_TOKEN=your_huggingface_token
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
| Language | Python 3.14 |

---

## Log Files and Audit Artifacts

| File | Description |
|---|---|
| `mcp_agent_system.log` | Dual-stream log from agent client runs |
| `mcp_agent_log.db` | SQLite vector store with structured log entries |
| `analysis_dashboard/analysis_agent.log` | Log Analysis Agent execution log |
| `explainability_audit_report.json` | High-fidelity JSON export containing SHAP/LIME calculations and Neo4j path context |

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