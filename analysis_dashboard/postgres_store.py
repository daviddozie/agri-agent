import os
import json
import asyncpg
from datetime import datetime, timezone

class StoreResult:
    def __init__(self, key: str, namespace: tuple[str, ...], value: dict):
        self.key = key
        self.namespace = namespace
        self.value = value

class PostgresStore:
    def __init__(self, pool, embeddings_obj=None):
        self.pool = pool
        self.embeddings = embeddings_obj

    @classmethod
    async def from_conn_string(cls, conn_string, index=None):
        # We prefer DATABASE_URL or SUPABASE_URL from environment
        db_url = os.getenv("DATABASE_URL") or os.getenv("SUPABASE_URL")
        if not db_url:
            db_url = "postgresql://daviddozie@localhost:5432/postgres"
            
        # Clean pgbouncer parameter for asyncpg
        db_url_clean = db_url.replace("?pgbouncer=true", "")
        
        # Disable prepared statement cache for PgBouncer transaction mode compatibility
        pool = await asyncpg.create_pool(dsn=db_url_clean, statement_cache_size=0)
        
        embeddings_obj = None
        if index and "embed" in index:
            class Embedder:
                def __init__(self, embed_fn):
                    self.embed_fn = embed_fn
                async def aembed_query(self, text: str):
                    res = await self.embed_fn([text])
                    return res[0]
            embeddings_obj = Embedder(index["embed"])
            
        return cls(pool, embeddings_obj)

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        if self.pool:
            await self.pool.close()

    async def aput(self, namespace: tuple[str, ...], key: str, value: dict) -> None:
        session_id = value.get("session_id")
        mcp_interaction_type = value.get("mcp_interaction_type", "unknown")
        component = value.get("component", "client")
        level = value.get("level", "INFO")
        content = value.get("content", "")
        
        # Parse timestamp
        timestamp_str = value.get("timestamp")
        timestamp = None
        if timestamp_str:
            try:
                timestamp = datetime.fromisoformat(timestamp_str.replace("Z", "+00:00"))
            except Exception:
                pass
        if not timestamp:
            timestamp = datetime.now(timezone.utc)
            
        # Generate embedding
        embedding = None
        if self.embeddings and content:
            try:
                embedding = await self.embeddings.aembed_query(content)
                embedding = str(embedding)
            except Exception:
                pass

        async with self.pool.acquire() as conn:
            if session_id:
                query = None
                if mcp_interaction_type == "agent_planning" and content.startswith("Agent session started. User query: "):
                    query = content.replace("Agent session started. User query: ", "")
                    
                await conn.execute(
                    """
                    INSERT INTO sessions (session_id, query, created_at)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (session_id) DO UPDATE
                    SET query = COALESCE(sessions.query, EXCLUDED.query)
                    """,
                    session_id,
                    query,
                    timestamp
                )
                
            await conn.execute(
                """
                INSERT INTO trace_logs (session_id, namespace, key, value, mcp_interaction_type, component, level, timestamp, embedding)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                """,
                session_id,
                list(namespace),
                key,
                json.dumps(value),
                mcp_interaction_type,
                component,
                level,
                timestamp,
                embedding
            )
            
            if mcp_interaction_type in ("resource_read", "tool_invocation"):
                tool_name = "reflect_on_answer" if mcp_interaction_type == "tool_invocation" else "crag_knowledge_tool"
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
                is_end = "response received" in content
                response_text = "Response received." if is_end else "Invocation initiated (no response logged)."
                
                await conn.execute(
                    """
                    INSERT INTO tool_invocations (session_id, tool_name, query, response, timestamp)
                    VALUES ($1, $2, $3, $4, $5)
                    """,
                    session_id,
                    tool_name,
                    query_text,
                    response_text,
                    timestamp
                )
                
            if level == "ERROR" or "error" in content.lower():
                await conn.execute(
                    """
                    INSERT INTO runtime_exceptions (session_id, exception_type, message, traceback, timestamp)
                    VALUES ($1, $2, $3, $4, $5)
                    """,
                    session_id,
                    "Log Error Alert" if level == "ERROR" else "Exception Detected",
                    content,
                    content,
                    timestamp
                )

    async def asearch(self, namespace: tuple[str, ...], query: str, limit: int = 5):
        embedding = None
        if self.embeddings:
            try:
                embedding = await self.embeddings.aembed_query(query)
                embedding = str(embedding)
            except Exception:
                pass
                
        async with self.pool.acquire() as conn:
            if embedding:
                rows = await conn.fetch(
                    """
                    SELECT key, namespace, value
                    FROM trace_logs
                    WHERE namespace @> $1::text[]
                    ORDER BY embedding <=> $2::vector
                    LIMIT $3
                    """,
                    list(namespace),
                    embedding,
                    limit
                )
            else:
                rows = await conn.fetch(
                    """
                    SELECT key, namespace, value
                    FROM trace_logs
                    WHERE namespace @> $1::text[]
                    ORDER BY timestamp DESC
                    LIMIT $2
                    """,
                    list(namespace),
                    limit
                )
        return [StoreResult(r["key"], tuple(r["namespace"]), r["value"]) for r in rows]
