import json
import os
from pathlib import Path
from datetime import datetime

import streamlit as st
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

from agent import build_analysis_agent

# Page config
st.set_page_config(
    page_title="Agri Agent Diagnostic Dashboard",
    page_icon="🌱",
    layout="wide",
)

# Header
st.title("🌱 Agricultural Agent Diagnostic Dashboard")
st.caption("Hierarchical Log Persistence and Graph Knowledge Mapping — Stage 3")
st.divider()

# Session state
if "agent" not in st.session_state:
    with st.spinner("Initialising Log Analysis Agent..."):
        st.session_state.agent = build_analysis_agent()

if "chat_history" not in st.session_state:
    st.session_state.chat_history = []

if "neo4j_notifications" not in st.session_state:
    st.session_state.neo4j_notifications = []

if "last_chart_path" not in st.session_state:
    st.session_state.last_chart_path = None


# Layout: two columns
left_col, right_col = st.columns([2, 1])


# Left column: chat interface
with left_col:
    st.subheader("💬 Natural Language Analysis Interface")
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
                steps = []
                step_num = 0

                result = st.session_state.agent.invoke(
                    {"messages": [{"role": "user", "content": user_input}]},
                )

                for msg in result.get("messages", []):
                    if hasattr(msg, "tool_calls") and msg.tool_calls:
                        for tc in msg.tool_calls:
                            step_num += 1
                            step_text = (
                                f"**Step {step_num}:** "
                                f"Calling `{tc['name']}` "
                                f"with args: `{json.dumps(tc['args'])}`"
                            )
                            steps.append(step_text)
                            reasoning_placeholder.markdown("\n\n".join(steps))

                    elif hasattr(msg, "name") and msg.name:
                        step_num += 1
                        content_preview = (
                            str(msg.content)[:200] + "..."
                            if len(str(msg.content)) > 200
                            else str(msg.content)
                        )
                        step_text = (
                            f"**Step {step_num}:** "
                            f"`{msg.name}` returned: `{content_preview}`"
                        )
                        steps.append(step_text)
                        reasoning_placeholder.markdown("\n\n".join(steps))

                        if msg.name == "map_to_neo4j":
                            st.session_state.neo4j_notifications.append({
                                "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                                "content": str(msg.content),
                            })

                        if msg.name == "generate_chart":
                            content = str(msg.content)
                            if "saved to:" in content.lower():
                                path = content.split("saved to:")[-1].strip()
                                st.session_state.last_chart_path = path

                
                final_answer = result["messages"][-1].content

            # Clear reasoning steps, show final answer
            reasoning_placeholder.empty()

            # Show step-by-step reasoning in expander
            if steps:
                with st.expander("🔍 Step-by-step reasoning", expanded=False):
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


# ── Right column: Neo4j notifications + quick actions ────────────────
with right_col:
    st.subheader("🗄️ Neo4j Sync Notifications")

    if st.session_state.neo4j_notifications:
        for notif in reversed(st.session_state.neo4j_notifications):
            with st.container(border=True):
                st.caption(f"🕐 {notif['timestamp']}")
                st.text(notif["content"])
    else:
        st.info(
            "No Neo4j sync events yet.\n\n"
            "Ask the agent to map a session to trigger a sync."
        )

    st.divider()

    st.subheader("⚡ Quick Actions")
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

    st.subheader("📊 System Info")
    db_path = os.getenv("SQLITE_DB_PATH", "mcp_agent_log.db")
    db_file = Path(db_path)
    if db_file.exists():
        size_kb = db_file.stat().st_size / 1024
        st.metric("Log DB size", f"{size_kb:.1f} KB")
        st.metric("DB path", db_path)
    else:
        st.warning("mcp_agent_log.db not found")
