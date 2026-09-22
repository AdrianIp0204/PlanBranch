"""Native permission copy-back, with deterministic isolated-container output."""
import io
import os
from pathlib import Path
import threading
import pytest
import flowdesk.command_runner as module

pytestmark=pytest.mark.skipif(os.name=='nt',reason='POSIX filesystem permissions')

class Watchdog:
    def __init__(self,*args,**kwargs):
        self.stdin=io.BytesIO();self.stdout=io.BytesIO(b'ready\n');self.returncode=0
    def wait(self,timeout=None):return 0


def test_native_copyback_preserves_rw_permissions_and_imports_execute_bits(tmp_path,monkeypatch):
    work=tmp_path/'work';work.mkdir()
    before={'changed.sh':(b'echo old\n',0o640),'chmod-only.sh':(b'echo same\n',0o600),
            'preserve-x.sh':(b'echo unusual\n',0o651),'remove-x.sh':(b'echo remove\n',0o751)}
    for name,(content,mode) in before.items():
        path=work/name;path.write_bytes(content);path.chmod(mode)
    runner=module.DockerCommandRunner(tmp_path/'data')
    def docker(executable,endpoint,args):
        if args[0]=='info':return '{"ID":"fixture","OSType":"linux","SecurityOptions":["seccomp"]}'
        if args[0]=='create':return 'a'*64
        return ''
    monkeypatch.setattr(runner,'_call',docker)
    monkeypatch.setattr(module.subprocess,'Popen',Watchdog)
    monkeypatch.setattr(module,'run_supervised',lambda *args,**kwargs:{'reason':'exited','returncode':0})
    after={name:content for name,(content,_) in before.items()}
    after.update({'changed.sh':b'echo new\n','new.sh':b'echo created\n'})
    modes={'changed.sh':0o755,'chmod-only.sh':0o755,'preserve-x.sh':0o755,'remove-x.sh':0o644,'new.sh':0o755}
    monkeypatch.setattr(runner,'_archive',lambda *args:(after,modes))
    policy={'version':module.POLICY_VERSION,'available':True,'executable':'/fixture/docker','endpoint':'unix:///fixture','daemonId':'fixture','imageId':'sha256:'+'a'*64}
    result=runner.run(policy,work,{'command':'fixture command'},'modes',threading.Event(),lambda _:None)
    assert result['command']['exitCode']==0
    expected={'changed.sh':0o751,'chmod-only.sh':0o711,'preserve-x.sh':0o651,'remove-x.sh':0o640}
    for name,mode in expected.items():assert (work/name).stat().st_mode & 0o777 == mode
    assert (work/'new.sh').stat().st_mode & 0o111 == 0o111
    assert (work/'changed.sh').read_bytes()==b'echo new\n'
