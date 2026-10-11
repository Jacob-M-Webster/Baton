"""Sessions on a GitHub repository: read what someone pasted, clone it once, start workspaces from the clone.

Clones live under data/repos/<owner>/<name>/<commit> and are never modified, so the code view can diff
against them and forks can start from the same commit the session did.
"""
from __future__ import annotations

import asyncio
import base64
import os
import re
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path

from .sandbox import WINDOWS, _kill, rmtree

CLONE_TIMEOUT = 180
MAX_REPO_BYTES = 300_000_000
MAX_REPO_FILES = 30_000

_URL = re.compile(
    r"^(?:(?:https?://)?(?:www\.)?github\.com/|git@github\.com:)?"
    r"(?P<owner>[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/(?P<name>[A-Za-z0-9._-]{1,100}?)(?:\.git)?"
    r"(?:/tree/(?P<ref>[^?#]+?))?/?(?:[?#].*)?$"
)
_REF = re.compile(r"^[A-Za-z0-9._/-]{1,200}$")


class GitHubError(Exception):
    pass


@dataclass(frozen=True)
class GitHubRepo:
    owner: str
    name: str
    ref: str | None = None

    @property
    def full_name(self) -> str:
        return f"{self.owner}/{self.name}"

    @property
    def url(self) -> str:
        return f"https://github.com/{self.full_name}"


def parse_github(text: str, ref: str | None = None) -> GitHubRepo:
    """Accept `owner/name`, a github.com URL (optionally .../tree/<branch>), or a git@github.com: remote."""
    m = _URL.match(text.strip())
    if not m or m["name"] in (".", ".."):
        raise GitHubError("That doesn't look like a GitHub repository. Try owner/name or https://github.com/owner/name")
    ref = (ref or "").strip() or m["ref"]
    if ref and (not _REF.match(ref) or ref.startswith(("-", "/")) or ".." in ref):
        raise GitHubError(f"Not a valid branch or tag name: {ref}")
    return GitHubRepo(m["owner"], m["name"], ref or None)


async def clone(repo: GitHubRepo, cache: Path, token: str | None = None) -> dict:
    """Shallow-clone `repo` into the cache (once per commit). Returns where it is and what was cloned."""
    git = shutil.which("git")
    if not git:
        raise GitHubError("git isn't installed on the server, so it can't clone repositories")
    cache.mkdir(parents=True, exist_ok=True)
    tmp = cache / f".clone-{uuid.uuid4().hex[:8]}"
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never", "GIT_LFS_SKIP_SMUDGE": "1"}
    if token:
        # Through the environment rather than argv, so the token never shows up in a process list.
        auth = base64.b64encode(f"x-access-token:{token}".encode()).decode()
        env.update({"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "http.https://github.com/.extraheader",
                    "GIT_CONFIG_VALUE_0": f"Authorization: Basic {auth}"})
    argv = [git, "-c", "credential.helper=", "clone", "--depth", "1", "--single-branch", "--no-tags"]
    if repo.ref:
        argv += ["--branch", repo.ref]
    argv += ["--", repo.url + ".git", str(tmp)]
    try:
        code, out = await _run(argv, env, CLONE_TIMEOUT)
        if code != 0:
            raise GitHubError(_explain(repo, out, private_ok=bool(token)))
        code, sha = await _run([git, "-C", str(tmp), "rev-parse", "HEAD"], env, 30)
        sha = sha.strip()
        if code != 0 or not re.fullmatch(r"[0-9a-f]{40}", sha):
            raise GitHubError(f"Cloned {repo.full_name} but couldn't read its commit")
        _check_size(tmp, repo)
        target = cache / repo.owner.lower() / repo.name.lower() / sha
        if target.exists():
            rmtree(tmp)  # someone else already cloned this commit
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            try:
                os.replace(tmp, target)
            except OSError:
                if not target.exists():
                    raise
                rmtree(tmp)
    finally:
        if tmp.exists():
            rmtree(tmp)
    return {
        "url": repo.url, "ref": repo.ref, "sha": sha,
        "path": target.relative_to(cache.parent).as_posix(),
    }


async def _run(argv: list[str], env: dict[str, str], timeout: float) -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(
        *argv, env=env, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT, start_new_session=not WINDOWS,
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        _kill(proc)
        await proc.wait()
        raise GitHubError(f"Cloning took longer than {int(timeout)}s; try a smaller repository") from None
    except asyncio.CancelledError:
        _kill(proc)
        raise
    return proc.returncode or 0, out.decode("utf-8", errors="replace")


def _explain(repo: GitHubRepo, out: str, private_ok: bool) -> str:
    low = out.lower()
    if repo.ref and ("remote branch" in low and "not found" in low):
        return f"{repo.full_name} has no branch or tag named {repo.ref}"
    if any(s in low for s in ("repository not found", "could not read username", "authentication failed",
                              "terminal prompts disabled", "returned error: 40")):
        hint = "" if private_ok else " If it's private, add a GitHub token in Settings."
        return f"Couldn't find {repo.full_name} on GitHub.{hint}"
    if "could not resolve host" in low or "unable to access" in low:
        return "The server couldn't reach GitHub"
    last = next((l.strip() for l in reversed(out.splitlines()) if l.strip()), "")
    return f"Couldn't clone {repo.full_name}: {last[:200]}" if last else f"Couldn't clone {repo.full_name}"


def _check_size(root: Path, repo: GitHubRepo) -> None:
    files = size = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d != ".git"]
        for f in filenames:
            files += 1
            try:
                size += (Path(dirpath) / f).lstat().st_size
            except OSError:
                pass
        if files > MAX_REPO_FILES or size > MAX_REPO_BYTES:
            raise GitHubError(f"{repo.full_name} is too big for a session (over {MAX_REPO_FILES:,} files or "
                              f"{MAX_REPO_BYTES // 1_000_000} MB)")

