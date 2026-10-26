# Offline evaluation fixtures

Start with [the evaluation protocol](../../docs/portfolio/EVALUATION.md) and
[the 115-second demo](../../docs/portfolio/DEMO.md).

- `tasks.json`: three fixed specifications, baseline files and intentionally
  selected candidates. Candidate text is not a model output.
- `oracle.py`: independent assertion groups, outside candidate repositories.
- `importer.planbranch.json`: ordinary portable plan with a design decision,
  linked diagram and two dependent tasks. No repository, approval, grant or result.
- `trial-template.json`: empty recording form for future empirical trials. Null
  fields mean not observed; it is not a result record.

Run from the repository root:

```powershell
.\.venv\Scripts\python.exe scripts/portfolio_evaluation.py --output output/portfolio-evaluation.json
```

All repositories and SQLite state are newly created temporary fixtures. No model
calls or production data are involved. The script invokes fixed trusted Python
checks; do not use this test runner to execute untrusted submissions.
