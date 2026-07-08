import sqlite3
import psycopg2
import json
import struct
import uuid
from datetime import datetime, timezone

def parse_iso_timestamp(ts_str):
    if not ts_str:
        return datetime.now(timezone.utc)
    try:
        return datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
    except Exception:
        return datetime.now(timezone.utc)

def migrate():
    # 1. Connect to SQLite
    sqlite_db = "mcp_agent_log.db"
    print(f"Connecting to SQLite: {sqlite_db}")
    sqlite_conn = sqlite3.connect(sqlite_db)
    sqlite_cur = sqlite_conn.cursor()

    # Get store rows
    sqlite_cur.execute("SELECT prefix, key, value, created_at, updated_at FROM store")
    store_rows = sqlite_cur.fetchall()
    print(f"Found {len(store_rows)} log entries in SQLite store table.")

    # Get vectors
    sqlite_cur.execute("SELECT prefix, key, embedding FROM store_vectors")
    vector_map = {}
    for prefix, key, blob in sqlite_cur.fetchall():
        if blob:
            try:
                floats = list(struct.unpack(f"384f", blob))
                vector_map[(prefix, key)] = floats
            except Exception as e:
                print(f"Failed to unpack embedding for {prefix} / {key}: {e}")
    print(f"Found {len(vector_map)} vectors in SQLite store_vectors table.")

    sqlite_conn.close()

    # 2. Parse into relational structures
    sessions = {}         # session_id -> {query, created_at}
    trace_logs = []       # list of dicts
    tool_invocations = [] # list of dicts
    exceptions = []       # list of dicts

    # We need to pair tool/resource query and response logs by session and query text.
    # We will collect all resource_read / tool_invocation logs and group them.
    tool_starts = {}      # (session_id, tool_name, query_text) -> start_log
    tool_ends = {}        # (session_id, tool_name, query_text) -> end_log

    for prefix, key, value_str, created_at_str, updated_at_str in store_rows:
        try:
            val = json.loads(value_str.decode('utf-8') if isinstance(value_str, bytes) else value_str)
        except Exception as e:
            print(f"Failed to parse JSON value for key {key}: {e}")
            continue

        session_id = val.get("session_id")
        if not session_id:
            continue

        mcp_type = val.get("mcp_interaction_type", "unknown")
        content = val.get("content", "")
        component = val.get("component", "client")
        level = val.get("level", "INFO")
        timestamp_str = val.get("timestamp", created_at_str)
        ts = parse_iso_timestamp(timestamp_str)

        # Retrieve embedding
        embedding = vector_map.get((prefix, key))

        # Extract session info
        if session_id not in sessions:
            sessions[session_id] = {"query": None, "created_at": ts}
        else:
            if ts < sessions[session_id]["created_at"]:
                sessions[session_id]["created_at"] = ts

        if mcp_type == "agent_planning" and content.startswith("Agent session started. User query: "):
            sessions[session_id]["query"] = content.replace("Agent session started. User query: ", "")

        # Prepare trace log record
        namespace = prefix.split(".")
        trace_logs.append({
            "session_id": session_id,
            "namespace": namespace,
            "key": key,
            "value": val,
            "mcp_interaction_type": mcp_type,
            "component": component,
            "level": level,
            "timestamp": ts,
            "embedding": embedding
        })

        # Process exceptions
        if level == "ERROR" or "error" in content.lower():
            exceptions.append({
                "session_id": session_id,
                "exception_type": "Log Error Alert" if level == "ERROR" else "Exception Detected",
                "message": content,
                "traceback": content,
                "timestamp": ts
            })

        # Process tool calls
        if mcp_type in ("resource_read", "tool_invocation"):
            # Try to identify tool name and query/response
            tool_name = "reflect_on_answer" if mcp_type == "tool_invocation" else "crag_knowledge_tool"
            
            # Format: "CRAG resource queried: {query}"
            # Format: "CRAG resource response received for query: {query}"
            # Format: "reflect_on_answer invoked. Query: {original_query}"
            # Format: "reflect_on_answer tool response received. Query: {original_query}"
            
            is_start = "queried" in content or "invoked" in content
            is_end = "response received" in content

            # Extract the query text
            query_text = content
            for prefix_pattern in [
                "CRAG resource queried: ",
                "CRAG resource response received for query: ",
                "reflect_on_answer invoked. Query: ",
                "reflect_on_answer tool response received. Query: "
            ]:
                if content.startswith(prefix_pattern):
                    query_text = content.replace(prefix_pattern, "")
                    break

            if is_start:
                tool_starts[(session_id, tool_name, query_text)] = ts
            elif is_end:
                tool_ends[(session_id, tool_name, query_text)] = ts

    # Pair up tool calls
    all_keys = set(tool_starts.keys()).union(tool_ends.keys())
    for (sid, tname, qtext) in all_keys:
        t_start = tool_starts.get((sid, tname, qtext))
        t_end = tool_ends.get((sid, tname, qtext))
        
        # If we have start and/or end, we insert a tool invocation
        tool_invocations.append({
            "session_id": sid,
            "tool_name": tname,
            "query": qtext,
            "response": "Response received." if t_end else "Invocation initiated (no response logged).",
            "timestamp": t_start or t_end or datetime.now(timezone.utc)
        })

    print(f"Parsed {len(sessions)} unique sessions.")
    print(f"Parsed {len(trace_logs)} trace logs.")
    print(f"Parsed {len(tool_invocations)} tool invocations.")
    print(f"Parsed {len(exceptions)} runtime exceptions.")

    # 3. Connect to Postgres
    import os
    from dotenv import load_dotenv
    load_dotenv()
    db_url = os.getenv("DATABASE_URL") or os.getenv("SUPABASE_URL")
    if not db_url:
        db_url = "postgresql://daviddozie@localhost:5432/postgres"
    # clean pgbouncer param
    db_url_clean = db_url.replace("?pgbouncer=true", "")
    print(f"Connecting to Postgres/Supabase: {db_url_clean}")
    pg_conn = psycopg2.connect(db_url_clean)
    pg_cur = pg_conn.cursor()

    # Clear tables to ensure clean migration
    print("Clearing existing tables in local Postgres...")
    pg_cur.execute("TRUNCATE TABLE runtime_exceptions CASCADE;")
    pg_cur.execute("TRUNCATE TABLE tool_invocations CASCADE;")
    pg_cur.execute("TRUNCATE TABLE trace_logs CASCADE;")
    pg_cur.execute("TRUNCATE TABLE sessions CASCADE;")
    pg_conn.commit()

    # 4. Insert Sessions
    print("Migrating sessions...")
    for sid, sdata in sessions.items():
        pg_cur.execute(
            "INSERT INTO sessions (session_id, query, created_at) VALUES (%s, %s, %s) ON CONFLICT DO NOTHING;",
            (sid, sdata["query"], sdata["created_at"])
        )

    # 5. Insert Trace Logs
    print("Migrating trace logs...")
    for log in trace_logs:
        pg_cur.execute(
            """
            INSERT INTO trace_logs (session_id, namespace, key, value, mcp_interaction_type, component, level, timestamp, embedding)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s);
            """,
            (
                log["session_id"],
                log["namespace"],
                log["key"],
                json.dumps(log["value"]),
                log["mcp_interaction_type"],
                log["component"],
                log["level"],
                log["timestamp"],
                log["embedding"]
            )
        )

    # 6. Insert Tool Invocations
    print("Migrating tool invocations...")
    for ti in tool_invocations:
        pg_cur.execute(
            """
            INSERT INTO tool_invocations (session_id, tool_name, query, response, timestamp)
            VALUES (%s, %s, %s, %s, %s);
            """,
            (
                ti["session_id"],
                ti["tool_name"],
                ti["query"],
                ti["response"],
                ti["timestamp"]
            )
        )

    # 7. Insert Exceptions
    print("Migrating runtime exceptions...")
    for exc in exceptions:
        pg_cur.execute(
            """
            INSERT INTO runtime_exceptions (session_id, exception_type, message, traceback, timestamp)
            VALUES (%s, %s, %s, %s, %s);
            """,
            (
                exc["session_id"],
                exc["exception_type"],
                exc["message"],
                exc["traceback"],
                exc["timestamp"]
            )
        )

    pg_conn.commit()
    pg_cur.close()
    pg_conn.close()
    print("Migration finished successfully!")

if __name__ == "__main__":
    migrate()
