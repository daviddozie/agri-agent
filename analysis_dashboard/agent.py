import asyncio
import json
import logging
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from dotenv import load_dotenv

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import seaborn as sns
from neo4j import GraphDatabase
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langchain.agents import create_agent
from langchain_huggingface import HuggingFaceEmbeddings
from postgres_store import PostgresStore

load_dotenv(Path(__file__).parent / ".env")

# Logger Setup
logger = logging.getLogger("analysis_agent")
logger.setLevel(logging.INFO)

formatter = logging.Formatter(
    "[%(asctime)s] [ANALYSIS] [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
console_handler = logging.StreamHandler()
console_handler.setFormatter(formatter)

file_handler = logging.FileHandler(
    Path(__file__).parent / "analysis_agent.log"
)
file_handler.setFormatter(formatter)

logger.addHandler(console_handler)
logger.addHandler(file_handler)


llm = ChatOpenAI(
    model=os.getenv("REASONING_MODEL", "nvidia/nemotron-3-nano-30b-a3b:free"),
    openai_api_key=os.getenv("OPENROUTER_API_KEY"),
    openai_api_base=os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
    temperature=0.3,
)

embeddings = HuggingFaceEmbeddings(
    model_name=os.getenv("EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2"),
)

neo4j_driver = GraphDatabase.driver(
    os.getenv("NEO4J_URI"),
    auth=(
        os.getenv("NEO4J_USERNAME"),
        os.getenv("NEO4J_PASSWORD"),
    ),
)

@tool
async def semantic_log_search(query: str, top_k: int = 5) -> str:
    """
    Performs semantic vector similarity search over the SQLite log store.
    Use this to find relevant log entries, trace anomalies, or discover
    patterns across agent execution histories.
    """
    logger.info(f"Semantic search query: '{query}' top_k={top_k}")

    db_path = os.getenv("SQLITE_DB_PATH", "mcp_agent_log.db")

    store = await PostgresStore.from_conn_string(
        db_path,
        index={
            "dims": 384,
            "embed": embeddings.aembed_documents,
        },
    )
    async with store:
        results = await store.asearch(
            ("logs",),
            query=query,
            limit=top_k,
        )

    if not results:
        logger.warning("Semantic search returned no results")
        return "No relevant log entries found."

    output = []
    for item in results:
        value = item.value
        output.append(
            f"[{value.get('timestamp', 'N/A')}] "
            f"[{value.get('component', '?').upper()}] "
            f"[{value.get('mcp_interaction_type', '?')}] "
            f"session={value.get('session_id', '?')[:8]}... "
            f"| {value.get('content', '')}"
        )

    logger.info(f"Semantic search returned {len(output)} results")
    return "\n".join(output)


# Neo4j mapping tool
@tool
async def map_to_neo4j(session_id: str) -> str:
    """
    Extracts log entries for a given session_id from the SQLite store
    and projects them into Neo4j Aura DB as a property knowledge graph.

    Graph schema:
        (:Session)-[:TRIGGERED]->(:AgentAction)-[:ROUTED_TO]->(:MCPServerCall)
        (:AgentAction)-[:DEPENDS_ON]->(:AgentAction)
    """
    logger.info(f"Mapping session {session_id} to Neo4j...")

    db_path = os.getenv("SQLITE_DB_PATH", "mcp_agent_log.db")

    store = await PostgresStore.from_conn_string(
        db_path,
        index={
            "dims": 384,
            "embed": embeddings.aembed_documents,
        },
    )
    async with store:
        results = await store.asearch(
            ("logs",),
            query=f"session {session_id}",
            limit=50,
        )

    # Filter to exact session
    entries = [
        r.value for r in results
        if r.value.get("session_id") == session_id
    ]

    if not entries:
        return f"No log entries found for session_id: {session_id}"

    nodes_created = 0
    edges_created = 0

    with neo4j_driver.session() as neo_session:
        # Create Session node
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
                "agent_planning", "resource_read", "tool_invocation", "sampling_request"
            ):
                # AgentAction node
                neo_session.run(
                    """
                    MERGE (a:AgentAction {action_id: $action_id})
                    ON CREATE SET
                        a.action_type = $action_type,
                        a.timestamp = $timestamp,
                        a.content = $content
                    """,
                    action_id=action_id,
                    action_type=interaction_type,
                    timestamp=timestamp,
                    content=content[:200],
                )
                nodes_created += 1

                neo_session.run(
                    """
                    MATCH (s:Session {session_id: $session_id})
                    MATCH (a:AgentAction {action_id: $action_id})
                    MERGE (s)-[:TRIGGERED]->(a)
                    """,
                    session_id=session_id,
                    action_id=action_id,
                )
                edges_created += 1

                if prev_action_id:
                    neo_session.run(
                        """
                        MATCH (a1:AgentAction {action_id: $prev_id})
                        MATCH (a2:AgentAction {action_id: $curr_id})
                        MERGE (a2)-[:DEPENDS_ON]->(a1)
                        """,
                        prev_id=prev_action_id,
                        curr_id=action_id,
                    )
                    edges_created += 1

                prev_action_id = action_id

            elif interaction_type in ("tool_invocation", "sampling_request"):
                # MCPServerCall node
                neo_session.run(
                    """
                    MERGE (m:MCPServerCall {action_id: $action_id})
                    ON CREATE SET
                        m.call_type = $call_type,
                        m.timestamp = $timestamp,
                        m.content = $content
                    """,
                    action_id=action_id,
                    call_type=interaction_type,
                    timestamp=timestamp,
                    content=content[:200],
                )
                nodes_created += 1

                # AgentAction → MCPServerCall
                if prev_action_id:
                    neo_session.run(
                        """
                        MATCH (a:AgentAction {action_id: $prev_id})
                        MATCH (m:MCPServerCall {action_id: $action_id})
                        MERGE (a)-[:ROUTED_TO]->(m)
                        """,
                        prev_id=prev_action_id,
                        action_id=action_id,
                    )
                    edges_created += 1

    summary = (
        f"Neo4j sync complete for session {session_id[:8]}...\n"
        f"Nodes created: {nodes_created}\n"
        f"Edges created: {edges_created}\n"
        f"Log entries processed: {len(entries)}"
    )
    logger.info(summary)
    return summary


@tool
async def compute_trend_metrics(metric: str = "interaction_types") -> str:
    """
    Computes operational metrics from the log store.
    metric options:
        - interaction_types: counts of each mcp_interaction_type
        - error_frequency: count of ERROR level entries over time
        - session_activity: number of log entries per session
    """
    logger.info(f"Computing trend metrics: {metric}")

    db_path = os.getenv("SQLITE_DB_PATH", "mcp_agent_log.db")

    store = await PostgresStore.from_conn_string(
        db_path,
        index={
            "dims": 384,
            "embed": embeddings.aembed_documents,
        },
    )
    async with store:
        results = await store.asearch(
            ("logs",),
            query=metric,
            limit=200,
        )

    entries = [r.value for r in results]

    if not entries:
        return "No log entries found for metric computation."

    metrics = {}

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

    result = json.dumps(metrics, indent=2)
    logger.info(f"Trend metrics computed: {result}")
    return result


@tool
def generate_chart(
    metric_json: str,
    chart_title: str = "Metric Chart",
    save_to_disk: bool = True,
    filename: str = "chart.png",
) -> str:
    """
    Generates a bar chart from metric JSON data using matplotlib/seaborn.
    metric_json: JSON string of {label: value} pairs.
    save_to_disk: if True, saves the chart as a PNG file.
    filename: filename to save the chart to if save_to_disk is True.
    Returns the file path if saved, or confirms chart was rendered.
    """
    logger.info(f"Generating chart: '{chart_title}'")

    try:
        data = json.loads(metric_json)
    except json.JSONDecodeError as e:
        return f"Invalid metric JSON: {e}"

    labels = list(data.keys())
    values = list(data.values())

    fig, ax = plt.subplots(figsize=(10, 5))
    sns.barplot(x=labels, y=values, ax=ax, palette="viridis")
    ax.set_title(chart_title, fontsize=14, fontweight="bold")
    ax.set_xlabel("Category", fontsize=11)
    ax.set_ylabel("Count", fontsize=11)
    plt.xticks(rotation=30, ha="right")
    plt.tight_layout()

    if save_to_disk:
        output_path = Path(__file__).parent / filename
        fig.savefig(output_path, dpi=150)
        plt.close(fig)
        logger.info(f"Chart saved to {output_path}")
        return f"Chart saved to: {output_path}"

    plt.close(fig)
    logger.info("Chart rendered (not saved)")
    return f"Chart rendered successfully for: {chart_title}"


def build_analysis_agent():
    tools = [
        semantic_log_search,
        map_to_neo4j,
        compute_trend_metrics,
        generate_chart,
    ]

    system_prompt = """You are an expert log analysis agent for a distributed MCP-based agricultural advisory system.

You have access to the following tools:
1. semantic_log_search — search the vector log store for relevant entries
2. map_to_neo4j — project session interaction paths into Neo4j knowledge graph
3. compute_trend_metrics — calculate operational metrics from log data
4. generate_chart — render bar charts from metric data

When analyzing logs:
- Always start with semantic_log_search to find relevant entries
- Use compute_trend_metrics to calculate patterns
- Use generate_chart to visualize metrics
- Use map_to_neo4j when asked to map or sync a specific session to the graph
- Be specific and analytical in your responses
"""

    agent = create_agent(
        model=llm,
        tools=tools,
        system_prompt=system_prompt,
    )

    logger.info("Log Analysis Agent initialized")
    return agent