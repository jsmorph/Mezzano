import argparse
import importlib.util
from pathlib import Path
import time

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=4006)
args = parser.parse_args()
spec = importlib.util.spec_from_file_location("transport", Path(__file__).with_name("web") / "server.py")
transport = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transport)

client = transport.Swank("127.0.0.1", args.port, time.monotonic() + 90)
try:
    try:
        client.rpc([transport.Symbol("swank:eval-and-grab-output"),
                    "(lispm-package-lock-debugger-test::overflow)"])
    except transport.ProtocolError as error:
        assert "SWANK entered its debugger" in str(error) and "Stack overflow" in str(error), str(error)
    else:
        raise AssertionError("Expected SLDB stack-overflow entry.")
finally:
    client.close()

client = transport.Swank("127.0.0.1", args.port, time.monotonic() + 90)
try:
    source = """(progn
 (assert (plusp lispm-package-lock-debugger-test::*overflow-cleanups*))
 (assert (null (mezzano.debug:debugger-stops :include-closed t)))
 (assert (null (mezzano.debug:evaluation-jobs)))
 (prog1 (list :package-stack-overflow-recovered
              lispm-package-lock-debugger-test::*overflow-cleanups* 42)
  (setf lispm-package-lock-debugger-test::*overflow-cleanups* 0)))"""
    result = client.rpc([transport.Symbol("swank:eval-and-grab-output"), source])
    assert ":PACKAGE-STACK-OVERFLOW-RECOVERED" in result[1], result
    print(result[1])
finally:
    client.close()
