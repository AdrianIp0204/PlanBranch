"""Source equality at command endpoints cannot certify the bytes tested."""
import subprocess
import sys
from flowdesk.check_evidence import source_identity, observation_state
from flowdesk.check_evidence import seal_command, authenticated_command
from copy import deepcopy
import pytest
from test_execution import fixture, prepare, finish, mutation


def test_transient_rewrite_and_restore_is_not_source_bound(tmp_path):
    source = tmp_path / 'source.py'
    source.write_text('VALUE = 1\n')
    before = source_identity({'source.py': source.read_bytes()})['sha256']
    result = subprocess.run([sys.executable, '-c',
        "from pathlib import Path; p=Path('source.py'); old=p.read_bytes(); "
        "p.write_text('VALUE = 999\\n'); "
        "assert '999' in p.read_text(); p.write_bytes(old)"], cwd=tmp_path)
    after = source_identity({'source.py': source.read_bytes()})['sha256']
    assert before == after and result.returncode == 0
    record = {'status': 'completed', 'exitCode': 0, 'evidence': {
        'schemaVersion': 1, 'provenance': 'host_observed',
        'candidateBefore': before, 'candidateAfter': after, 'sourceChanged': False}}
    assert observation_state(record, before) == 'legacy_writable_observation'


def record(run_id):
    return {'id': 'check', 'command': 'pytest', 'status': 'completed', 'exitCode': 0, 'output': '',
            'evidence': {'schemaVersion': 2, 'provenance': 'host_observed', 'runId': run_id,
                         'executionMode': 'immutable_verification', 'candidateBefore': 'abc', 'candidateAfter': 'abc',
                         'sourceChanged': False, 'mountReadOnly': True, 'runtime': 'docker-source-bound-v2',
                         'testResult': {'state': 'passed'}}}


@pytest.mark.parametrize('field', ['command', 'output', 'exitCode', 'evidence'])
def test_host_evidence_cannot_be_forged_tampered_or_replayed(tmp_path, field):
    signed = seal_command(tmp_path, record('original'))
    assert authenticated_command(tmp_path, signed, 'original')
    assert not authenticated_command(tmp_path, signed, 'another-run')
    changed = deepcopy(signed)
    if field == 'evidence': changed[field]['executionMode'] = 'made-up'
    else: changed[field] = 9 if field == 'exitCode' else 'substituted'
    assert not authenticated_command(tmp_path, changed, 'original')
    assert not authenticated_command(tmp_path, record('original'), 'original')


def test_execution_ingestion_strips_provider_assigned_evidence(fixture):
    _, _, project, _, executor, service = fixture
    preview = prepare(fixture)
    def forged(context, worktree, cancel, on_event):
        command = record(context['runId'])
        command['evidence']['hostAuthenticated'] = True
        on_event({'type': 'command', 'command': command})
        return {'status': 'succeeded', 'commands': [command]}
    executor.run = forged
    run = service.start(project['id'], mutation(previewId=preview['id'], confirmed=True))['run']
    run = finish(service, project['id'], run['id'])
    assert 'evidence' not in run['commands'][0]
    assert run['commands'][0]['verificationState'] == 'external_result_reported'


def test_execution_ingestion_preserves_only_host_signed_run_evidence(fixture):
    _, _, project, _, executor, service = fixture
    preview = prepare(fixture)
    def host(context, worktree, cancel, on_event):
        from flowdesk.check_evidence import snapshot_identity
        command = record(context['runId'])
        candidate = snapshot_identity(worktree)['sha256']
        command['evidence'].update(candidateBefore=candidate, candidateAfter=candidate)
        command = seal_command(service.data_dir, command)
        on_event({'type': 'command', 'command': command})
        return {'status': 'succeeded', 'commands': [command]}
    executor.run = host
    run = service.start(project['id'], mutation(previewId=preview['id'], confirmed=True))['run']
    run = finish(service, project['id'], run['id'])
    assert run['commands'][0]['evidence']['hostAuthenticated'] is True
    assert run['commands'][0]['verificationState'] == 'observed_check_passed'


def test_native_verification_uses_same_durable_budget_and_never_replays_uncertain_work(tmp_path):
    import threading
    from test_model_executor import setup, reply, ToolJournal
    from flowdesk.execution_git import WorkspaceError
    root, executor, context, registry = setup(tmp_path, [reply('verify_without_editing', {'command': 'check'})])
    calls = []
    def verify(policy, worktree, arguments, key, cancel, on_event):
        calls.append(policy['evidenceRunId'])
        raise WorkspaceError('Verification transport interrupted after launch')
    executor.runner.verify = verify
    result = executor.run(context, root, threading.Event(), lambda _: None)
    assert result['status'] == 'interrupted' and calls == [context['runId']]
    journal = ToolJournal(executor.data_dir, context['runId']).load()
    assert journal['calls'][0]['state'] == 'pending' and journal['elapsedSeconds'] >= 0
    again = executor.run(context, root, threading.Event(), lambda _: None)
    assert 'not replayed' in again['error'] and len(calls) == 1 and len(registry.seen) == 1


def test_long_native_command_ids_preserve_each_result_and_update_only_the_same_command(fixture):
    from flowdesk.check_evidence import snapshot_identity
    from flowdesk.model_executor import ModelExecutor
    from test_model_executor import Registry, Runner, reply
    _, _, project, _, injected, service = fixture
    native_ids = ['x' * 198 + 'aa', 'x' * 198 + 'bb']
    registry = Registry([reply('verify_without_editing', {'command': 'failing check'}, key=native_ids[0]),
                         reply('verify_without_editing', {'command': 'passing check'}, key=native_ids[1]),
                         reply(text='Finished both checks')])
    runner = Runner()
    def verify(policy, worktree, arguments, key, cancel, on_event):
        identity = snapshot_identity(worktree)
        command = {'id': key, 'command': arguments['command'], 'status': 'in_progress', 'exitCode': None, 'output': '',
            'evidence': {'schemaVersion': 2, 'provenance': 'host_observed', 'runId': policy['evidenceRunId'],
                        'executionMode': 'immutable_verification', 'runtime': 'test-double',
                        'candidateBefore': identity['sha256'], 'candidateAfter': identity['sha256'], 'sourceChanged': False}}
        on_event({'type': 'command', 'command': seal_command(service.data_dir, command)})
        failed = arguments['command'] == 'failing check'
        command.update(status='failed' if failed else 'completed', exitCode=1 if failed else 0,
                       output='failure retained' if failed else 'success retained')
        command = seal_command(service.data_dir, command)
        on_event({'type': 'command', 'command': command})
        return {'executed': True, 'command': command}
    runner.verify = verify
    executor = ModelExecutor(service.data_dir, registry, runner)
    selection = {'provider': 'ollama', 'mode': 'explicit', 'model': 'fixture', 'reasoningEffort': None}
    injected.configure = lambda _: executor.configure(selection)
    injected.run = executor.run
    preview = prepare(fixture)
    started = service.start(project['id'], mutation(previewId=preview['id'], confirmed=True))['run']
    run = finish(service, project['id'], started['id'])
    assert run['state'] == 'succeeded', run
    assert [command['id'] for command in run['commands']] == ['1:' + key for key in native_ids]
    assert [command['exitCode'] for command in run['commands']] == [1, 0]
    assert [command['output'] for command in run['commands']] == ['failure retained', 'success retained']
    assert 'Observed command failures remain' in run['summary']
    assert all(command['evidence']['hostAuthenticated'] for command in run['commands'])
    assert all(command['verificationState'] == 'not_verified' for command in run['commands'])
