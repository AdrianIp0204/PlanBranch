from copy import deepcopy
import io
import json
import os
from pathlib import Path
import tarfile
import threading
from uuid import uuid4
import pytest
from flowdesk.command_runner import DockerCommandRunner, archive_files, environment
from flowdesk.execution_git import WorkspaceError
from flowdesk.model_executor import ModelExecutor, ToolJournal
from flowdesk.workspace_tools import WorkspaceTools, digest, snapshot


class Registry:
    def __init__(self, replies): self.replies, self.seen = iter(replies), []
    def status(self, provider): return {'available': True, 'label': provider}
    def configure(self, selection, purpose): return {'provider': selection['provider'], 'purpose': purpose, 'selection': selection, 'privateFrozen': 'preserved'}
    def turn(self, generation, messages, tools, cancel):
        self.seen.append(deepcopy((generation, messages, tools)))
        value = next(self.replies)
        if isinstance(value, Exception): raise value
        return value


class Runner:
    def configure(self): return {'version': 'fixture', 'available': False, 'reason': 'No isolated runtime'}
    def run(self, policy, worktree, args, key, cancel, event): return {'executed': False, 'testsRun': False, 'reason': policy['reason']}


def reply(name=None, args=None, key='call1', text=''):
    return {'text': text, 'toolCalls': [] if name is None else [{'id': key, 'name': name, 'arguments': args or {}}], 'continuation': {'reasoning': 'PRIVATE_NATIVE_BLOCK'}, 'done': name is None}


def setup(tmp_path, replies):
    root = tmp_path / 'work'; root.mkdir(); (root / 'main.txt').write_text('before')
    registry = Registry(replies); executor = ModelExecutor(tmp_path / 'data', registry, Runner())
    selection = {'provider': 'ollama', 'mode': 'explicit', 'model': 'fixture', 'reasoningEffort': None}
    context = {'runId': str(uuid4()), 'task': {'id': str(uuid4()), 'title': 'fixture'}, 'brief': {}, 'linkedNodes': [], 'sourceCommit': 'abc', 'generation': executor.configure(selection)}
    return root, executor, context, registry


def test_tool_loop_edits_once_and_retains_frozen_provider_without_private_continuation(tmp_path):
    call = reply('write_file', {'path': 'main.txt', 'content': 'after', 'expectedSha256': digest(b'before')})
    root, executor, context, registry = setup(tmp_path, [call, reply(text='Ready')])
    events = []
    result = executor.run(context, root, threading.Event(), events.append)
    assert result['status'] == 'succeeded' and (root / 'main.txt').read_text() == 'after'
    assert 'No commands or tests' in result['summary'] and result['commands'] == []
    journal = ToolJournal(executor.data_dir, context['runId']).load()
    assert len(journal['calls']) == 1 and journal['calls'][0]['arguments']['content'] == 'after'
    assert 'PRIVATE_NATIVE_BLOCK' not in json.dumps(journal) + json.dumps(events)
    assert registry.seen[1][1][-2]['continuation']['reasoning'] == 'PRIVATE_NATIVE_BLOCK'
    assert all(value[0] == context['generation']['providerGeneration'] for value in registry.seen)


def test_changed_tool_identity_stops_without_repeating(tmp_path):
    root, executor, context, _ = setup(tmp_path, [reply('write_file', {'path':'new.txt','content':'one','expectedSha256':None}), reply('write_file', {'path':'new.txt','content':'two','expectedSha256':digest(b'one')})])
    result = executor.run(context,root,threading.Event(),lambda _:None)
    assert result['status'] == 'interrupted' and (root/'new.txt').read_text() == 'one'


def test_uncertain_command_stays_pending_and_never_replays(tmp_path):
    root, executor, context, registry = setup(tmp_path, [reply('run_command',{'command':'check'})])
    def run(policy, worktree, args, key, cancel, event):
        event({'type':'command','command':{'id':key,'command':'check','status':'interrupted','exitCode':None,'output':'observed'}})
        raise WorkspaceError('Transport interrupted after launch')
    executor.runner.run = run
    result = executor.run(context,root,threading.Event(),lambda _:None)
    assert result['commands'][0]['output'] == 'observed'
    assert ToolJournal(executor.data_dir,context['runId']).load()['calls'][0]['state'] == 'pending'
    again = executor.run(context,root,threading.Event(),lambda _:None)
    assert 'not replayed' in again['error'] and len(registry.seen) == 1


def test_missing_runtime_does_not_invent_test_results(tmp_path):
    root, executor, context, _ = setup(tmp_path,[reply('run_command',{'command':'check'}),reply(text='Tests passed')])
    result = executor.run(context,root,threading.Event(),lambda _:None)
    assert result['commands'] == [] and 'No commands or tests' in result['summary']


def question():
    return {'id':str(uuid4()),'kind':'text','prompt':'Which output?','options':[],'recommendedOptionId':None}


def test_question_survives_restart_and_resumes_with_canonical_visible_context(tmp_path):
    q = question()
    root, executor, context, _ = setup(tmp_path,[reply('ask_question',{'questions':[q]})])
    result = executor.run(context,root,threading.Event(),lambda _:None)
    assert result['status'] == 'interrupted'
    journal = ToolJournal(executor.data_dir,context['runId']); public = journal.public_question()
    request = {'mutationId':str(uuid4()),'questionId':public['id'],'answers':[{'questionId':q['id'],'optionId':None,'text':'JSON'}],'digest':'abc','confirmed':True}
    journal.answer(request); journal.answer(request)
    registry = Registry([reply(text='Answer used')]); restarted = ModelExecutor(executor.data_dir,registry,Runner())
    assert restarted.run(context,root,threading.Event(),lambda _:None)['status'] == 'succeeded'
    assert 'JSON' in registry.seen[0][1][1]['content'] and 'PRIVATE_NATIVE_BLOCK' not in registry.seen[0][1][1]['content']
    assert journal.public_question() is None


def test_second_question_can_receive_a_new_answer_and_cancel(tmp_path):
    q1, q2 = question(), question()
    root, executor, context, _ = setup(tmp_path,[reply('ask_question',{'questions':[q1]})])
    executor.run(context,root,threading.Event(),lambda _:None)
    journal=ToolJournal(executor.data_dir,context['runId'])
    journal.answer({'questionId':journal.public_question()['id'],'answers':[{'questionId':q1['id'],'optionId':None,'text':'one'}]})
    executor.registry=Registry([reply('ask_question',{'questions':[q2]},key='call2')])
    executor.run(context,root,threading.Event(),lambda _:None)
    assert 'answerRequest' not in journal.public_question()
    journal.answer({'questionId':journal.public_question()['id'],'answers':[{'questionId':q2['id'],'optionId':None,'text':'two'}]})
    journal.cancel_question(); assert journal.public_question() is None


@pytest.mark.parametrize('path',['../secret','/etc/passwd','C:/secret','.git/config','sub/.git/config','NUL','x:stream','x\\y','trailing.','trailing '])
def test_file_paths_cannot_escape_or_target_metadata(tmp_path,path):
    tools=WorkspaceTools(tmp_path)
    with pytest.raises((WorkspaceError,ValueError)):
        tools.write_file({'path':path,'content':'bad','expectedSha256':None})


def test_hash_precondition_and_hardlink_rejection(tmp_path):
    (tmp_path/'a.txt').write_text('old'); tools=WorkspaceTools(tmp_path)
    with pytest.raises(WorkspaceError,match='changed'):
        tools.write_file({'path':'a.txt','content':'new','expectedSha256':None})
    os.link(tmp_path/'a.txt',tmp_path/'b.txt')
    with pytest.raises(WorkspaceError,match='Hard links'): snapshot(tmp_path)


def test_junction_or_symlink_rejected(tmp_path):
    target=tmp_path/'target'; target.mkdir(); root=tmp_path/'link'
    try: root.symlink_to(target,target_is_directory=True)
    except OSError: pytest.skip('Symbolic link permission unavailable')
    with pytest.raises(WorkspaceError): WorkspaceTools(root)


def tar(entries):
    buffer=io.BytesIO()
    with tarfile.open(fileobj=buffer,mode='w') as output:
        for name,kind in entries:
            info=tarfile.TarInfo(name); info.type=kind; info.size=1 if kind==tarfile.REGTYPE else 0; info.linkname='outside'
            output.addfile(info,io.BytesIO(b'x') if info.size else None)
    return buffer.getvalue()


@pytest.mark.parametrize('entry',[('../escape',tarfile.REGTYPE),('.git/config',tarfile.REGTYPE),('link',tarfile.SYMTYPE),('hard',tarfile.LNKTYPE),('pipe',tarfile.FIFOTYPE),('dev',tarfile.CHRTYPE)])
def test_archive_is_validated_without_extracting(entry):
    with pytest.raises((WorkspaceError,ValueError)): archive_files(tar([entry]))


def test_archive_collision_and_ordinary_files():
    assert archive_files(tar([('src/a.txt',tarfile.REGTYPE)])) == {'src/a.txt':b'x'}
    with pytest.raises(WorkspaceError): archive_files(tar([('A',tarfile.REGTYPE),('a',tarfile.REGTYPE)]))
    with pytest.raises(WorkspaceError): archive_files(tar([('a',tarfile.REGTYPE),('a/b',tarfile.REGTYPE)]))


def test_no_runtime_has_no_shell_fallback(tmp_path,monkeypatch):
    monkeypatch.delenv('PLANBRANCH_EXECUTION_IMAGE',raising=False)
    runner=DockerCommandRunner(tmp_path); policy=runner.configure()
    assert not policy['available']
    assert runner.run(policy,tmp_path,{'command':'echo harmless'},'id',threading.Event(),lambda _:None)['executed'] is False
    monkeypatch.setenv('OPENAI_API_KEY','private'); monkeypatch.setenv('SSH_AUTH_SOCK','private')
    assert not {'OPENAI_API_KEY','SSH_AUTH_SOCK'} & environment().keys()
    flags=runner.restrictions()
    assert '--network=none' in flags and '--read-only' in flags and '--pull=never' in flags
    assert '--cap-drop=ALL' in flags and '--cap-add=KILL' in flags

def test_three_consecutive_tool_failures_stop_before_more_work(tmp_path):
    root,executor,context,registry=setup(tmp_path,[reply('read_file',{'path':'missing'},key=str(i)) for i in range(4)])
    result=executor.run(context,root,threading.Event(),lambda _:None)
    assert 'Three consecutive' in result['error'] and len(registry.seen)==3
    assert ToolJournal(executor.data_dir,context['runId']).load()['consecutiveFailures']==3


def test_total_deadline_cancels_provider_and_prevents_late_tool_effect(tmp_path,monkeypatch):
    import time
    import flowdesk.model_executor as module
    monkeypatch.setattr(module,'MAX_SECONDS',.01)
    root,executor,context,registry=setup(tmp_path,[])
    def delayed(generation,messages,tools,cancel):
        assert cancel.wait(.1)
        return reply('write_file',{'path':'late','content':'bad','expectedSha256':None})
    registry.turn=delayed
    result=executor.run(context,root,threading.Event(),lambda _:None)
    assert 'time limit' in result['error'] and not (root/'late').exists()


def test_usage_is_reported_without_inventing_cost_or_private_data(tmp_path):
    root,executor,context,registry=setup(tmp_path,[{**reply(),'usage':{'inputTokens':12,'outputTokens':4,'invalid':float('inf'),'bool':True}}])
    events=[];executor.run(context,root,threading.Event(),events.append)
    usage=next(e for e in events if e['type']=='usage')
    assert usage['usage']=={'inputTokens':12,'outputTokens':4} and usage['turn']==1


def test_repeated_completed_tool_identity_stops_safely(tmp_path):
    call=reply('write_file',{'path':'new','content':'one','expectedSha256':None})
    root,executor,context,registry=setup(tmp_path,[call,call])
    result=executor.run(context,root,threading.Event(),lambda _:None)
    assert result['status']=='interrupted' and 'not repeated' in result['error']
    assert (root/'new').read_text()=='one' and len(ToolJournal(executor.data_dir,context['runId']).load()['calls'])==1


def test_archive_preserves_executable_metadata_and_existing_permissions():
    from flowdesk.command_runner import output_mode
    buffer=io.BytesIO()
    with tarfile.open(fileobj=buffer,mode='w') as output:
        info=tarfile.TarInfo('script.sh');info.mode=0o755;info.size=4;output.addfile(info,io.BytesIO(b'test'))
    files,modes=archive_files(buffer.getvalue(),include_modes=True)
    assert files=={'script.sh':b'test'} and modes=={'script.sh':0o755}
    assert output_mode(0o640,0o640,0o755)==0o751  # chmod+x, preserve read/write bits
    assert output_mode(0o751,0o751,0o644)==0o640  # chmod-x
    assert output_mode(0o651,0o651,0o755)==0o651  # ordinary content edit preserves unusual x bits
    assert output_mode(None,0o640,0o755)==0o751  # newly generated executable


def test_harness_limits_are_frozen_and_older_records_use_fixed_v1_profile(tmp_path,monkeypatch):
    import flowdesk.model_executor as module
    root,executor,context,registry=setup(tmp_path,[reply()])
    assert context['generation']['harnessPolicy']=={'version':1,'maxTurns':24,'maxCalls':80,'maxSeconds':1200,'maxContextBytes':1500000}
    monkeypatch.setattr(module,'MAX_TURNS',0)
    assert executor.run(context,root,threading.Event(),lambda _:None)['status']=='succeeded'
    assert module.harness_policy(None)['maxTurns']==24
    with pytest.raises(WorkspaceError): module.harness_policy({**context['generation']['harnessPolicy'],'maxCalls':999})


@pytest.mark.parametrize('version', [True, 1.0, '1', None])
def test_harness_version_requires_an_integer(version):
    from flowdesk.model_executor import harness_policy
    with pytest.raises(WorkspaceError, match='unsupported'):
        harness_policy({**harness_policy(None), 'version': version})


def answer_current(journal):
    public = journal.public_question()
    journal.answer({'questionId': public['id'], 'answers': [
        {'questionId': q['id'], 'optionId': None, 'text': 'Chosen'} for q in public['questions']]})


def test_active_budget_accumulates_across_two_question_continuations_without_idle_time(tmp_path, monkeypatch):
    import flowdesk.model_executor as module
    root, executor, context, _ = setup(tmp_path, [])
    context['generation']['harnessPolicy']['maxSeconds'] = 10
    clock = [100.0]
    monkeypatch.setattr(module.time, 'monotonic', lambda: clock[0])
    journal = ToolJournal(executor.data_dir, context['runId'])
    for duration, expected in ((3, 3), (4, 7)):
        q = question()
        def ask(*_args, **_kwargs):
            clock[0] += duration
            return reply('ask_question', {'questions': [q]})
        executor.registry.turn = ask
        assert executor.run(context, root, threading.Event(), lambda _: None)['status'] == 'interrupted'
        assert journal.load()['elapsedSeconds'] == expected
        clock[0] += 10000  # user/server idle time is not execution time
        answer_current(journal)
        executor = ModelExecutor(executor.data_dir, Registry([]), Runner())
    def over_remaining_budget(_generation, _messages, _tools, cancel):
        assert not cancel.is_set()
        clock[0] += 4
        assert cancel.is_set()
        return reply('write_file', {'path': 'too-late.txt', 'content': 'no', 'expectedSha256': None})
    executor.registry.turn = over_remaining_budget
    result = executor.run(context, root, threading.Event(), lambda _: None)
    assert 'time limit' in result['error'] and not (root / 'too-late.txt').exists()
    assert journal.load()['elapsedSeconds'] == 11
    assert journal.load()['turns'] == 3


@pytest.mark.parametrize('cancelled', [False, True])
def test_cancel_and_provider_error_preserve_active_elapsed_time(tmp_path, monkeypatch, cancelled):
    import flowdesk.model_executor as module
    root, executor, context, _ = setup(tmp_path, [])
    clock = [10.0]; cancel = threading.Event()
    monkeypatch.setattr(module.time, 'monotonic', lambda: clock[0])
    def fail(*_args, **_kwargs):
        clock[0] += 3
        if cancelled: cancel.set()
        raise WorkspaceError('Original provider failure')
    executor.registry.turn = fail
    result = executor.run(context, root, cancel, lambda _: None)
    assert result['status'] == ('cancelled' if cancelled else 'interrupted')
    assert result['error'] == 'Original provider failure'
    journal = ToolJournal(executor.data_dir, context['runId'])
    assert journal.load()['elapsedSeconds'] == 3
    again = executor.run(context, root, threading.Event(), lambda _: None)
    assert 'not replayed' in again['error'] and journal.load()['elapsedSeconds'] == 3


def test_uncertain_command_preserves_elapsed_and_pending_intent(tmp_path, monkeypatch):
    import flowdesk.model_executor as module
    root, executor, context, _ = setup(tmp_path, [reply('run_command', {'command': 'check'})])
    clock = [0.0]
    monkeypatch.setattr(module.time, 'monotonic', lambda: clock[0])
    def fail(*_args, **_kwargs):
        clock[0] += 5
        raise WorkspaceError('Command transport interrupted')
    executor.runner.run = fail
    result = executor.run(context, root, threading.Event(), lambda _: None)
    state = ToolJournal(executor.data_dir, context['runId']).load()
    assert result['error'] == 'Command transport interrupted'
    assert state['elapsedSeconds'] == 5 and state['calls'][0]['state'] == 'pending'


def test_unwritable_elapsed_checkpoint_keeps_original_error(tmp_path, monkeypatch):
    import flowdesk.model_executor as module
    root, executor, context, _ = setup(tmp_path, [])
    def fail(*_args, **_kwargs):
        def no_save(*_a, **_k): raise OSError('Fixture journal unavailable')
        monkeypatch.setattr(ToolJournal, 'save', no_save)
        raise WorkspaceError('Original provider failure')
    executor.registry.turn = fail
    result = executor.run(context, root, threading.Event(), lambda _: None)
    assert result['error'].startswith('Original provider failure')
    assert 'could not be saved' in result['error']
    assert ToolJournal(executor.data_dir, context['runId']).load()['state'] == 'running'


def test_legacy_journal_keeps_question_and_work_without_granting_new_time(tmp_path):
    root, executor, context, _ = setup(tmp_path, [reply('ask_question', {'questions': [question()]})])
    executor.run(context, root, threading.Event(), lambda _: None)
    journal = ToolJournal(executor.data_dir, context['runId'])
    answer_current(journal)
    state = journal.load(); state.pop('elapsedSeconds'); journal.save(state)
    registry = Registry([reply('write_file', {'path': 'unexpected', 'content': 'no', 'expectedSha256': None})])
    result = ModelExecutor(executor.data_dir, registry, Runner()).run(context, root, threading.Event(), lambda _: None)
    assert 'older run' in result['error'] and 'preview a new Run step' in result['error']
    assert journal.load() == state and journal.public_question() is not None
    assert registry.seen == [] and not (root / 'unexpected').exists()


@pytest.mark.parametrize('elapsed', [True, -1, float('nan'), float('inf'), '0'])
def test_invalid_saved_elapsed_never_extends_authority(tmp_path, elapsed):
    root, executor, context, _ = setup(tmp_path, [reply('ask_question', {'questions': [question()]})])
    executor.run(context, root, threading.Event(), lambda _: None)
    journal = ToolJournal(executor.data_dir, context['runId']); answer_current(journal)
    state = journal.load(); state['elapsedSeconds'] = elapsed
    journal.path.write_text(json.dumps(state), encoding='utf-8')
    registry = Registry([reply(text='Must not run')])
    result = ModelExecutor(executor.data_dir, registry, Runner()).run(context, root, threading.Event(), lambda _: None)
    assert 'elapsed time is invalid' in result['error'] and registry.seen == []


def test_exhausted_saved_elapsed_retains_answer_and_stops_before_provider(tmp_path):
    root, executor, context, _ = setup(tmp_path, [reply('ask_question', {'questions': [question()]})])
    executor.run(context, root, threading.Event(), lambda _: None)
    journal = ToolJournal(executor.data_dir, context['runId']); answer_current(journal)
    state = journal.load(); state['elapsedSeconds'] = context['generation']['harnessPolicy']['maxSeconds']; journal.save(state)
    registry = Registry([reply(text='Must not run')])
    result = ModelExecutor(executor.data_dir, registry, Runner()).run(context, root, threading.Event(), lambda _: None)
    assert 'time limit was reached' in result['error'] and registry.seen == []
    assert journal.load() == state and journal.public_question() is not None
