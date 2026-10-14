"""Prepare or explicitly publish an owned draft using immutable, CI-tested bytes.

No rebuild, force-update, asset replacement, deletion, or published-release edit.
The workflow serializes callers; API creation conflicts are also reconciled so a
lost acknowledgement can be retried without changing an existing object.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile

try:
    from scripts.release_receipt import release_metadata, verify_bundle
except ModuleNotFoundError:
    from release_receipt import release_metadata, verify_bundle

MAX_ARCHIVE = 768 * 1024 * 1024


class APIError(RuntimeError):
    def __init__(self, status, method, path):
        self.status = status
        super().__init__(f"GitHub {method} {path} failed (HTTP {status}); no absence was inferred.")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class GitHub:
    def __init__(self, token):
        self.token = token
        self.opener = urllib.request.build_opener(NoRedirect())

    def _request(self, method, path, *, data=None, binary=False, upload=False):
        host = "https://uploads.github.com" if upload else "https://api.github.com"
        headers = {"Authorization": "Bearer " + self.token, "X-GitHub-Api-Version": "2022-11-28",
                   "Accept": "application/octet-stream" if binary else "application/vnd.github+json"}
        if data is not None:
            if isinstance(data, bytes):
                headers["Content-Type"] = "application/octet-stream"
            else:
                data = json.dumps(data).encode()
                headers["Content-Type"] = "application/json"
        request = urllib.request.Request(host + path, data=data, headers=headers, method=method)
        try:
            response = self.opener.open(request, timeout=120)
        except urllib.error.HTTPError as exc:
            if binary and exc.code in {301, 302, 303, 307, 308}:
                # Signed storage URLs do not receive the GitHub credential.
                location = exc.headers.get("Location", "")
                if urllib.parse.urlparse(location).scheme != "https":
                    raise ValueError("Artifact downloads must redirect to HTTPS.") from exc
                response = urllib.request.urlopen(location, timeout=120)
            else:
                raise APIError(exc.code, method, path) from exc
        with response:
            payload = response.read(MAX_ARCHIVE + 1)
        if len(payload) > MAX_ARCHIVE:
            raise ValueError("GitHub response exceeds the release size limit.")
        return payload if binary else json.loads(payload)

    def request(self, method, path, data=None):
        return self._request(method, path, data=data)

    def download(self, path):
        return self._request("GET", path, binary=True)

    def upload(self, path, data):
        return self._request("POST", path, data=data, upload=True)


def optional(api, path):
    try:
        return api.request("GET", path)
    except APIError as exc:
        if exc.status == 404:
            return None
        raise


def paginated(api, path, key=None):
    items = []
    for page in range(1, 101):
        result = api.request("GET", f"{path}?per_page=100&page={page}")
        rows = result[key] if key else result
        if not isinstance(rows, list):
            raise ValueError("Invalid GitHub paginated response.")
        items.extend(rows)
        if len(rows) < 100:
            return items
    raise ValueError("GitHub pagination limit exceeded; refusing an incomplete inventory.")


def _tag(api, base, tag):
    ref = optional(api, base + "/git/ref/tags/" + tag)
    if ref is None:
        return None
    obj = ref["object"]
    for _ in range(5):
        if obj.get("type") == "commit":
            return obj["sha"]
        if obj.get("type") != "tag":
            break
        obj = api.request("GET", base + "/git/tags/" + obj["sha"])["object"]
    raise ValueError("Release tag must resolve to one commit.")


def _release(api, base, tag):
    matches = [item for item in paginated(api, base + "/releases") if item.get("tag_name") == tag]
    if len(matches) > 1:
        raise ValueError("Multiple releases claim this tag; refusing to choose one.")
    return matches[0] if matches else None


def _owned(release, expected):
    if not release.get("draft"):
        raise ValueError("Published releases are immutable here; use a new patch version.")
    if any(release.get(key) != value for key, value in expected.items()):
        raise ValueError("Existing draft is unrelated or its ownership receipt changed.")


def _assets(api, base, release_id, files):
    items = paginated(api, f"{base}/releases/{release_id}/assets")
    found = {}
    for item in items:
        name = item.get("name")
        if name not in files or name in found:
            raise ValueError("Existing draft contains unknown or duplicate assets; nothing was replaced.")
        data = files[name]
        sha = hashlib.sha256(data).hexdigest()
        if item.get("state") != "uploaded" or item.get("size") != len(data):
            raise ValueError(f"Existing asset is incomplete or mismatched: {name}. Inspect this draft asset manually; automatic replacement is forbidden.")
        digest = item.get("digest")
        if digest is None:
            digest = "sha256:" + hashlib.sha256(api.download(f"{base}/releases/assets/{item['id']}")).hexdigest()
        if digest != "sha256:" + sha:
            raise ValueError(f"Existing asset hash mismatches: {name}; nothing was replaced.")
        found[name] = item
    return found


def _extract(data, directory):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        members = archive.infolist()
        if len(members) != 4 or len({item.filename for item in members}) != 4:
            raise ValueError("Tested artifact must contain exactly four distinct files.")
        if sum(item.file_size for item in members) > MAX_ARCHIVE:
            raise ValueError("Tested artifact exceeds its expanded size limit.")
        for item in members:
            if (item.is_dir() or not re.fullmatch(r"[A-Za-z0-9_.-]+", item.filename)
                    or ((item.external_attr >> 16) & 0o170000) == 0o120000):
                raise ValueError("Tested artifact contains an unsafe member.")
            (directory / item.filename).write_bytes(archive.read(item))


def prepare_release(api, root, repository, commit, checks_run, *, publish=False):
    root = Path(root).resolve()
    if not re.fullmatch(r"[a-f0-9]{40}", commit) or not re.fullmatch(r"[1-9]\d*", str(checks_run)):
        raise ValueError("A full commit SHA and positive checks run ID are required.")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("Invalid repository name.")
    def git(*args):
        return subprocess.check_output(["git", "-c", f"safe.directory={root.as_posix()}", "-C", str(root), *args]).decode().strip()
    if git("rev-parse", "HEAD") != commit or git("status", "--porcelain", "--untracked-files=normal"):
        raise ValueError("Check out the exact clean tested commit before preparing a release.")
    metadata = release_metadata(root)
    base = "/repos/" + repository
    run = api.request("GET", f"{base}/actions/runs/{checks_run}")
    if (str(run.get("id")) != str(checks_run) or run.get("head_sha") != commit
            or run.get("status") != "completed" or run.get("conclusion") != "success"
            or run.get("path") != ".github/workflows/checks.yml"
            or run.get("head_repository", {}).get("full_name") != repository
            or run.get("repository", {}).get("full_name") != repository
            or run.get("event") not in {"push", "workflow_dispatch"}
            or not isinstance(run.get("run_attempt"), int) or run["run_attempt"] < 1):
        raise ValueError("Successful push/dispatch checks must certify this exact repository commit.")
    attempt = str(run["run_attempt"])
    artifacts = paginated(api, f"{base}/actions/runs/{checks_run}/artifacts", "artifacts")
    name = f"PlanBranch-tested-release-{checks_run}-{attempt}"
    matches = [item for item in artifacts if item.get("name") == name]
    if len(matches) != 1:
        raise ValueError("Checks did not produce exactly one immutable tested release bundle.")
    artifact = matches[0]
    if (artifact.get("expired") is not False or artifact.get("workflow_run", {}).get("head_sha") != commit
            or str(artifact.get("workflow_run", {}).get("id")) != str(checks_run)
            or not re.fullmatch(r"sha256:[a-f0-9]{64}", artifact.get("digest", ""))):
        raise ValueError("Immutable artifact metadata does not match the checks receipt.")
    archive = api.download(f"{base}/actions/artifacts/{artifact['id']}/zip")
    if "sha256:" + hashlib.sha256(archive).hexdigest() != artifact["digest"]:
        raise ValueError("Downloaded tested artifact digest mismatches GitHub's immutable artifact.")
    with tempfile.TemporaryDirectory(prefix="planbranch-release-") as temporary:
        directory = Path(temporary)
        _extract(archive, directory)
        manifest = verify_bundle(directory, commit=commit, checks_run=checks_run, attempt=attempt,
                                 repository=repository, tested=True)
        if (manifest["version"] != metadata["version"] or manifest.get("releaseNotes") !=
                {"path": metadata["notes"], "sha256": metadata["notesSha256"]}):
            raise ValueError("Tested artifacts and versioned source release notes disagree.")
        candidate = [item for item in artifacts if str(item.get("id")) == manifest["candidateArtifactId"]]
        if (len(candidate) != 1 or candidate[0].get("expired") is not False
                or candidate[0].get("name") != f"PlanBranch-candidate-{checks_run}-{attempt}"
                or candidate[0].get("workflow_run", {}).get("head_sha") != commit
                or str(candidate[0].get("workflow_run", {}).get("id")) != str(checks_run)):
            raise ValueError("Tested receipt does not refer to this run's immutable build candidate.")
        candidate = candidate[0]
        candidate_archive = api.download(f"{base}/actions/artifacts/{candidate['id']}/zip")
        if (not re.fullmatch(r"sha256:[a-f0-9]{64}", candidate.get("digest", ""))
                or candidate["digest"] != "sha256:" + hashlib.sha256(candidate_archive).hexdigest()):
            raise ValueError("Immutable build candidate digest mismatches.")
        with tempfile.TemporaryDirectory(prefix="planbranch-candidate-") as candidate_directory:
            _extract(candidate_archive, Path(candidate_directory))
            built = verify_bundle(candidate_directory, commit=commit, checks_run=checks_run, attempt=attempt, repository=repository)
            if (built["stage"] != "built" or any(built.get(key) != manifest.get(key)
                    for key in ("version", "artifacts", "releaseNotes"))):
                raise ValueError("Sealed release bytes differ from the immutable tested build candidate.")
            for name in [item["name"] for item in manifest["artifacts"]] + ["SHA256SUMS.txt"]:
                if (Path(candidate_directory) / name).read_bytes() != (directory / name).read_bytes():
                    raise ValueError("Sealing must preserve exact candidate asset bytes.")
        files = {path.name: path.read_bytes() for path in sorted(directory.iterdir())}
    notes_data = (root / metadata["notes"]).read_bytes()
    if (hashlib.sha256(notes_data).hexdigest() != metadata["notesSha256"] or git("rev-parse", "HEAD") != commit
            or git("status", "--porcelain", "--untracked-files=normal")):
        raise ValueError("Source or release notes changed during preparation.")
    notes = notes_data.decode("utf-8")
    owner = {"schemaVersion": 1, "repository": repository, "commit": commit, "version": metadata["version"],
             "checksRun": str(checks_run), "runAttempt": attempt, "candidateArtifactId": manifest["candidateArtifactId"],
             "testedArtifactId": str(artifact["id"]), "testedArtifactDigest": artifact["digest"],
             "receiptSha256": hashlib.sha256(files["release-manifest.json"]).hexdigest()}
    expected = {"tag_name": "v" + metadata["version"], "target_commitish": commit, "prerelease": False,
                "name": "PlanBranch " + metadata["version"], "body": notes.rstrip() +
                "\n\n<!-- PlanBranch release ownership " + json.dumps(owner, sort_keys=True, separators=(",", ":")) + " -->"}
    tag = expected["tag_name"]
    release = _release(api, base, tag)
    if release is not None:
        _owned(release, expected)
        _assets(api, base, release["id"], files)
    tagged = _tag(api, base, tag)
    if tagged is not None and tagged != commit:
        raise ValueError("Existing tag points at a different commit; it was not changed.")
    if release is None:
        try:
            release = api.request("POST", base + "/releases", {**expected, "draft": True})
        except APIError as exc:
            if exc.status not in {409, 422}:
                raise
            release = _release(api, base, tag)
            if release is None:
                raise
        _owned(release, expected)
    if tagged is None:
        try:
            api.request("POST", base + "/git/refs", {"ref": "refs/tags/" + tag, "sha": commit})
        except APIError as exc:
            if exc.status not in {409, 422} or _tag(api, base, tag) != commit:
                raise
    for name, data in files.items():
        release = api.request("GET", f"{base}/releases/{release['id']}")
        _owned(release, expected)
        if _tag(api, base, tag) != commit:
            raise ValueError("Release tag changed during preparation.")
        if name in _assets(api, base, release["id"], files):
            continue
        try:
            api.upload(f"{base}/releases/{release['id']}/assets?name={urllib.parse.quote(name, safe='')}", data)
        except APIError as exc:
            if exc.status not in {409, 422} or name not in _assets(api, base, release["id"], files):
                raise
    release = api.request("GET", f"{base}/releases/{release['id']}")
    _owned(release, expected)
    if _tag(api, base, tag) != commit or set(_assets(api, base, release["id"], files)) != set(files):
        raise ValueError("Release changed before final verification; it remains a draft.")
    if publish:
        release = api.request("PATCH", f"{base}/releases/{release['id']}", {"draft": False})
        if release.get("draft") is not False:
            raise ValueError("GitHub did not confirm publication.")
    return {"tag": tag, "commit": commit, "checksRun": str(checks_run), "draft": release["draft"],
            "releaseId": release["id"], "assets": list(files), "url": release.get("html_url")}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--checks-run", required=True)
    parser.add_argument("--publish", action="store_true", help="Explicitly promote the fully reconciled owned draft")
    args = parser.parse_args()
    token = os.environ.get("GH_TOKEN")
    if not token:
        parser.error("GH_TOKEN is required")
    result = prepare_release(GitHub(token), Path(__file__).resolve().parents[1], args.repository,
                             args.commit, args.checks_run, publish=args.publish)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
