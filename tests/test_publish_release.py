"""Release state-machine tests use a local fake API; no GitHub mutations."""
from concurrent.futures import ThreadPoolExecutor
import copy
import hashlib
import io
import json
from pathlib import Path
import subprocess
import threading
import urllib.error
from urllib.parse import parse_qs, urlsplit
import zipfile

import pytest

from scripts.publish_release import APIError, GitHub, optional, prepare_release
from scripts.release_receipt import GATES


def sha(data):
    return hashlib.sha256(data).hexdigest()


def archive(files):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as zipped:
        for name, data in files.items():
            zipped.writestr(name, data)
    return stream.getvalue()


class FakeGitHub:
    def __init__(self, commit, files, candidate):
        self.lock = threading.RLock()
        self.commit = commit
        self.run = {"id": 123, "run_attempt": 1, "head_sha": commit, "status": "completed", "conclusion": "success",
                    "path": ".github/workflows/checks.yml", "head_repository": {"full_name": "owner/repo"},
                    "repository": {"full_name": "owner/repo"}, "event": "push"}
        self.archives = {10: archive(candidate), 11: archive(files)}
        self.artifacts = [{"id": id_, "name": f"PlanBranch-{label}-123-1", "expired": False,
                           "digest": "sha256:" + sha(self.archives[id_]),
                           "workflow_run": {"id": 123, "head_sha": commit}}
                          for id_, label in [(10, "candidate"), (11, "tested-release")]]
        self.tag = None
        self.release = None
        self.assets = {}
        self.payloads = {}
        self.calls = []
        self.fail = None
        self.lose_upload_ack = False
        self.lose_create_ack = False
        self.conflicts = set()

    def request(self, method, path, data=None):
        with self.lock:
            self.calls.append((method, path, data))
            parsed = urlsplit(path)
            route = parsed.path.removeprefix("/repos/owner/repo")
            if self.fail and (method, route) == self.fail[:2]:
                if self.fail[2] is None:
                    raise ConnectionError("Simulated transport failure")
                raise APIError(self.fail[2], method, path)
            if route == "/actions/runs/123":
                return copy.deepcopy(self.run)
            if route == "/actions/runs/123/artifacts":
                return {"artifacts": copy.deepcopy(self.artifacts)}
            if route.startswith("/git/ref/tags/"):
                if self.tag is None:
                    raise APIError(404, method, path)
                return {"object": {"type": "commit", "sha": self.tag}}
            if route == "/git/refs" and method == "POST":
                if self.tag is not None:
                    raise APIError(422, method, path)
                self.tag = data["sha"]
                if "tag" in self.conflicts:
                    raise APIError(422, method, path)
                return {"object": {"type": "commit", "sha": self.tag}}
            if route == "/releases" and method == "GET":
                return [copy.deepcopy(self.release)] if self.release else []
            if route == "/releases" and method == "POST":
                if self.release is not None:
                    raise APIError(422, method, path)
                self.release = {**data, "id": 20, "html_url": "https://example.invalid/release"}
                if self.lose_create_ack:
                    self.lose_create_ack = False
                    raise ConnectionError("Release created but acknowledgement lost")
                if "release" in self.conflicts:
                    raise APIError(422, method, path)
                return copy.deepcopy(self.release)
            if route == "/releases/20":
                if method == "PATCH":
                    self.release.update(data)
                return copy.deepcopy(self.release)
            if route == "/releases/20/assets":
                return copy.deepcopy(list(self.assets.values()))
            raise AssertionError((method, path, data))

    def download(self, path, *, accept):
        with self.lock:
            self.calls.append(("DOWNLOAD", path, None))
            if "/actions/artifacts/" in path:
                assert accept == "application/vnd.github+json"
                return self.archives[int(path.split("/")[-2])]
            assert accept == "application/octet-stream"
            return self.payloads[int(path.split("/")[-1])]

    def upload(self, path, data):
        with self.lock:
            self.calls.append(("UPLOAD", path, None))
            name = parse_qs(urlsplit(path).query)["name"][0]
            if name in self.assets:
                raise APIError(422, "POST", path)
            id_ = len(self.assets) + 100
            self.assets[name] = {"id": id_, "name": name, "state": "uploaded", "size": len(data), "digest": "sha256:" + sha(data)}
            self.payloads[id_] = data
            if self.lose_upload_ack:
                self.lose_upload_ack = False
                raise ConnectionError("Asset uploaded but acknowledgement lost")
            if "asset" in self.conflicts:
                raise APIError(422, "POST", path)
            return copy.deepcopy(self.assets[name])


def fixture(tmp_path, version="0.3.1"):
    root = tmp_path / "source"
    root.mkdir()
    notes = f"# PlanBranch {version} — fixture\n\nPatch notes for these exact bytes.\n".encode()
    for name, data in {"pyproject.toml": f'[project]\nversion = "{version}"\n'.encode(),
                       "flowdesk/__init__.py": f'__version__ = "{version}"\n'.encode(),
                       f"docs/Release_{version}.md": notes}.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    for args in (["init"], ["-c", "core.autocrlf=false", "add", "."],
                 ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "Fixture"]):
        subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True)
    commit = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"]).decode().strip()
    files = {f"flowdesk-{version}-py3-none-any.whl": b"exact CI-tested wheel bytes", f"PlanBranch-{version}-windows-x64.zip": b"exact CI-tested portable bytes"}
    manifest = {"schemaVersion": 2, "version": version, "commit": commit, "checksRun": "123", "runAttempt": "1",
                "repository": "owner/repo", "stage": "built", "gates": [],
                "releaseNotes": {"path": f"docs/Release_{version}.md", "sha256": sha(notes)},
                "artifacts": [{"name": name, "sha256": sha(data), "bytes": len(data)} for name, data in files.items()]}
    files["SHA256SUMS.txt"] = "".join(f"{item['sha256']}  {item['name']}\n" for item in manifest["artifacts"]).encode()
    files["release-manifest.json"] = json.dumps(manifest).encode()
    candidate = copy.deepcopy(files)
    manifest.update(stage="tested", gates=GATES, candidateArtifactId="10")
    files["release-manifest.json"] = json.dumps(manifest).encode()
    api = FakeGitHub(commit, files, candidate)
    return root, api, files


@pytest.fixture
def release(tmp_path):
    return fixture(tmp_path)


def prepare(release, **kwargs):
    root, api, _ = release
    return prepare_release(api, root, "owner/repo", api.commit, "123", **kwargs)


def writes(api):
    return [call for call in api.calls if call[0] in {"POST", "PATCH", "UPLOAD", "DELETE", "PUT"}]


@pytest.mark.parametrize("version", ["0.3.0", "0.3.1", "12.34.56"])
def test_first_preparation_uses_versioned_immutable_tested_assets(tmp_path, version):
    release = fixture(tmp_path, version)
    root, api, files = release
    result = prepare(release)
    assert result["tag"] == f"v{version}" and result["draft"] is True
    assert api.tag == api.commit and api.release["draft"] is True
    assert {name: api.payloads[item["id"]] for name, item in api.assets.items()} == files
    assert f"# PlanBranch {version}" in api.release["body"]
    assert "PlanBranch release ownership" in api.release["body"]
    assert not any(call[0] in {"PATCH", "PUT", "DELETE"} for call in api.calls)
    mutations = writes(api)
    assert mutations[0][1] == "/repos/owner/repo/releases" and mutations[0][2]["draft"] is True
    assert mutations[1][1] == "/repos/owner/repo/git/refs"


def test_matching_retry_is_read_only_and_explicit_promotion_changes_only_draft(release):
    first = prepare(release)
    api = release[1]
    api.calls.clear()
    assert prepare(release) == first and not writes(api)
    result = prepare(release, publish=True)
    assert result["draft"] is False
    assert writes(api) == [("PATCH", "/repos/owner/repo/releases/20", {"draft": False})]
    api.calls.clear()
    with pytest.raises(ValueError, match="Published"):
        prepare(release, publish=True)
    assert not writes(api)


@pytest.mark.parametrize("lost_ack", ["lose_create_ack", "lose_upload_ack"])
def test_lost_acknowledgement_and_partial_upload_resume_without_replacement(release, lost_ack):
    api = release[1]
    setattr(api, lost_ack, True)
    with pytest.raises(ConnectionError):
        prepare(release)
    previous = copy.deepcopy(api.assets)
    assert api.release["draft"] is True
    api.calls.clear()
    prepare(release)
    assert len(api.assets) == 4
    assert all(api.assets[name] == item for name, item in previous.items())
    assert len([call for call in writes(api) if call[0] == "UPLOAD"]) == 4 - len(previous)
    assert not any(call[0] in {"PATCH", "DELETE", "PUT"} for call in writes(api))
    assert all(call[1].endswith("/git/refs") for call in writes(api) if call[0] == "POST")


def test_matching_existing_tag_is_reused_but_different_tag_is_never_changed(release):
    api = release[1]
    api.tag = "f" * 40
    with pytest.raises(ValueError, match="different commit"):
        prepare(release)
    assert not writes(api) and api.tag == "f" * 40
    api.tag = api.commit
    prepare(release)
    assert not any(call[1].endswith("/git/refs") for call in writes(api))


@pytest.mark.parametrize("change", ["hash", "size", "partial", "extra", "ownership", "public"])
def test_existing_mismatch_or_unrelated_draft_is_preserved(release, change):
    api = release[1]
    prepare(release)
    first = next(iter(api.assets.values()))
    if change == "hash":
        first["digest"] = "sha256:" + "f" * 64
    elif change == "size":
        first["size"] += 1
    elif change == "partial":
        first["state"] = "starter"
    elif change == "extra":
        api.assets["foreign"] = {"name": "foreign"}
    elif change == "ownership":
        api.release["body"] = "Someone else's draft"
    else:
        api.release["draft"] = False
    saved = copy.deepcopy((api.release, api.assets, api.tag))
    api.calls.clear()
    with pytest.raises(ValueError):
        prepare(release, publish=True)
    assert not writes(api) and (api.release, api.assets, api.tag) == saved


def test_assets_without_api_digest_are_downloaded_and_hashed(release):
    api = release[1]
    prepare(release)
    first = next(iter(api.assets.values()))
    del first["digest"]
    api.calls.clear()
    prepare(release)
    assert any(call[0] == "DOWNLOAD" and "/releases/assets/" in call[1] for call in api.calls)
    api.payloads[first["id"]] = b"mismatching bytes"
    with pytest.raises(ValueError, match="hash mismatches"):
        prepare(release)


@pytest.mark.parametrize("status", [401, 403, 429, 500, None])
def test_only_true_404_is_absence_and_transport_or_api_failures_never_write(release, status):
    api = release[1]
    api.fail = ("GET", "/git/ref/tags/v0.3.1", status)
    with pytest.raises(ConnectionError if status is None else APIError):
        prepare(release)
    assert not writes(api) and api.release is None and api.tag is None


def test_creation_conflicts_reconcile_only_exact_matching_objects(release):
    api = release[1]
    api.conflicts = {"tag", "release", "asset"}
    assert prepare(release)["draft"] is True
    assert len(api.assets) == 4


def test_concurrent_matching_attempts_converge_without_clobber(release):
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda _: prepare(release), range(2)))
    assert results[0] == results[1]
    api = release[1]
    assert len(api.assets) == 4 and len(set(api.payloads)) == 4
    assert not any(call[0] in {"PUT", "PATCH", "DELETE"} for call in api.calls)


@pytest.mark.parametrize("key,value", [("head_sha", "f" * 40), ("event", "pull_request"), ("conclusion", "failure"),
                                      ("status", "in_progress"), ("path", ".github/workflows/other.yml"),
                                      ("head_repository", {"full_name": "other/repo"}), ("run_attempt", 2)])
def test_checks_must_succeed_for_exact_repository_commit_and_attempt(release, key, value):
    api = release[1]
    api.run[key] = value
    with pytest.raises(ValueError):
        prepare(release)
    assert not writes(api)


def test_dispatch_checks_are_accepted(release):
    release[1].run["event"] = "workflow_dispatch"
    assert prepare(release)["draft"] is True


@pytest.mark.parametrize("change", ["archive_digest", "expired", "wrong_commit", "unsealed", "bytes", "notes", "extra_file", "traversal", "candidate", "rebuild_and_reseal"])
def test_artifact_receipts_refuse_changed_or_unproven_bytes(release, change):
    _, api, files = release
    if change == "archive_digest":
        api.archives[11] += b"corrupt"
    elif change == "expired":
        api.artifacts[1]["expired"] = True
    elif change == "wrong_commit":
        api.artifacts[1]["workflow_run"]["head_sha"] = "f" * 40
    elif change == "candidate":
        api.artifacts[0]["name"] = "other-run-candidate"
    else:
        manifest = json.loads(files["release-manifest.json"])
        if change == "unsealed":
            manifest["stage"] = "built"
        elif change == "notes":
            manifest["releaseNotes"]["path"] = "docs/Release_0.3.0.md"
        elif change == "bytes":
            files[next(iter(files))] = b"rebuilt bytes after original CI"
        elif change == "rebuild_and_reseal":
            # Internally consistent new hashes still do not certify the bytes
            # consumed by the original OS test jobs.
            asset = manifest["artifacts"][0]
            files[asset["name"]] = b"different rebuilt candidate"
            asset.update(sha256=sha(files[asset["name"]]), bytes=len(files[asset["name"]]))
            files["SHA256SUMS.txt"] = "".join(f"{item['sha256']}  {item['name']}\n" for item in manifest["artifacts"]).encode()
        elif change == "extra_file":
            files["extra"] = b"extra"
        elif change == "traversal":
            files["../escape"] = files.pop("SHA256SUMS.txt")
        files["release-manifest.json"] = json.dumps(manifest).encode()
        api.archives[11] = archive(files)
        api.artifacts[1]["digest"] = "sha256:" + sha(api.archives[11])
    with pytest.raises(ValueError):
        prepare(release)
    assert not writes(api)


def test_workflow_tests_one_immutable_candidate_and_seals_after_all_gates():
    root = Path(__file__).resolve().parents[1]
    checks = (root / ".github/workflows/checks.yml").read_text(encoding="utf-8-sig")
    release = (root / ".github/workflows/release.yml").read_text(encoding="utf-8-sig")
    assert checks.count("run: python scripts/build_release.py") == 1
    assert checks.count("run: python scripts/build_windows_portable.py") == 1
    assert "needs: [build, test, docker]" in checks
    assert checks.count("artifact-ids: ${{ needs.build.outputs.candidate }}") == 2
    assert '"output/release-candidate/$WHEEL"' in checks and '"output/release-candidate/$PORTABLE"' in checks
    assert 'PLANBRANCH_TEST_DOCKER: "1"' in checks and "test_immutable_verification_live.py" in checks
    assert "'skipped', 'failures', 'errors'" in checks
    assert "build_release.py" not in release and "build_windows_portable.py" not in release
    assert "publish_release.py" in release and "cancel-in-progress: false" in release
    assert "default: false" in release and "0.3.0" not in checks + release


@pytest.mark.parametrize("status", [404, 401, 403, 429, 500])
def test_http_adapter_distinguishes_404_from_other_failures(status):
    api = GitHub("sentinel-credential")
    class Opener:
        def open(self, request, timeout):
            assert request.get_header("Authorization") == "Bearer sentinel-credential"
            raise urllib.error.HTTPError(request.full_url, status, "Failure", {}, None)
    api.opener = Opener()
    if status == 404:
        assert optional(api, "/repos/owner/repo/git/ref/tags/v0.3.1") is None
    else:
        with pytest.raises(APIError) as error:
            optional(api, "/repos/owner/repo/git/ref/tags/v0.3.1")
        assert error.value.status == status and "sentinel-credential" not in str(error.value)


def test_preparation_negotiates_actions_archives_and_release_asset_bytes(release, monkeypatch):
    root, state, files = release
    api = GitHub("sentinel-credential")
    downloads = []

    class Opener:
        def open(self, request, timeout):
            parsed = urlsplit(request.full_url)
            path = parsed.path + ("?" + parsed.query if parsed.query else "")
            assert request.get_header("Authorization") == "Bearer sentinel-credential"
            if "/actions/artifacts/" in path:
                downloads.append((path, request.get_header("Accept")))
                if request.get_header("Accept") != "application/vnd.github+json":
                    raise urllib.error.HTTPError(request.full_url, 415, "Unsupported Media Type", {}, None)
                artifact_id = int(parsed.path.split("/")[-2])
                raise urllib.error.HTTPError(request.full_url, 302, "Found",
                                             {"Location": f"https://storage.example.invalid/{artifact_id}"}, None)
            if "/releases/assets/" in path:
                downloads.append((path, request.get_header("Accept")))
                assert request.get_header("Accept") == "application/octet-stream"
                return io.BytesIO(state.payloads[int(parsed.path.split("/")[-1])])
            assert request.get_header("Accept") == "application/vnd.github+json"
            if parsed.netloc == "uploads.github.com":
                result = state.upload(path, request.data)
            else:
                data = json.loads(request.data) if request.data is not None else None
                result = state.request(request.get_method(), path, data)
            return io.BytesIO(json.dumps(result).encode())

    def signed_download(request, *, timeout):
        # A bare signed URL carries none of the original authenticated headers.
        assert isinstance(request, str) and request.startswith("https://storage.example.invalid/")
        assert timeout == 120
        return io.BytesIO(state.archives[int(urlsplit(request).path.removeprefix("/"))])

    api.opener = Opener()
    monkeypatch.setattr("urllib.request.urlopen", signed_download)
    result = prepare_release(api, root, "owner/repo", state.commit, "123")
    assert result["draft"] is True
    assert {name: state.payloads[item["id"]] for name, item in state.assets.items()} == files
    assert downloads == [
        ("/repos/owner/repo/actions/artifacts/11/zip", "application/vnd.github+json"),
        ("/repos/owner/repo/actions/artifacts/10/zip", "application/vnd.github+json"),
    ]

    first = next(iter(state.assets.values()))
    del first["digest"]
    state.calls.clear()
    assert prepare_release(api, root, "owner/repo", state.commit, "123") == result
    assert not writes(state)
    assert (f"/repos/owner/repo/releases/assets/{first['id']}", "application/octet-stream") in downloads


DOWNLOAD_ROUTES = [
    ("/repos/owner/repo/actions/artifacts/11/zip", "application/vnd.github+json"),
    ("/repos/owner/repo/releases/assets/100", "application/octet-stream"),
]


@pytest.mark.parametrize("path,accept", DOWNLOAD_ROUTES)
def test_download_redirect_never_forwards_github_credential(monkeypatch, path, accept):
    api = GitHub("sentinel-credential")
    class Opener:
        def open(self, request, timeout):
            assert request.get_header("Accept") == accept
            assert request.get_header("Authorization") == "Bearer sentinel-credential"
            raise urllib.error.HTTPError(request.full_url, 302, "Found", {"Location": "https://storage.example.invalid/signed"}, None)
    api.opener = Opener()
    calls = []
    def download(request, **kwargs):
        calls.append((request, kwargs))
        return io.BytesIO(b"immutable artifact archive")
    monkeypatch.setattr("urllib.request.urlopen", download)
    assert api.download(path, accept=accept) == b"immutable artifact archive"
    assert calls == [("https://storage.example.invalid/signed", {"timeout": 120})]


@pytest.mark.parametrize("path,accept", DOWNLOAD_ROUTES)
def test_download_refuses_non_https_redirect(monkeypatch, path, accept):
    api = GitHub("sentinel-credential")
    class Opener:
        def open(self, request, timeout):
            raise urllib.error.HTTPError(request.full_url, 302, "Found",
                                         {"Location": "http://storage.example.invalid/signed"}, None)
    api.opener = Opener()
    monkeypatch.setattr("urllib.request.urlopen", lambda *args, **kwargs: pytest.fail("Unsafe redirect was followed"))
    with pytest.raises(ValueError, match="HTTPS"):
        api.download(path, accept=accept)


@pytest.mark.parametrize("path,accept", DOWNLOAD_ROUTES)
@pytest.mark.parametrize("redirect", [False, True])
def test_download_bounds_direct_and_redirected_payloads(monkeypatch, path, accept, redirect):
    api = GitHub("sentinel-credential")
    monkeypatch.setattr("scripts.publish_release.MAX_ARCHIVE", 16)
    class Opener:
        def open(self, request, timeout):
            assert request.get_header("Accept") == accept
            if redirect:
                raise urllib.error.HTTPError(request.full_url, 302, "Found",
                                             {"Location": "https://storage.example.invalid/signed"}, None)
            return io.BytesIO(b"x" * 17)
    api.opener = Opener()
    monkeypatch.setattr("urllib.request.urlopen", lambda *args, **kwargs: io.BytesIO(b"x" * 17))
    with pytest.raises(ValueError, match="size limit"):
        api.download(path, accept=accept)
