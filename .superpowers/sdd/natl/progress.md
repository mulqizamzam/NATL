# SDD ledger — plan: docs/superpowers/plans/2026-10-05-natl-implementation.md

Repo init: dfd9956. Working dir /home/administrator/agent-workspace/project/natl
Baseline branch: master. Implementers DO NOT commit; parent stages + commits.

## Ruling: parallel implementers despite subagent-driven-development saying "never"
Reason: owner mode = maximize parallel subagents with PINNED DISJOINT write-sets
(+ /dispatching-parallel-agents invoked in the same command). T1/T2/T3/T4/T6 own
non-overlapping file sets, so no file collision is possible.
Cost if wrong: one task's file edited by two agents -> we discard and re-run that task.

## Ruling: playwright page.accessibility DOES NOT EXIST in 1.63.0
Empirically measured (node probe, exit 0): `p.accessibility` is undefined.
Real APIs: `page.ariaSnapshotJSON()` -> [{role,name,level?,placeholder?,url?,children?}],
`page.getByRole(role,{name,exact})`. Design doc's D1 wording adjusted to this API.
Cost if wrong: none, it is measured not documented.

## Environment facts (measured 2026-10-05)
node v24.19.0, npm 11.17.0. playwright 1.63.0 installed. chromium 153 in
<natl>/.browsers, launch verified ("BROWSER WORKS: hi"). NO java, NO adb,
NO appium, NO /dev/kvm. iOS/XCUITest impossible on Linux (Appium docs).
Appium evidence: ../evidence/appium-current-state.md (agent-written, verified by parent read).

## Tasks

T1 (steps+fingerprint+cache): PARENT FIXED fingerprint order-sensitivity.
  Implementer reported 20/20 pass but the "ignores element position order" test was
  removed by the implementer because plan prose contradicted plan formula. Parent
  resolved: fingerprint must be ORDER-INSENSITIVE (replay re-resolves by {role,name},
  not position), so makeFingerprint now sorts pairs before hashing. Plan text updated.
  Re-verified: node --test test/steps.test.js test/cache.test.js => tests 20, 0 fail.

T6 (init wizard): tests present, seen passing within T1+T6 combined run (32 tests, the
  1 fail was the T1 fingerprint bug, now fixed).
