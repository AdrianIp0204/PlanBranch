from pathlib import Path
import hashlib
import os
import subprocess
import sys
from uuid import uuid4

import pytest

from flowdesk.execution_git import GitWorkspace, WorkspaceError


def git(root, *args):
    env = {key: value for key, value in os.environ.items() if not key.upper().startswith('GIT_')}
    env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull)
    result = subprocess.run(['git', '-c', f'safe.directory={root}', '-c', 'core.autocrlf=false', '-C', str(root), *args],
        env=env, check=True, capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    return result.stdout.decode().strip()


@pytest.fixture
def fixture(tmp_path):
    source = tmp_path / 'original repo'
    source.mkdir()
    git(source, 'init')
    git(source, 'config', 'user.name', 'PlanBranch fixture')
    git(source, 'config', 'user.email', 'fixture@example.invalid')
    (source / 'main.py').write_text('value = 1\n', encoding='utf-8')
    (source / 'keep.txt').write_text('unrelated baseline\n', encoding='utf-8')
    (source / '.gitignore').write_text('__pycache__/\n', encoding='utf-8')
    git(source, 'add', '.')
    git(source, 'commit', '-m', 'Fixture baseline')
    engine = GitWorkspace(tmp_path / 'data')
    repo = engine.inspect_repository(str(source))
    return source, engine, repo


def workspace(fixture):
    source, engine, repo = fixture
    result = engine.create(repo, repo['head'], str(uuid4()))
    return source, engine, result, Path(result['path'])


def test_detached_workspace_capture_apply_preserves_dirty_checkout_and_index(fixture):
    source, engine, repo = fixture
    (source / 'keep.txt').write_text('unrelated local edit\n', encoding='utf-8')
    git(source, 'add', 'keep.txt')
    index_before = (source / '.git' / 'index').read_bytes()
    result = engine.create(repo, repo['head'], str(uuid4()))
    root = Path(result['path'])
    assert root != source and (root / 'keep.txt').read_text() == 'unrelated baseline\n'
    (root / 'main.py').write_text('value = 2\n', encoding='utf-8')
    (root / 'new.py').write_text('print(value)\n', encoding='utf-8')
    (root / '__pycache__').mkdir()
    (root / '__pycache__' / 'ignored.pyc').write_bytes(b'generated')
    review = engine.capture(result)
    assert {f['path'] for f in review['files']} == {'main.py', 'new.py'}
    assert '+value = 2' in next(f['patch'] for f in review['files'] if f['path'] == 'main.py')
    assert (source / 'main.py').read_text() == 'value = 1\n'
    assert engine.load(result['id']) == result
    assert engine.artifact(result['id'], review['digest']) == review
    assert engine.apply(result, review['digest'])['applied']
    assert (source / 'main.py').read_text() == 'value = 2\n'
    assert (source / 'keep.txt').read_text() == 'unrelated local edit\n'
    assert (source / '.git' / 'index').read_bytes() == index_before
    assert engine.inspect_apply(result, review['digest'])['state'] == 'applied'
    # Retrying a known committed application must not overwrite a subsequent edit.
    (source / 'main.py').write_text('later user edit\n', encoding='utf-8')
    assert engine.apply(result, review['digest'])['replayed']
    assert (source / 'main.py').read_text() == 'later user edit\n'


@pytest.mark.parametrize('conflict', ['working', 'staged', 'new-file', 'head'])
def test_conflicts_do_not_partially_overwrite_checkout(fixture, conflict):
    source, engine, result, root = workspace(fixture)
    (root / 'main.py').write_text('value = 2\n', encoding='utf-8')
    (root / 'new.py').write_text('new file\n', encoding='utf-8')
    review = engine.capture(result)
    if conflict in {'working', 'staged'}:
        (source / 'main.py').write_text('user draft\n', encoding='utf-8')
        if conflict == 'staged':
            git(source, 'add', 'main.py')
            (source / 'main.py').write_text('value = 1\n', encoding='utf-8')
    elif conflict == 'new-file':
        (source / 'new.py').write_text('user file\n', encoding='utf-8')
    else:
        git(source, 'commit', '--allow-empty', '-m', 'New source revision')
    before = {p.name: p.read_bytes() for p in source.iterdir() if p.is_file()}
    with pytest.raises(WorkspaceError, match='conflict|revision'):
        engine.apply(result, review['digest'])
    assert {p.name: p.read_bytes() for p in source.iterdir() if p.is_file()} == before


def test_capture_includes_staged_binary_and_deleted_files(fixture):
    source, engine, result, root = workspace(fixture)
    (root / 'new.bin').write_bytes(b'\x00binary\xff')
    git(root, 'add', 'new.bin')
    (root / 'keep.txt').unlink()
    review = engine.capture(result)
    assert {(f['path'], f['kind'], f['binary']) for f in review['files']} == {
        ('new.bin', 'added', True), ('keep.txt', 'removed', False)}
    engine.apply(result, review['digest'])
    assert (source / 'new.bin').read_bytes() == b'\x00binary\xff'
    assert not (source / 'keep.txt').exists()


def test_partial_apply_requires_explicit_retry_and_preserves_newer_edits(fixture, monkeypatch):
    import flowdesk.execution_git as module
    source, engine, result, root = workspace(fixture)
    (root / 'main.py').write_text('value = 2\n', encoding='utf-8')
    (root / 'keep.txt').write_text('updated keep\n', encoding='utf-8')
    review = engine.capture(result)
    original = module._atomic_json
    stopped = False
    def interrupt(path, value):
        nonlocal stopped
        original(path, value)
        if value.get('state') == 'applying' and len(value.get('completed', [])) == 1 and not stopped:
            stopped = True
            raise OSError('simulated power loss')
    monkeypatch.setattr(module, '_atomic_json', interrupt)
    with pytest.raises(OSError):
        engine.apply(result, review['digest'])
    restarted = GitWorkspace(engine.root.parent)
    assert restarted.inspect_apply(result, review['digest'])['state'] == 'applying'
    assert (source / 'main.py').read_text() == 'value = 1\n'
    (source / 'main.py').write_text('new user draft\n', encoding='utf-8')
    with pytest.raises(WorkspaceError, match='newer edit'):
        restarted.apply(result, review['digest'])
    assert (source / 'main.py').read_text() == 'new user draft\n'
    (source / 'main.py').write_text('value = 1\n', encoding='utf-8')
    assert restarted.apply(result, review['digest'])['applied']
    assert (source / 'main.py').read_text() == 'value = 2\n'


def test_crlf_checkout_remains_crlf(fixture):
    source, engine, result, root = workspace(fixture)
    (source / 'main.py').write_bytes(b'value = 1\r\n')
    (root / 'main.py').write_bytes(b'value = 2\n')
    review = engine.capture(result)
    engine.apply(result, review['digest'])
    assert (source / 'main.py').read_bytes() == b'value = 2\r\n'


def test_changed_git_pointer_and_corrupt_artifact_are_rejected(fixture):
    source, engine, result, root = workspace(fixture)
    (root / 'main.py').write_text('value = 2\n', encoding='utf-8')
    review = engine.capture(result)
    pointer = (root / '.git').read_bytes()
    (root / '.git').unlink()
    (root / '.git').write_text('gitdir: ../../outside\n', encoding='utf-8')
    with pytest.raises(WorkspaceError, match='pointer'):
        engine.capture(result)
    (root / '.git').write_bytes(pointer)
    artifact = engine.root / result['id'] / 'artifacts' / (review['digest'] + '.json')
    artifact.write_text('{}', encoding='utf-8')
    with pytest.raises(WorkspaceError, match='artifact changed'):
        engine.apply(result, review['digest'])
    assert (source / 'main.py').read_text() == 'value = 1\n'


def test_no_repository_filters_or_hooks_are_executed(fixture):
    source, engine, repo = fixture
    marker = source.parent / 'unsafe-helper-ran'
    helper = source.parent / 'helper.py'
    helper.write_text('from pathlib import Path\nimport sys\nPath('+repr(str(marker))+').write_text("ran")\nsys.stdout.buffer.write(sys.stdin.buffer.read())\n', encoding='utf-8')
    command = '"' + sys.executable.replace('\\', '/') + '" "' + str(helper).replace('\\', '/') + '"'
    git(source, 'config', 'filter.unsafe.smudge', command)
    git(source, 'config', 'filter.unsafe.clean', command)
    (source / '.gitattributes').write_text('*.py filter=unsafe\n', encoding='utf-8')
    git(source, 'add', '.gitattributes')
    git(source, 'commit', '-m', 'Filter configuration fixture')
    hook = source / '.git' / 'hooks' / 'post-checkout'
    hook.write_text('#!/bin/sh\n' + command + '\n', encoding='utf-8')
    hook.chmod(0o755)
    if marker.exists(): marker.unlink()  # Git's fixture commit may have refreshed a filtered file.
    repo = engine.inspect_repository(str(source))
    result = engine.create(repo, repo['head'], str(uuid4()))
    assert not marker.exists()
    assert (Path(result['path']) / 'main.py').read_text() == 'value = 1\n'


def test_unchanged_large_file_is_allowed_but_changed_large_file_is_not(fixture):
    source, engine, repo = fixture
    (source / 'large.bin').write_bytes(b'a' * (3 * 1024 * 1024))
    git(source, 'add', 'large.bin')
    git(source, 'commit', '-m', 'Large unchanged asset')
    repo = engine.inspect_repository(str(source))
    result = engine.create(repo, repo['head'], str(uuid4()))
    assert engine.capture(result)['files'] == []
    (Path(result['path']) / 'large.bin').write_bytes(b'b' * (3 * 1024 * 1024))
    with pytest.raises(WorkspaceError, match='2 MiB'):
        engine.capture(result)


def test_identity_traversal_and_subfolder_selection_are_rejected(fixture):
    source, engine, repo = fixture
    with pytest.raises(WorkspaceError, match='identity'):
        engine.load('../../outside')
    child = source / 'child'
    child.mkdir()
    with pytest.raises(WorkspaceError, match='top-level'):
        engine.inspect_repository(str(child))
    with pytest.raises(WorkspaceError, match='review identity'):
        engine.inspect_apply({'id': str(uuid4())}, '../../outside')

@pytest.mark.parametrize('mode', ['120000', '160000'])
def test_source_links_and_submodules_rejected_without_materialization(fixture, mode):
    source, engine, repo = fixture
    oid = repo['head'] if mode == '160000' else git(source, 'rev-parse', 'HEAD:main.py')
    git(source, 'update-index', '--add', '--cacheinfo', mode, oid, 'linked-entry')
    git(source, 'commit', '-m', 'Unsupported linked tree fixture')
    with pytest.raises(WorkspaceError, match='unsupported tree entry|symbolic links|submodules'):
        engine.inspect_repository(str(source))
    assert list(engine.root.iterdir()) == []


def test_new_parent_directory_conflict_preserves_all_files(fixture):
    source, engine, result, root = workspace(fixture)
    (root / 'new-area').mkdir()
    (root / 'new-area' / 'child.py').write_text('new code\n', encoding='utf-8')
    review = engine.capture(result)
    (source / 'new-area').write_text('user-owned file, not a directory\n', encoding='utf-8')
    with pytest.raises((WorkspaceError, OSError)):
        engine.apply(result, review['digest'])
    assert (source / 'new-area').read_text() == 'user-owned file, not a directory\n'
    assert (source / 'main.py').read_text() == 'value = 1\n'


def _interrupt_after_first_file(engine, result, review, monkeypatch):
    import flowdesk.execution_git as module
    original = module._atomic_json
    def interrupt(path, value):
        original(path, value)
        if value.get('state') == 'applying' and len(value.get('completed', [])) == 1:
            raise OSError('simulated interruption')
    with monkeypatch.context() as patch:
        patch.setattr(module, '_atomic_json', interrupt)
        with pytest.raises(OSError, match='interruption'):
            engine.apply(result, review['digest'])


def test_partial_retry_preserves_user_revert_of_completed_file(fixture, monkeypatch):
    source, engine, result, root = workspace(fixture)
    (root / 'keep.txt').write_text('accepted keep\n', encoding='utf-8')
    (root / 'main.py').write_text('value = 2\n', encoding='utf-8')
    review = engine.capture(result)
    _interrupt_after_first_file(engine, result, review, monkeypatch)
    assert engine.inspect_apply(result, review['digest'])['completed'] == ['keep.txt']
    (source / 'keep.txt').write_text('unrelated baseline\n', encoding='utf-8')
    with pytest.raises(WorkspaceError, match='newer edit'):
        GitWorkspace(engine.root.parent).apply(result, review['digest'])
    assert (source / 'keep.txt').read_text() == 'unrelated baseline\n'
    assert (source / 'main.py').read_text() == 'value = 1\n'


def test_legacy_partial_journal_retains_valid_recovery(fixture, monkeypatch):
    import json
    source, engine, result, root = workspace(fixture)
    (root / 'keep.txt').write_text('accepted keep\n', encoding='utf-8')
    (root / 'main.py').write_text('value = 2\n', encoding='utf-8')
    review = engine.capture(result)
    _interrupt_after_first_file(engine, result, review, monkeypatch)
    path = engine.root / result['id'] / ('apply-' + review['digest'] + '.json')
    journal = json.loads(path.read_text(encoding='utf-8'))
    for item in journal['entries']:
        for key in ('beforeMode', 'afterMode', 'beforePermissions', 'afterPermissions'):
            item.pop(key, None)
    path.write_text(json.dumps(journal), encoding='utf-8')
    assert GitWorkspace(engine.root.parent).apply(result, review['digest'])['applied']
    assert (source / 'keep.txt').read_text() == 'accepted keep\n'
    assert (source / 'main.py').read_text() == 'value = 2\n'


@pytest.mark.skipif(os.name == 'nt', reason='POSIX executable modes are not represented by Windows filesystems')
@pytest.mark.parametrize('when', ['before-apply', 'after-interruption'])
def test_unstaged_executable_mode_change_is_preserved(fixture, monkeypatch, when):
    source, engine, result, root = workspace(fixture)
    (root / 'keep.txt').write_text('accepted keep\n', encoding='utf-8')
    (root / 'main.py').write_text('value = 2\n', encoding='utf-8')
    review = engine.capture(result)
    if when == 'after-interruption':
        _interrupt_after_first_file(engine, result, review, monkeypatch)
    (source / 'main.py').chmod(0o755)
    with pytest.raises(WorkspaceError, match='mode change|newer edit'):
        GitWorkspace(engine.root.parent).apply(result, review['digest'])
    assert (source / 'main.py').stat().st_mode & 0o777 == 0o755
    assert (source / 'main.py').read_text() == 'value = 1\n'


@pytest.mark.skipif(os.name == 'nt', reason='POSIX permissions are not represented by Windows filesystems')
def test_apply_preserves_local_read_write_permissions_and_reviews_executable_change(fixture):
    source, engine, result, root = workspace(fixture)
    (source / 'main.py').chmod(0o640)
    (root / 'main.py').write_text('value = 2\n', encoding='utf-8')
    (root / 'main.py').chmod(0o755)
    review = engine.capture(result)
    assert engine.apply(result, review['digest'])['applied']
    assert (source / 'main.py').read_text() == 'value = 2\n'
    assert (source / 'main.py').stat().st_mode & 0o777 == 0o750


@pytest.mark.skipif(os.name == 'nt', reason='POSIX permissions are not represented by Windows filesystems')
def test_content_only_apply_preserves_local_group_and_other_executable_permissions(fixture):
    source, engine, result, root = workspace(fixture)
    (source / 'main.py').chmod(0o641)
    (root / 'main.py').write_text('value = 2\n', encoding='utf-8')
    review = engine.capture(result)
    file = next(item for item in review['files'] if item['path'] == 'main.py')
    assert file['oldMode'] == file['newMode'] == '100644'
    assert engine.apply(result, review['digest'])['applied']
    assert (source / 'main.py').read_text() == 'value = 2\n'
    assert (source / 'main.py').stat().st_mode & 0o777 == 0o641


@pytest.mark.skipif(os.name == 'nt', reason='POSIX permissions are not represented by Windows filesystems')
@pytest.mark.parametrize('permissions', [0o4644, 0o2644, 0o1644])
def test_apply_rejects_special_permissions_before_changing_checkout(fixture, permissions):
    source, engine, result, root = workspace(fixture)
    (source / 'main.py').chmod(permissions)
    (root / 'keep.txt').write_text('accepted keep\n', encoding='utf-8')
    (root / 'main.py').write_text('value = 2\n', encoding='utf-8')
    review = engine.capture(result)
    with pytest.raises(WorkspaceError, match='Special file permissions'):
        engine.apply(result, review['digest'])
    assert (source / 'main.py').read_text() == 'value = 1\n'
    assert (source / 'main.py').stat().st_mode & 0o7777 == permissions
    assert (source / 'keep.txt').read_text() == 'unrelated baseline\n'
    assert engine.inspect_apply(result, review['digest']) is None


def test_apply_rechecks_checkout_after_preparing_replacement(fixture, monkeypatch):
    import flowdesk.execution_git as module
    source, engine, result, root = workspace(fixture)
    (root / 'main.py').write_text('value = 2\n', encoding='utf-8')
    review = engine.capture(result)
    original = module.os.fsync
    changed = False
    def edit_during_fsync(fd):
        nonlocal changed
        if not changed and list(source.glob('.planbranch-*.tmp')):
            changed = True
            (source / 'main.py').write_text('new user edit\n', encoding='utf-8')
        return original(fd)
    monkeypatch.setattr(module.os, 'fsync', edit_during_fsync)
    with pytest.raises(WorkspaceError, match='changed while preparing'):
        engine.apply(result, review['digest'])
    assert changed
    assert (source / 'main.py').read_text() == 'new user edit\n'
    assert engine.inspect_apply(result, review['digest'])['state'] == 'applying'
    assert list(source.glob('.planbranch-*.tmp')) == []


def test_resume_after_file_write_before_journal_ack_does_not_rewrite_result(fixture, monkeypatch):
    import flowdesk.execution_git as module
    source, engine, result, root = workspace(fixture)
    (root / 'main.py').write_text('value = 2\n', encoding='utf-8')
    review = engine.capture(result)
    original = module._atomic_json
    def interrupt(path, value):
        if value.get('state') == 'applying' and value.get('completed') == ['main.py']:
            raise OSError('lost file acknowledgement')
        return original(path, value)
    with monkeypatch.context() as patch:
        patch.setattr(module, '_atomic_json', interrupt)
        with pytest.raises(OSError, match='lost file acknowledgement'):
            engine.apply(result, review['digest'])
    assert (source / 'main.py').read_text() == 'value = 2\n'
    assert engine.inspect_apply(result, review['digest'])['completed'] == []
    modified_at = (source / 'main.py').stat().st_mtime_ns
    assert GitWorkspace(engine.root.parent).apply(result, review['digest'])['applied']
    assert (source / 'main.py').stat().st_mtime_ns == modified_at


def test_repository_identity_does_not_inspect_checkout_contents(fixture, monkeypatch):
    source, engine, repo = fixture
    def forbidden(*args):
        raise AssertionError('Live identity polling must not read the checkout')
    monkeypatch.setattr(engine, '_dirty', forbidden)
    identity = engine.repository_identity(str(source))
    assert {key: identity[key] for key in ('path', 'gitDir', 'commonDir', 'head')} == {
        key: repo[key] for key in ('path', 'gitDir', 'commonDir', 'head')}
    assert identity['dirty'] is None


def recovery_record():
    import base64
    before = base64.b64encode(b'old\n').decode()
    after = base64.b64encode(b'new\n').decode()
    artifact = {'files': [{'path': 'main.py', 'before': before, 'after': after, 'oldMode': '100644', 'newMode': '100644'}]}
    journal = {'digest': 'accepted', 'state': 'applying', 'fileCount': 1, 'completed': [], 'entries': [
        {'path': 'main.py', 'before': before, 'after': after, 'mode': '100644'}]}
    return journal, artifact


def test_recovery_record_preserves_unreviewed_executable_permissions():
    from flowdesk.execution_git import _validate_apply_journal
    journal, artifact = recovery_record()
    item = journal['entries'][0]
    item.update(beforePermissions=0o641, afterPermissions=0o641)
    assert _validate_apply_journal(journal, artifact, 'accepted')['entries'][0]['afterPermissions'] == 0o641
    item['afterPermissions'] = 0o640
    with pytest.raises(WorkspaceError, match='does not match the accepted result'):
        _validate_apply_journal(journal, artifact, 'accepted')


@pytest.mark.parametrize('permissions', [0o4644, 0o2644, 0o1644])
def test_recovery_record_rejects_special_permissions(permissions):
    from flowdesk.execution_git import _validate_apply_journal
    journal, artifact = recovery_record()
    journal['entries'][0].update(beforePermissions=permissions, afterPermissions=0o644)
    with pytest.raises(WorkspaceError, match='does not match the accepted result'):
        _validate_apply_journal(journal, artifact, 'accepted')


@pytest.mark.parametrize('mutation', ['digest', 'path-set', 'duplicate-path', 'completed', 'before', 'after', 'mode', 'before-mode', 'after-mode', 'permissions', 'applied-incomplete'])
def test_recovery_record_cannot_substitute_unreviewed_changes(mutation):
    from flowdesk.execution_git import _validate_apply_journal
    import base64
    journal, artifact = recovery_record()
    item = journal['entries'][0]
    if mutation == 'digest': journal['digest'] = 'different'
    elif mutation == 'path-set': item['path'] = 'other.py'
    elif mutation == 'duplicate-path': journal['entries'].append(dict(item))
    elif mutation == 'completed': journal['completed'] = ['other.py']
    elif mutation in {'before', 'after'}: item[mutation] = base64.b64encode(b'unreviewed\n').decode()
    elif mutation == 'mode': item['mode'] = '100755'
    elif mutation == 'before-mode': item['beforeMode'] = '100755'
    elif mutation == 'after-mode': item['afterMode'] = '100755'
    elif mutation == 'permissions': item.update(beforePermissions=0o644, afterPermissions=0o777)
    elif mutation == 'applied-incomplete': journal['state'] = 'applied'
    with pytest.raises(WorkspaceError, match='does not match the accepted result'):
        _validate_apply_journal(journal, artifact, 'accepted')


def test_recovery_record_accepts_only_recorded_crlf_adaptation():
    from flowdesk.execution_git import _validate_apply_journal
    import base64
    journal, artifact = recovery_record()
    journal['entries'][0].update(before=base64.b64encode(b'old\r\n').decode(), after=base64.b64encode(b'new\r\n').decode())
    assert _validate_apply_journal(journal, artifact, 'accepted')['entries'][0]['beforeMode'] == '100644'
    journal['entries'][0]['after'] = base64.b64encode(b'new\n').decode()
    with pytest.raises(WorkspaceError, match='does not match the accepted result'):
        _validate_apply_journal(journal, artifact, 'accepted')


def test_apply_rejects_changed_recovery_bytes_before_touching_checkout(fixture, monkeypatch):
    import json
    import base64
    import flowdesk.execution_git as module
    source, engine, result, root = workspace(fixture)
    (root / 'main.py').write_text('value = 2\n', encoding='utf-8')
    review = engine.capture(result)
    original = module._atomic_json
    def interrupt(path, value):
        original(path, value)
        if value.get('state') == 'prepared': raise OSError('before file writes')
    with monkeypatch.context() as patch:
        patch.setattr(module, '_atomic_json', interrupt)
        with pytest.raises(OSError): engine.apply(result, review['digest'])
    path = engine.root / result['id'] / ('apply-' + review['digest'] + '.json')
    journal = json.loads(path.read_text(encoding='utf-8'))
    journal['entries'][0]['after'] = base64.b64encode(b'not accepted\n').decode()
    path.write_text(json.dumps(journal), encoding='utf-8')
    with pytest.raises(WorkspaceError, match='does not match the accepted result'):
        GitWorkspace(engine.root.parent).apply(result, review['digest'])
    assert (source / 'main.py').read_text() == 'value = 1\n'
