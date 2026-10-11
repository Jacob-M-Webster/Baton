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

import httpx

from .sandbox import SKIP_DIRS, WINDOWS, _kill, rmtree

API = "https://api.github.com"
CLONE_TIMEOUT = 180
PUSH_TIMEOUT = 180
MAX_REPO_BYTES = 300_000_000
MAX_REPO_FILES = 30_000

_URL = re.compile(
    r"^(?:(?:git|gh\s+repo)\s+clone\s+)?"  # the whole clone command, as people copy it
    r"(?P<host>(?:(?:https?|ssh)://)?(?:git@)?(?:www\.)?github\.com[/:])?"
    r"(?P<owner>[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/(?P<name>[A-Za-z0-9._-]{1,100}?)(?:\.git)?"
    # After a github.com URL, any page inside the repo (a file, its pulls...) still means the repo.
    r"(?:/tree/(?P<ref>[^?#]+?)|(?(host)/[^?#\s]*))?/?(?:[?#].*)?$",
    re.IGNORECASE,
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
    git = _git("clone repositories")
    cache.mkdir(parents=True, exist_ok=True)
    tmp = cache / f".clone-{uuid.uuid4().hex[:8]}"
    env = _env(token)
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


def branch_name(title: str, session_id: str) -> str:
    """The branch a session pushes to, e.g. baton/add-rate-limiting-3f9a1c."""
    slug = "-".join(re.findall(r"[a-z0-9]+", title.lower()))[:40].strip("-") or "session"
    return f"baton/{slug}-{session_id[-6:].lower()}"


async def push(base: Path, workspace: Path, gitdir: Path, repo: GitHubRepo, *, start: str, branch: str,
               message: str, author: tuple[str, str], token: str | None) -> dict:
    """Commit the workspace on top of the session's starting commit and push it to a branch on GitHub.

    `gitdir` is the session's own repository, made on the first push and kept for the next ones: it borrows
    the clone's objects, uses the workspace as its work tree, and adds one commit per push. Returns the branch
    (fixed by the first push), the commit pushed, whether this call made a new one, and the base branch.
    """
    git = _git("push changes")
    env = {**_env(token), "GIT_DIR": str(gitdir), "GIT_WORK_TREE": str(workspace),
           "GIT_AUTHOR_NAME": author[0], "GIT_AUTHOR_EMAIL": author[1],
           "GIT_COMMITTER_NAME": author[0], "GIT_COMMITTER_EMAIL": author[1]}
    opts = ["-c", "credential.helper=", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false"]

    async def g(*args: str, check: bool = True, cwd: Path | None = workspace, timeout: float = 60) -> tuple[int, str]:
        code, out = await _run([git, *opts, *args], env, timeout, cwd=cwd, doing="Pushing")
        if check and code != 0:
            raise GitHubError(f"git {args[0]} failed: {_last_line(out)[:200]}")
        return code, out

    ready = gitdir / "baton-ready"
    if not ready.exists():
        if gitdir.exists():
            rmtree(gitdir)  # a first push that failed halfway
        gitdir.parent.mkdir(parents=True, exist_ok=True)
        code, out = await _run([git, "init", "-q", "--bare", str(gitdir)], _env(None), 30)
        if code != 0:
            raise GitHubError(f"git init failed: {_last_line(out)[:200]}")
        # newline="" so Windows doesn't write \r\n: git would read the \r as part of the path.
        (gitdir / "objects" / "info" / "alternates").write_text(str((base / ".git" / "objects").resolve()) + "\n",
                                                               encoding="utf-8", newline="")
        if (base / ".git" / "shallow").exists():
            shutil.copyfile(base / ".git" / "shallow", gitdir / "shallow")
        await g("config", "core.bare", "false")
        await g("update-ref", f"refs/heads/{branch}", start)
        await g("symbolic-ref", "HEAD", f"refs/heads/{branch}")
        await g("read-tree", "HEAD")
        ready.touch()
    branch = (await g("symbolic-ref", "--short", "HEAD"))[1].strip()

    # Folders the workspace never copied (node_modules, .venv...) stay as the repository has them.
    skipped = [f":(exclude,glob)**/{d}/**" for d in sorted(SKIP_DIRS) if d != ".git"]
    await g("add", "-A", "--", ".", *skipped, timeout=PUSH_TIMEOUT)
    committed = (await g("diff", "--cached", "--quiet", check=False))[0] != 0
    if committed:
        await g("commit", "-q", "--no-verify", "-m", message)
    head = (await g("rev-parse", "HEAD"))[1].strip()
    if head == start:
        raise GitHubError("There are no changes to push yet")

    code, out = await g("push", "--porcelain", repo.url + ".git", f"HEAD:refs/heads/{branch}",
                        check=False, timeout=PUSH_TIMEOUT)
    if code != 0:
        raise GitHubError(_explain_push(repo, branch, out))
    gb = await _run([git, "-C", str(base), "symbolic-ref", "--short", "HEAD"], _env(None), 30)
    return {"branch": branch, "commit": head, "committed": committed,
            "base": gb[1].strip() if gb[0] == 0 else None}  # None: the session started from a tag


async def open_pull_request(repo: GitHubRepo, *, branch: str, base: str, title: str, body: str, token: str) -> str:
    """Open a pull request from `branch` into `base` (or find the one already open). Returns its URL."""
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
               "X-GitHub-Api-Version": "2022-11-28"}
    try:
        async with httpx.AsyncClient(base_url=API, headers=headers, timeout=20) as c:
            r = await c.post(f"/repos/{repo.full_name}/pulls", json={"title": title, "head": branch, "base": base, "body": body})
            if r.status_code == 201:
                return r.json()["html_url"]
            if r.status_code == 422:
                q = await c.get(f"/repos/{repo.full_name}/pulls", params={"head": f"{repo.owner}:{branch}", "state": "open"})
                if q.status_code == 200 and q.json():
                    return q.json()[0]["html_url"]
    except httpx.HTTPError:
        raise GitHubError("The server couldn't reach GitHub to open a pull request") from None
    if r.status_code in (401, 403, 404):
        raise GitHubError("The GitHub token can't open pull requests here; it needs Pull requests: read and write")
    try:
        data = r.json()
        msg = "; ".join(e.get("message", "") for e in data.get("errors", []) if e.get("message")) or data.get("message", "")
    except ValueError:
        msg = ""
    raise GitHubError(f"GitHub didn't open the pull request{': ' + msg if msg else ''}")


def _explain_push(repo: GitHubRepo, branch: str, out: str) -> str:
    low = out.lower()
    if "[rejected]" in low or "non-fast-forward" in low or "fetch first" in low:
        return f"Someone changed {branch} on GitHub since Baton last pushed it, and Baton won't overwrite their commits"
    if any(s in low for s in ("403", "permission", "denied", "authentication failed", "could not read username",
                              "terminal prompts disabled", "repository not found")):
        return f"The GitHub token can't push to {repo.full_name}; it needs Contents: read and write on that repository"
    if "could not resolve host" in low or "unable to access" in low:
        return "The server couldn't reach GitHub"
    last = _last_line(out)
    return f"Couldn't push to {repo.full_name}: {last[:200]}" if last else f"Couldn't push to {repo.full_name}"


def _git(purpose: str) -> str:
    git = shutil.which("git")
    if not git:
        raise GitHubError(f"git isn't installed on the server, so it can't {purpose}")
    return git


def _env(token: str | None) -> dict[str, str]:
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never", "GIT_LFS_SKIP_SMUDGE": "1"}
    if token:
        # Through the environment rather than argv, so the token never shows up in a process list.
        auth = base64.b64encode(f"x-access-token:{token}".encode()).decode()
        env.update({"GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "http.https://github.com/.extraheader",
                    "GIT_CONFIG_VALUE_0": f"Authorization: Basic {auth}"})
    return env


def _last_line(out: str) -> str:
    return next((l.strip() for l in reversed(out.splitlines()) if l.strip()), "")


async def _run(argv: list[str], env: dict[str, str], timeout: float, cwd: Path | None = None,
               doing: str = "Cloning") -> tuple[int, str]:
    proc = await asyncio.create_subprocess_exec(
        *argv, env=env, cwd=cwd, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT, start_new_session=not WINDOWS,
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        _kill(proc)
        await proc.wait()
        if doing != "Cloning":
            raise GitHubError(f"{doing} took longer than {int(timeout)}s") from None
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

