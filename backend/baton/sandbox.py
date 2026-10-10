"""Per-session workspace and the tools the agent can call inside it.

Each session gets its own copy of a sample repo under data/workspaces/<id>.
Commands run either as a local subprocess with a scrubbed environment, or in a
throwaway container with no network (BATON_SANDBOX=docker|podman).
"""
from __future__ import annotations

import asyncio
import difflib
import os
import shutil
import signal
import sys
import time
from pathlib import Path

from .config import ROOT

SAMPLE_REPOS = ROOT / "sample-repos"
MAX_OUTPUT = 12_000
MAX_DIFF = 16_000
SKIP_DIRS = {".git", "__pycache__", "node_modules", ".pytest_cache", ".venv"}


class ToolError(Exception):
    pass


TOOL_SPECS: list[dict] = [
    {
        "name": "list_files",
        "description": "List files in the repository, recursively. Start here to learn the layout.",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string", "description": "Directory relative to the repo root. Defaults to '.'"}},
        },
    },
    {
        "name": "read_file",
        "description": "Read a text file from the repository. Returns numbered lines.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "start_line": {"type": "integer", "description": "1-based, optional"},
                "end_line": {"type": "integer", "description": "inclusive, optional"},
            },
            "required": ["path"],
        },
    },
    {
        "name": "write_file",
        "description": "Create or overwrite a file with the full content given.",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
            "required": ["path", "content"],
        },
    },
    {
        "name": "edit_file",
        "description": "Replace one exact, unique occurrence of old_str with new_str in a file.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "old_str": {"type": "string"},
                "new_str": {"type": "string"},
            },
            "required": ["path", "old_str", "new_str"],
        },
    },
    {
        "name": "run_command",
        "description": "Run a shell command in the repository root (no network). Use it to run tests, grep, etc.",
        "input_schema": {
            "type": "object",
            "properties": {
                "command": {"type": "string"},
                "timeout_seconds": {"type": "integer", "description": "Defaults to 60"},
            },
            "required": ["command"],
        },
    },
    {
        "name": "update_plan",
        "description": (
            "Publish your current plan so the humans watching can follow along. Call it at the start "
            "and whenever a step's status or the plan itself changes."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "steps": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": {"type": "string"},
                            "status": {"type": "string", "enum": ["pending", "in_progress", "done"]},
                        },
                        "required": ["title", "status"],
                    },
                }
            },
            "required": ["steps"],
        },
    },
    {
        "name": "ask_humans",
        "description": (
            "Pause and ask the humans in this session to decide something. Use it for genuine trade-offs "
            "or ambiguity in the task, not for routine progress. Offer 2-4 concrete options."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "question": {"type": "string"},
                "options": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["question"],
        },
    },
    {
        "name": "finish",
        "description": "Call once the task is complete and verified. Summarize what changed.",
        "input_schema": {
            "type": "object",
            "properties": {"summary": {"type": "string"}},
            "required": ["summary"],
        },
    },
]

# Tools handled by the runner itself rather than the sandbox.
CONTROL_TOOLS = {"update_plan", "ask_humans", "finish"}


def list_sample_repos() -> list[dict]:
    out = []
    if SAMPLE_REPOS.exists():
        for d in sorted(SAMPLE_REPOS.iterdir()):
            if d.is_dir():
                readme = d / "README.md"
                desc = ""
                if readme.exists():
                    lines = [l.strip() for l in readme.read_text().splitlines() if l.strip() and not l.startswith("#")]
                    desc = lines[0] if lines else ""
                out.append({"id": d.name, "description": desc})
    return out


def truncate(text: str, limit: int = MAX_OUTPUT) -> tuple[str, bool]:
    if len(text) <= limit:
        return text, False
    head = text[: limit * 2 // 3]
    tail = text[-limit // 3 :]
    return f"{head}\n\n… [{len(text) - limit} characters truncated] …\n\n{tail}", True


class Workspace:
    def __init__(self, root: Path, runtime: str = "local", image: str = "python:3.12-slim"):
        self.root = root
        self.runtime = runtime
        self.image = image

    @classmethod
    def create(cls, root: Path, repo: str, **kw) -> "Workspace":
        src = SAMPLE_REPOS / repo
        if not src.is_dir():
            raise ToolError(f"unknown sample repo: {repo}")
        if root.exists():
            shutil.rmtree(root)
        shutil.copytree(src, root, ignore=shutil.ignore_patterns(*SKIP_DIRS))
        return cls(root, **kw)

    # ---- paths ----------------------------------------------------------
    def resolve(self, rel: str) -> Path:
        p = (self.root / (rel or ".")).resolve()
        if p != self.root.resolve() and self.root.resolve() not in p.parents:
            raise ToolError(f"path escapes the repository: {rel}")
        return p

    def rel(self, p: Path) -> str:
        return str(p.relative_to(self.root.resolve()))

    # ---- file tools -----------------------------------------------------
    def list_files(self, path: str = ".") -> str:
        base = self.resolve(path)
        if not base.exists():
            raise ToolError(f"no such directory: {path}")
        lines = []
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
            for f in sorted(filenames):
                if f.endswith(".pyc"):
                    continue
                fp = Path(dirpath) / f
                lines.append(f"{self.rel(fp)}  ({fp.stat().st_size} B)")
            if len(lines) > 400:
                lines.append("… (truncated)")
                break
        return "\n".join(lines) or "(empty)"

    def read_file(self, path: str, start_line: int | None = None, end_line: int | None = None) -> str:
        p = self.resolve(path)
        if not p.is_file():
            raise ToolError(f"no such file: {path}")
        lines = p.read_text(errors="replace").splitlines()
        s = max(1, start_line or 1)
        e = min(len(lines), end_line or len(lines))
        body = "\n".join(f"{i:>4}  {lines[i - 1]}" for i in range(s, e + 1))
        return truncate(body)[0] or "(empty file)"

    def read_text(self, path: str) -> str | None:
        p = self.resolve(path)
        return p.read_text(errors="replace") if p.is_file() else None

    def write_file(self, path: str, content: str) -> tuple[str, str]:
        p = self.resolve(path)
        before = p.read_text(errors="replace") if p.is_file() else ""
        existed = p.is_file()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
        diff = make_diff(path, before, content)
        verb = "Updated" if existed else "Created"
        return f"{verb} {path} ({len(content.splitlines())} lines)", diff

    def edit_file(self, path: str, old_str: str, new_str: str) -> tuple[str, str]:
        p = self.resolve(path)
        if not p.is_file():
            raise ToolError(f"no such file: {path}")
        before = p.read_text(errors="replace")
        n = before.count(old_str)
        if n == 0:
            raise ToolError("old_str was not found in the file; read the file and copy the text exactly")
        if n > 1:
            raise ToolError(f"old_str matches {n} places; include more surrounding context")
        after = before.replace(old_str, new_str, 1)
        p.write_text(after)
        return f"Edited {path}", make_diff(path, before, after)

    # ---- commands -------------------------------------------------------
    async def run_command(self, command: str, timeout: int = 60) -> tuple[str, int]:
        timeout = max(1, min(int(timeout or 60), 300))
        if self.runtime in ("docker", "podman"):
            argv = [
                self.runtime, "run", "--rm", "--network", "none", "-v", f"{self.root.resolve()}:/workspace",
                "-w", "/workspace", self.image, "sh", "-lc", command,
            ]
            proc = await asyncio.create_subprocess_exec(
                *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, start_new_session=True
            )
        else:
            env = {
                # Put this interpreter first so `python` is a modern Python; keep no secrets.
                "PATH": f"{Path(sys.executable).parent}:/usr/local/bin:/usr/bin:/bin",
                "HOME": str(self.root.resolve()),
                "LANG": "C.UTF-8",
                "PYTHONDONTWRITEBYTECODE": "1",
                "PYTHONUNBUFFERED": "1",
                "TERM": "dumb",
            }
            proc = await asyncio.create_subprocess_shell(
                command,
                cwd=self.root,
                env=env,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                start_new_session=True,
            )
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            _kill(proc)
            await proc.wait()
            return f"(command timed out after {timeout}s)", 124
        except asyncio.CancelledError:
            _kill(proc)
            raise
        return out.decode(errors="replace"), proc.returncode or 0

    def snapshot(self) -> dict[str, str]:
        files = {}
        for dirpath, dirnames, filenames in os.walk(self.root):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            for f in filenames:
                fp = Path(dirpath) / f
                if f.endswith(".pyc") or fp.stat().st_size > 200_000:
                    continue
                files[str(fp.relative_to(self.root))] = fp.read_text(errors="replace")
        return files


def _kill(proc: asyncio.subprocess.Process) -> None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


def make_diff(path: str, before: str, after: str) -> str:
    d = "".join(
        difflib.unified_diff(
            before.splitlines(keepends=True), after.splitlines(keepends=True),
            fromfile=f"a/{path}", tofile=f"b/{path}", n=2,
        )
    )
    return truncate(d, MAX_DIFF)[0]


async def execute_tool(ws: Workspace, name: str, args: dict) -> dict:
    """Run one sandbox tool. Returns a tool.result payload fragment."""
    t0 = time.monotonic()
    result: dict = {"is_error": False}
    try:
        if name == "list_files":
            result["output"] = ws.list_files(args.get("path") or ".")
        elif name == "read_file":
            result["output"] = ws.read_file(args["path"], args.get("start_line"), args.get("end_line"))
        elif name == "write_file":
            result["output"], result["diff"] = ws.write_file(args["path"], args.get("content", ""))
        elif name == "edit_file":
            result["output"], result["diff"] = ws.edit_file(args["path"], args["old_str"], args.get("new_str", ""))
        elif name == "run_command":
            out, code = await ws.run_command(args["command"], args.get("timeout_seconds") or 60)
            text, truncated = truncate(out)
            result["output"] = f"{text}\n[exit code {code}]".lstrip()
            result["exit_code"] = code
            result["is_error"] = code != 0
            if truncated:
                result["full_output"] = out
        else:
            raise ToolError(f"unknown tool: {name}")
    except ToolError as e:
        result = {"is_error": True, "output": f"Error: {e}"}
    except KeyError as e:
        result = {"is_error": True, "output": f"Error: missing argument {e}"}
    except (OSError, UnicodeError) as e:
        result = {"is_error": True, "output": f"Error: {e}"}
    result["duration_ms"] = int((time.monotonic() - t0) * 1000)
    return result


def replay_file_changes(ws: Workspace, events: list[dict]) -> int:
    """Re-apply successful write_file/edit_file calls from a log onto a fresh workspace (forks)."""
    calls = {e["payload"]["call_id"]: e["payload"] for e in events if e["type"] == "tool.call"}
    applied = 0
    for e in events:
        if e["type"] != "tool.result" or e["payload"].get("is_error") or e["payload"].get("cancelled"):
            continue
        call = calls.get(e["payload"]["call_id"])
        if not call:
            continue
        try:
            if call["name"] == "write_file":
                ws.write_file(call["input"]["path"], call["input"].get("content", ""))
                applied += 1
            elif call["name"] == "edit_file":
                ws.edit_file(call["input"]["path"], call["input"]["old_str"], call["input"].get("new_str", ""))
                applied += 1
        except (ToolError, KeyError, OSError):
            pass
    return applied
