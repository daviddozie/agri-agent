import logging
from pathlib import Path

from dotenv import load_dotenv
from langgraph.graph import StateGraph, START

from graph_state import AnalysisState
from graph_nodes import (
    initial_ingest_node,
    semantic_search_node,
    neo4j_context_node,
    trend_analysis_node,
    chart_generation_node,
    audit_node,
    respond_node,
)

load_dotenv(Path(__file__).parent / ".env")

logger = logging.getLogger("analysis_agent")


def build_analysis_graph():
    """
    Builds and compiles the edgeless Log Analysis StateGraph.

    Structural rule (per Stage 4 brief): exactly ONE static edge is
    permitted — START -> initial_ingest_node. Every other transition
    between nodes is computed dynamically at runtime inside the node
    itself via Command(goto=...), not declared here via add_edge().
    """
    builder = StateGraph(AnalysisState)

    # ── Register all 6 nodes ────────────────────────────────────────
    builder.add_node("initial_ingest_node", initial_ingest_node)
    builder.add_node("semantic_search_node", semantic_search_node)
    builder.add_node("neo4j_context_node", neo4j_context_node)
    builder.add_node("trend_analysis_node", trend_analysis_node)
    builder.add_node("chart_generation_node", chart_generation_node)
    builder.add_node("audit_node", audit_node)
    builder.add_node("respond_node", respond_node)

    # ── THE ONLY STATIC EDGE PERMITTED ──────────────────────────────
    # All other hops (semantic_search_node -> respond_node,
    # trend_analysis_node -> chart_generation_node | respond_node, etc.)
    # are decided dynamically inside each node via Command(goto=...).
    builder.add_edge(START, "initial_ingest_node")

    graph = builder.compile()

    logger.info(
        "Edgeless Log Analysis StateGraph compiled. "
        "Static edges: 1 (START -> initial_ingest_node). "
        "All other routing is dynamic via Command(goto=...)."
    )

    return graph