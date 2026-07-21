"""Provision one online Omnigent session for the browser nonce demo."""

from __future__ import annotations

import argparse
import asyncio
import io
import json
import tarfile
from pathlib import Path

import httpx
from omnigent_client import OmnigentClient


def build_bundle(agent_dir: Path) -> bytes:
    payload = io.BytesIO()
    with tarfile.open(fileobj=payload, mode="w:gz") as archive:
        archive.add(agent_dir, arcname=".")
    return payload.getvalue()


async def provision(base_url: str, agent_dir: Path, workspace: Path) -> None:
    async with (
        OmnigentClient(base_url=base_url) as client,
        httpx.AsyncClient(base_url=base_url, timeout=30.0) as http,
    ):
        session = await client.sessions.create(
            build_bundle(agent_dir),
            filename="agent-connect-browser.tar.gz",
            workspace=str(workspace),
        )
        hosts = await http.get("/v1/hosts")
        hosts.raise_for_status()
        online = [
            host
            for host in hosts.json().get("hosts", [])
            if host.get("status") == "online"
        ]
        if len(online) != 1:
            raise RuntimeError(
                f"expected exactly one online Omnigent host, observed {len(online)}"
            )
        launch = await http.post(
            f"/v1/hosts/{online[0]['host_id']}/runners",
            json={"session_id": session.id, "workspace": str(workspace)},
        )
        launch.raise_for_status()
        for _ in range(120):
            snapshot = await client.sessions.get(session.id)
            if snapshot.runner_id:
                health = await http.get(f"/v1/sessions/{session.id}")
                health.raise_for_status()
                if health.json().get("runner_online") is True:
                    print(json.dumps({"session_id": session.id, "base_url": base_url}))
                    return
            await asyncio.sleep(0.25)
        raise TimeoutError(f"runner for {session.id} did not come online")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--workspace", type=Path, default=Path.cwd())
    parser.add_argument(
        "--agent-dir", type=Path, default=Path(__file__).with_name("agent")
    )
    args = parser.parse_args()
    asyncio.run(
        provision(
            args.base_url,
            args.agent_dir.resolve(),
            args.workspace.resolve(),
        )
    )


if __name__ == "__main__":
    main()
