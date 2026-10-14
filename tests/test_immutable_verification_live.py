"""Required Linux CI gate: actual Docker mounts/processes, never string mocks."""
import json
import os
import threading
from copy import deepcopy
import pytest
from flowdesk.command_runner import DockerCommandRunner
from flowdesk.check_evidence import observation_state, authenticated_command, snapshot_identity
from flowdesk.execution_git import WorkspaceError

pytestmark = pytest.mark.skipif(os.environ.get('PLANBRANCH_TEST_DOCKER') != '1', reason='Explicit live Linux Docker gate')


@pytest.fixture
def runtime(tmp_path):
    runner = DockerCommandRunner(tmp_path / 'data')
    policy = runner.configure()
    assert policy['available'], policy
    policy['evidenceRunId'] = 'live-verification'
    root = tmp_path / 'candidate'; root.mkdir()
    (root / 'source.py').write_text('VALUE = 1\n')
    return runner, policy, root


def run(runtime, command, *, cancel=None, event=lambda _: None, timeout=30):
    runner, policy, root = runtime
    result = runner.verify(policy, root, {'command': command, 'timeoutSeconds': timeout}, 'check', cancel or threading.Event(), event)
    assert authenticated_command(runner.data_dir, result['command'], policy['evidenceRunId'])
    result['command']['evidence']['hostAuthenticated'] = True
    return result['command']


@pytest.mark.parametrize('command', [
    "python -c \"from pathlib import Path; p=Path('source.py'); old=p.read_bytes(); p.write_text('VALUE = 999'); assert '999' in p.read_text(); p.write_bytes(old)\"",
    'chmod 777 source.py && echo changed > source.py',
    'echo changed > source.py',
    'rm source.py && ln -s /tmp/substitute source.py',
    'mv /workspace /tmp/old && mkdir /workspace',
])
def test_live_source_mutation_and_substitution_fail(runtime, command):
    record = run(runtime, command)
    assert record['exitCode'] != 0, record
    assert observation_state(record, snapshot_identity(runtime[2])['sha256']) == 'observed_check_failed'
    assert (runtime[2] / 'source.py').read_text() == 'VALUE = 1\n'


def test_live_immutable_success_with_separate_bounded_outputs(runtime):
    record = run(runtime, "python -c \"from pathlib import Path; from source import VALUE; assert VALUE == 1; Path('/cache/cache.txt').write_text('cache'); Path('/tmp/temp.txt').write_text('tmp'); Path('/artifacts/junit.xml').write_text('<testsuite><testcase/></testsuite>')\"")
    assert record['exitCode'] == 0, record
    assert record['evidence']['mountReadOnly'] is True
    assert record['evidence']['testResult']['counts']['passed'] == 1
    assert observation_state(record, snapshot_identity(runtime[2])['sha256']) == 'observed_check_passed'
    assert sorted(p.name for p in runtime[2].iterdir()) == ['source.py']
    assert run(runtime, 'true')['exitCode'] == 0
    assert observation_state(run(runtime, 'true'), snapshot_identity(runtime[2])['sha256']) == 'command_exit_observed'


def test_live_output_link_escape_rejected_without_candidate_copyback(runtime):
    with pytest.raises(WorkspaceError, match='link'):
        run(runtime, 'ln -s /workspace/source.py /artifacts/junit.xml')
    assert (runtime[2] / 'source.py').read_text() == 'VALUE = 1\n'


@pytest.mark.parametrize('mode', ['cancel', 'timeout'])
def test_live_verification_cancel_timeout_cleanup(runtime, mode):
    cancelled = threading.Event()
    def event(packet):
        if mode == 'cancel' and 'begun' in packet.get('command', {}).get('output', ''): cancelled.set()
    record = run(runtime, 'echo begun; sleep 30', cancel=cancelled, event=event, timeout=1 if mode == 'timeout' else 30)
    assert record['status'] == ('cancelled' if mode == 'cancel' else 'interrupted')
    assert observation_state(record, snapshot_identity(runtime[2])['sha256']) == 'not_verified'
    runner, policy, _ = runtime
    for path in runner.directory.glob('*/container.json'):
        key = json.loads(path.read_text())['container']
        with pytest.raises(WorkspaceError): runner._call(policy['executable'], policy['endpoint'], ['inspect', key])


def test_live_mutable_commands_remain_available_but_never_source_bound(runtime):
    runner, policy, root = runtime
    record = runner.run(policy, root, {'command': 'echo VALUE=999 > source.py'}, 'coding', threading.Event(), lambda _: None)['command']
    record['evidence']['hostAuthenticated'] = True
    assert record['exitCode'] == 0 and '999' in (root / 'source.py').read_text()
    assert observation_state(record, snapshot_identity(root)['sha256']) == 'mutable_command_observed'


def test_live_runtime_and_selected_candidate_drift_refused(runtime):
    runner, policy, root = runtime
    changed = deepcopy(policy); changed['daemonId'] = 'different'
    with pytest.raises(WorkspaceError, match='runtime changed'):
        runner.verify(changed, root, {'command': 'true'}, 'drift', threading.Event(), lambda _: None)
    changed = deepcopy(policy); changed['candidateHash'] = 'different'
    with pytest.raises(WorkspaceError, match='candidate changed'):
        runner.verify(changed, root, {'command': 'true'}, 'drift', threading.Event(), lambda _: None)
