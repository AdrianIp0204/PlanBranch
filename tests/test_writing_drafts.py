from copy import deepcopy
from contextlib import closing
from uuid import uuid4
import pytest
from flowdesk.storage import Store, encode, now
from flowdesk.writing_drafts import WritingDrafts, WritingConflict, empty_writing, fingerprint
from flowdesk.validation import ValidationError

@pytest.fixture
def setup(tmp_path):
    store = Store(tmp_path / 'data.sqlite3')
    project = store.create_project('Writing')
    return store, project, WritingDrafts(store)

def save(service, project, text, revision=0, **extra):
    payload=empty_writing();payload['message']=text;payload['versions']['message']=str(uuid4())
    request={'mutationId':str(uuid4()),'baseRevision':revision,'payload':payload,**extra}
    return service.save(project['id'],request),request

def test_restart_keeps_writing_separate_from_history_and_approval(setup):
    store,project,service=setup
    result,_=save(service,project,'Keep this unsent')
    restored=WritingDrafts(Store(store.db_path)).get(project['id'])
    assert restored==result
    assert store.get_project(project['id'])==project


def test_exact_save_retry_and_conflict_retain_both_versions(setup):
    store,project,service=setup
    first,request=save(service,project,'First tab')
    assert service.save(project['id'],request)==first
    try: save(service,project,'Second tab')
    except WritingConflict as conflict: response=conflict.response
    assert response['draft']['payload']['message']=='First tab'
    assert response['copies'][0]['payload']['message']=='Second tab'
    assert response['recoveryId']==response['copies'][0]['id']
    with pytest.raises(ValidationError,match='reused'):
        service.save(project['id'],{**request,'payload':{**request['payload'],'message':'Different'}})
    assert store.get_project(project['id'])==project


def test_conflict_retry_creates_only_one_saved_copy(setup):
    _,project,service=setup
    save(service,project,'First')
    request={'baseRevision':0,'mutationId':str(uuid4()),'payload':empty_writing()}
    for _ in range(2):
        with pytest.raises(WritingConflict) as caught: service.save(project['id'],request)
    assert len(service.get(project['id'])['copies'])==1
    assert caught.value.response['recoveryId']==service.get(project['id'])['copies'][0]['id']


def test_explicit_replace_preserves_other_draft_and_copy_delete_is_idempotent(setup):
    _,project,service=setup
    save(service,project,'Other tab')
    state,_=save(service,project,'My chosen writing',1,preserveCurrent=True)
    assert state['draft']['payload']['message']=='My chosen writing'
    assert state['copies'][0]['payload']['message']=='Other tab'
    copy=state['copies'][0]
    assert service.discard_copy(project['id'],copy['id'],{'baseRevision':1})['copies']==[]
    assert service.discard_copy(project['id'],copy['id'],{'baseRevision':1})['copies']==[]


def test_orphan_context_is_retained_without_requiring_existing_node(setup):
    _,project,service=setup
    data=empty_writing();data['comments']={'deleted':'Keep the note'}
    data['context']={'diagramId':'deleted-diagram','nodeId':'deleted','diagramName':'Old flow','nodeTitle':'Old node'}
    state=service.save(project['id'],{'baseRevision':0,'mutationId':str(uuid4()),'payload':data})
    assert state['draft']['payload']==data

@pytest.mark.parametrize('newer',[False,True])
def test_acknowledged_comment_only_retires_its_exact_writing_version(setup,newer):
    store,project,service=setup
    data=empty_writing();request={'mutationId':'sent-comment','diagramId':'old','nodeId':'deleted','text':'Submitted'}
    data.update(failedComment=request,comments={'deleted':'Newer' if newer else 'Submitted'},submitted={'comment':'version1'})
    data['versions']['comments']['deleted']='version2' if newer else 'version1'
    service.save(project['id'],{'baseRevision':0,'mutationId':str(uuid4()),'payload':data})
    with closing(store.connect()) as db,db:
        db.execute('INSERT INTO planning_receipts VALUES(?,?,?)',(project['id'],request['mutationId'],fingerprint({'action':'comment','payload':request})))
    result=service.get(project['id'])['draft']['payload']
    assert result['failedComment'] is None
    assert result['comments']==({'deleted':'Newer'} if newer else {})


def test_wrong_receipt_and_failed_delivery_do_not_retire_writing(setup):
    store,project,service=setup
    data=empty_writing();data['comments']={'n':'Writing'}
    data['failedComment']={'mutationId':'uncertain','diagramId':'d','nodeId':'n','text':'Writing'}
    data['versions']['comments']['n']='v';data['submitted']['comment']='v'
    service.save(project['id'],{'baseRevision':0,'mutationId':str(uuid4()),'payload':data})
    with closing(store.connect()) as db,db:
        db.execute('INSERT INTO planning_receipts VALUES(?,?,?)',(project['id'],'uncertain','wrong'))
    assert service.get(project['id'])['draft']['payload']==data


def test_bad_payload_does_not_commit(setup):
    _,project,service=setup
    data=empty_writing();data['comments']={'n':42}
    with pytest.raises(ValidationError): service.save(project['id'],{'baseRevision':0,'mutationId':'bad','payload':data})
    assert service.get(project['id'])['draft']['revision']==0


def test_api_token_project_ownership_and_settings_info(tmp_path):
    from flowdesk.app import create_app
    app=create_app(tmp_path,testing=True);client=app.test_client()
    assert client.get('/api/settings/info').status_code==403
    client.environ_base['HTTP_X_FLOWDESK_TOKEN']=client.get('/api/bootstrap').json['token']
    assert client.get('/api/settings/info').json['dataDirectory']==str(tmp_path.resolve())
    assert client.get('/api/settings/info').json['schemaVersion']==9
    project=client.post('/api/projects',json={'name':'API writing'}).json
    url=f"/api/projects/{project['id']}/planning/writing"
    assert client.get(url).json['draft']['revision']==0
    payload={'mutationId':'save','baseRevision':0,'payload':empty_writing()}
    assert client.put(url,json=payload).status_code==200
    assert client.put(url,json={**payload,'mutationId':'conflict'}).status_code==409
    assert client.get('/api/projects/missing/planning/writing').status_code==404
    app.extensions['flowdesk_execution'].close()

@pytest.mark.parametrize('kind', ['comment', 'answer'])
def test_acknowledged_legacy_request_without_versions_preserves_unsent_text(setup,kind):
    store,project,service=setup
    data=empty_writing()
    if kind=='comment':
        request={'mutationId':'legacy','nodeId':'gone','diagramId':'gone','text':'Old'}
        data.update(failedComment=request,comments={'gone':'New unsent comment'})
        action='comment';body=request
    else:
        request={'mutationId':'legacy','setId':'gone','baseRevision':1,'answers':[],'selection':{'mode':'default'}}
        data.update(failedAnswer=request,questionDrafts={'gone':{'q':{'choice':None,'custom':True,'text':'New unsent answer'}}})
        action='answers:gone';body={key:value for key,value in request.items() if key!='setId'}
    service.save(project['id'],{'baseRevision':0,'mutationId':'save','payload':data})
    with closing(store.connect()) as db,db:
        db.execute('INSERT INTO planning_receipts VALUES(?,?,?)',(project['id'],'legacy',fingerprint({'action':action,'payload':body})))
    recovered=service.get(project['id'])['draft']['payload']
    assert recovered['comments']==data['comments']
    assert recovered['questionDrafts']==data['questionDrafts']
    assert recovered['failedComment' if kind=='comment' else 'failedAnswer'] is None

@pytest.mark.parametrize('newer',[False,True])
def test_delivered_message_retirement_preserves_newer_prompt_after_restart(setup,newer):
    store,project,service=setup
    data=empty_writing()
    request={'mutationId':'sent','text':'Submitted','diagramId':project['content']['diagrams'][0]['id'],'nodeId':None}
    data.update(message='Newer' if newer else 'Submitted',failedPrompt=request,submitted={'message':'old'})
    data['versions']['message']='new' if newer else 'old'
    service.save(project['id'],{'baseRevision':0,'mutationId':'save','payload':data})
    with closing(store.connect()) as db,db:
        db.execute('INSERT INTO planning_requests(id,project_id,payload_hash,payload,context,base_revision,base_cursor,base_hash,attempt_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
          ('sent',project['id'],fingerprint(request),encode(request),'{}',project['revision'],project['cursor'],'hash','attempt','failed',now(),now()))
    recovered=WritingDrafts(Store(store.db_path)).get(project['id'])['draft']['payload']
    assert recovered['message']==('Newer' if newer else '')
    assert recovered['failedPrompt'] is None

def test_lost_legacy_import_ack_does_not_duplicate_identical_recovery_copy(setup):
    _,project,service=setup
    save(service,project,'Canonical')
    data=empty_writing();data['message']='Legacy import'
    first=service.save(project['id'],{'baseRevision':1,'mutationId':'import-1','copyOnly':True,'payload':data})
    second=service.save(project['id'],{'baseRevision':1,'mutationId':'import-2','copyOnly':True,'payload':data})
    assert first['recoveryId']==second['recoveryId']
    assert len(second['copies'])==1
    assert second['draft']['payload']['message']=='Canonical'


def test_exact_migration_retry_keeps_receipt_without_recreating_discarded_copy(setup):
    _, project, service = setup
    save(service, project, 'Canonical')
    data = empty_writing(); data['message'] = 'Legacy import'
    request = {'baseRevision': 1, 'mutationId': 'migration', 'copyOnly': True, 'payload': data}
    receipt = service.save(project['id'], request)
    saved_copy = receipt['copies'][0]
    service.discard_copy(project['id'], saved_copy['id'], {'baseRevision': saved_copy['revision']})
    assert service.save(project['id'], request) == receipt
    assert service.get(project['id'])['copies'] == []
    assert service.get(project['id'])['draft']['payload']['message'] == 'Canonical'


def test_obsolete_versions_do_not_block_new_writing_after_500_targets(setup):
    _, project, service = setup
    data = empty_writing()
    data['versions']['comments'] = {f'old-{index}': f'v-{index}' for index in range(505)}
    data['versions']['questions'] = {f'old-{index}': f'v-{index}' for index in range(505)}
    data['comments'] = {'live': 'New unsent writing'}
    data['versions']['comments'].update(live='live-version', pending='pending-version')
    data['failedComment'] = {'mutationId': 'uncertain', 'nodeId': 'pending', 'diagramId': 'd', 'text': 'Submitted'}
    data['submitted']['comment'] = 'pending-version'
    state = service.save(project['id'], {'baseRevision': 0, 'mutationId': 'save', 'payload': data})
    assert state['draft']['payload']['versions']['comments'] == {'live': 'live-version', 'pending': 'pending-version'}
    assert state['draft']['payload']['versions']['questions'] == {}
    assert state['draft']['payload']['comments'] == {'live': 'New unsent writing'}
    # The immutable receipt still accepts the exact original, unpruned request.
    assert service.save(project['id'], {'baseRevision': 0, 'mutationId': 'save', 'payload': data}) == state


def test_recovery_prunes_old_stored_versions_but_preserves_pending_request(setup):
    store, project, service = setup
    data = empty_writing()
    data['versions']['questions'] = {'obsolete': 'old', 'pending': 'pending-version'}
    data['failedAnswer'] = {'mutationId': 'uncertain', 'setId': 'pending', 'baseRevision': 1, 'answers': [], 'selection': {'mode': 'default'}}
    data['submitted']['answer'] = 'pending-version'
    with closing(store.connect()) as db, db:
        db.execute("INSERT INTO writing_drafts VALUES(?,'current',1,?,?,?)", (project['id'], encode(data), now(), now()))
    recovered = service.get(project['id'])['draft']['payload']
    assert recovered['versions']['questions'] == {'pending': 'pending-version'}
    assert recovered['failedAnswer'] == data['failedAnswer']


def test_empty_cleared_targets_do_not_exhaust_live_draft_limits(setup):
    _, project, service = setup
    data = empty_writing()
    data['comments'] = {f'old-{index}': '' for index in range(505)}
    data['questionDrafts'] = {f'old-{index}': {} for index in range(505)}
    data['versions']['comments'] = {f'old-{index}': f'v-{index}' for index in range(505)}
    data['versions']['questions'] = {f'old-{index}': f'v-{index}' for index in range(505)}
    data['comments']['live'] = 'Keep this'
    state = service.save(project['id'], {'baseRevision': 0, 'mutationId': 'save', 'payload': data})
    assert state['draft']['payload']['comments'] == {'live': 'Keep this'}
    assert state['draft']['payload']['questionDrafts'] == {}
    assert state['draft']['payload']['versions']['comments'] == {}
    assert state['draft']['payload']['versions']['questions'] == {}
