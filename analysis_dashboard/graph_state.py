from typing import Literal, Optional
from typing_extensions import TypedDict


class AnalysisState(TypedDict, total=False):
    """
    Shared state for the edgeless Log Analysis StateGraph.
    Every node reads from and writes to this schema. Routing between
    nodes is computed dynamically inside each node via Command(goto=...),
    not declared as static graph edges.
    """
    user_query: str

    # Routing intent (set by initial_ingest_node)
    intent: Literal[
        "semantic_search",
        "neo4j_mapping",
        "trend_metrics",
        "chart_request",
        "audit_request",
        "unknown",
    ]

    # Working data, populated as nodes execute
    semantic_results: Optional[str]
    session_id: Optional[str]
    neo4j_summary: Optional[str]
    trend_metric_name: Optional[str]
    trend_metrics_json: Optional[str]
    chart_path: Optional[str]
    chart_requested: bool

    # Step trace, for dashboard "step-by-step reasoning" display
    steps: list[str]

    # Final output
    final_answer: str
    audit_report: Optional[dict]