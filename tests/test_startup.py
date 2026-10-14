from argparse import Namespace
import sys

import pytest

from flowdesk import __main__ as launcher


def test_startup_failure_is_logged_in_unicode_space_path(tmp_path, capsys):
    args = Namespace(data_dir=tmp_path / "PlanBranch first run 計劃")
    launcher.startup_failure(args, ModuleNotFoundError("No module named 'waitress'"))
    text = (args.data_dir / "startup.log").read_text(encoding="utf-8")
    assert "ModuleNotFoundError" in text and "waitress" in text
    assert "Startup log" in capsys.readouterr().err


def test_failed_startup_exits_nonzero_with_actionable_message(tmp_path, monkeypatch, capsys):
    def fail(args): raise OSError("Address already in use")
    monkeypatch.setattr(launcher, "_run", fail)
    monkeypatch.setattr(sys, "argv", ["planbranch", "--data-dir", str(tmp_path)])
    with pytest.raises(SystemExit) as exc: launcher.main()
    assert exc.value.code == 1
    assert "--port" in capsys.readouterr().err
