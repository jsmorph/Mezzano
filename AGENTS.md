# Mezzano development

After compaction, read this file again.

## Decision procedure

Simplicity is the greatest virtue.

On 2026-10-12, the user authorized the entire debugger, headless-system, and QEMU host-control agenda under this procedure.  Apply it explicitly to every further design decision and proposed approval:

1. Review the relevant implementation, authoritative documentation, prior decisions, and test evidence.
2. Prefer the simplest design that satisfies the required behavior.  Start with existing mechanisms and determine the cause of failures.
3. Make a concrete recommendation, review the whole change, and revise the recommendation.  Explain the final recommendation and its consequences.
4. Record the final recommendation, rationale, evidence, and required tests in the development journal before proceeding.
5. Proceed with the recommendation under the user's standing authorization.

This authorization supersedes the earlier requirement for separate user approval of each design decision within this agenda.  Essential missing information still requires a question.  Ask one question at a time, with a recommendation.

The authorized agenda continues across increments, commits, restarts, and compactions.  After testing and committing an increment, proceed to the next unfinished item.  End agenda work when its requirements are satisfied or when the user directs a pause.

Bare-metal FEP work remains deferred.

## Implementation and reporting

Development runs through `tailscale ssh minideb2`.  The Mezzano checkout is `/home/somebody/src/mezzano-boot/Mezzano`, and the Slime checkout is `/home/somebody/src/mezzano-boot/home/slime`.  Both use the `debugging` branch.  The main guest uses SWANK host port 4021 and native HTTP port 8765, with HTTP port 8769 as an alias.  The preserved earlier guest uses SWANK port 4006 and HTTP port 8771.  The original VM uses SWANK port 4005.

The accepted rebuilt guest uses SWANK 4024 and native HTTP 8776/8777.  Its current launch receipt is `/home/somebody/src/mezzano-boot/cold-debug-add32-20261020/accepted-checkpoint/captured-pause/resumed-vm-launch.json`.  Its cold core is 09cbd1c8, with three recorded ordinary updates: BUILD-CFG, dependency/HOME/cache, and COMPILE-FILE worker shutdown.  The compiler update receipt is /home/somebody/src/mezzano-boot/cold-debug-add32-20261020/compiler-worker-update/ready.json.  Use this guest for further debugger work.  Preserve the original main world at 4021 and 8765/8769.

The cold foothold candidate at `/home/somebody/src/mezzano-boot/cold-foothold-20261020/` is stopped after a GC panic during fresh Ironclad compilation.  Its first ten native phases passed cold, and the remaining six passed after the resident notifier correction.  The continuation error correction and ordinary compiler THE/control-flow correction subsequently passed their stated native tests.  Its last runtime metadata is `optimizer-diagnostic/vm-runtime.json`: two resident updates and one ordinary compiler update.  The failure logs, registers, selected raw memory, forwarding chain, and hashes are preserved under `module-failure/`.  The image does not contain those latest live updates.  HTTP/HTTPS, saved-state, and browser acceptance remain incomplete.  Do not describe this candidate as accepted.

The cold runtime-correction guest uses SWANK 4025, GDB 1254, and HTTP forwards 8778/8779.  Its launch receipt is `/home/somebody/src/mezzano-boot/cold-runtime-corrections-20261020/vm-launch.json`: PID 1109504, start ticks 97176693.  Its fresh cold source is ca303127, including the notifier, continuation error, compiler THE/control-flow, and forwarded-target GC metadata corrections.  The build, image-header, and first-boot checks passed.  Native, HTTP/HTTPS, saved-state, and browser acceptance remain required.  The GC test copy is saved and stopped at `/home/somebody/src/mezzano-boot/gc-forwarding-test-20261020/stopped-snapshot.json`; its read-only image SHA-256 is 41dc3641a1a9336e7419c4c797d3072e11293988d047a8fce48cdde9cb902253.  Its restart remains untested.  The original accepted image remains paused and unchanged at `/home/somebody/src/mezzano-boot/cold-debug-add32-20261020/accepted-checkpoint/cold-foothold-pause/snapshot.json`.  Revalidate every owned launch receipt, including restoration launches, before restoring the accepted guest or starting another memory-intensive process.

System service administration uses the established `tailscale ssh root@minideb2` account.  Root SSH access was verified on 2026-10-15.  Use that account for authorized changes to root-owned service files and service restarts.

Read the repository README and relevant documentation before changing an implementation.  Read documentation again after editing it.  Keep debugger implementation, compiler changes, clients, and new tests in Lisp where the existing system permits it.  Minimize dependencies.

Load ordinary debugger, evaluator, Command Processor, SWANK, and test modules with LOAD's default allocation policy, as the image builder does.  Reserve explicit :WIRED T for supervisor/runtime code whose execution context requires resident code and data.  The wired area is collected but cannot compact or grow to satisfy every request.  Do not force ordinary publication and test data into that area.

Before replacing resident function definitions, retain every existing function object that will be replaced before compiling or loading.  Keep those publication roots through GC and Snapshot until all old activations have ended.  Supervisor and idle stacks are excluded from ordinary GC scanning.

Complete a bounded increment, test its behavior, document it, commit, and push.  Review the changes before committing.  Commit headlines start with a capital letter, contain fewer than 60 characters, and have no final period.

Use `collaboration.followup_task` to resume a completed agent.  `collaboration.send_message` queues text without starting a new turn.  Verify running status before reporting delegated execution as started.

The development journal is Mezzano's `tools/swank/devnotes.md`.  Record decisions, diagnoses, failures, test scope, and evidence there.  Keep historical findings distinct from current implementation status.

A completion claim requires the implementation and the stated tests to pass.  Identify supported architectures, compilation policies, and stopping states.  Distinguish implemented behavior, source inspection, proposed behavior, and untested cases.  Report failures and unresolved work.
