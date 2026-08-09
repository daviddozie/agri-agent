from mcp.types import SamplingMessage, TextContent as MCPTextContent
import logging
import os
from datetime import datetime
import json
import base64
import urllib.parse
import requests
import secrets
from dotenv import load_dotenv
from fastmcp import FastMCP, Context
from pydantic import BaseModel, Field
from tavily import TavilyClient
from knowledge_base import DOCUMENTS
import psycopg2
import redis
import numpy as np
from langchain_huggingface import HuggingFaceEmbeddings
from eth_helpers import verify_eip3009_signature

load_dotenv()

# Redis Configuration
redis_host = os.getenv("REDIS_HOST", "localhost")
redis_port = int(os.getenv("REDIS_PORT", "6379"))
redis_pass = os.getenv("REDIS_PASSWORD") or None

# Embeddings model
logger_init = logging.getLogger(__name__)
logger_init.info("Loading sentence-transformers model in MCP server...")
embeddings = HuggingFaceEmbeddings(model_name="sentence-transformers/all-MiniLM-L6-v2")

# logging setup
logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [SERVER] [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)

# --- Database & x402 Configuration ---
db_url = os.getenv("DATABASE_URL") or os.getenv("SUPABASE_URL")
SERVER_RECIPIENT = os.getenv("XPAY_RECIPIENT_ADDRESS") or os.getenv("SERVER_ADDRESS") or "0xd32Ea5203f359Fd6CEFD7094Da5425B060EAe79d"
USDC_ADDRESS = os.getenv("USDC_CONTRACT_ADDRESS", "0x036CbD53842c5426634e7929541eC2318f3dCF7e")
XPAY_FACILITATOR = os.getenv("XPAY_FACILITATOR_URL", "https://facilitator.xpay.sh")

def get_db_connection():
    if not db_url:
        return None
    db_url_clean = db_url.replace("?pgbouncer=true", "")
    return psycopg2.connect(db_url_clean)

# Initialize tables
try:
    conn = get_db_connection()
    if conn:
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS x402_payments (
                id SERIAL PRIMARY KEY,
                session_id VARCHAR(100),
                tx_hash VARCHAR(100),
                sender VARCHAR(100),
                recipient VARCHAR(100),
                amount NUMERIC,
                token VARCHAR(100),
                network VARCHAR(50),
                direction VARCHAR(20),
                resource_or_tool VARCHAR(100),
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        """)
        conn.commit()
        cursor.close()
        conn.close()
        logger.info("x402_payments table verified/created in database.")
except Exception as e:
    logger.error(f"Failed to initialize x402_payments database table: {e}")

def log_payment(session_id: str, tx_hash: str, sender: str, recipient: str, amount_atoms: int, token: str, network: str, direction: str, resource_or_tool: str):
    try:
        conn = get_db_connection()
        if conn:
            cursor = conn.cursor()
            amount_usdc = float(amount_atoms) / 1000000.0
            cursor.execute(
                """
                INSERT INTO x402_payments (session_id, tx_hash, sender, recipient, amount, token, network, direction, resource_or_tool, timestamp)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, CURRENT_TIMESTAMP)
                """,
                (session_id, tx_hash, sender, recipient, amount_usdc, token, network, direction, resource_or_tool)
            )
            conn.commit()
            cursor.close()
            conn.close()
            logger.info(f"Logged {direction} payment of {amount_usdc} USDC. Tx: {tx_hash}")
    except Exception as e:
        logger.error(f"Failed to log payment to database: {e}")

def verify_and_settle_x402(payment_b64: str, expected_amount: int, session_id: str, resource_or_tool: str) -> tuple[bool, str]:
    """
    Decodes, cryptographically validates locally, and settles x402 payments via the facilitator.
    """
    bypass = os.getenv("XPAY_BYPASS_VERIFICATION", "false").lower() == "true"
    if bypass:
        mock_tx = "0x" + secrets.token_hex(32)
        logger.info(f"[BYPASS] Mocking successful settlement. Tx: {mock_tx}")
        log_payment(session_id, mock_tx, "0xmockedpayer", SERVER_RECIPIENT, expected_amount, USDC_ADDRESS, "eip155:84532", "incoming", resource_or_tool)
        return True, mock_tx

    try:
        # 1. Decode base64 payment payload
        decoded_bytes = base64.b64decode(payment_b64)
        payment_data = json.loads(decoded_bytes.decode("utf-8"))
        
        # 2. Basic payload checks
        payload_data = payment_data.get("paymentPayload", {})
        payload = payload_data.get("payload", {})
        auth = payload.get("authorization", {})
        
        if not auth:
            return False, "Malformed payment payload: missing authorization fields"
            
        # Check recipient and amount
        to_addr = auth.get("to", "").lower()
        val = int(auth.get("value", "0"))
        
        if to_addr != SERVER_RECIPIENT.lower():
            return False, f"Invalid payment recipient: expected {SERVER_RECIPIENT}, got {to_addr}"
            
        if val < expected_amount:
            return False, f"Insufficient payment amount: expected {expected_amount}, got {val}"
            
        # 3. Cryptographically recover signature locally to verify correctness
        try:
            recovered_from = verify_eip3009_signature(payload)
            if recovered_from.lower() != auth.get("from", "").lower():
                return False, f"Cryptographic signature mismatch: recovered {recovered_from}, expected {auth.get('from')}"
            logger.info(f"Local EIP-3009 signature verification passed! Signer: {recovered_from}")
        except Exception as sig_err:
            logger.error(f"Local EIP-3009 signature verification failed: {sig_err}")
            return False, f"Invalid cryptographic signature: {sig_err}"

        # 4. Submit to facilitator settle endpoint
        settle_url = f"{XPAY_FACILITATOR.rstrip('/')}/settle"
        logger.info(f"Submitting x402 settlement payload to facilitator: {settle_url}")
        res = requests.post(settle_url, json=payment_data, timeout=30)
        
        if res.status_code == 200:
            res_data = res.json()
            if res_data.get("isValid") or res_data.get("success") or "transactionHash" in res_data or "txHash" in res_data:
                tx_hash = res_data.get("transactionHash") or res_data.get("txHash") or ("0x" + secrets.token_hex(32))
                logger.info(f"x402 Settlement successful! TxHash: {tx_hash}")
                log_payment(session_id, tx_hash, auth.get("from"), SERVER_RECIPIENT, val, USDC_ADDRESS, "eip155:84532", "incoming", resource_or_tool)
                return True, tx_hash
            else:
                reason = res_data.get("invalidReason") or res_data.get("error") or "Unknown settlement failure"
                logger.warning(f"x402 Settlement rejected by facilitator: {reason}")
                return False, f"Settlement rejected: {reason}"
        else:
            logger.error(f"Facilitator returned status {res.status_code}: {res.text}")
            return False, f"Facilitator error: {res.text}"
            
    except Exception as e:
        logger.error(f"Error during x402 verification and settlement: {e}")
        return False, str(e)

# intialise server

mcp = FastMCP(
    "Agricultural Advisory System",
)
tavily = TavilyClient(api_key=os.getenv("TAVILY_API_KEY"))

class CritiqueResponse(BaseModel):
    factual_errors: list[str] = Field(
        description="List of factual errors found in the draft answer"
    )
    missing_points: list[str] = Field(
        description="Key points that are missing from the draft answer"
    )
    improvement_areas: list[str] = Field(
        description="Specific areas that could be improved"
    )
    overall_quality: str = Field(
        description="Overall quality rating: poor, fair, or good"
    )


class CorrectionResponse(BaseModel):
    corrected_answer: str = Field(
        description="The improved, corrected final answer for the farmer"
    )
    changes_made: list[str] = Field(
        description="List of specific changes made from the original draft"
    )


class ToTScoreResponse(BaseModel):
    analytical: int = Field(
        ge=0, le=10,
        description="0-10: does this chunk directly answer the query?"
    )
    contextual: int = Field(
        ge=0, le=10,
        description="0-10: is the parent document topically relevant to the query?"
    )
    practical: int = Field(
        ge=0, le=10,
        description="0-10: is this chunk actionable and useful for a farmer?"
    )
    reasoning: str = Field(
        description="One sentence explaining the scores"
    )



# helpers
def expand_query(query: str) -> str:
    """
    Multi-query expansion, generate multiple semantic search
    vectors from the original query to improve retrieval coverage.
    """

    expansions = [
        query,
        f"what are the best practices for {query}",
        f"challenges and solutions related to {query}",
        f"how does {query} affect crop yield and farm productivity",
        f"modern techniques and tools for {query} in agriculture",
    ]
    logger.info(f"Expanded query into {len(expansions)} search vectors")
    return expansions


def cosine_similarity(v1, v2):
    dot_product = np.dot(v1, v2)
    norm_v1 = np.linalg.norm(v1)
    norm_v2 = np.linalg.norm(v2)
    if norm_v1 == 0 or norm_v2 == 0:
        return 0.0
    return dot_product / (norm_v1 * norm_v2)


def hierarchical_search(query_text: str, top_k: int = 3, threshold: float = 0.85) -> list[dict]:
    """
    True two-level hierarchical vector search using standard Cosine similarity.
    Level 1 — Summary vector: find the top K documents with closest summary embedding.
    Level 2 — Chunk vector: return chunks of those top K documents with similarity >= threshold.
    """
    logger.info(f"Initiating Cosine Semantic hierarchical_search for: '{query_text}'")
    
    # Generate query embedding
    query_emb = embeddings.embed_query(query_text)
    query_vector = np.array(query_emb, dtype=np.float32)

    results = []

    # 1. Try Redis first
    try:
        r = redis.Redis(host=redis_host, port=redis_port, password=redis_pass, decode_responses=False)
        doc_keys = r.keys("kb:doc:*")
        
        if doc_keys:
            doc_scores = []
            for k in doc_keys:
                doc_data = r.hgetall(k)
                if doc_data:
                    doc_id = doc_data[b"doc_id"].decode("utf-8")
                    summary = doc_data[b"summary"].decode("utf-8")
                    emb_bytes = doc_data[b"summary_embedding"]
                    doc_vector = np.frombuffer(emb_bytes, dtype=np.float32)
                    
                    sim = cosine_similarity(query_vector, doc_vector)
                    doc_scores.append((doc_id, summary, sim))
            
            # Sort by similarity descending, take top K candidate documents
            doc_scores.sort(key=lambda x: x[2], reverse=True)
            top_doc_ids = [d[0] for d in doc_scores[:top_k]]
            top_doc_summaries = {d[0]: d[1] for d in doc_scores[:top_k]}
            
            # Search chunks for candidate documents
            chunk_keys = r.keys("kb:chunk:*")
            chunk_scores = []
            for ck in chunk_keys:
                chunk_data = r.hgetall(ck)
                if chunk_data:
                    chunk_id = chunk_data[b"chunk_id"].decode("utf-8")
                    doc_id = chunk_data[b"doc_id"].decode("utf-8")
                    chunk_text = chunk_data[b"chunk_text"].decode("utf-8")
                    
                    if doc_id in top_doc_ids:
                        emb_bytes = chunk_data[b"chunk_embedding"]
                        chunk_vector = np.frombuffer(emb_bytes, dtype=np.float32)
                        
                        sim = cosine_similarity(query_vector, chunk_vector)
                        # We strictly require similarity >= threshold (Cosine distance <= 0.15)
                        if sim >= threshold:
                            chunk_scores.append({
                                "doc_id": doc_id,
                                "summary": top_doc_summaries[doc_id],
                                "chunk": chunk_text,
                                "similarity": round(float(sim), 4)
                            })
            
            # Sort by similarity descending
            chunk_scores.sort(key=lambda x: x["similarity"], reverse=True)
            if chunk_scores:
                logger.info(f"Level-2 Redis search: found {len(chunk_scores)} chunks matching threshold.")
                return chunk_scores
    except Exception as e:
        logger.warning(f"Redis Cosine search failed/unavailable: {e}. Falling back to PostgreSQL.")

    # 2. Fallback to Supabase / PostgreSQL
    try:
        db_url = os.getenv("DATABASE_URL") or os.getenv("SUPABASE_URL")
        db_url_clean = db_url.replace("?pgbouncer=true", "")
        conn = psycopg2.connect(db_url_clean)
        cursor = conn.cursor()
        
        # Level 1: Find top K document summaries using pgvector cosine distance <=>
        cursor.execute(
            """
            SELECT doc_id, summary, (1.0 - (summary_embedding <=> %s::vector)) as similarity
            FROM kb_documents
            ORDER BY summary_embedding <=> %s::vector
            LIMIT %s;
            """,
            (query_emb, query_emb, top_k)
        )
        top_docs = cursor.fetchall()
        top_doc_ids = [d[0] for d in top_docs]
        top_doc_summaries = {d[0]: d[1] for d in top_docs}
        
        if top_doc_ids:
            # Level 2: Find chunks within candidate documents having similarity >= threshold
            cursor.execute(
                """
                SELECT doc_id, chunk_id, chunk_text, (1.0 - (chunk_embedding <=> %s::vector)) as similarity
                FROM kb_chunks
                WHERE doc_id = ANY(%s) AND (1.0 - (chunk_embedding <=> %s::vector)) >= %s
                ORDER BY chunk_embedding <=> %s::vector;
                """,
                (query_emb, top_doc_ids, query_emb, threshold, query_emb)
            )
            chunks = cursor.fetchall()
            
            for doc_id, chunk_id, chunk_text, sim in chunks:
                results.append({
                    "doc_id": doc_id,
                    "summary": top_doc_summaries[doc_id],
                    "chunk": chunk_text,
                    "similarity": round(float(sim), 4)
                })
        
        cursor.close()
        conn.close()
        logger.info(f"Level-2 PostgreSQL search: found {len(results)} chunks matching threshold.")
    except Exception as e:
        logger.error(f"PostgreSQL Cosine search failed: {e}")
        
    return results


async def tot_evaluate(chunks: list[dict], query: str, ctx: Context) -> list[dict]:
    """
    Tree-of-Thought (ToT) evaluation.

    For each retrieved chunk the LLM is asked to reason along 3 independent
    thought paths and return a structured score for each:

    Path 1 — Analytical:  Does this chunk directly answer the query?
    Path 2 — Contextual:  Is the parent document topically relevant?
    Path 3 — Practical:   Is the chunk actionable / useful for a farmer?

    Each path score is 0-10.  Chunks with avg >= 5 are retained.
    The LLM response is validated against ToTScoreResponse before use;
    on validation failure the chunk is conservatively dropped.
    """
    logger.info("Initiating ToT Evaluation on retrieved chunks via LLM sampling...")
    scored = []

    for item in chunks:
        prompt = (
            f"You are an agricultural knowledge evaluator.\n\n"
            f"User Query: {query}\n\n"
            f"Document Summary: {item['summary']}\n\n"
            f"Chunk Text: {item['chunk']}\n\n"
            f"Score this chunk along 3 independent reasoning paths:\n"
            f"  Path 1 — Analytical (0-10): Does this chunk directly answer the query?\n"
            f"  Path 2 — Contextual (0-10): Is the parent document topically relevant to the query?\n"
            f"  Path 3 — Practical  (0-10): Is this chunk actionable and useful for a farmer?\n\n"
            f"Respond ONLY with a valid JSON object — no markdown, no extra text:\n"
            f'{{"analytical": <int>, "contextual": <int>, "practical": <int>, "reasoning": "<one sentence>"}}'  
        )

        try:
            sample_result = await ctx.sample(
                messages=[
                    SamplingMessage(
                        role="user",
                        content=MCPTextContent(type="text", text=prompt),
                    )
                ],
                max_tokens=150,
            )
            raw = sample_result.text.strip()
            if raw.startswith("```"):
                raw = raw.split("```")[1]
                if raw.startswith("json"):
                    raw = raw[4:]
                raw = raw.strip()

            scores = ToTScoreResponse(**json.loads(raw))
            avg = round((scores.analytical + scores.contextual + scores.practical) / 3, 2)

            logger.info(
                f"ToT chunk [{item['doc_id']}]: "
                f"analytical={scores.analytical} | "
                f"contextual={scores.contextual} | "
                f"practical={scores.practical} | "
                f"avg={avg} | reasoning=\"{scores.reasoning}\""
            )
            await ctx.info(
                f"ToT [{item['doc_id']}] analytical={scores.analytical} "
                f"contextual={scores.contextual} practical={scores.practical} avg={avg}"
            )

            if avg >= 5:
                item["tot_score"] = avg
                scored.append(item)

        except Exception as exc:
            logger.warning(f"ToT scoring failed for chunk [{item['doc_id']}]: {exc} — dropping chunk")

    logger.info(f"ToT kept {len(scored)}/{len(chunks)} chunks (threshold=5)")
    return scored

def parse_and_validate_critique(raw_text: str) -> CritiqueResponse:
    """
    Parse and validate the LLM's critique response against
    the CritiqueResponse Pydantic model.
    Raises ValueError if the response doesn't match the schema.
    """
    # Strip markdown code fences if present
    clean = raw_text.strip()
    if clean.startswith("```"):
        clean = clean.split("```")[1]
        if clean.startswith("json"):
            clean = clean[4:]
    clean = clean.strip()

    try:
        data = json.loads(clean)
        return CritiqueResponse(**data)
    except (json.JSONDecodeError, TypeError, ValueError) as e:
        raise ValueError(f"Critique response failed validation: {e}\nRaw: {raw_text}")


def parse_and_validate_correction(raw_text: str) -> CorrectionResponse:
    """
    Parse and validate the LLM's correction response against
    the CorrectionResponse Pydantic model.
    Raises ValueError if the response doesn't match the schema.
    """
    clean = raw_text.strip()
    if clean.startswith("```"):
        clean = clean.split("```")[1]
        if clean.startswith("json"):
            clean = clean[4:]
    clean = clean.strip()

    try:
        data = json.loads(clean)
        return CorrectionResponse(**data)
    except (json.JSONDecodeError, TypeError, ValueError) as e:
        raise ValueError(f"Correction response failed validation: {e}\nRaw: {raw_text}")



# CRAG Resource
@mcp.resource("knowledge://agriculture/docs/{query}")
async def agricultural_knowledge(query: str, ctx: Context) -> str:
    """
    Hierarchical CRAG resource for agricultural domain knowledge.
    Protected by x402 payment challenge.
    Implements: payment settlement check → true cosine search →
    Tree-of-Thought evaluation → Tavily fallback if needed.
    """
    logger.info(f"CRAG resource queried with: '{query}'")
    await ctx.info(f"CRAG resource queried: '{query}'") 

    # Parse parameters
    search_query = query
    payment_b64 = ""
    session_id = "unknown_session"
    
    # Try to decode query as base64-encoded JSON envelope
    try:
        padded = query + "=" * (4 - len(query) % 4)
        decoded = base64.urlsafe_b64decode(padded).decode("utf-8")
        envelope = json.loads(decoded)
        if isinstance(envelope, dict) and "query" in envelope:
            search_query = envelope["query"]
            payment_b64 = envelope.get("payment", "")
            session_id = envelope.get("session_id", "unknown_session")
            logger.info(f"Decoded envelope parameters: query='{search_query}', session_id='{session_id}'")
    except Exception:
        pass
    
    # Cost for resource read: 5000 atoms (0.005 USDC)
    expected_amount = 5000
    
    if not payment_b64:
        logger.info("Payment signature missing, issuing 402 challenge...")
        challenge = {
            "status": 402,
            "error": "Payment Required",
            "token": USDC_ADDRESS,
            "recipient": SERVER_RECIPIENT,
            "amount": str(expected_amount),
            "scheme": "exact",
            "network": "eip155:84532"
        }
        return json.dumps(challenge)
        
    # Verify and Settle Payment
    ok, err_or_tx = verify_and_settle_x402(payment_b64, expected_amount, session_id, f"resource_read: {search_query}")
    if not ok:
        logger.warning(f"Payment verification failed: {err_or_tx}")
        challenge = {
            "status": 402,
            "error": f"Payment Required: {err_or_tx}",
            "token": USDC_ADDRESS,
            "recipient": SERVER_RECIPIENT,
            "amount": str(expected_amount),
            "scheme": "exact",
            "network": "eip155:84532"
        }
        return json.dumps(challenge)

    # Continue execution since payment is settled
    retrieved_chunks = hierarchical_search(search_query)
    await ctx.info(f"Cosine Semantic search: {len(retrieved_chunks)} chunks retrieved above threshold") 

    relevant_chunks = await tot_evaluate(retrieved_chunks, search_query, ctx)
    await ctx.info(f"Level-2 search: {len(relevant_chunks)} chunks after ToT filter")

    # Tavily fallback if ToT filtered everything out
    if not relevant_chunks:
        logger.info("ToT found no relevant chunks, triggering Tavily fallback...")
        try:
            tavily_results = tavily.search(query=f"agriculture {search_query}", max_results=3)
            fallback_content = "\n\n".join(
                f"[Web Source]: {r['title']}\n{r['content']}"
                for r in tavily_results.get("results", [])
            )
            logger.info("Tavily fallback successful")
            await ctx.info("Tavily fallback triggered and successful")
            return f"[FALLBACK, Web Results]\n\n{fallback_content}"
        except Exception as e:
            logger.error(f"Tavily fallback failed: {e}")
            return "No relevant knowledge found and web fallback failed."

    # Format and return relevant chunks
    output = []
    for item in relevant_chunks:
        output.append(
            f"[Doc: {item['doc_id']} | Score: {item['tot_score']}]\n"
            f"Summary: {item['summary']}\n"
            f"Detail: {item['chunk']}"
        )

    logger.info(f"CRAG resource returning {len(output)} relevant results")
    await ctx.info(f"CRAG returning {len(output)} relevant results")
    return "\n\n".join(output)


# Reflector tool
@mcp.tool()
async def reflect_on_answer(
    original_query: str,
    draft_answer: str,
    ctx: Context,
    payment_signature: str = "",
    session_id: str = "unknown_session"
) -> str:
    """
    Protected by x402 payment challenge.
    """
    logger.info(f"Reflection tool invoked for query: '{original_query}'")
    await ctx.info(f"Reflection tool invoked for query: '{original_query}'")

    # Cost for reflection tool: 10000 atoms (0.01 USDC)
    expected_amount = 10000
    
    if not payment_signature:
        logger.info("Payment signature missing, issuing 402 challenge...")
        challenge = {
            "status": 402,
            "error": "Payment Required",
            "token": USDC_ADDRESS,
            "recipient": SERVER_RECIPIENT,
            "amount": str(expected_amount),
            "scheme": "exact",
            "network": "eip155:84532"
        }
        return json.dumps(challenge)
        
    # Verify and Settle Payment
    ok, err_or_tx = verify_and_settle_x402(payment_signature, expected_amount, session_id, "tool_invocation: reflect_on_answer")
    if not ok:
        logger.warning(f"Payment verification failed: {err_or_tx}")
        challenge = {
            "status": 402,
            "error": f"Payment Required: {err_or_tx}",
            "token": USDC_ADDRESS,
            "recipient": SERVER_RECIPIENT,
            "amount": str(expected_amount),
            "scheme": "exact",
            "network": "eip155:84532"
        }
        return json.dumps(challenge)

    # Continue execution since payment is settled

    # Define paywall sampling wrapper
    async def run_sampling_with_paywall(messages_list, max_tokens) -> str:
        try:
            # First call without signature
            critique_result = await ctx.sample(
                messages=messages_list,
                max_tokens=max_tokens,
            )
            raw_text = critique_result.text
        except Exception as e:
            logger.error(f"First sampling attempt failed: {e}")
            raise RuntimeError(f"First sampling attempt failed: {e}")

        # Check if this is a 402 challenge
        is_challenge = False
        challenge_data = {}
        try:
            challenge_data = json.loads(raw_text)
            if isinstance(challenge_data, dict) and challenge_data.get("status") == 402:
                is_challenge = True
        except Exception:
            pass

        if is_challenge:
            logger.info("Client returned 402 Payment Required for compute. Preparing reciprocal payment...")
            try:
                SERVER_PRIVATE_KEY = os.getenv("SERVER_PRIVATE_KEY")
                if not SERVER_PRIVATE_KEY:
                    raise ValueError("SERVER_PRIVATE_KEY environment variable is not set on the server")
                    
                recipient_wallet = challenge_data.get("recipient")
                amount_atoms = int(challenge_data.get("amount", "5000"))
                token_address = challenge_data.get("token", USDC_ADDRESS)
                
                # Generate signature
                from eth_helpers import create_eip3009_payload
                auth_payload = create_eip3009_payload(SERVER_PRIVATE_KEY, recipient_wallet, amount_atoms)
                
                # Build envelope
                resource = {
                    "url": "sampling://client/llm",
                    "description": "Client Sampling Compute",
                    "mimeType": "application/json"
                }
                accepted = {
                    "scheme": "exact",
                    "network": "eip155:84532",
                    "asset": token_address,
                    "amount": str(amount_atoms),
                    "payTo": recipient_wallet,
                    "maxTimeoutSeconds": 3600,
                    "extra": {
                        "name": "USD Coin",
                        "version": "2"
                    }
                }
                payment_envelope = {
                    "x402Version": 2,
                    "paymentPayload": {
                        "x402Version": 2,
                        "resource": resource,
                        "accepted": accepted,
                        "payload": {
                            "authorization": auth_payload["authorization"],
                            "signature": auth_payload["signature"]
                        }
                    },
                    "paymentRequirements": accepted
                }
                
                payment_b64 = base64.b64encode(json.dumps(payment_envelope).encode("utf-8")).decode("utf-8")
                
                # Log outgoing payment in database (direction = 'outgoing')
                log_payment(
                    session_id=session_id,
                    tx_hash="0x_pending_settlement",
                    sender=SERVER_RECIPIENT,
                    recipient=recipient_wallet,
                    amount_atoms=amount_atoms,
                    token=token_address,
                    network="eip155:84532",
                    direction="outgoing",
                    resource_or_tool="sampling_compute"
                )
                
                # Prepend payment signature message to messages list
                from mcp.types import TextContent as MCPTextContent
                paywall_msg = SamplingMessage(
                    role="user",
                    content=MCPTextContent(
                        type="text",
                        text=f"[PAYWALL_SIGNATURE] {payment_b64}"
                    )
                )
                retry_messages = [paywall_msg] + messages_list
                
                logger.info("Resubmitting sample request with payment signature prepended...")
                retry_result = await ctx.sample(
                    messages=retry_messages,
                    max_tokens=max_tokens
                )
                raw_text = retry_result.text
                
            except Exception as pay_err:
                logger.error(f"Failed to generate reciprocal payment for sampling: {pay_err}")
                raise RuntimeError(f"Failed to generate reciprocal payment: {pay_err}")

        return raw_text

    # Critic loop via MCP Sampling
    logger.info("Requesting critique sample from client LLM via MCP Sampling...")
    await ctx.info("Initiating critique loop via MCP Sampling...")

    critique_messages = [
        SamplingMessage(
            role="user",
            content=MCPTextContent(
                type="text",
                text=(
                    f"You are an expert agricultural advisor reviewing an answer.\n\n"
                    f"Original Question: {original_query}\n\n"
                    f"Draft Answer: {draft_answer}\n\n"
                    f"Critique this answer for a farmer or agronomist. "
                    f"Respond ONLY with a valid JSON object — no markdown, no extra text:\n"
                    f"{{\n"
                    f'  "factual_errors": ["..."],\n'
                    f'  "missing_points": ["..."],\n'
                    f'  "improvement_areas": ["..."],\n'
                    f'  "overall_quality": "poor|fair|good"\n'
                    f"}}\n\n"
                    f"Use empty arrays [] where a category has no entries."
                ),
            ),
        )
    ]

    raw_critique = await run_sampling_with_paywall(critique_messages, 500)
    logger.info("Critique sample received from client LLM")
    await ctx.info("Critique sample received from client LLM")

    # Validate critique against Pydantic schema
    try:
        critique = parse_and_validate_critique(raw_critique)
        critique_text = (
            f"Quality: {critique.overall_quality}\n"
            f"Factual errors: {', '.join(critique.factual_errors) or 'none'}\n"
            f"Missing points: {', '.join(critique.missing_points) or 'none'}\n"
            f"Improvement areas: {', '.join(critique.improvement_areas) or 'none'}"
        )
        logger.info(f"Critique validated — overall quality: {critique.overall_quality}")
        await ctx.info(f"Critique validated — quality={critique.overall_quality}")
    except ValueError as exc:
        logger.warning(f"Critique validation failed, falling back to raw text: {exc}")
        critique_text = raw_critique

    # Correction loop via MCP Sampling
    logger.info("Requesting correction sample from client LLM via MCP Sampling...")
    await ctx.info("Initiating correction loop via MCP Sampling...")

    correction_messages = [
        SamplingMessage(
            role="user",
            content=MCPTextContent(
                type="text",
                text=(
                    f"You are an expert agricultural advisor.\n\n"
                    f"Original Question: {original_query}\n\n"
                    f"Draft Answer: {draft_answer}\n\n"
                    f"Critique: {critique_text}\n\n"
                    f"Write an improved final answer that addresses the critique. "
                    f"Be clear, accurate, and practical for a farmer.\n"
                    f"Respond ONLY with a valid JSON object — no markdown, no extra text:\n"
                    f"{{\n"
                    f'  "corrected_answer": "...",\n'
                    f'  "changes_made": ["..."]\n'
                    f"}}\n\n"
                    f"List every specific change you made from the draft in changes_made."
                ),
            ),
        )
    ]

    raw_correction = await run_sampling_with_paywall(correction_messages, 700)
    logger.info("Correction sample received from client LLM")
    await ctx.info("Correction sample received from client LLM")

    # Validate correction against Pydantic schema
    try:
        correction = parse_and_validate_correction(raw_correction)
        corrected_answer = correction.corrected_answer
        changes_summary = "\n".join(f"- {c}" for c in correction.changes_made)
        logger.info(f"Correction validated — {len(correction.changes_made)} changes made")
        await ctx.info(f"Correction validated — {len(correction.changes_made)} changes made")
    except ValueError as exc:
        logger.warning(f"Correction validation failed, falling back to raw text: {exc}")
        corrected_answer = raw_correction
        changes_summary = "N/A"

    return (
        f"[CRITIQUE]\n{critique_text}\n\n"
        f"[CHANGES MADE]\n{changes_summary}\n\n"
        f"[CORRECTED ANSWER]\n{corrected_answer}"
    )

# Run server
def main():
    host = os.getenv("MCP_HOST")
    port = int(os.getenv("MCP_PORT"))
    logger.info(
        f"Starting Agricultural Advisory System MCP Server "
        f"on streamable-http at {host}:{port}..."
    )
    mcp.run(transport="streamable-http", host=host, port=port)


if __name__ == "__main__":
    main()