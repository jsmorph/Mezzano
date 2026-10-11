from pathlib import Path
import argparse
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--port', default='4005')
parser.add_argument('--implementation', default='Mezzano')
config = parser.parse_args()

root = Path(__file__).resolve().parent
client = str(root / 'lispm-eval')
package = 'LISPM-EVAL-TEST-' + str(time.time_ns())


def run(source, *, options=(), stdin=False, status=0):
    args = [client, '--port', config.port, *options]
    if not stdin:
        args.append(source)
    result = subprocess.run(args, input=source if stdin else None,
                            text=True, capture_output=True, timeout=15)
    assert result.returncode == status, (args, result.returncode, result.stdout, result.stderr)
    if status == 0:
        assert not result.stderr, result.stderr
    return result


assert run('(+ 1 2)').stdout == '3\n'
assert config.implementation in run('(lisp-implementation-type)').stdout
print('PASS arithmetic and guest identity', flush=True)

assert run('(format t "hello λ~%") (values 42 "café")', stdin=True).stdout == 'hello λ\n42\n"café"\n'
assert run('(values)').stdout == ''
print('PASS stdin, UTF-8, output, and multiple values', flush=True)

run(f'(defpackage :{package} (:use :cl)) (in-package :{package}) '
    '(defparameter *value* 41) (defun next-value () (incf *value*)) (values)', stdin=True)
try:
    assert run('(next-value)', options=('--package', package)).stdout == '42\n'
    print('PASS definitions and state across connections', flush=True)

    failure = run('(unwind-protect (progn (format t "before~%") '
                  '(error "deliberate eval test")) (setf *value* 99))',
                  options=('--package', package), status=1)
    assert failure.stdout == 'before\n', failure.stdout
    assert 'deliberate eval test' in failure.stderr, failure.stderr
    assert run('*value*', options=('--package', package)).stdout == '99\n'
    print('PASS condition reporting, preceding output, and unwind cleanup', flush=True)
finally:
    run(f'(delete-package :{package})')

assert run('(', status=1).stderr
assert 'No package named' in run('t', options=('--package', package), status=1).stderr
assert run('(+ 20 22)').stdout == '42\n'
print('PASS reader errors, missing packages, and recovery', flush=True)

output = run('(dotimes (i 220) (format t "~D~%" i) (finish-output)) (values)', stdin=True).stdout
assert output == ''.join(f'{i}\n' for i in range(220))
assert run('(make-string 100000 :initial-element #\\x)').stdout == '"' + 'x' * 100000 + '"\n'
print('PASS Swank flow control and large replies', flush=True)

assert 'Timed out' in run('(sleep 2)', options=('--timeout', '1'), status=124).stderr
assert run('(+ 3 4)').stdout == '7\n'
print('PASS timeout reporting and subsequent evaluation', flush=True)
