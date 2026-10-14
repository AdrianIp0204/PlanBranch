# PlanBranch 0.3.1 — verification and release recovery

This patch tightens source verification, planning authority and release preparation.
The public 0.3.0 release and its tags and assets remain unchanged.

## Changes

- Verification is bound to the captured candidate source and preserves the
  distinction between agent reports, local observations and human review.
- Source drift and changed task intent cannot silently reuse earlier approval or
  acceptance. Existing interrupted operations retain their original recovery bounds.
- Concurrent execution polling and journal writes are serialized, preventing a
  Windows file-sharing race while retaining pending commands and no-replay rules.
- Handoffs prefer the explicitly selected execution repository, freeze its identity
  and preserve planning-only exports for ordinary scanner folders. A separate
  verify-without-editing action checks an exact imported candidate without a provider.
- Prerequisite summaries use the same local evidence rules as execution previews.
  Comparison shows name, blocker and other approval-affecting changes as readable
  field differences under the existing semantic scope policy.
- Release preparation uses the exact wheel and portable ZIP tested by both-platform
  CI and the standalone Windows smoke test. The real Ubuntu Docker gate is required.
  It never rebuilds binaries after certifying a previous workflow's tests.
- Preparation can resume an owned draft and matching partial uploads. It refuses
  different tags or asset bytes, unrelated drafts, public releases and API errors.
  Publishing is a separate explicit workflow choice after every asset is verified.

## Installation and upgrade

When this version is published, extract `PlanBranch-0.3.1-windows-x64.zip` into a new
folder and run `planbranch.cmd`, or install `flowdesk-0.3.1-py3-none-any.whl` with
Python 3.14 or newer. Stop the existing application and back up its data directory,
including execution worktrees, before upgrading. Do not overwrite a running install.

The receipt `release-manifest.json` records the source commit, checks run and attempt,
immutable candidate identity, required gates and artifact hashes. Compare downloads
with `SHA256SUMS.txt`. Drafts and CI artifacts are prepared builds, not public releases.

## Validation status

The release workflow refuses publication until the exact source commit has a
successful push/dispatch checks run containing its tested artifact bundle. Patch
preparation and regression tests do not by themselves establish public availability.
