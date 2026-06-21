import os
import sys
import sqlite3
import json
from pathlib import Path
from datetime import datetime
import asyncio

import streamlit as st
import matplotlib.pyplot as plt
import seaborn as sns
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

from graph_builder import build_analysis_graph
from agent import logger as agent_logger

# Ensure explainability engine is importable
sys.path.append(str(Path(__file__).parent))
from explainability_engine import run_explainability_audit, save_audit_report

def get_recent_sessions():
    db_path = os.getenv("SQLITE_DB_PATH", "mcp_agent_log.db")
    if not os.path.exists(db_path):
        return []
    try:
        conn = sqlite3.connect(db_path)
        rows = conn.execute("SELECT value FROM store").fetchall()
        sessions = {}
        for row in rows:
            try:
                val = json.loads(row[0].decode('utf-8') if isinstance(row[0], bytes) else row[0])
                sid = val.get("session_id")
                if sid:
                    if sid not in sessions:
                        sessions[sid] = {"has_error": False, "query": "", "logs_count": 0}
                    sessions[sid]["logs_count"] += 1
                    if val.get("level") == "ERROR":
                        sessions[sid]["has_error"] = True
                    if val.get("mcp_interaction_type") == "agent_planning" and not sessions[sid]["query"]:
                        sessions[sid]["query"] = val.get("content", "")
            except Exception:
                pass
        
        # Sort sessions
        sorted_sessions = []
        for sid, info in sessions.items():
            status = "ERROR" if info["has_error"] else "SUCCESS"
            short_query = info["query"][:60] + "..." if len(info["query"]) > 60 else info["query"]
            label = f"{sid[:8]}... | {status} | Logs: {info['logs_count']} | '{short_query}'"
            sorted_sessions.append((sid, label))
        return sorted_sessions
    except Exception as e:
        st.error(f"Error reading session list: {e}")
        return []

# Page config
st.set_page_config(
    page_title="Agri Agent Diagnostic Dashboard",
    page_icon="🌱",
    layout="wide",
)

# Header
st.title("🌱 Agricultural Agent Diagnostic Dashboard")
st.caption("Resilient Client Orchestration, Edgeless State Routing, and Graph-Contextual Explainability Audits — Stage 4")
st.divider()

# Session state
if "agent" not in st.session_state:
    with st.spinner("Initialising edgeless Log Analysis StateGraph..."):
        st.session_state.agent = build_analysis_graph()

if "chat_history" not in st.session_state:
    st.session_state.chat_history = []

if "neo4j_notifications" not in st.session_state:
    st.session_state.neo4j_notifications = []

if "last_chart_path" not in st.session_state:
    st.session_state.last_chart_path = None

if "active_audit_report" not in st.session_state:
    st.session_state.active_audit_report = None

# Layout: two columns
left_col, right_col = st.columns([2, 1])

# Left column with tabs
with left_col:
    tab1, tab2 = st.tabs(["💬 Log Analysis Agent", "🔍 Explainability Audit Room"])

    with tab1:
        st.subheader("Natural Language Analysis Interface")
        st.caption(
            "Ask questions about your agent logs. Examples:\n"
            "- *Find all tool invocation logs*\n"
            "- *Show me error frequency metrics as a chart*\n"
            "- *Map session abc123 to Neo4j*\n"
            "- *What interaction types are most common?*"
        )

        # Render chat history
        for message in st.session_state.chat_history:
            with st.chat_message(message["role"]):
                st.markdown(message["content"])

        # Chat input
        user_input = st.chat_input("Ask the Log Analysis Agent...")

        if user_input:
            # Display user message
            agent_logger.info(f"User query received: '{user_input}'")
            st.session_state.chat_history.append(
                {
                    "role": "user",
                    "content": user_input,
                }
            )
            with st.chat_message("user"):
                st.markdown(user_input)

            # Run agent
            with st.chat_message("assistant"):
                with st.spinner("Analyzing logs..."):

                    # Step-by-step reasoning display
                    reasoning_placeholder = st.empty()

                    async def run_agent(query: str):
                        return await st.session_state.agent.ainvoke(
                            {"user_query": query, "steps": []}
                        )

                    loop = asyncio.new_event_loop()
                    asyncio.set_event_loop(loop)
                    result = loop.run_until_complete(run_agent(user_input))
                    loop.close()

                    # Step trace comes directly from graph state
                    steps = result.get("steps", [])
                    for i in range(1, len(steps) + 1):
                        reasoning_placeholder.markdown(
                            "\n\n".join(f"**Step {n}:** {s}" for n, s in enumerate(steps[:i], 1))
                        )

                    # Neo4j notification, directly from state
                    if result.get("neo4j_summary") and "Nodes created" in result["neo4j_summary"]:
                        st.session_state.neo4j_notifications.append({
                            "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                            "content": result["neo4j_summary"],
                        })

                    # Chart path, directly from state
                    if result.get("chart_path"):
                        st.session_state.last_chart_path = result["chart_path"]

                    final_answer = result.get("final_answer", "No answer generated.")

                # Clear reasoning steps, show final answer
                reasoning_placeholder.empty()

                # Show step-by-step reasoning in expander
                if steps:
                    with st.expander("Step-by-step reasoning", expanded=False):
                        for step in steps:
                            st.markdown(step)

                # Final answer
                st.markdown(final_answer)

                # Show chart if generated
                if st.session_state.last_chart_path:
                    chart_path = Path(st.session_state.last_chart_path)
                    if chart_path.exists():
                        st.image(
                            str(chart_path),
                            caption="Generated trend chart",
                            use_container_width=True,
                        )
                        st.session_state.last_chart_path = None

            st.session_state.chat_history.append(
                {
                    "role": "assistant",
                    "content": final_answer,
                }
            )

    with tab2:
        st.subheader("🔍 Explainability Audit Control Room")
        st.caption("Inspect proxy LIME and SHAP value weights combined with adjacent Neo4j graphs.")
        
        session_list = get_recent_sessions()
        if not session_list:
            st.info("No execution traces found in the SQLite database yet.")
        else:
            session_options = {label: sid for sid, label in session_list}
            selected_label = st.selectbox("Select target Session ID for audit:", list(session_options.keys()))
            target_session_id = session_options[selected_label]
            
            if st.button("Initiate Localized Explainability Audit", type="primary", use_container_width=True):
                with st.spinner("Calculating token importance (LIME), structured feature weights (SHAP) and fetching Neo4j context..."):
                    # Execute audit using the async engine
                    audit_loop = asyncio.new_event_loop()
                    asyncio.set_event_loop(audit_loop)
                    report = audit_loop.run_until_complete(run_explainability_audit(target_session_id))
                    audit_loop.close()
                    
                    if "error" in report:
                        st.error(f"Audit completed with error: {report['error']}")
                    else:
                        save_audit_report(report)
                        st.session_state.active_audit_report = report
            
            if st.session_state.active_audit_report and st.session_state.active_audit_report.get("session_id") == target_session_id:
                report = st.session_state.active_audit_report
                
                st.success("Audit completed successfully! View details below.")
                st.divider()
                
                # Layout for XAI Metric Renderers
                col_x, col_y = st.columns([1, 1])
                
                with col_x:
                    st.subheader("⚖️ Structured Feature Contributions (Proxy SHAP)")
                    shap_data = report.get("proxy_shap", {})
                    if shap_data:
                        shap_values = shap_data.get("shapley_values", {})
                        feature_vector = shap_data.get("feature_vector", {})
                        
                        # Generate matplotlib bar chart
                        fig, ax = plt.subplots(figsize=(7, 4.5))
                        features = list(shap_values.keys())
                        weights = list(shap_values.values())
                        
                        # Harmonious colors
                        colors = ['#f44336' if w > 0 else '#4caf50' for w in weights]
                        
                        sns.barplot(x=weights, y=features, palette=colors, ax=ax, hue=features, legend=False)
                        ax.set_title("Proxy Shapley Values (Feature Impact on Failure)", fontsize=11, fontweight="bold")
                        ax.set_xlabel("Contribution Score")
                        ax.set_ylabel("Metric Feature")
                        plt.axvline(0, color='grey', linewidth=0.8, linestyle='--')
                        plt.tight_layout()
                        st.pyplot(fig)
                        plt.close(fig)
                        
                        st.write(f"Dominant Anomaly Feature: **`{shap_data.get('dominant_feature')}`**")
                        with st.expander("View Raw Feature Vector Values"):
                            for k, v in feature_vector.items():
                                st.write(f"- `{k}`: {v:.2f}")
                                
                with col_y:
                    st.subheader("📝 Unstructured Token Importance (Proxy LIME)")
                    lime_data = report.get("proxy_lime", {})
                    if lime_data:
                        importances = lime_data.get("top_importances", [])
                        st.write("Top masked phrase windows skewing log text similarity toward failure context:")
                        
                        lime_rows = []
                        for idx, imp in enumerate(importances[:8], 1):
                            importance_score = imp["importance"]
                            window_text = imp["window_text"]
                            indicator = "🚨 High" if abs(importance_score) > 0.05 else "⚠️ Medium"
                            lime_rows.append({
                                "Rank": idx,
                                "Log Phrase Window": window_text,
                                "Importance (phi)": importance_score,
                                "Severity Alert": indicator
                            })
                        if lime_rows:
                            st.dataframe(lime_rows, use_container_width=True)
                        else:
                            st.write("No LIME results.")
                
                st.subheader("🕸️ Neo4j Graph-Relational adjacent context")
                neo4j_context = report.get("neo4j_context", {})
                if neo4j_context.get("found"):
                    st.write(f"Hydrated adjacency path: **{neo4j_context.get('node_count')}** nodes and **{neo4j_context.get('edge_count')}** edges.")
                    with st.expander("Show adjacent structural path traces from Graph Database"):
                        st.text(neo4j_context.get("context_text"))
                else:
                    st.warning("No adjacent Neo4j graph nodes found for this session. Use the Log Analysis Agent tab or map tool first to sync traces.")
                
                with st.expander("View Complete XAI Compliance Report JSON"):
                    st.json(report)


# Right column: Neo4j notifications, quick actions, system info, resilience tracking
with right_col:
    st.subheader("Neo4j Sync Notifications")

    if st.session_state.neo4j_notifications:
        for notif in reversed(st.session_state.neo4j_notifications):
            with st.container(border=True):
                st.caption(f"{notif['timestamp']}")
                st.text(notif["content"])
    else:
        st.info(
            "No Neo4j sync events yet.\n\n"
            "Ask the agent to map a session to trigger a sync."
        )

    st.divider()

    st.subheader("Quick Actions")
    st.caption("Click to send a preset query to the agent")

    quick_queries = [
        "What are the most common interaction types? Show me a chart.",
        "Find any error logs and summarize them.",
        "Show session activity metrics as a chart.",
        "Search for all sampling request logs.",
    ]

    for q in quick_queries:
        if st.button(q, use_container_width=True):
            st.session_state.chat_history.append(
                {
                    "role": "user",
                    "content": q,
                }
            )
            st.rerun()

    st.divider()

    st.subheader("System Info")
    db_path = os.getenv("SQLITE_DB_PATH", "mcp_agent_log.db")
    db_file = Path(db_path)
    if db_file.exists():
        size_kb = db_file.stat().st_size / 1024
        st.metric("Log DB size", f"{size_kb:.1f} KB")
        st.metric("DB path", db_path)
    else:
        st.warning("mcp_agent_log.db not found")

    st.divider()

    st.subheader("Resilience Tracking")
    st.caption("Live counts of MCP client fallback activations")

    show_resilience = st.toggle("Show resilience metrics", value=True)

    if show_resilience:
        async def _fetch_resilience_counts():
            from langchain_huggingface import HuggingFaceEmbeddings
            from langgraph.store.sqlite.aio import AsyncSqliteStore

            embed_model = os.getenv("EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
            embeddings = HuggingFaceEmbeddings(model_name=embed_model)
            resilience_db_path = os.getenv("SQLITE_DB_PATH", "mcp_agent_log.db")

            async with AsyncSqliteStore.from_conn_string(
                resilience_db_path,
                index={"dims": 384, "embed": embeddings.aembed_documents},
            ) as resilience_store:
                results = await resilience_store.asearch(
                    ("logs", "resilience"),
                    query="fallback retry resilience event",
                    limit=200,
                )

            self_healing = 0
            hardcoded = 0
            for item in results:
                namespace_str = str(item.namespace)
                if "self_healing" in namespace_str:
                    self_healing += 1
                elif "hardcoded_absolute" in namespace_str:
                    hardcoded += 1

            return self_healing, hardcoded

        resilience_loop = asyncio.new_event_loop()
        asyncio.set_event_loop(resilience_loop)
        self_healing_count, hardcoded_count = resilience_loop.run_until_complete(
            _fetch_resilience_counts()
        )
        resilience_loop.close()

        col_a, col_b = st.columns(2)
        with col_a:
            st.metric("Self-healing activations", self_healing_count)
        with col_b:
            st.metric("Hardcoded fallback activations", hardcoded_count)

        if self_healing_count == 0 and hardcoded_count == 0:
            st.success("No resilience fallbacks triggered — system running on primary path.")
        elif hardcoded_count > 0:
            st.error(
                f"⚠️ {hardcoded_count} catastrophic failure(s) reached the hardcoded "
                "absolute fallback. Review mcp_agent_system.log for details."
            )
        else:
            st.warning(
                f"{self_healing_count} self-healing fallback(s) activated. "
                "System recovered without reaching catastrophic failure."
            )