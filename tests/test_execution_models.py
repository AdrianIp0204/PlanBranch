"""Shared provider execution uses existing review controls and durable questions."""
from copy import deepcopy
import threading
from uuid import uuid4
import pytest
from flowdesk.execution import ExecutionService
from flowdesk.execution_git import GitWorkspace
from flowdesk.model_executor import ModelExecutor, ToolJournal
from test_execution import fixture, mutation, finish, Executor
from test_model_executor import Registry, Runner, reply, question


def service_for(fixture,replies):
    source,store,project,planning,legacy,old=fixture
    old.close()
    registry=Registry(replies)
    service=ExecutionService(store,planning,git=GitWorkspace(store.db_path.parent),registry=registry,command_runner=Runner())
    current=store.get_project(project['id'])
    planning.approve(project['id'],mutation(baseRevision=current['revision']))
    service.repository(project['id'],mutation(path=str(source),confirmed=True))
    selection={'provider':'ollama','mode':'explicit','model':'fixture','reasoningEffort':None}
    preview=service.preview(project['id'],{'taskId':current['content']['buildTasks'][0]['id'],'selection':selection})
    assert preview['ready'],preview
    return service,registry,preview['preview']


def test_provider_dispatch_ignores_lazily_cached_codex_and_freezes_command_policy(fixture):
    service,registry,preview=service_for(fixture,[reply(text='No commands')])
    try:
        service._executor=Executor()  # equivalent to earlier Codex availability lookup
        assert isinstance(service._for_provider('ollama'),ModelExecutor)
        assert preview['generation']['provider']=='ollama' and not preview['generation']['commandPolicy']['available']
        run=service.start(fixture[2]['id'],mutation(previewId=preview['id'],confirmed=True))['run']
        result=finish(service,fixture[2]['id'],run['id'])
        assert result['state']=='succeeded' and len(registry.seen)==1
    finally: service.close()


def test_execution_question_restart_answer_exact_diff_and_idempotent_resume(fixture):
    q=question(); service,registry,preview=service_for(fixture,[reply('ask_question',{'questions':[q]})])
    pid=fixture[2]['id']
    try:
        run=service.start(pid,mutation(previewId=preview['id'],confirmed=True))['run']
        waiting=finish(service,pid,run['id'])
        assert waiting['state']=='interrupted' and waiting['question']['questions']==[q]
        with pytest.raises(RuntimeError,match='question'):
            service.accept(pid,run['id'],mutation(digest=waiting['artifact']['digest'],confirmed=True))
        service.close()
        resumed_registry=Registry([reply('write_file',{'path':'answer.txt','content':'chosen','expectedSha256':None}),reply(text='Ready')])
        service=ExecutionService(fixture[1],fixture[3],git=GitWorkspace(fixture[1].db_path.parent),registry=resumed_registry,command_runner=Runner())
        restored=service.detail(pid,run['id'])['run']
        assert restored['question']==waiting['question']
        request=mutation(questionId=restored['question']['id'],answers=[{'questionId':q['id'],'optionId':None,'text':'chosen'}],digest=restored['artifact']['digest'],confirmed=True)
        with pytest.raises(RuntimeError,match='changed'):
            service.answer(pid,run['id'],{**request,'digest':'wrong'})
        service.answer(pid,run['id'],request)
        result=finish(service,pid,run['id'])
        assert result['state']=='succeeded' and result['question'] is None
        assert any(x['path']=='answer.txt' for x in result['artifact']['files'])
        service.answer(pid,run['id'],request)
        assert len(resumed_registry.seen)==2
        assert 'chosen' in resumed_registry.seen[0][1][1]['content']
        assert not (fixture[0]/'answer.txt').exists()
    finally: service.close()


def test_cancel_question_stops_resumability_without_discarding_artifact(fixture):
    service,registry,preview=service_for(fixture,[reply('ask_question',{'questions':[question()]})]); pid=fixture[2]['id']
    try:
        run=service.start(pid,mutation(previewId=preview['id'],confirmed=True))['run']
        waiting=finish(service,pid,run['id'])
        cancelled=service.cancel(pid,run['id'],mutation())['run']
        assert cancelled['state']=='cancelled' and cancelled['question'] is None
        assert cancelled['artifact']['digest']==waiting['artifact']['digest']
    finally: service.close()

def test_committed_unconsumed_answer_needs_explicit_retry_after_restart(fixture):
    q=question();service,registry,preview=service_for(fixture,[reply('ask_question',{'questions':[q]})]);pid=fixture[2]['id']
    try:
        run=service.start(pid,mutation(previewId=preview['id'],confirmed=True))['run']
        waiting=finish(service,pid,run['id'])
        request=mutation(questionId=waiting['question']['id'],answers=[{'questionId':q['id'],'optionId':None,'text':'chosen'}],digest=waiting['artifact']['digest'],confirmed=True)
        service._worker=lambda *args,**kwargs:None  # process stopped after DB intent, before harness began
        service.answer(pid,run['id'],request)
        service.close()
        resumed=Registry([reply(text='Continued once')])
        service=ExecutionService(fixture[1],fixture[3],git=GitWorkspace(fixture[1].db_path.parent),registry=resumed,command_runner=Runner())
        assert service.detail(pid,run['id'])['run']['state']=='interrupted' and resumed.seen==[]
        assert service.detail(pid,run['id'])['run']['question']['answerRequest']==request
        service.answer(pid,run['id'],request)
        assert finish(service,pid,run['id'])['state']=='succeeded'
        service.answer(pid,run['id'],request)
        assert len(resumed.seen)==1
    finally:service.close()
