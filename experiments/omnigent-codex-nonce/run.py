"""Live OmniGENT -> codex-acp -> Codex -> client-tool composition proof."""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import secrets
import sys
import tarfile
from pathlib import Path

import httpx
from omnigent_client import OmnigentClient, SessionsChat, SessionToolCallInfo


NONCE_TOOL_SCHEMA: dict[str, object] = {
    "type": "function",
    "function": {
        "name": "get_test_nonce",
        "description": "Return a fresh unpredictable value known only to the application.",
        "parameters": {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
    },
}


def build_bundle(agent_dir: Path) -> bytes:
    """Pack an OmniGENT agent directory into the session upload format."""
    payload = io.BytesIO()
    with tarfile.open(fileobj=payload, mode="w:gz") as archive:
        archive.add(agent_dir, arcname=".")
    return payload.getvalue()


def emit(event: str, **data: object) -> None:
    print(json.dumps({"event": event, **data}, sort_keys=True), flush=True)


async def resolve_host_id(http: httpx.AsyncClient, requested: str | None) -> str:
    if requested:
        return requested
    response = await http.get("/v1/hosts")
    response.raise_for_status()
    online = [
        host
        for host in response.json().get("hosts", [])
        if host.get("status") == "online"
    ]
    if len(online) != 1:
        raise RuntimeError(
            f"expected exactly one online OmniGENT host, observed {len(online)}; "
            "pass --host-id explicitly"
        )
    return str(online[0]["host_id"])


async def wait_for_runner(
    http: httpx.AsyncClient, session_id: str, timeout_seconds: float = 30.0
) -> None:
    deadline = asyncio.get_running_loop().time() + timeout_seconds
    while asyncio.get_running_loop().time() < deadline:
        response = await http.get(f"/v1/sessions/{session_id}")
        response.raise_for_status()
        snapshot = response.json()
        if snapshot.get("runner_online") is True:
            emit("runner.online", runner_id=snapshot.get("runner_id"))
            return
        await asyncio.sleep(0.25)
    raise TimeoutError(f"runner for session {session_id} did not come online")


async def run(
    base_url: str,
    agent_dir: Path,
    workspace: Path,
    host_id: str | None,
    timeout_seconds: float,
) -> int:
    nonce = f"agent-connect-{secrets.token_urlsafe(24)}"
    calls: list[SessionToolCallInfo] = []

    def get_test_nonce(call: SessionToolCallInfo) -> str:
        calls.append(call)
        emit(
            "client_tool.called",
            name=call.name,
            call_id=call.call_id,
            arguments=call.arguments,
            nonce=nonce,
        )
        return nonce

    bundle = build_bundle(agent_dir)
    emit("spike.started", base_url=base_url, agent_dir=str(agent_dir))

    async with (
        OmnigentClient(base_url=base_url) as client,
        httpx.AsyncClient(base_url=base_url, timeout=30.0) as http,
    ):
        async def declared_client_tools(
            _agent_id: str, _session_id: str | None = None
        ) -> list[dict[str, str]]:
            # SessionsChat 0.5.1 validates callables against spec-declared tools,
            # even when the application supplies the schema on the message event.
            # This compatibility declaration bypasses only that SDK preflight.
            return [{"name": "get_test_nonce", "runtime": "client"}]

        chat = await SessionsChat.create(
            namespace=client.sessions,
            bundle=bundle,
            filename="agent-connect-nonce.tar.gz",
            tool_callables={"get_test_nonce": get_test_nonce},
            agent_tools_getter=declared_client_tools,
        )
        emit("session.created", session_id=chat.session_id, agent_id=chat.agent_id)

        # OmniGENT's sessions wire accepts request-scoped tools at the top level
        # of a message event, but SessionsChat 0.5.1 does not expose that field.
        # Inject it at the namespace boundary so the tool remains application-
        # supplied (rather than becoming a bundled/local agent tool).
        original_post_event = chat._namespace.post_event

        async def post_event_with_tools(
            session_id: str, event: dict[str, object]
        ) -> None:
            forwarded = dict(event)
            if forwarded.get("type") == "message":
                forwarded["tools"] = [NONCE_TOOL_SCHEMA]
            await original_post_event(session_id, forwarded)

        chat._namespace.post_event = post_event_with_tools

        selected_host = await resolve_host_id(http, host_id)
        launch = await http.post(
            f"/v1/hosts/{selected_host}/runners",
            json={"session_id": chat.session_id, "workspace": str(workspace)},
        )
        launch.raise_for_status()
        emit("runner.launching", host_id=selected_host, **launch.json())
        await wait_for_runner(http, chat.session_id)

        prompt = (
            "Call get_test_nonce exactly once. Then reply with the exact value it "
            "returned, with no abbreviation."
        )
        result = await asyncio.wait_for(chat.query(prompt), timeout=timeout_seconds)

    emit("turn.completed", text=result.text, tool_call_count=len(calls))

    failures: list[str] = []
    if len(calls) != 1:
        failures.append(f"expected exactly one client-tool call, observed {len(calls)}")
    if nonce not in result.text:
        failures.append("Codex's final response did not contain the application nonce")

    if failures:
        emit("spike.failed", failures=failures)
        return 1

    emit("spike.passed", nonce=nonce, tool_call_id=calls[0].call_id)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:6767")
    parser.add_argument("--host-id")
    parser.add_argument("--timeout", type=float, default=300.0)
    parser.add_argument("--workspace", type=Path, default=Path.cwd())
    parser.add_argument(
        "--agent-dir",
        type=Path,
        default=Path(__file__).with_name("agent"),
    )
    args = parser.parse_args()
    return asyncio.run(
        run(
            args.base_url,
            args.agent_dir.resolve(),
            args.workspace.resolve(),
            args.host_id,
            args.timeout,
        )
    )


if __name__ == "__main__":
    sys.exit(main())
