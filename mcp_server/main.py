from mcp.types import SamplingMessage, TextContent as MCPTextContent
import logging
import os
from datetime import datetime
import json
from dotenv import load_dotenv
from fastmcp import FastMCP, Context
from pydantic import BaseModel, Field
from tavily import TavilyClient
from knowledge_base import DOCUMENTS

load_dotenv()

# logging setup
logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [SERVER] [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)

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


def hierarchical_search(queries: list[str], top_k: int = 3) -> list[dict]:
    """
    True two-level hierarchical retrieval.

    Level 1 — Summary index: score every document by keyword overlap
    between the expanded query set and the document summary.  Only the
    top_k highest-scoring documents are promoted to level 2, keeping the
    chunk search manageable regardless of corpus size.

    Level 2 — Chunk index: for each candidate document compute a Jaccard
    similarity between the query token set and every chunk's token set.
    Only chunks with similarity > 0 are returned, sorted descending.
    """
    # rank documents by summary relevance
    doc_scores: list[tuple[dict, float]] = []
    for doc in DOCUMENTS:
        summary_tokens = set(doc["summary"].lower().split())
        score = 0.0
        for query in queries:
            query_tokens = {w for w in query.lower().split() if len(w) > 3}
            score += len(query_tokens & summary_tokens)
        if score > 0:
            doc_scores.append((doc, score))

    doc_scores.sort(key=lambda x: x[1], reverse=True)
    candidate_docs = [doc for doc, _ in doc_scores[:top_k]]

    logger.info(
        f"Level-1 search: {len(candidate_docs)} candidate documents "
        f"(top_k={top_k}, corpus={len(DOCUMENTS)})"
    )

    # rank chunks to the query
    results: list[dict] = []
    for doc in candidate_docs:
        for chunk in doc["chunks"]:
            chunk_tokens = set(chunk.lower().split())
            sim_total = 0.0
            for query in queries:
                query_tokens = {w for w in query.lower().split() if len(w) > 3}
                union = query_tokens | chunk_tokens
                if union:
                    sim_total += len(query_tokens & chunk_tokens) / len(union)
            if sim_total > 0:
                results.append(
                    {
                        "doc_id": doc["id"],
                        "summary": doc["summary"],
                        "chunk": chunk,
                        "similarity": round(sim_total, 4),
                    }
                )

    results.sort(key=lambda x: x["similarity"], reverse=True)
    logger.info(f"Level-2 search: {len(results)} chunks with similarity > 0")
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
    Implements: multi-query expansion → hierarchical search →
    Tree-of-Thought evaluation (LLM-based) → Tavily fallback if needed.
    """
    logger.info(f"CRAG resource queried with: '{query}'")

    expanded_queries = expand_query(query)
    retrieved_chunks = hierarchical_search(expanded_queries)
    relevant_chunks = await tot_evaluate(retrieved_chunks, query, ctx)

    # Tavily fallback if ToT filtered everything out
    if not relevant_chunks:
        logger.info("ToT found no relevant chunks, triggering Tavily fallback...")
        try:
            tavily_results = tavily.search(query=f"agriculture {query}", max_results=3)
            fallback_content = "\n\n".join(
                f"[Web Source]: {r['title']}\n{r['content']}"
                for r in tavily_results.get("results", [])
            )
            logger.info("Tavily fallback successful")
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
    return "\n\n".join(output)


# Reflector tool
@mcp.tool()
async def reflect_on_answer(
    original_query: str,
    draft_answer: str,
    ctx: Context,
) -> str:
    """
    Reflection tool, uses true MCP Sampling to delegate LLM
    critique and correction back to the client's model.
    The server holds no API key and makes no direct LLM calls.
    """
    logger.info(f"Reflection tool invoked for query: '{original_query}'")
    await ctx.info(f"Reflection tool invoked for query: '{original_query}'")

    # Critic loop via MCP Sampling
    logger.info("Requesting critique sample from client LLM via MCP Sampling...")
    await ctx.info("Initiating critique loop via MCP Sampling...")

    critique_result = await ctx.sample(
        messages=[
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
        ],
        max_tokens=500,
    )
    raw_critique = critique_result.text
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

    correction_result = await ctx.sample(
        messages=[
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
        ],
        max_tokens=700,
    )
    raw_correction = correction_result.text
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