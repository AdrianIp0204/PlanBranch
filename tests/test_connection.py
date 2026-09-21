"""Read-only onboarding checks do not create projects or send agent prompts."""
from flowdesk.app import create_app
from flowdesk import codex_planner


def test_connection_check_needs_token_and_refresh_is_explicit(tmp_path):
    class Provider:
        def __init__(self): self.calls=[]
        def connection_status(self,refresh=False):
            self.calls.append(refresh)
            return {'available':refresh,'label':'Codex CLI',**({} if refresh else {'reason':'Sign in with codex login.'})}
        def generate(self,context): raise AssertionError('Onboarding must never generate')
    provider=Provider()
    app=create_app(tmp_path,testing=True,planner=provider)
    client=app.test_client()
    assert client.get('/api/connection').status_code==403
    client.environ_base['HTTP_X_FLOWDESK_TOKEN']=client.get('/api/bootstrap').json['token']
    assert client.get('/api/connection').json['agent']['available'] is False
    assert client.get('/api/connection?refresh=1').json['agent']['available'] is True
    assert provider.calls==[False,True]
    assert client.get('/api/projects').json=={'projects':[]}
    app.extensions['flowdesk_execution'].close()


def test_retry_refreshes_cached_missing_cli_without_reading_credentials(monkeypatch):
    calls=[]
    monkeypatch.setattr(codex_planner,'_executable',lambda: calls.append('lookup'))
    provider=codex_planner.CodexPlanner()
    assert not provider.connection_status()['available']
    assert not provider.connection_status()['available']
    assert calls==['lookup']
    assert not provider.connection_status(refresh=True)['available']
    assert calls==['lookup','lookup']
