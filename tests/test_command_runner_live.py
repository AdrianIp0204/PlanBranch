"""Opt-in real Docker isolation against an already installed local image; never pull."""
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import pytest
from flowdesk.command_runner import DockerCommandRunner
from flowdesk.execution_git import WorkspaceError

pytestmark=pytest.mark.skipif(os.environ.get('PLANBRANCH_TEST_DOCKER')!='1',reason='Explicit local Docker isolation gate only')

@pytest.fixture
def runtime(tmp_path):
    runner=DockerCommandRunner(tmp_path/'data'); policy=runner.configure()
    assert policy['available'],policy
    work=tmp_path/'work';work.mkdir(); (work/'main.js').write_text('console.log(1)')
    (work/'.git').write_text('gitdir: private-not-shared')
    return runner,policy,work


def test_live_policy_blocks_host_metadata_credentials_network_and_root_writes(runtime,monkeypatch):
    runner,policy,work=runtime
    monkeypatch.setenv('OPENAI_API_KEY','private-host-key')
    script="""const fs=require('fs'),cp=require('child_process');
if(process.getuid()!==65534)throw Error('uid');
if(!fs.readFileSync('/proc/self/status','utf8').includes('CapEff:\\t0000000000000000'))throw Error('caps');
if(process.env.OPENAI_API_KEY)throw Error('credential');
if(fs.existsSync('/workspace/.git')||fs.existsSync('/input/.git'))throw Error('git metadata');
for(const p of ['/input/injected','/etc/injected','/var/run/docker.sock']){try{fs.writeFileSync(p,'bad');throw Error('writable '+p)}catch(e){if(e.message.startsWith('writable'))throw e}}
const interfaces=require('os').networkInterfaces();if(Object.keys(interfaces).some(x=>x!=='lo'))throw Error('network');
fs.writeFileSync('result.txt','observed');console.log('isolation verified');"""
    (work/'verify.js').write_text(script)
    events=[]; result=runner.run(policy,work,{'command':'node verify.js'},'isolation',threading.Event(),events.append)
    assert result['command']['exitCode']==0,result
    assert (work/'result.txt').read_text()=='observed' and (work/'.git').read_text()=='gitdir: private-not-shared'
    assert 'isolation verified' in result['command']['output']
    assert not list(runner.directory.glob('*/input/injected'))
    records=list(runner.directory.glob('*/container.json'))
    for record in records:
        key=json.loads(record.read_text())['container']
        result=subprocess.run(runner._args(policy['executable'],policy['endpoint'],['inspect',key]),capture_output=True)
        assert result.returncode != 0


def test_live_background_descendants_are_stopped_before_capture(runtime):
    runner,policy,work=runtime
    original=runner._archive;observed=[]
    def collect(executable,endpoint,container):
        captured=original(executable,endpoint,container)
        state=runner._call(executable,endpoint,['exec','--user=0:0',container,'/bin/sh','-c',"for p in /proc/[0-9]*/status; do if grep -q '^Uid:[[:space:]]*65534' \"$p\"; then grep '^State:' \"$p\"; fi; done"])
        observed.append(state)
        return captured
    runner._archive=collect
    command="node -e \"const f=require('fs');setInterval(()=>f.writeFileSync('heartbeat.txt',String(Date.now())),10)\" >/dev/null 2>&1 & while [ ! -f heartbeat.txt ]; do sleep 0.01; done; echo spawned"
    result=runner.run(policy,work,{'command':command},'background',threading.Event(),lambda _:None)
    assert result['command']['exitCode']==0 and (work/'heartbeat.txt').exists()
    assert observed and all('(stopped)' in line or '(zombie)' in line for line in observed[0].splitlines()),observed


@pytest.mark.parametrize('mode',['timeout','cancel'])
def test_live_timeout_and_cancel_keep_results_and_remove_owned_container(runtime,mode):
    runner,policy,work=runtime;cancel=threading.Event()
    def event(value):
        if mode=='cancel' and 'begun' in value.get('command',{}).get('output',''): cancel.set()
    result=runner.run(policy,work,{'command':'echo begun; echo partial > partial.txt; sleep 30','timeoutSeconds':1 if mode=='timeout' else 30},mode,cancel,event)
    assert result['command']['status']==('cancelled' if mode=='cancel' else 'interrupted')
    assert (work/'partial.txt').read_text().strip()=='partial'


def test_live_returned_link_is_rejected_before_copyback(runtime):
    runner,policy,work=runtime
    with pytest.raises(WorkspaceError,match='link'):
        runner.run(policy,work,{'command':'echo new > main.js; ln -s /etc/passwd escape'},'link',threading.Event(),lambda _:None)
    assert (work/'main.js').read_text()=='console.log(1)' and not (work/'escape').exists()


def test_live_server_death_removes_only_owned_container(runtime,tmp_path):
    runner,policy,work=runtime
    config=tmp_path/'config.json'; config.write_text(json.dumps({'data':str(tmp_path/'owner-data'),'work':str(work),'policy':policy}))
    code="import json,sys,threading; from flowdesk.command_runner import DockerCommandRunner; c=json.load(open(sys.argv[1])); DockerCommandRunner(c['data']).run(c['policy'],c['work'],{'command':'echo owned > live.txt; sleep 60','timeoutSeconds':90},'owned',threading.Event(),lambda _:None)"
    process=subprocess.Popen([sys.executable,'-c',code,str(config)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    record=None
    try:
        deadline=time.monotonic()+30
        while time.monotonic()<deadline:
            records=list((tmp_path/'owner-data'/'command-sandboxes').glob('*/container.json'))
            if records:
                record=json.loads(records[0].read_text())
                state=runner._call(policy['executable'],policy['endpoint'],['inspect','--format','{{.State.Running}}',record['container']]).strip()
                if state=='true':break
            time.sleep(.1)
        assert record and process.poll() is None
        process.kill();process.wait(timeout=10)
        deadline=time.monotonic()+25
        while time.monotonic()<deadline:
            inspected=subprocess.run(runner._args(policy['executable'],policy['endpoint'],['inspect',record['container']]),capture_output=True)
            if inspected.returncode:break
            time.sleep(.2)
        assert inspected.returncode != 0
    finally:
        if process.poll() is None:process.kill();process.wait(timeout=10)
        if record:
            subprocess.run(runner._args(policy['executable'],policy['endpoint'],['rm','--force',record['container']]),capture_output=True)

def test_live_executable_bits_survive_archive_and_posix_copyback(runtime):
    runner,policy,work=runtime; captured=[]; original=runner._archive
    (work/'script.sh').write_text('#!/bin/sh\necho existing\n');(work/'script.sh').chmod(0o640)
    def archive(*args):
        value=original(*args);captured.append(value[1]);return value
    runner._archive=archive
    result=runner.run(policy,work,{'command':'chmod +x script.sh; printf "#!/bin/sh\\necho new\\n" > new.sh; chmod +x new.sh'},'modes',threading.Event(),lambda _:None)
    assert result['command']['exitCode']==0
    assert captured[0]['script.sh'] & 0o111 and captured[0]['new.sh'] & 0o111
    if os.name!='nt':
        assert (work/'script.sh').stat().st_mode & 0o777 == 0o751
        assert (work/'new.sh').stat().st_mode & 0o111 == 0o111
