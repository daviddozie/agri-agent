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
    import psycopg2
    import redis
    import json
    
    redis_host = os.getenv("REDIS_HOST", "localhost")
    redis_port = int(os.getenv("REDIS_PORT", "6379"))
    redis_pass = os.getenv("REDIS_PASSWORD") or None
    r = redis.Redis(host=redis_host, port=redis_port, password=redis_pass, decode_responses=True)
    
    cache_key = "cache:ui:recent_sessions"
    try:
        cached = r.get(cache_key)
        if cached:
            r.incr("telemetry:cache_hits")
            return json.loads(cached)
    except Exception:
        pass

    db_url = os.getenv("DATABASE_URL")
    if not db_url or not (db_url.startswith("postgres://") or db_url.startswith("postgresql://")):
        temp_url = os.getenv("SUPABASE_URL")
        if temp_url and (temp_url.startswith("postgres://") or temp_url.startswith("postgresql://")):
            db_url = temp_url
    if not db_url:
        db_url = "postgresql://daviddozie@localhost:5432/postgres"
    
    db_url_clean = db_url.replace("?pgbouncer=true", "")
    try:
        conn = psycopg2.connect(db_url_clean)
        cursor = conn.cursor()
        cursor.execute(
            """
            SELECT 
                s.session_id, 
                s.query, 
                COUNT(t.id) as logs_count,
                EXISTS(SELECT 1 FROM trace_logs tl WHERE tl.session_id = s.session_id AND tl.level = 'ERROR') as has_error
            FROM sessions s
            LEFT JOIN trace_logs t ON t.session_id = s.session_id
            GROUP BY s.session_id, s.query, s.created_at
            ORDER BY s.created_at DESC
            """
        )
        rows = cursor.fetchall()
        cursor.close()
        conn.close()
        
        sorted_sessions = []
        for session_id, query, logs_count, has_error in rows:
            status = "ERROR" if has_error else "SUCCESS"
            q_text = query or "No query logged"
            short_query = q_text[:60] + "..." if len(q_text) > 60 else q_text
            label = f"{session_id[:8]}... | {status} | Logs: {logs_count} | '{short_query}'"
            sorted_sessions.append((session_id, label))
            
        try:
            r.set(cache_key, json.dumps(sorted_sessions), ex=10)  # cache for 10s
        except Exception:
            pass
            
        return sorted_sessions
    except Exception as e:
        st.error(f"Error reading session list from Postgres: {e}")
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
            import redis
            import json
            
            redis_host = os.getenv("REDIS_HOST", "localhost")
            redis_port = int(os.getenv("REDIS_PORT", "6379"))
            redis_pass = os.getenv("REDIS_PASSWORD") or None
            r = redis.Redis(host=redis_host, port=redis_port, password=redis_pass, decode_responses=True)
            
            cache_key = "cache:ui:resilience_counts"
            try:
                cached = r.get(cache_key)
                if cached:
                    r.incr("telemetry:cache_hits")
                    val = json.loads(cached)
                    return val[0], val[1]
            except Exception:
                pass

            from langchain_huggingface import HuggingFaceEmbeddings
            from postgres_store import PostgresStore

            embed_model = os.getenv("EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
            embeddings = HuggingFaceEmbeddings(model_name=embed_model)
            resilience_db_path = os.getenv("SQLITE_DB_PATH", "mcp_agent_log.db")

            resilience_store = await PostgresStore.from_conn_string(
                resilience_db_path,
                index={"dims": 384, "embed": embeddings.aembed_documents},
            )
            async with resilience_store:
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

            try:
                r.set(cache_key, json.dumps([self_healing, hardcoded]), ex=15)  # cache for 15s
            except Exception:
                pass

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

    st.divider()
    
    st.subheader("⚡ Caching Telemetry & Optimization")
    st.caption("Real-time distributed Redis cache performance and savings matrix")

    import redis
    redis_host = os.getenv("REDIS_HOST", "localhost")
    redis_port = int(os.getenv("REDIS_PORT", "6379"))
    redis_pass = os.getenv("REDIS_PASSWORD") or None
    try:
        r = redis.Redis(host=redis_host, port=redis_port, password=redis_pass, decode_responses=True)
        
        hits = int(r.get("telemetry:cache_hits") or 0)
        misses = int(r.get("telemetry:cache_misses") or 0)
        tokens_saved = int(r.get("telemetry:tokens_saved") or 0)
        cost_saved_micro = int(r.get("telemetry:cost_saved_micro") or 0)
        cost_saved_usd = cost_saved_micro / 1000000.0
        
        total_requests = hits + misses
        hit_rate = (hits / total_requests * 100) if total_requests > 0 else 0.0
        
        latest_hit_latency = r.get("telemetry:latest_hit_latency_ms") or "0.0"
        latest_miss_latency = r.get("telemetry:latest_miss_latency_ms") or "0.0"
        
        col_t1, col_t2 = st.columns(2)
        with col_t1:
            st.metric("Cache Hit Rate", f"{hit_rate:.1f}%", help="Percentage of LLM/UI queries bypassed via Redis")
            st.metric("Estimated Cost Savings", f"${cost_saved_usd:.6f}", help="Total dollars saved by bypassing downstream APIs")
        with col_t2:
            st.metric("Total Tokens Saved", f"{tokens_saved:,}", help="Total input & output tokens short-circuited")
            st.metric("Cache Hits / Misses", f"{hits} / {misses}", help="Hits versus misses in current deployment")

        st.subheader("⏱️ Latency Delta Metrics")
        col_l1, col_l2 = st.columns(2)
        with col_l1:
            st.metric("Latest Cache Hit Latency", f"{float(latest_hit_latency):.2f} ms", delta="Lightning Fast", delta_color="normal")
        with col_l2:
            st.metric("Latest Un-cached Latency", f"{float(latest_miss_latency):.2f} ms", delta="Standard LLM Roundtrip", delta_color="inverse")
            
        st.subheader("🧹 Cache Invalidation Hub")
        st.caption("Flush specific namespaces of the distributed Redis cache")
        
        col_b1, col_b2 = st.columns(2)
        with col_b1:
            if st.button("Purge UI Cache", use_container_width=True):
                ui_keys = r.keys("cache:ui:*")
                if ui_keys:
                    r.delete(*ui_keys)
                st.success("UI Cache Purged!")
                st.rerun()
                
            if st.button("Purge Agent Memory", use_container_width=True):
                mem_keys = r.keys("cache:semantic:*")
                if mem_keys:
                    r.delete(*mem_keys)
                st.success("Semantic Memory Cleared!")
                st.rerun()
                
        with col_b2:
            if st.button("Purge Graph Context", use_container_width=True):
                graph_keys = r.keys("cache:neo4j:*")
                if graph_keys:
                    r.delete(*graph_keys)
                st.success("Neo4j Cache Purged!")
                st.rerun()
                
            if st.button("Flush All Cache", use_container_width=True, type="primary"):
                r.flushall()
                st.success("Entire Redis Cache Flushed!")
                st.rerun()
                
    except Exception as cache_err:
        st.error(f"Failed to connect to Redis for telemetry: {cache_err}")