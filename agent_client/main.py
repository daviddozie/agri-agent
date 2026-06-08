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

load_dotenv()

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


llm = ChatOpenAI(
    model=os.getenv("REASONING_MODEL", "nvidia/nemotron-3-nano-30b-a3b:free"),
    openai_api_key=os.getenv("OPENROUTER_API_KEY"),
    openai_api_base=os.getenv("OPENROUTER_BASE_URL"),
    temperature=0.3,
)

embeddings = HuggingFaceEmbeddings(
    model_name=os.getenv("EMBEDDING_MODEL", "sentence-transformers/all-MiniLM-L6-v2"),
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

    invoke_kwargs = {}
    max_tokens = getattr(params, "max_tokens", None)
    if max_tokens is None:
        max_tokens = getattr(params, "maxTokens", None)
    if max_tokens is not None:
        invoke_kwargs["max_tokens"] = max_tokens

    response = await llm.ainvoke(prompt_text, **invoke_kwargs)
    result_text = response.content

    logger.info("MCP Sampling complete, returning result to server")

    return CreateMessageResult(
        role="assistant",
        content=TextContent(type="text", text=result_text),
        model=os.getenv("REASONING_MODEL", "nvidia/nemotron-3-nano-30b-a3b:free"),
        stopReason="endTurn",
    )


# Server log handler
async def server_log_handler(log_message: LogMessage) -> None:
    level = str(log_message.level).upper()
    message = (
        log_message.data
        if isinstance(log_message.data, str)
        else str(log_message.data)
    )
    if level == "ERROR":
        server_logger.error(message)
    elif level == "WARNING":
        server_logger.warning(message)
    elif level == "DEBUG":
        server_logger.debug(message)
    else:
        server_logger.info(message)


async def run_agent(user_query: str):
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

        async with Client(
            "http://localhost:8000/mcp",
            sampling_handler=sampling_handler,
            log_handler=server_log_handler,
        ) as client:
            logger.info("MCP session initialised, sampling handler and log handler registered")

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
                    results = await client.read_resource(
                        f"knowledge://agriculture/docs/{query}"
                    )
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
                result = await client.call_tool(
                    "reflect_on_answer",
                    arguments={
                        "original_query": original_query,
                        "draft_answer": draft_answer,
                    },
                )
                logger.info("Reflection tool response received")
                await write_structured_log(
                    store=store,
                    session_id=session_id,
                    namespace=("logs", "mcp", "sampling"),
                    mcp_interaction_type="sampling_request",
                    content=f"MCP Sampling completed for reflection. Query: {original_query}",
                )
                if result.content:
                    block = result.content[0]
                    return block.text if hasattr(block, "text") else str(block)
                return "No reflection result"

            tools = [crag_knowledge_tool, reflection_tool]

            system_prompt = """You are an expert agricultural advisor assistant.

You MUST always follow these steps in order for EVERY question:
1. ALWAYS call crag_knowledge_tool first to retrieve relevant knowledge
2. Use the retrieved knowledge to draft a detailed answer
3. ALWAYS call reflection_tool with your original query and draft answer
4. Return the final corrected answer from the reflection tool
"""

            agent = create_agent(
                model=llm,
                tools=tools,
                system_prompt=system_prompt,
            )

            logger.info("Agent ready. Sending query...")

            try:
                response = await agent.ainvoke(
                    {
                        "messages": [{"role": "user", "content": user_query}],
                    },
                )
                final_answer = response["messages"][-1].content

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