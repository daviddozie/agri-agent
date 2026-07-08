import json
import logging
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv
from pydantic import BaseModel, Field
from langgraph.types import Command
from langchain_openai import ChatOpenAI
from langchain_huggingface import HuggingFaceEmbeddings
from postgres_store import PostgresStore
from explainability_engine import run_explainability_audit, save_audit_report
from neo4j import GraphDatabase

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import seaborn as sns

from graph_state import AnalysisState

load_dotenv(Path(__file__).parent / ".env")

logger = logging.getLogger("analysis_agent")

_model_name = os.getenv("REASONING_MODEL", "openai/gpt-4o-mini")
_api_key = os.getenv("OPENROUTER_API_KEY")
_api_base = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
_embedding_model = os.getenv("EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2")

_classifier_llm = ChatOpenAI(
    model=_model_name,
    openai_api_key=_api_key,
    openai_api_base=_api_base,
    temperature=0.0,
)

_embeddings = HuggingFaceEmbeddings(model_name=_embedding_model)

_neo4j_driver = GraphDatabase.driver(
    os.getenv("NEO4J_URI"),
    auth=(os.getenv("NEO4J_USERNAME"), os.getenv("NEO4J_PASSWORD")),
)


def _append_step(state: AnalysisState, message: str) -> list[str]:
    steps = list(state.get("steps", []))
    steps.append(message)
    return steps


class IntentClassification(BaseModel):
    intent: Literal[
        "semantic_search",
        "neo4j_mapping",
        "trend_metrics",
        "chart_request",
        "audit_request",
        "unknown",
    ] = Field(
        description=(
            "The classified intent of the user's query. "
            "semantic_search: looking for log entries or traces. "
            "neo4j_mapping: wants a session mapped to the Neo4j graph. "
            "trend_metrics: wants operational metrics computed (counts, frequencies). "
            "chart_request: wants a visual chart generated. "
            "audit_request: wants an explainability/XAI audit report on a failure. "
            "unknown: doesn't clearly match any of the above."
        )
    )
    session_id: str | None = Field(
        default=None,
        description=(
            "ONLY extract this if the query contains an actual UUID-formatted "
            "session ID (e.g., '715202f1-0791-4cee-8603-d1573daba5a5'). "
            "If no explicit UUID is present in the query text, this MUST be null. "
            "Never invent or guess a session ID."
        ),
    )
    reasoning: str = Field(description="One sentence explaining the classification.")

async def audit_node(
    state: AnalysisState,
) -> Command[Literal["respond_node"]]:
    session_id = state.get("session_id")
    logger.info(f"[audit_node] Running explainability audit for session_id={session_id}")

    if not session_id:
        steps = _append_step(state, "audit_node: no session_id provided, cannot run audit")
        return Command(
            update={
                "audit_report": None,
                "steps": steps,
            },
            goto="respond_node",
        )

    report = await run_explainability_audit(session_id)

    if "error" in report:
        steps = _append_step(state, f"audit_node: {report['error']}")
        return Command(
            update={"audit_report": report, "steps": steps},
            goto="respond_node",
        )

    saved_path = save_audit_report(report)

    dominant = report.get("proxy_shap", {}).get("dominant_feature", "unknown")
    top_lime = report.get("proxy_lime", {}).get("top_importances", [])
    top_lime_text = top_lime[0]["window_text"] if top_lime else "N/A"

    steps = _append_step(
        state,
        f"audit_node: explainability audit complete — "
        f"dominant SHAP feature='{dominant}', top LIME token-window='{top_lime_text}', "
        f"saved to {saved_path}",
    )

    return Command(
        update={"audit_report": report, "steps": steps},
        goto="respond_node",
    )


# ════════════════════════════════════════════════════════════════════
# NODE: initial_ingest_node
# This is the ONLY node reached via a static edge: START → initial_ingest_node.
# Every node after this computes its own destination via Command(goto=...).
# ════════════════════════════════════════════════════════════════════

async def initial_ingest_node(
    state: AnalysisState,
) -> Command[Literal[
    "semantic_search_node",
    "neo4j_context_node",
    "trend_analysis_node",
    "chart_generation_node",
    "audit_node",
    "respond_node",
]]:
    user_query = state["user_query"]
    logger.info(f"[initial_ingest_node] Classifying intent for query: '{user_query}'")

    classifier = _classifier_llm.with_structured_output(IntentClassification)
    result: IntentClassification = await classifier.ainvoke(
        f"Classify the intent of this log-analysis query:\n\n{user_query}"
    )

    logger.info(
        f"[initial_ingest_node] Classified as '{result.intent}' "
        f"(session_id={result.session_id}) — {result.reasoning}"
    )

    step_trace = _append_step(
        state,
        f"initial_ingest_node: classified intent='{result.intent}' "
        f"({result.reasoning})",
    )

    state_update = {
        "intent": result.intent,
        "session_id": result.session_id,
        "steps": step_trace,
    }

    # ── Dynamic routing decision, computed here, not via add_edge() ──
    if result.intent == "semantic_search":
        return Command(update=state_update, goto="semantic_search_node")
    elif result.intent == "neo4j_mapping":
        return Command(update=state_update, goto="neo4j_context_node")
    elif result.intent == "trend_metrics":
        return Command(update=state_update, goto="trend_analysis_node")
    elif result.intent == "chart_request":
        return Command(update={**state_update, "chart_requested": True}, goto="trend_analysis_node")
    elif result.intent == "audit_request":
        return Command(update=state_update, goto="audit_node")
    else:
        # unknown
        return Command(update=state_update, goto="respond_node")


async def semantic_search_node(
    state: AnalysisState,
) -> Command[Literal["respond_node"]]:
    user_query = state["user_query"]
    logger.info(f"[semantic_search_node] Searching for: '{user_query}'")

    db_path = os.getenv("SQLITE_DB_PATH", "mcp_agent_log.db")

    store = await PostgresStore.from_conn_string(
        db_path,
        index={"dims": 384, "embed": _embeddings.aembed_documents},
    )
    async with store:
        results = await store.asearch(("logs",), query=user_query, limit=5)

    if not results:
        summary = "No relevant log entries found."
    else:
        lines = []
        for item in results:
            value = item.value
            lines.append(
                f"[{value.get('timestamp', 'N/A')}] "
                f"[{value.get('component', '?').upper()}] "
                f"[{value.get('mcp_interaction_type', '?')}] "
                f"session={value.get('session_id', '?')[:8]}... "
                f"| {value.get('content', '')}"
            )
        summary = "\n".join(lines)

    logger.info(f"[semantic_search_node] Found {len(results)} results")

    steps = _append_step(state, f"semantic_search_node: found {len(results)} matching log entries")

    return Command(
        update={"semantic_results": summary, "steps": steps},
        goto="respond_node",
    )


# ════════════════════════════════════════════════════════════════════
# NODE: neo4j_context_node
# ════════════════════════════════════════════════════════════════════

async def neo4j_context_node(
    state: AnalysisState,
) -> Command[Literal["respond_node"]]:
    session_id = state.get("session_id")
    logger.info(f"[neo4j_context_node] Mapping session: {session_id}")

    if not session_id:
        steps = _append_step(state, "neo4j_context_node: no session_id provided, skipping")
        return Command(
            update={"neo4j_summary": "No session_id provided for Neo4j mapping.", "steps": steps},
            goto="respond_node",
        )

    db_path = os.getenv("SQLITE_DB_PATH", "mcp_agent_log.db")

    store = await PostgresStore.from_conn_string(
        db_path,
        index={"dims": 384, "embed": _embeddings.aembed_documents},
    )
    async with store:
        results = await store.asearch(("logs",), query=f"session {session_id}", limit=50)

    entries = [r.value for r in results if r.value.get("session_id") == session_id]

    if not entries:
        steps = _append_step(state, f"neo4j_context_node: no log entries found for session {session_id}")
        return Command(
            update={"neo4j_summary": f"No log entries found for session_id: {session_id}", "steps": steps},
            goto="respond_node",
        )

    nodes_created = 0
    edges_created = 0

    with _neo4j_driver.session() as neo_session:
        neo_session.run(
            """
            MERGE (s:Session {session_id: $session_id})
            ON CREATE SET s.created_at = $created_at
            """,
            session_id=session_id,
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        nodes_created += 1

        prev_action_id = None
        for entry in entries:
            interaction_type = entry.get("mcp_interaction_type", "unknown")
            content = entry.get("content", "")
            timestamp = entry.get("timestamp", "")
            component = entry.get("component", "client")
            action_id = str(uuid.uuid4())

            if component == "client" and interaction_type in (
                "agent_planning", "resource_read", "tool_invocation",
                "sampling_request", "resilience_event",
            ):
                neo_session.run(
                    """
                    MERGE (a:AgentAction {action_id: $action_id})
                    ON CREATE SET a.action_type = $action_type,
                        a.timestamp = $timestamp, a.content = $content
                    """,
                    action_id=action_id, action_type=interaction_type,
                    timestamp=timestamp, content=content[:200],
                )
                nodes_created += 1

                neo_session.run(
                    """
                    MATCH (s:Session {session_id: $session_id})
                    MATCH (a:AgentAction {action_id: $action_id})
                    MERGE (s)-[:TRIGGERED]->(a)
                    """,
                    session_id=session_id, action_id=action_id,
                )
                edges_created += 1

                if prev_action_id:
                    neo_session.run(
                        """
                        MATCH (a1:AgentAction {action_id: $prev_id})
                        MATCH (a2:AgentAction {action_id: $curr_id})
                        MERGE (a2)-[:DEPENDS_ON]->(a1)
                        """,
                        prev_id=prev_action_id, curr_id=action_id,
                    )
                    edges_created += 1

                prev_action_id = action_id

            elif component == "server" or interaction_type == "server_log":
                neo_session.run(
                    """
                    MERGE (m:MCPServerCall {action_id: $action_id})
                    ON CREATE SET m.call_type = $call_type,
                        m.timestamp = $timestamp, m.content = $content
                    """,
                    action_id=action_id, call_type=interaction_type,
                    timestamp=timestamp, content=content[:200],
                )
                nodes_created += 1

                if prev_action_id:
                    neo_session.run(
                        """
                        MATCH (a:AgentAction {action_id: $prev_id})
                        MATCH (m:MCPServerCall {action_id: $action_id})
                        MERGE (a)-[:ROUTED_TO]->(m)
                        """,
                        prev_id=prev_action_id, action_id=action_id,
                    )
                    edges_created += 1

    summary = (
        f"Neo4j sync complete for session {session_id[:8]}...\n"
        f"Nodes created: {nodes_created}\n"
        f"Edges created: {edges_created}\n"
        f"Log entries processed: {len(entries)}"
    )
    logger.info(f"[neo4j_context_node] {summary}")

    steps = _append_step(
        state,
        f"neo4j_context_node: synced {nodes_created} nodes, {edges_created} edges for session {session_id[:8]}...",
    )

    return Command(
        update={"neo4j_summary": summary, "steps": steps},
        goto="respond_node",
    )


# ════════════════════════════════════════════════════════════════════
# NODE: trend_analysis_node
# Routes to chart_generation_node if a chart was requested, else respond_node.
# ════════════════════════════════════════════════════════════════════

async def trend_analysis_node(
    state: AnalysisState,
) -> Command[Literal["chart_generation_node", "respond_node"]]:
    user_query = state["user_query"]
    metric = "interaction_types"
    if "error" in user_query.lower():
        metric = "error_frequency"
    elif "session" in user_query.lower() and "activity" in user_query.lower():
        metric = "session_activity"

    logger.info(f"[trend_analysis_node] Computing metric: {metric}")

    db_path = os.getenv("SQLITE_DB_PATH", "mcp_agent_log.db")

    store = await PostgresStore.from_conn_string(
        db_path,
        index={"dims": 384, "embed": _embeddings.aembed_documents},
    )
    async with store:
        results = await store.asearch(("logs",), query=metric, limit=200)

    entries = [r.value for r in results]
    metrics: dict = {}

    if metric == "interaction_types":
        for e in entries:
            t = e.get("mcp_interaction_type", "unknown")
            metrics[t] = metrics.get(t, 0) + 1
    elif metric == "error_frequency":
        for e in entries:
            if e.get("level") == "ERROR":
                date = e.get("timestamp", "")[:10]
                metrics[date] = metrics.get(date, 0) + 1
    elif metric == "session_activity":
        for e in entries:
            sid = e.get("session_id", "unknown")[:8]
            metrics[sid] = metrics.get(sid, 0) + 1

    metrics_json = json.dumps(metrics, indent=2)
    logger.info(f"[trend_analysis_node] Computed: {metrics_json}")

    steps = _append_step(state, f"trend_analysis_node: computed '{metric}' metrics ({len(metrics)} categories)")

    state_update = {
        "trend_metric_name": metric,
        "trend_metrics_json": metrics_json,
        "steps": steps,
    }

    if state.get("chart_requested"):
        return Command(update=state_update, goto="chart_generation_node")
    return Command(update=state_update, goto="respond_node")


# ════════════════════════════════════════════════════════════════════
# NODE: chart_generation_node
# ════════════════════════════════════════════════════════════════════

async def chart_generation_node(
    state: AnalysisState,
) -> Command[Literal["respond_node"]]:
    metrics_json = state.get("trend_metrics_json", "{}")
    metric_name = state.get("trend_metric_name", "metric")
    logger.info(f"[chart_generation_node] Generating chart for: {metric_name}")

    try:
        data = json.loads(metrics_json)
    except json.JSONDecodeError:
        data = {}

    chart_path_str = ""
    if data:
        labels = list(data.keys())
        values = list(data.values())

        fig, ax = plt.subplots(figsize=(10, 5))
        sns.barplot(x=labels, y=values, hue=labels, legend=False, palette="viridis", ax=ax)
        ax.set_title(metric_name.replace("_", " ").title(), fontsize=14, fontweight="bold")
        ax.set_xlabel("Category", fontsize=11)
        ax.set_ylabel("Count", fontsize=11)
        plt.xticks(rotation=30, ha="right")
        plt.tight_layout()

        output_path = Path(__file__).parent / f"{metric_name}_chart.png"
        fig.savefig(output_path, dpi=150)
        plt.close(fig)
        chart_path_str = str(output_path)
        logger.info(f"[chart_generation_node] Chart saved to {chart_path_str}")

    steps = _append_step(state, f"chart_generation_node: chart saved to {chart_path_str or 'N/A'}")

    return Command(
        update={"chart_path": chart_path_str, "steps": steps},
        goto="respond_node",
    )


# ════════════════════════════════════════════════════════════════════
# NODE: respond_node
# Terminal node — assembles whatever is in state into a single
# human-readable final_answer, then routes to END (the only other
# permitted destination besides peer nodes).
# ════════════════════════════════════════════════════════════════════

async def respond_node(
    state: AnalysisState,
) -> Command[Literal["__end__"]]:
    from langgraph.graph import END

    intent = state.get("intent", "unknown")
    logger.info(f"[respond_node] Assembling final answer for intent='{intent}'")

    parts: list[str] = []

    if state.get("semantic_results"):
        parts.append(f"**Semantic search results:**\n{state['semantic_results']}")

    if state.get("neo4j_summary"):
        parts.append(f"**Neo4j sync summary:**\n{state['neo4j_summary']}")

    if state.get("trend_metrics_json"):
        parts.append(
            f"**Trend metrics ({state.get('trend_metric_name', 'unknown')}):**\n"
            f"```json\n{state['trend_metrics_json']}\n```"
        )

    if state.get("chart_path"):
        parts.append(f"**Chart saved to:** {state['chart_path']}")
    
    if state.get("audit_report"):
        report = state["audit_report"]
        if "error" not in report:
            shap = report.get("proxy_shap", {})
            lime = report.get("proxy_lime", {})
            parts.append(
                f"**Explainability Audit Report**\n\n"
                f"Session: `{report['session_id']}`\n"
                f"Log entries analyzed: {report['log_entries_analyzed']}\n"
                f"Neo4j context: {report['neo4j_context']['node_count']} nodes, "
                f"{report['neo4j_context']['edge_count']} edges\n\n"
                f"**Dominant SHAP feature:** `{shap.get('dominant_feature')}`\n"
                f"```json\n{json.dumps(shap.get('shapley_values', {}), indent=2)}\n```\n\n"
                f"**Top LIME token-importance windows:**\n"
                + "\n".join(
                    f"- `{w['window_text']}` (importance: {w['importance']})"
                    for w in lime.get("top_importances", [])[:5]
                )
            )
        else:
            parts.append(f"**Audit failed:** {report['error']}")

    if not parts:
        parts.append(
            "I couldn't determine a clear action for that query. "
            "Try asking about log entries, session mapping to Neo4j, "
            "trend metrics, or a chart."
        )

    final_answer = "\n\n".join(parts)

    steps = _append_step(state, "respond_node: assembled final answer")

    logger.info(f"[respond_node] Final answer assembled ({len(final_answer)} chars)")

    return Command(
        update={"final_answer": final_answer, "steps": steps},
        goto=END,
    )