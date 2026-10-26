# Evaluation: protocol, deterministic evidence and open questions

**Empirical direct-AI versus PlanBranch comparison: NOT YET CONDUCTED.** No model
calls, study participants or human review timings were collected in this audit.
The fixtures below test workflow mechanisms with deliberately selected inputs;
they do not measure AI quality, productivity, user comprehension or safety rates.

## Research questions

1. Does PlanBranch make requirement-to-change-to-test traceability clearer to a
   reviewer than a direct coding-agent workflow?
2. Does it help reviewers identify unrequested or insufficiently verified changes?
3. Does it improve review clarity and recovery after an interrupted coding task?

The motivating hypothesis is that explicit states and source-bound evidence help
human oversight. A competing hypothesis is that extra planning, approval and
review steps cost more effort than they save on small tasks. Both remain open.

## Reproducible instrument

[portfolio_evaluation.py](../../scripts/portfolio_evaluation.py) creates three
fresh temporary Git repositories and SQLite stores. It exercises the **real**
`PlanningService`, `ExecutionService`, `GitWorkspace` and portable exporter with
an injected executor that writes fixed bundled text. No provider is contacted;
there is no model, prompt sampling or general command-execution agent. The only
commits are fixed baseline commits inside those disposable repositories.

The fixed [task specifications](../../examples/evaluation/tasks.json) contain
baseline and candidate bytes. An [independent oracle](../../examples/evaluation/oracle.py)
lives outside each candidate repository. It was authored in this audit, fixed
before scoring, and is independent of candidate-editable files, not independently
authored by an external evaluator. A Python subprocess using isolated-import mode
(`-I`, not an OS sandbox) runs three prewritten assertion groups per task. Candidate SHA-256 identities are
recorded before and after the checks; the runner disables bytecode writes.

| Task | Requirements and design decision | Deliberate diagnostic case |
| --- | --- | --- |
| Record importer | Save valid identifiers once; skip missing/empty/whitespace identifiers; continue mixed batches. Validate before storage. Counting successful writes is a second task dependent on validation. | Correct fixed candidate; script separately accepts, completes and applies to its disposable checkout. A dependent run still requires a user commit. |
| Pagination | Zero-based pages, strict integer/range validation and empty out-of-range results. Reject invalid values instead of clamping. | Functional tests pass but the fixed candidate also disables `auditLogging` in `settings.json`, outside the allowed files. Script withholds acceptance. |
| JSON export | Sorted compact output, readable Unicode and rejection of NaN/infinity. Use the standard encoder. | Test double reports interruption after a partial edit; non-finite numbers remain accepted. The candidate survives service reopen and is not rerun or accepted. |

The harness does not supply a real human decision. `scriptedReviewDecision`
records an action selected in the fixture specification. Likewise, `traceLinks`
are predeclared mappings, not automatically discovered semantic relationships.
The unexpected-file calculation belongs to the evaluation harness: it is **not**
a claim that PlanBranch automatically detects every unrequested modification.

External oracle checks are actual local observations, but are **not PlanBranch
authenticated immutable verification**. They are kept in the public receipt;
the production run's command evidence stays empty. This avoids presenting an
ordinary host test as a sandbox-enforced, host-sealed verification result.

## Reproduction

Use the normal source environment from the [README](../../README.md): Python
3.14, installed locked project dependencies, and Git. This harness adds no package
or service dependency. It runs trusted bundled code, not untrusted submissions.

```powershell
.\.venv\Scripts\python.exe scripts/portfolio_evaluation.py --output output/portfolio-evaluation.json
.\.venv\Scripts\python.exe -m pytest -q tests/test_portfolio_evaluation.py
```

On Linux, use `.venv/bin/python` instead. All execution repositories and grants
exist only under a newly created temporary directory and are removed afterward.
There is intentionally no option to nominate an existing repository. The receipt
contains relative filenames, source/candidate hashes and booleans, not temporary
machine paths or database records. `--export-plan output/importer.planbranch.json`
also emits ordinary importable content without approvals, repository attachment,
execution records or verification results. A ready-made copy is in
[examples/evaluation/importer.planbranch.json](../../examples/evaluation/importer.planbranch.json).

## Recorded fixture evidence

The machine-readable [deterministic receipt](evidence/deterministic-evaluation.json)
is the result record, including each assertion outcome, candidate identity,
baseline commit and boundary observation. Its source fingerprint covers backend
Python, migrations and prompts, frontend source, the harness, oracle and task
specifications; `sourceHead` alone does not identify uncommitted work. Fingerprint
and HEAD are captured before and after each full evaluation; a difference marks
the receipt invalid and makes the CLI fail. Use a stable checkout. Re-run on
changed source. The receipt is not a certificate for a later checkout or release.

The expected negative cases are part of instrument validation: a passing
functional test suite can coexist with an unrequested settings change, and an
interrupted edit can preserve useful work while failing an acceptance criterion.
The harness must retain those failures rather than change checks to obtain an
all-green candidate score. See the receipt for actual counts and the final
[evidence register](EVIDENCE_REGISTER.md) for source-wide validation.

The completed Windows fixture run recorded these outcomes (three baseline checks
and three candidate checks per task):

| Fixture | Baseline oracle groups passing | Candidate oracle groups passing | Unrequested files | Service-boundary observations |
| --- | --- | --- | --- | --- |
| Importer | 1/3 | 3/3 | 0 | 14/14 |
| Pagination | 2/3 | 3/3 | 1 (`settings.json`) | 8/8 |
| Interrupted JSON export | 0/3 | 2/3 | 0 | 10/10 |

These are 18 actual oracle-group outcomes and 32 passing boundary observations
for fixed scenarios. They are not 18 AI trials, not a comparative effect size,
and not a probability of correctness. Pagination's acceptance was withheld by
the scripted policy despite all its functional groups passing.

An initial harness attempt failed before candidate execution with SQLite's
`database or disk is full`; the host reported zero free bytes. That attempt yielded
no usable fixture metrics and is an environment limitation, not an AI trial.
Subsequent completed runs must be identified through their receipts rather than
silently replacing that fact with a claim that every attempt succeeded.

## Proposed empirical comparison

Use the three baseline tasks above, with the same requirements and allowed files,
but **do not provide the fixed candidates to the coding agent**. Before running,
freeze task/oracle hashes, model identifier and provider version, temperature and
sampling controls when supported, context, tool definitions, filesystem/network
permissions, budgets, machine image and evaluation rubric. Keep the independent
oracle outside agent-editable files. Both conditions receive identical task text
and visible test examples; both are evaluated by the same withheld oracle.
For the importer comparison, score only the validation task. The later counting
task demonstrates a dependency and is outside implementation scope in both arms.

- **Direct condition:** the chosen coding agent works from the task specification
  in a disposable checkout and produces its diff, transcript and check output.
- **PlanBranch condition:** the same model uses a human-reviewed brief, visual
  plan and tasks, explicit one-task authorization, diff/evidence review and
  deliberate acceptance/application. Record planning, approval and interaction
  effort as part of its cost.

Match effective tools and runtime permissions, not just model names. If matching
is impossible, report the difference as a confound; do not attribute its effect
to visual planning. Exclude neither failures nor refused runs. Log reasons and
retain the original source state and artifacts for every attempt.

For an exploratory coding comparison, pre-register five independent attempts per
task per condition (30 runs), randomized within task. This is a modest pilot, not
a power calculation or an assurance of generalizability. For review usability,
recruit at least six consenting reviewers with recorded programming experience.
Counterbalance condition/task order and use equivalent task variants so a person
does not review the identical patch twice. Use neutral task labels and hide
condition when judging code correctness; workflow usability cannot be fully
blinded. Predefine a stopping rule and retain timeouts and incomplete reviews.

Use [trial-template.json](../../examples/evaluation/trial-template.json) to record
actual evidence. `null` means unobserved, never zero. Store only disposable sources
and consented, pseudonymous observations. This audit does not initiate paid trials.

## Metrics fixed before empirical measurement

| Metric | Definition and denominator | Ground truth / caution |
| --- | --- | --- |
| Requirement coverage | Number of stated criteria adjudicated satisfied / all stated criteria. Report counts as well as proportions. | Independent tests plus a reviewer rubric; passing tests alone is only test coverage evidence. |
| Independent correctness | Passing fixed oracle groups / total applicable groups, plus execution errors and timeouts. | Versioned oracle reviewed separately; do not edit it after observing outcomes without declaring a new experiment. |
| Unrequested modifications | Count changed files outside the allowed-file list; separately count reviewer-adjudicated out-of-scope hunks inside allowed files. | File comparison is deterministic; semantic hunk labels need two reviewers and disagreement reporting. |
| Evidence completeness | For each criterion, count present fields among requirement/task ID, candidate hash, relevant changed file/hunk, observed check with outcome/provenance, and review rationale: present / (5 × criteria). | Presence is not truth; separately report stale identities, failed checks and external-only reports. |
| Traceability accuracy | Correct requirement→change→check links / all submitted links; report missing required links separately. | Prewritten task rubric and two human adjudicators; false links must not receive credit. |
| Review time | Active seconds from first opening the review packet to an explicit accept/reject/needs-work decision; record pauses separately. | Human observation only; report median and spread, decision accuracy and incomplete reviews alongside time. |
| Unresolved decisions | Count rubric-required design choices still unspecified or disputed at the review decision. | Define required choices in advance; extra verbosity is not automatic resolution. |
| Recovery success and time | Fraction of interrupted trials that reach an independently passing, explicitly reviewed result within the fixed recovery budget; elapsed active recovery time. | Inject interruption at a matched observable milestone. Preserve failed/censored trials; merely recovering files is a different outcome. |
| Workflow overhead | Active planning, approval, review and application time plus user interaction count, provider calls/tokens and errors. | Costs may rise even when traceability improves. Do not omit setup costs. |

No model-generated judge is authoritative. Two reviewers independently label
semantic coverage, scope and traceability; publish agreement and adjudication
rules. Summarize paired differences by task and reviewer and show raw observations.
Any uncertainty interval from this small pilot must be described as exploratory.

## Limitations and possible adverse results

The three small Python tasks do not represent large repositories, unfamiliar
frameworks, concurrent development, provider instability or long-running agents.
The deterministic candidates were chosen by the instrument author and cannot
estimate real failure frequencies. The interruption is a test-double status,
not an OS process kill or full power-loss experiment. SQLite/worktree persistence
is exercised; platform sandbox enforcement is not established by these fixtures.

Matching a model does not control nondeterministic provider behavior. Learning,
reviewer familiarity, extra attention, visible workflow condition and task order
can change review time. Traceability annotations can be wrong even when present.
The current brief has one requirement paragraph, not a fully structured
requirement graph. A person can knowingly accept insufficiently tested work;
explicit review states do not prove the decision was sound.

PlanBranch may impose substantial overhead on tiny changes. A valuable result
could be improved evidence completeness with unchanged correctness and slower
review. Another could be no measurable benefit. Both should be reported.
