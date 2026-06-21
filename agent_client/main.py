import asyncio
import logging
import os
import uuid
from datetime import datetime, timezone
from dotenv import load_dotenv
from fastmcp import Client
from fastmcp.client.logging import LogMessage
from langchain_openai import ChatOpenAI
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_core.tools import tool
from langchain.agents import create_agent
from langgraph.store.sqlite.aio import AsyncSqliteStore
from mcp.types import (
    CreateMessageRequestParams,
    CreateMessageResult,
    TextContent,
)
from langchain_core.runnables import RunnableLambda
from langchain_core.messages import AIMessage

load_dotenv()
_resilience_events: list[dict] = []

# Flat file logger
logger = logging.getLogger("agri_agent")
logger.setLevel(logging.INFO)

formatter = logging.Formatter(
    "[%(asctime)s] [CLIENT] [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
console_handler = logging.StreamHandler()
console_handler.setFormatter(formatter)

shared_file_handler = logging.FileHandler("mcp_agent_system.log")
shared_file_handler.setFormatter(formatter)

logger.addHandler(console_handler)
logger.addHandler(shared_file_handler)

server_logger = logging.getLogger("mcp_server_logs")
server_logger.setLevel(logging.DEBUG)
server_formatter = logging.Formatter(
    "[%(asctime)s] [SERVER] [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
server_console = logging.StreamHandler()
server_console.setFormatter(server_formatter)
server_logger.addHandler(server_console)
server_logger.addHandler(shared_file_handler)

def _record_resilience_event(layer: str, detail: str) -> None:
    """Thread-safe-enough append for our single-process use case."""
    _resilience_events.append({
        "layer": layer,
        "detail": detail,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    })

MAX_RETRY_ATTEMPTS = int(os.getenv("MAX_RETRY_ATTEMPTS", "3"))

_model_name = os.getenv("REASONING_MODEL", "nvidia/nemotron-3-nano-30b-a3b:free")
_api_key = os.getenv("OPENROUTER_API_KEY")
_api_base = os.getenv("OPENROUTER_BASE_URL")
_embedding_model = os.getenv("EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2")

def _make_raw_llm(temperature: float = 0.3) -> ChatOpenAI:
    return ChatOpenAI(
        model=_model_name,
        openai_api_key=_api_key,
        openai_api_base=_api_base,
        temperature=temperature,
        max_retries=MAX_RETRY_ATTEMPTS,
    )

llm = _make_raw_llm(temperature=0.3)

llm_with_retry = llm.with_retry(
    retry_if_exception_type=(Exception,),
    wait_exponential_jitter=True,
    stop_after_attempt=MAX_RETRY_ATTEMPTS,
)

embeddings = HuggingFaceEmbeddings(
    model_name=_embedding_model,
)

def get_sampling_chain(max_tokens: int | None = None):
    llm_to_use = _make_raw_llm(temperature=0.3)
    if max_tokens is not None:
        llm_to_use = llm_to_use.bind(max_tokens=max_tokens)
        
    sampling_llm_with_retry = (
        RunnableLambda(lambda payload, **kwargs: payload.get("input")) | llm_to_use
    ).with_retry(
        retry_if_exception_type=(Exception,),
        wait_exponential_jitter=True,
        stop_after_attempt=MAX_RETRY_ATTEMPTS,
    )
    
    def fallback_healing(payload: dict, **kwargs):
        original_input = payload.get("input")
        error_trace = payload.get("error_trace")
        logger.warning(
            f"Sampling LLM failed after {MAX_RETRY_ATTEMPTS} retries. "
            f"Engaging self-healing fallback. error_trace={error_trace}"
        )
        _record_resilience_event(
            layer="self_healing_fallback",
            detail=f"Sampling LLM retry exhausted. error_trace={error_trace}",
        )
        healing_llm = _make_raw_llm(temperature=0.0)
        if max_tokens is not None:
            healing_llm = healing_llm.bind(max_tokens=max_tokens)
        return healing_llm.invoke(original_input)

    def fallback_hardcoded(payload: dict, **kwargs):
        error_trace = payload.get("error_trace")
        logger.error(
            f"CATASTROPHIC FAILURE (sampling LLM): retry and self-healing "
            f"fallback both exhausted. error_trace={error_trace}. "
            "Returning deterministic error payload."
        )
        _record_resilience_event(
            layer="hardcoded_absolute_fallback",
            detail=f"Sampling LLM self-healing fallback also failed. error_trace={error_trace}",
        )
        return AIMessage(
            content=(
                "[SYSTEM ERROR] Sampling request could not be completed after "
                "exhausting all retry and self-healing attempts."
            )
        )

    return sampling_llm_with_retry.with_fallbacks(
        [
            RunnableLambda(fallback_healing),
            RunnableLambda(fallback_hardcoded),
        ],
        exception_key="error_trace",
    )




# Structured log writer
async def write_structured_log(
    store: AsyncSqliteStore,
    session_id: str,
    namespace: tuple,
    mcp_interaction_type: str,
    content: str,
    component: str = "client",
    level: str = "INFO",
) -> None:
    """
    Write a structured, vector-embedded log entry to AsyncSqliteStore.

    namespace examples:
        ("logs", "agent", "planning")
        ("logs", "mcp", "server", "tools")
        ("logs", "mcp", "sampling")
        ("logs", "mcp", "resource")
    """
    key = str(uuid.uuid4())
    doc = {
        "session_id": session_id,
        "mcp_interaction_type": mcp_interaction_type,
        "content": content,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "component": component,
        "level": level,
    }
    await store.aput(namespace, key, doc)
    logger.debug(f"Structured log written → namespace={namespace} type={mcp_interaction_type}")


# Sampling handler
async def sampling_handler(
    messages: list,
    params: CreateMessageRequestParams,
    ctx,
) -> CreateMessageResult:
    logger.info("MCP Sampling request received from server, executing LLM locally...")

    prompt_text = ""
    for msg in messages:
        if hasattr(msg.content, "text"):
            prompt_text += msg.content.text + "\n"

    max_tokens = getattr(params, "max_tokens", None)
    if max_tokens is None:
        max_tokens = getattr(params, "maxTokens", None)

    call_chain = get_sampling_chain(max_tokens)
    response = await call_chain.ainvoke({"input": prompt_text})
    result_text = response.content

    logger.info("MCP Sampling complete, returning result to server")

    return CreateMessageResult(
        role="assistant",
        content=TextContent(type="text", text=result_text),
        model=_model_name,
        stopReason="endTurn",
    )


async def run_agent(user_query: str):
    global _resilience_events
    session_id = str(uuid.uuid4())
    logger.info(f"Agent started. Session: {session_id} | Query: '{user_query}'")

    db_path = os.getenv("SQLITE_DB_PATH", "mcp_agent_log.db")

    async with AsyncSqliteStore.from_conn_string(
        db_path,
        index={
            "dims": 384,
            "embed": embeddings.aembed_documents,
        },
    ) as store:
        logger.info(f"AsyncSqliteStore initialised: {db_path}")

        await write_structured_log(
            store=store,
            session_id=session_id,
            namespace=("logs", "agent", "planning"),
            mcp_interaction_type="agent_planning",
            content=f"Agent session started. User query: {user_query}",
        )

        # Define server log handler INSIDE run_agent
        async def server_log_handler(log_message: LogMessage) -> None:
            level = str(log_message.level).upper()
            message = (
                log_message.data
                if isinstance(log_message.data, str)
                else str(log_message.data)
            )

            # Write to flat log file
            if level == "ERROR":
                server_logger.error(message)
            elif level == "WARNING":
                server_logger.warning(message)
            elif level == "DEBUG":
                server_logger.debug(message)
            else:
                server_logger.info(message)

            # Write to SQLite store with component="server"
            await write_structured_log(
                store=store,
                session_id=session_id,
                namespace=("logs", "mcp", "server"),
                mcp_interaction_type="server_log",
                content=message,
                component="server",
                level=level,
            )

        async with Client(
            "http://localhost:8000/mcp",
            sampling_handler=sampling_handler,
            log_handler=server_log_handler,
        ) as client:
            logger.info("MCP session initialised, sampling handler and log handler registered")

            # Native RunnableWithRetry wrappers for MCP tool invocation chains
            async def _read_resource_fn(query: str) -> list:
                return await client.read_resource(f"knowledge://agriculture/docs/{query}")

            read_resource_runnable = RunnableLambda(_read_resource_fn).with_retry(
                retry_if_exception_type=(Exception,),
                wait_exponential_jitter=True,
                stop_after_attempt=MAX_RETRY_ATTEMPTS,
            )

            async def _call_reflection_fn(args: dict) -> any:
                return await client.call_tool("reflect_on_answer", arguments=args)

            call_reflection_runnable = RunnableLambda(_call_reflection_fn).with_retry(
                retry_if_exception_type=(Exception,),
                wait_exponential_jitter=True,
                stop_after_attempt=MAX_RETRY_ATTEMPTS,
            )

            @tool
            async def crag_knowledge_tool(query: str) -> str:
                """
                Queries the agricultural knowledge base on the MCP server.
                Uses hierarchical search (2-level) + Tree-of-Thought + Tavily fallback.
                """
                logger.info(f"Querying CRAG resource with: '{query}'")
                await write_structured_log(
                    store=store,
                    session_id=session_id,
                    namespace=("logs", "mcp", "resource"),
                    mcp_interaction_type="resource_read",
                    content=f"CRAG resource queried: {query}",
                )
                try:
                    # Invoke the wrapped tool invocation chain that handles network faults
                    results = await read_resource_runnable.ainvoke(query)
                    logger.info("CRAG resource response received")
                    await write_structured_log(
                        store=store,
                        session_id=session_id,
                        namespace=("logs", "mcp", "resource"),
                        mcp_interaction_type="resource_read",
                        content=f"CRAG resource response received for query: {query}",
                    )
                    if results:
                        item = results[0]
                        return item.text if hasattr(item, "text") else item.blob.decode()
                    return "No knowledge found"
                except Exception as e:
                    logger.error(f"CRAG resource error: {e}")
                    await write_structured_log(
                        store=store,
                        session_id=session_id,
                        namespace=("logs", "mcp", "resource"),
                        mcp_interaction_type="resource_read",
                        content=f"CRAG resource error: {e}",
                        level="ERROR",
                    )
                    return f"Knowledge retrieval failed: {e}"

            @tool
            async def reflection_tool(original_query: str, draft_answer: str) -> str:
                """
                Critiques and corrects a draft answer using true MCP Sampling.
                The server calls ctx.sample() which fires the sampling_handler,
                runs the LLM locally on this client, and returns the validated result.
                """
                logger.info("Calling remote reflection tool on MCP server...")
                await write_structured_log(
                    store=store,
                    session_id=session_id,
                    namespace=("logs", "mcp", "server", "tools"),
                    mcp_interaction_type="tool_invocation",
                    content=f"reflect_on_answer invoked. Query: {original_query}",
                )
                try:
                    # Invoke the wrapped tool invocation chain that handles network faults
                    result = await call_reflection_runnable.ainvoke({
                        "original_query": original_query,
                        "draft_answer": draft_answer,
                    })
                    logger.info("Reflection tool response received")
                    await write_structured_log(
                        store=store,
                        session_id=session_id,
                        namespace=("logs", "mcp", "server", "tools"),
                        mcp_interaction_type="tool_invocation",
                        content=f"reflect_on_answer tool response received. Query: {original_query}",
                    )
                    if result.content:
                        block = result.content[0]
                        return block.text if hasattr(block, "text") else str(block)
                    return "No reflection result"
                except Exception as e:
                    logger.error(f"Reflection tool error: {e}")
                    await write_structured_log(
                        store=store,
                        session_id=session_id,
                        namespace=("logs", "mcp", "server", "tools"),
                        mcp_interaction_type="tool_invocation",
                        content=f"reflect_on_answer tool error: {e}",
                        level="ERROR",
                    )
                    return f"Reflection tool failed: {e}"

            tools = [crag_knowledge_tool, reflection_tool]

            system_prompt = """You are an expert agricultural advisor assistant.

You MUST always follow these steps in order for EVERY question:
1. ALWAYS call crag_knowledge_tool first to retrieve relevant knowledge
2. Use the retrieved knowledge to draft a detailed answer
3. ALWAYS call reflection_tool with your original query and draft answer
4. Return the final corrected answer from the reflection tool
"""

            agent = create_agent(
                model=llm_with_retry,
                tools=tools,
                system_prompt=system_prompt,
            )

            logger.info("Agent ready. Sending query...")

            # ── Wrap the agent invocation with fallback layers ──────
            async def _invoke_agent(payload: dict):
                input_data = payload.get("input")
                return await agent.ainvoke(input_data)

            async def _agent_self_healing_fallback(payload: dict):
                error_trace = payload.get("error_trace")
                logger.warning(
                    f"Agent invocation failed. Engaging self-healing fallback. "
                    f"error_trace={error_trace}"
                )
                _record_resilience_event(
                    layer="self_healing_fallback",
                    detail=f"Agent invocation failed, retrying once more. error_trace={error_trace}",
                )
                input_data = payload.get("input")
                user_query = ""
                if isinstance(input_data, dict) and "messages" in input_data:
                    user_query = input_data["messages"][-1]["content"]
                else:
                    user_query = str(input_data)

                # Query LLM to resolve the exception state and generate a correct final answer
                healing_prompt = (
                    f"You are the self-healing recovery layer for an agricultural advisory agent.\n"
                    f"The primary agent failed during execution due to the following exception.\n"
                    f"Original User Query: {user_query}\n"
                    f"Error Trace: {error_trace}\n\n"
                    f"Please analyze the error trace. Generate a helpful, correct, and professional "
                    f"agricultural response that answers the user's query while explaining that a "
                    f"transient tool error occurred but was self-healed. If you cannot solve the query, "
                    f"raise a runtime error to trigger the absolute fallback."
                )

                try:
                    healing_llm = _make_raw_llm(temperature=0.1)
                    healed_response = await healing_llm.ainvoke(healing_prompt)
                    if "failed" in healed_response.content.lower() and len(healed_response.content) < 50:
                        raise RuntimeError("Self-healing LLM could not resolve the error.")
                    return {
                        "messages": [
                            AIMessage(content=healed_response.content)
                        ]
                    }
                except Exception as healing_exc:
                    logger.error(f"LLM self-healing failed: {healing_exc}")
                    raise RuntimeError(f"Self-healing failed: {healing_exc}") from healing_exc

            async def _agent_hardcoded_absolute_fallback(payload: dict):
                error_trace = payload.get("error_trace")
                logger.error(
                    f"CATASTROPHIC FAILURE (agent invocation): self-healing fallback "
                    f"also failed. error_trace={error_trace}"
                )
                _record_resilience_event(
                    layer="hardcoded_absolute_fallback",
                    detail=f"Agent invocation catastrophic failure. error_trace={error_trace}",
                )

                # Capture execution state and write structured error to sqlite store
                try:
                    await write_structured_log(
                        store=store,
                        session_id=session_id,
                        namespace=("logs", "resilience", "hardcoded_absolute_fallback"),
                        mcp_interaction_type="resilience_event",
                        content=f"CATASTROPHIC FAILURE: {error_trace}",
                        level="ERROR",
                    )
                except Exception as log_exc:
                    logger.error(f"Failed to log catastrophic failure to store: {log_exc}")

                return {
                    "messages": [
                        AIMessage(
                            content=(
                                "[SYSTEM ERROR] The advisory engine encountered a "
                                "critical failure after exhausting all retry and "
                                "self-healing attempts. Please try your question again shortly."
                            )
                        )
                    ]
                }

            resilient_agent_call = RunnableLambda(_invoke_agent).with_fallbacks(
                [
                    RunnableLambda(_agent_self_healing_fallback),
                    RunnableLambda(_agent_hardcoded_absolute_fallback),
                ],
                exception_key="error_trace",
            )

            try:
                response = await resilient_agent_call.ainvoke(
                    {
                        "input": {
                            "messages": [{"role": "user", "content": user_query}],
                        }
                    }
                )
                final_answer = response["messages"][-1].content

                for event in _resilience_events:
                    await write_structured_log(
                        store=store,
                        session_id=session_id,
                        namespace=("logs", "resilience", event["layer"]),
                        mcp_interaction_type="resilience_event",
                        content=event["detail"],
                        level="WARNING" if event["layer"] == "self_healing_fallback" else "ERROR",
                    )
                    logger.info(f"Resilience event drained to store: {event['layer']} — {event['detail']}")
                _resilience_events = []

                await write_structured_log(
                    store=store,
                    session_id=session_id,
                    namespace=("logs", "agent", "planning"),
                    mcp_interaction_type="agent_planning",
                    content=f"Agent final answer: {final_answer}",
                )

                logger.info(f"Agent final answer: {final_answer}")
                print(f"\n{'='*60}")
                print(f"FINAL ANSWER:\n{final_answer}")
                print(f"{'='*60}\n")

            except Exception as e:
                logger.error(f"Agent execution failed: {e}")

                # ── Drain resilience events even on failure ─────────
                for event in _resilience_events:
                    await write_structured_log(
                        store=store,
                        session_id=session_id,
                        namespace=("logs", "resilience", event["layer"]),
                        mcp_interaction_type="resilience_event",
                        content=event["detail"],
                        level="WARNING" if event["layer"] == "self_healing_fallback" else "ERROR",
                    )
                _resilience_events = []

                await write_structured_log(
                    store=store,
                    session_id=session_id,
                    namespace=("logs", "agent", "planning"),
                    mcp_interaction_type="agent_planning",
                    content=f"Agent execution failed: {e}",
                    level="ERROR",
                )
                raise


if __name__ == "__main__":
    query = input("Enter your agricultural question: ")
    asyncio.run(run_agent(query))