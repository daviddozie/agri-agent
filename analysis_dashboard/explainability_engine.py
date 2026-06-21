import itertools
import json
import logging
import math
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
from dotenv import load_dotenv
from neo4j import GraphDatabase
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_openai import ChatOpenAI
from langgraph.store.sqlite.aio import AsyncSqliteStore

load_dotenv(Path(__file__).parent / ".env")

logger = logging.getLogger("analysis_agent")

_model_name = os.getenv("REASONING_MODEL", "openai/gpt-4o-mini")
_api_key = os.getenv("OPENROUTER_API_KEY")
_api_base = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
_embedding_model_name = os.getenv("EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2")

_embeddings = HuggingFaceEmbeddings(model_name=_embedding_model_name)

_neo4j_driver = GraphDatabase.driver(
    os.getenv("NEO4J_URI"),
    auth=(os.getenv("NEO4J_USERNAME"), os.getenv("NEO4J_PASSWORD")),
)

# Reference phrase representing "failure" semantics — token masking that
# pushes the log text's embedding CLOSER to this reference indicates that
# the masked token was suppressing failure-relevant signal (i.e. that
# token was important context AWAY from a failure reading); conversely a
# masking that pushes the embedding FURTHER from this reference indicates
# the masked token was itself carrying the failure signal.
_FAILURE_REFERENCE_TEXT = (
    "error failed exception timeout retry fallback catastrophic "
    "invalid unavailable crashed denied rejected"
)


# ════════════════════════════════════════════════════════════════════
# 1. Graph Context Hydration — pulls Neo4j subgraph for a session_id
# ════════════════════════════════════════════════════════════════════

def hydrate_neo4j_context(session_id: str) -> dict[str, Any]:
    """
    Runs Cypher queries against Neo4j Aura DB to extract the adjacent
    structural relationship subgraph for a given session_id: the parent
    (:Session), all (:AgentAction) nodes it TRIGGERED, and all
    (:MCPServerCall) nodes those actions were ROUTED_TO.

    Returns a dict formatted for direct prompt injection into the
    explainability layer, plus the raw node/edge counts for the report.
    """
    logger.info(f"[xai] Hydrating Neo4j context for session_id={session_id}")

    try:
        with _neo4j_driver.session() as neo_session:
            result = neo_session.run(
                """
                MATCH (s:Session {session_id: $session_id})
                OPTIONAL MATCH (s)-[:TRIGGERED]->(a:AgentAction)
                OPTIONAL MATCH (a)-[:ROUTED_TO]->(m:MCPServerCall)
                OPTIONAL MATCH (a)-[:DEPENDS_ON]->(prev:AgentAction)
                RETURN
                    s.session_id AS session_id,
                    s.created_at AS session_created_at,
                    collect(DISTINCT {
                        action_id: a.action_id,
                        action_type: a.action_type,
                        timestamp: a.timestamp,
                        content: a.content
                    }) AS actions,
                    collect(DISTINCT {
                        call_type: m.call_type,
                        timestamp: m.timestamp,
                        content: m.content
                    }) AS server_calls,
                    count(DISTINCT a) AS action_count,
                    count(DISTINCT m) AS server_call_count
                """,
                session_id=session_id,
            )
            record = result.single()
            
        if record is None or record["session_id"] is None:
            logger.warning(f"[xai] No Neo4j subgraph found for session_id={session_id}")
            return {
                "found": False,
                "session_id": session_id,
                "context_text": f"No graph context found for session {session_id}.",
                "node_count": 0,
                "edge_count": 0,
            }

        actions = [a for a in record["actions"] if a.get("action_id")]
        server_calls = [c for c in record["server_calls"] if c.get("call_type")]

        context_lines = [f"Session {session_id} created at {record['session_created_at']}."]
        for a in actions:
            context_lines.append(
                f"  AgentAction[{a['action_type']}] @ {a['timestamp']}: {a['content']}"
            )
        for c in server_calls:
            context_lines.append(
                f"  MCPServerCall[{c['call_type']}] @ {c['timestamp']}: {c['content']}"
            )

        context_text = "\n".join(context_lines)
        node_count = 1 + record["action_count"] + record["server_call_count"]
        edge_count = record["action_count"] + record["server_call_count"]

        logger.info(
            f"[xai] Neo4j context hydrated: {node_count} nodes, {edge_count} edges "
            f"for session {session_id[:8]}..."
        )

        return {
            "found": True,
            "session_id": session_id,
            "context_text": context_text,
            "node_count": node_count,
            "edge_count": edge_count,
            "actions": actions,
            "server_calls": server_calls,
        }

    except Exception as e:
        logger.warning(f"[xai] Neo4j hydration failed due to connection error: {e}")
        return {
            "found": False,
            "session_id": session_id,
            "context_text": f"Offline/Unavailable: Neo4j graph context could not be retrieved due to connection error: {e}",
            "node_count": 0,
            "edge_count": 0,
        }


# ════════════════════════════════════════════════════════════════════
# 2. Proxy LIME — token-masking perturbation over unstructured text
# ════════════════════════════════════════════════════════════════════

def _embedding_failure_similarity(text: str) -> float:
    """
    Returns cosine similarity between `text`'s embedding and the
    failure-reference embedding. Higher = text reads more "failure-like".
    """
    if not text.strip():
        return 0.0
    vecs = _embeddings.embed_documents([text, _FAILURE_REFERENCE_TEXT])
    a, b = np.array(vecs[0]), np.array(vecs[1])
    denom = (np.linalg.norm(a) * np.linalg.norm(b))
    if denom == 0:
        return 0.0
    return float(np.dot(a, b) / denom)


def proxy_lime_text_importance(
    log_text: str,
    window_size: int = 3,
    max_windows: int = 25,
) -> list[dict[str, Any]]:
    """
    Proxy LIME for unstructured log text.

    Method:
      1. Tokenize log_text by whitespace.
      2. Slide a window of `window_size` tokens across the text,
         masking each window (replacing with '[MASK]') one at a time.
      3. For each masked variant, compute the embedding-similarity to
         the failure-reference text.
      4. The importance of a window = baseline_similarity - masked_similarity.
         A LARGE POSITIVE value means removing that window made the text
         look LESS like a failure -> that window carried failure signal
         -> high importance. Capped at `max_windows` perturbations to
         bound cost on long logs.

    Returns a list of {window_text, start_idx, importance} sorted by
    |importance| descending.
    """
    tokens = log_text.split()
    if not tokens:
        return []

    baseline_similarity = _embedding_failure_similarity(log_text)

    windows = []
    step = max(1, len(tokens) // max_windows) if len(tokens) > max_windows else 1
    for start in range(0, len(tokens), step):
        end = min(start + window_size, len(tokens))
        if start >= end:
            continue
        windows.append((start, end))
        if len(windows) >= max_windows:
            break

    logger.info(
        f"[xai] Proxy LIME: {len(tokens)} tokens, {len(windows)} perturbation windows, "
        f"baseline_similarity={baseline_similarity:.4f}"
    )

    importances = []
    for start, end in windows:
        masked_tokens = tokens[:start] + ["[MASK]"] * (end - start) + tokens[end:]
        masked_text = " ".join(masked_tokens)
        masked_similarity = _embedding_failure_similarity(masked_text)

        importance = baseline_similarity - masked_similarity
        window_text = " ".join(tokens[start:end])

        importances.append({
            "window_text": window_text,
            "start_idx": start,
            "end_idx": end,
            "importance": round(importance, 5),
        })

    importances.sort(key=lambda x: abs(x["importance"]), reverse=True)

    logger.info(
        f"[xai] Proxy LIME complete. Top token-importance window: "
        f"{importances[0] if importances else 'N/A'}"
    )

    return importances


# ════════════════════════════════════════════════════════════════════
# 3. Proxy SHAP — exact Shapley values over structured execution features
# ════════════════════════════════════════════════════════════════════

def proxy_shap_feature_contribution(
    feature_vector: dict[str, float],
    value_fn=None,
) -> dict[str, float]:
    """
    Computes exact proxy Shapley values for a small set of structured
    execution features (e.g. {"latency_ms": 4200, "payload_len": 850,
    "call_frequency": 6, "retry_count": 2}).

    Method (standard Shapley value, exact since |features| is small,
    typically <= 6, making 2^n subset enumeration trivial):
      For each feature f:
        phi(f) = sum over all subsets S not containing f of
                 [ |S|! * (n - |S| - 1)! / n! ] *
                 [ value_fn(S union {f}) - value_fn(S) ]

    `value_fn(subset_dict)` scores how "anomalous" a given subset of
    active features makes the execution look. If not provided, a
    default normalized-magnitude scorer is used: each feature is
    normalized against a fixed reference scale and summed, so the
    "value" of a coalition is the sum of its normalized feature values.
    """
    features = list(feature_vector.keys())
    n = len(features)

    if n == 0:
        return {}

    # Default value function: normalized magnitude scorer.
    # Reference scales are rough operational ceilings — tune as needed.
    _reference_scale = {
        "latency_ms": 10000.0,
        "payload_len": 5000.0,
        "call_frequency": 20.0,
        "retry_count": 5.0,
        "error_count": 5.0,
    }

    def _default_value_fn(subset: dict[str, float]) -> float:
        total = 0.0
        for k, v in subset.items():
            scale = _reference_scale.get(k, max(abs(v), 1.0))
            total += min(abs(v) / scale, 1.0)
        return total

    scorer = value_fn or _default_value_fn

    logger.info(f"[xai] Proxy SHAP: computing exact Shapley values for {n} features: {features}")

    shapley_values: dict[str, float] = {f: 0.0 for f in features}

    for f in features:
        other_features = [x for x in features if x != f]
        total_contribution = 0.0

        # Enumerate every subset S of the OTHER features
        for r in range(len(other_features) + 1):
            for subset_features in itertools.combinations(other_features, r):
                subset_size = len(subset_features)

                subset_without_f = {k: feature_vector[k] for k in subset_features}
                subset_with_f = {**subset_without_f, f: feature_vector[f]}

                marginal_contribution = scorer(subset_with_f) - scorer(subset_without_f)

                # Shapley weight: |S|! * (n - |S| - 1)! / n!
                weight = (
                    math.factorial(subset_size)
                    * math.factorial(n - subset_size - 1)
                    / math.factorial(n)
                )
                total_contribution += weight * marginal_contribution

        shapley_values[f] = round(total_contribution, 5)

    logger.info(f"[xai] Proxy SHAP complete: {shapley_values}")

    return shapley_values


# ════════════════════════════════════════════════════════════════════
# 4. Full Explainability Audit — combines all of the above
# ════════════════════════════════════════════════════════════════════

async def run_explainability_audit(session_id: str) -> dict[str, Any]:
    """
    Orchestrates a full explainability audit for a given session_id:
      1. Pull structured log entries for the session from the SQLite store.
      2. Hydrate Neo4j graph context.
      3. Run proxy LIME over the concatenated log text.
      4. Derive structured features (latency proxy, payload length,
         call frequency, error count) from the log entries and run
         proxy SHAP over them.
      5. Assemble everything into a single JSON-exportable report.
    """
    logger.info(f"[xai] Starting explainability audit for session_id={session_id}")

    db_path = os.getenv("SQLITE_DB_PATH", "mcp_agent_log.db")

    async with AsyncSqliteStore.from_conn_string(
        db_path,
        index={"dims": 384, "embed": _embeddings.aembed_documents},
    ) as store:
        results = await store.asearch(("logs",), query=f"session {session_id}", limit=100)

    entries = [r.value for r in results if r.value.get("session_id") == session_id]

    if not entries:
        logger.warning(f"[xai] No log entries found for session_id={session_id}")
        return {
            "session_id": session_id,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "error": f"No log entries found for session_id: {session_id}",
        }

    # ── Concatenate log text for LIME ───────────────────────────────
    full_log_text = "\n".join(e.get("content", "") for e in entries)

    # ── Derive structured features for SHAP ─────────────────────────
    error_count = sum(1 for e in entries if e.get("level") == "ERROR")
    call_frequency = len(entries)
    payload_len = sum(len(e.get("content", "")) for e in entries)

    timestamps = sorted(e.get("timestamp", "") for e in entries if e.get("timestamp"))
    latency_ms = 0.0
    if len(timestamps) >= 2:
        try:
            t0 = datetime.fromisoformat(timestamps[0])
            t1 = datetime.fromisoformat(timestamps[-1])
            latency_ms = (t1 - t0).total_seconds() * 1000
        except ValueError:
            latency_ms = 0.0

    feature_vector = {
        "latency_ms": latency_ms,
        "payload_len": float(payload_len),
        "call_frequency": float(call_frequency),
        "error_count": float(error_count),
    }

    # ── Run the three XAI components ─────────────────────────────────
    neo4j_context = hydrate_neo4j_context(session_id)
    lime_importances = proxy_lime_text_importance(full_log_text)
    shap_values = proxy_shap_feature_contribution(feature_vector)

    report = {
        "session_id": session_id,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "log_entries_analyzed": len(entries),
        "neo4j_context": {
            "found": neo4j_context["found"],
            "node_count": neo4j_context["node_count"],
            "edge_count": neo4j_context["edge_count"],
            "context_text": neo4j_context["context_text"],
        },
        "proxy_lime": {
            "method": "token-window masking + embedding-similarity to failure reference",
            "top_importances": lime_importances[:10],
        },
        "proxy_shap": {
            "method": "exact Shapley value over normalized-magnitude feature scorer",
            "feature_vector": feature_vector,
            "shapley_values": shap_values,
            "dominant_feature": max(shap_values, key=lambda k: abs(shap_values[k])) if shap_values else None,
        },
    }

    logger.info(
        f"[xai] Explainability audit complete for session {session_id[:8]}... "
        f"dominant_feature={report['proxy_shap']['dominant_feature']}"
    )

    return report


def save_audit_report(report: dict[str, Any], output_path: str | None = None) -> str:
    """Saves the audit report as explainability_audit_report.json."""
    if output_path is None:
        output_path = str(Path(__file__).parent.parent / "explainability_audit_report.json")

    with open(output_path, "w") as f:
        json.dump(report, f, indent=2)

    logger.info(f"[xai] Audit report saved to {output_path}")
    return output_path