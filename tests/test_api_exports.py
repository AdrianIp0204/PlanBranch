from copy import deepcopy
import json
import sqlite3
from uuid import uuid4

import pytest

from flowdesk.app import create_app
from flowdesk.exports import portable_project, import_project, markdown_brief
from flowdesk.storage import Store
from flowdesk.sample import sample_content
from flowdesk.validation import ValidationError


@pytest.fixture
def app(tmp_path):
    return create_app(tmp_path, testing=True)


@pytest.fixture
def client(app):
    client = app.test_client()
    token = client.get('/api/bootstrap').json['token']
    client.environ_base['HTTP_X_FLOWDESK_TOKEN'] = token
    return client


def test_local_request_boundary(app):
    c = app.test_client()
    assert c.get('/api/projects').status_code == 403
    token = c.get('/api/bootstrap').json['token']
    h = {'X-FlowDesk-Token': token}
    assert c.post('/api/projects', json={'name':'safe'}, headers=h).status_code == 201
    assert c.post('/api/projects', json={'name':'blocked'}, headers={**h,'Origin':'https://evil.example'}).status_code == 403
    assert c.get('/api/bootstrap', headers={'Host':'evil.example'}).status_code == 400
    assert c.get('/api/bootstrap', headers={'Sec-Fetch-Site':'cross-site'}).status_code == 403
    assert not c.get('/api/bootstrap').headers.get('Access-Control-Allow-Origin')
    assert c.get('/api/projects', headers=h).json['projects'][0]['name'] == 'safe'


def test_api_create_save_conflict_delete_and_backup(client, app):
    project = client.post('/api/projects', json={'sample':True}).json
    assert project['content']['diagrams'][0]['nodes']
    content = deepcopy(project['content'])
    content['notes'] = '<img src=x onerror=alert(1)>'
    checkpoint = {'id':str(uuid4()), 'label':'Notes', 'content':content}
    payload = {'baseRevision':0,'mutationId':str(uuid4()),'anchorId':project['cursor'],
               'append':[checkpoint], 'cursor':checkpoint['id'], 'views':{}}
    saved = client.put('/api/projects/'+project['id'], json=payload)
    assert saved.status_code == 200, saved.json
    assert client.put('/api/projects/'+project['id'], json=payload).json == saved.json
    stale = {**payload, 'mutationId':str(uuid4())}
    assert client.put('/api/projects/'+project['id'], json=stale).status_code == 409
    assert client.get('/api/projects/'+project['id']).json['content']['notes'] == content['notes']
    backup = client.post('/api/backup', json={})
    assert backup.status_code == 200
    store = app.extensions['flowdesk_store']
    with sqlite3.connect(store.db_path.parent/'backups'/backup.json['filename']) as db:
        assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    assert client.delete('/api/projects/'+project['id'], json={'revision':1}).status_code == 400
    assert client.delete('/api/projects/'+project['id'], json={'revision':1,'confirmed':True}).status_code == 200


def test_portable_roundtrip_remaps_relationships_and_views(tmp_path):
    store = Store(tmp_path/'db.sqlite3')
    content = sample_content()
    sid = str(uuid4())
    evidence = [{'id':sid,'name':'count','kind':'variable','file':'sample.py','scope':'main','scopeKind':'function',
                 'annotation':'int','locations':[{'line':4,'column':0}], 'declarations':[], 'state':'current',
                 'scanTime':'2026-09-10T00:00:00Z','hash':'abc','sourceExcerpt':'secret', 'absoluteRoot':'C:/private'}]
    content['nodeLinks'].append({'id':str(uuid4()),'nodeId':content['diagrams'][0]['nodes'][0]['id'],
                                'variableId':sid,'origin':'detected','relationship':'reads'})
    content['matches'].append({'id':str(uuid4()),'plannedId':content['variables'][0]['id'],
                              'symbolId':sid,'decision':'confirmed'})
    did = content['diagrams'][0]['id']
    p = store.create_project(content=content, evidence=evidence, views={did:{'x':-40,'y':20,'zoom':0.7}})
    exported = portable_project(p, evidence)
    assert 'secret' not in json.dumps(exported)
    assert 'C:/private' not in json.dumps(exported)
    imported = import_project(store, exported)
    assert imported['id'] != p['id']
    assert imported['content']['diagrams'][0]['id'] != did
    assert imported['content']['diagrams'][0]['nodes'][0]['title'] == content['diagrams'][0]['nodes'][0]['title']
    assert len(imported['content']['nodeLinks']) == len(content['nodeLinks'])
    assert imported['views'][imported['content']['diagrams'][0]['id']]['zoom'] == 0.7
    assert len(imported['history']) == 1
    with store.connect() as db:
        symbol = json.loads(db.execute('SELECT data FROM detected_symbols WHERE project_id=?',(imported['id'],)).fetchone()[0])
    assert symbol['state'] == 'historical'
    assert imported['content']['matches'][0]['symbolId'] == symbol['id']


def test_invalid_import_leaves_database_unchanged(tmp_path):
    store = Store(tmp_path/'db.sqlite3')
    p = store.create_project(content=sample_content())
    document = portable_project(p, [])
    document['content']['diagrams'][0]['edges'][0]['target'] = 'unknown'
    before = store.list_projects()
    with pytest.raises(ValidationError):
        import_project(store, document)
    assert store.list_projects() == before
    document = portable_project(p, [])
    document['sourceRoot'] = 'C:/private'
    with pytest.raises(ValidationError):
        import_project(store, document)
    assert store.list_projects() == before


def test_markdown_contains_decisions_checklists_and_plans():
    content = sample_content()
    content['notes'] = '<script>alert(1)</script>'
    text = markdown_brief(content)
    assert '<script>' not in text and '&lt;script&gt;' in text
    assert '| Name | Purpose |' in text
    assert '- [x]' in text or '- [ ]' in text
    for variable in content['variables']:
        assert variable['name'].replace('_', r'\_') in text


def test_json_import_does_not_attach_root(client, app):
    p = client.post('/api/projects', json={'sample':True}).json
    export = client.get(f"/api/projects/{p['id']}/export/json")
    assert export.status_code == 200
    restored = client.post('/api/import', json=export.json)
    assert restored.status_code == 201, restored.json
    assert client.get(f"/api/projects/{restored.json['id']}/source").json['attached'] is False
    assert client.get(f"/api/projects/{p['id']}/export/markdown").status_code == 200


def test_copy_scanned_project_strips_machine_metadata(client, app):
    store = app.extensions['flowdesk_store']
    content = sample_content()
    symbol_id = str(uuid4())
    symbol = {'id':symbol_id,'name':'count','kind':'variable','file':'importer.py','scope':'process_records',
              'scopeKind':'function','annotation':'int','locations':[{'line':3,'column':4}], 'declarations':[],
              'state':'current','hash':'abc','scanTime':'2026-09-10T00:00:00Z',
              'attachmentGeneration':'machine-specific','freshnessReason':'Current on this machine'}
    content['matches'].append({'id':str(uuid4()),'plannedId':content['variables'][0]['id'],
                              'symbolId':symbol_id,'decision':'confirmed'})
    original = store.create_project(content=content,evidence=[symbol])
    result = client.post('/api/projects',json={'content':original['content']})
    assert result.status_code == 201, result.json
    copied=result.json
    assert copied['id'] != original['id']
    with store.connect() as db:
        evidence=json.loads(db.execute('SELECT data FROM detected_symbols WHERE project_id=?',(copied['id'],)).fetchone()[0])
    assert evidence['state']=='historical'
    assert 'attachmentGeneration' not in evidence
    assert client.get(f"/api/projects/{copied['id']}/source").json['attached'] is False


def test_invalid_copy_payload_rejected_without_side_effects(client):
    before = client.get('/api/projects').json
    assert client.post('/api/projects',json={'content':'invalid'}).status_code==400
    assert client.get('/api/projects').json==before


def test_non_ascii_token_rejected(app):
    response=app.test_client().get('/api/projects',headers={'X-FlowDesk-Token':'café'})
    assert response.status_code==403


@pytest.mark.parametrize('evidence',[[{'id':'partial'}], [{'id':'bad','name':'x','kind':'variable','file':'x.py','scope':'<module>', 'scopeKind':'module','annotation':'unknown','locations':[], 'declarations':[{'kind':[],'scope':'f','line':1}], 'state':'historical','scanTime':'','hash':''}]])
def test_malformed_evidence_does_not_create_project(client,evidence):
    before=client.get('/api/projects').json
    content=sample_content()
    response=client.post('/api/import',json={'format':'flowdesk','version':1,'content':content,'symbols':evidence,'views':{}})
    assert response.status_code==400
    assert client.get('/api/projects').json==before
import time


def test_scan_state_survives_browser_reload(client, app, tmp_path):
    source=tmp_path/'source'
    source.mkdir()
    (source/'main.py').write_text('count: int = 1\n', encoding='utf-8')
    p=client.post('/api/projects',json={'name':'Scan recovery'}).json
    # The app data directory itself is excluded; keep fixture source outside it.
    scans=app.extensions['flowdesk_scans']
    scans.data_dir=tmp_path/'data-only'
    attached=client.post(f"/api/projects/{p['id']}/source",json={'root':str(source),'ignores':[],'confirmed':True})
    assert attached.status_code==200,attached.json
    run=client.post(f"/api/projects/{p['id']}/scans",json={}).json
    deadline=time.monotonic()+10
    while time.monotonic()<deadline:
        state=client.get(f"/api/projects/{p['id']}/source").json['latestScan']
        if state and state['status'] not in {'queued','running'}:
            break
        time.sleep(.02)
    assert state['id']==run['id']
    assert state['status']=='completed'
    assert state['summary']['analysed']==1
    assert client.get(f"/api/projects/{p['id']}").json['revision']==0
    symbols=client.get(f"/api/projects/{p['id']}/symbols").json['symbols']
    assert len(symbols)==1
    preview=client.get(f"/api/projects/{p['id']}/symbols/{symbols[0]['id']}/preview").json
    assert preview['stale'] is False and 'count' in preview['text']
    (source/'main.py').write_text('\ncount: int = 2\n',encoding='utf-8')
    preview=client.get(f"/api/projects/{p['id']}/symbols/{symbols[0]['id']}/preview").json
    assert preview['stale'] is True
