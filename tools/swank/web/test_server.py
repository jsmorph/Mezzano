import argparse
import http.client
import json
import secrets
import socket
import threading
import time
import unittest
from unittest import mock

import server


class ProtocolTests(unittest.TestCase):
    def test_strings_and_values(self):
        text = 'lambda λ, 中文, "quoted", slash \\, line\nnext'
        self.assertEqual(server.parse(server.lisp(text)), text)
        self.assertEqual(server.json_value(server.parse(
            '(:state :returned :values nil :locals ((:name "X" :available-p nil :value nil) '
            '(:name "Y" :available-p t :value "NIL")))')),
            {"state": ":returned", "values": None,
             "locals": [{"name": "X", "available-p": None, "value": None},
                        {"name": "Y", "available-p": True, "value": "NIL"}]})
        for malformed in ["#.(quit)", "(a . b)", '"missing', "(a", "a b", ")"]:
            with self.subTest(malformed=malformed):
                with self.assertRaises(server.ProtocolError):
                    server.parse(malformed)

    def test_fragmented_utf8_packet(self):
        reader, writer = socket.socketpair()
        connection = object.__new__(server.Swank)
        connection.socket = reader
        connection.deadline = time.monotonic() + 3
        payload = '(:return (:ok "λ中文") 1)'.encode()
        packet = f"{len(payload):06x}".encode() + payload
        def send():
            with writer:
                for byte in packet:
                    writer.sendall(bytes([byte]))
        thread = threading.Thread(target=send)
        thread.start()
        try:
            self.assertEqual(connection.receive()[1][1], "λ中文")
        finally:
            connection.close()
            thread.join()

    def test_typed_arguments(self):
        session = "a" * 64
        stop = [":stop", session, 1]
        for command in ("current-frame", "top-frame", "bottom-frame", "arglist"):
            with self.subTest(command=command):
                self.assertEqual(server.operation_arguments("submit",
                    {"stop": stop, "id": 0, "command": command}, session)[2:],
                    [server.Symbol(":" + command), None])
                with self.assertRaises(ValueError):
                    server.operation_arguments("submit",
                        {"stop": stop, "id": 0, "command": command, "argument": 0}, session)
        for command in ("select-frame", "next-frame", "previous-frame"):
            for argument in (0, 1):
                with self.subTest(command=command, argument=argument):
                    self.assertEqual(server.operation_arguments("submit",
                        {"stop": stop, "id": 0, "command": command, "argument": argument}, session)[2:],
                        [server.Symbol(":" + command), argument])
            for argument in (None, True, -1, "0", 1.5):
                with self.subTest(command=command, argument=argument), self.assertRaises(ValueError):
                    server.operation_arguments("submit",
                        {"stop": stop, "id": 0, "command": command, "argument": argument}, session)
        self.assertEqual(server.operation_arguments("submit",
            {"stop": stop, "id": 0, "command": "proceed"}, session),
            [[server.Symbol(":stop"), session, 1], 0, server.Symbol(":proceed"), None])
        with self.assertRaises(ValueError):
            server.operation_arguments("submit",
                {"stop": stop, "id": 0, "command": "proceed", "argument": 0}, session)
        for argument in (None, 0, 3):
            with self.subTest(argument=argument):
                self.assertEqual(server.operation_arguments("submit",
                    {"stop": stop, "id": 0, "command": "invoke-restart-with-arguments", "argument": argument}, session),
                    [[server.Symbol(":stop"), session, 1], 0, server.Symbol(":invoke-restart-with-arguments"), argument])
        for argument in (True, -1, "0", [1]):
            with self.subTest(argument=argument), self.assertRaises(ValueError):
                server.operation_arguments("submit",
                    {"stop": stop, "id": 0, "command": "invoke-restart-with-arguments", "argument": argument}, session)
        source = '(values "λ" x)'
        self.assertEqual(server.operation_arguments("submit",
            {"stop": stop, "id": 0, "command": "evaluate", "argument": source}, session),
            [[server.Symbol(":stop"), session, 1], 0, server.Symbol(":evaluate"), source])
        for argument in (None, True, 42, ["x"]):
            with self.subTest(argument=argument), self.assertRaises(ValueError):
                server.operation_arguments("submit",
                    {"stop": stop, "id": 0, "command": "evaluate", "argument": argument}, session)
        with self.assertRaises(ValueError):
            server.operation_arguments("submit",
                {"stop": [":stop", session, 1], "id": 0, "command": "quit"}, session)
        with self.assertRaises(ValueError):
            server.operation_arguments("job-information",
                {"job": [":job", "b" * 64, 1]}, session)
        for arguments in [
            {"source": "🚀", "cursor": 2, "action": "inspect"},
            {"source": "Show File ", "cursor": 10, "action": "insert"},
            {"source": "Help", "cursor": 4, "action": "execute"},
        ]:
            with self.subTest(arguments=arguments):
                with self.assertRaises(ValueError):
                    server.operation_arguments("listener-assistance", arguments, session)
        self.assertEqual(server.operation_arguments("listener-assistance",
            {"source": "🚀", "cursor": 1, "action": "help"}, session)[:3],
            ["🚀", 1, server.Symbol(":help")])
        for operation, arguments in [
            ("save-private-document", {"name": session, "pathname": "x", "topics": "x"}),
            ("save-private-document", {"name": session, "pathname": "x", "topics": [1]}),
            ("save-private-document", {"name": "bad", "pathname": "x", "topics": []}),
            ("read-private-document", {"pathname": 1}),
            ("document-query", {"action": "topic"}),
            ("document-query", {"action": "search"}),
            ("document-query", {"action": "search", "query": "x", "mode": "unknown"}),
            ("document-query", {"action": "catalog", "adjacent": "yes"}),
            ("document-assistance", {"source": "🚀", "cursor": 2, "action": "help"}),
        ]:
            with self.subTest(operation=operation, arguments=arguments):
                with self.assertRaises(ValueError):
                    server.operation_arguments(operation, arguments, session)
        self.assertEqual(server.operation_arguments("document-assistance",
            {"source": "🚀", "cursor": 1, "action": "help"}, session),
            ["🚀", 1, server.Symbol(":help")])
        self.assertEqual(server.operation_arguments("save-private-document",
            {"name": session, "pathname": "🚀.psb", "topics": ["a", "b"]}, session),
            [session, "🚀.psb", ["a", "b"]])
        self.assertEqual(server.operation_arguments("read-private-document",
            {"pathname": "x.psb"}, session), ["x.psb"])
        with self.assertRaises(ValueError):
            server.integer(True)


    def test_control_record_arguments(self):
        session = "a" * 64
        stop = [":stop", session, 1]
        for command in ("handlers", "catches"):
            for argument in (None, False, True):
                with self.subTest(command=command, argument=argument):
                    result = server.operation_arguments("submit",
                        {"stop": stop, "id": 2, "command": command, "argument": argument}, session)
                    self.assertEqual(result[2:], [server.Symbol(":" + command), bool(argument)])
                    self.assertEqual(server.lisp(result[3]), "t" if argument else "nil")
            for argument in (0, 1, "Yes", [], [True], {}):
                with self.subTest(command=command, argument=argument), self.assertRaises(ValueError):
                    server.operation_arguments("submit",
                        {"stop": stop, "id": 2, "command": command, "argument": argument}, session)

    def test_binding_arguments(self):
        session = "a" * 64
        stop = [":stop", session, 1]
        def submit(argument):
            return server.operation_arguments("submit",
                {"stop": stop, "id": 2, "command": "bindings", "argument": argument}, session)[3]
        self.assertIsNone(submit(None))
        for all_frames in (None, False, True):
            for matching in ("", "*λ-probe*"):
                with self.subTest(all_frames=all_frames, matching=matching):
                    result = submit([all_frames, matching])
                    self.assertEqual(result, [bool(all_frames), matching])
                    self.assertEqual(server.lisp(result), server.lisp([all_frames, matching]))
        for argument in (True, 0, "", [], [True], [True, "", 0], [0, ""], [1, ""],
                         ["Yes", ""], [[], ""], [False, None], [False, 0], [False, []]):
            with self.subTest(argument=argument), self.assertRaises(ValueError):
                submit(argument)

    def test_inspection_arguments(self):
        session = "a" * 64
        stop = [":stop", session, 1]
        def submit(command, argument):
            return server.operation_arguments("submit",
                {"stop": stop, "id": 2, "command": command, "argument": argument}, session)[3]
        for command in ("inspect", "describe-object", "clear-inspection"):
            self.assertIsNone(submit(command, None))
        self.assertEqual(submit("describe-object", [":object", session, 3]),
                         [server.Symbol(":object"), session, 3])
        for command, kind in (("inspect", "object"), ("modify", "part")):
            reference = [":" + kind, session, 3]
            for start, count in ((0, 1), (64, 32), (70, 64)):
                argument = [reference, start, count]
                self.assertEqual(submit(command, argument), argument)
            for argument in (True, 3, [], [reference], [reference, 0, 1, 2],
                             [reference, -1, 32], [reference, True, 32],
                             [reference, 0, 0], [reference, 0, 65], [reference, 0, True],
                             [[":frame", session, 3], 0, 32],
                             [[":" + kind, "b" * 64, 3], 0, 32]):
                with self.subTest(command=command, argument=argument), self.assertRaises(ValueError):
                    submit(command, argument)
        for command, argument in (("modify", None), ("clear-inspection", 0),
                                  ("describe-object", [":part", session, 3]),
                                  ("describe-object", 3)):
            with self.subTest(command=command, argument=argument), self.assertRaises(ValueError):
                submit(command, argument)

    def test_optional_argument_types(self):
        name = "a" * 64
        job = [":job", name, 1]
        cases = [
            ("stops", {}, "include_closed"),
            ("start-listener", {"name": name, "source": "(values)"}, "interactive"),
            ("start-evaluation", {"name": name, "source": "(values)"}, "interactive"),
            ("job-input", {"job": job, "offset": 0, "text": ""}, "eof"),
            ("document-query", {"action": "search", "query": "Lisp"}, "adjacent"),
        ]
        for operation, arguments, field in cases:
            with self.subTest(operation=operation, field=field):
                self.assertIs(server.operation_arguments(operation, arguments, name)[-1], False)
                for value in (False, True):
                    self.assertIs(server.operation_arguments(operation,
                        {**arguments, field: value}, name)[-1], value)
                for value in (None, 0, 1, "false", []):
                    with self.subTest(value=value), self.assertRaises(ValueError):
                        server.operation_arguments(operation, {**arguments, field: value}, name)
        for field in ("package", "input"):
            arguments = {"name": name, "source": "(values)"}
            for value in ("", "λ"):
                values = server.operation_arguments("start-evaluation", {**arguments, field: value}, name)
                self.assertEqual(values[values.index(server.Symbol(":" + field)) + 1], value)
            for value in (None, 0, False, []):
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    server.operation_arguments("start-evaluation", {**arguments, field: value}, name)
        for end in (0, 2):
            self.assertEqual(server.operation_arguments("job-output",
                {"job": job, "start": 0, "end": end}, name)[-1], end)
        for end in (None, True, -1, 0.5, "0"):
            with self.subTest(end=end), self.assertRaises(ValueError):
                server.operation_arguments("job-output", {"job": job, "start": 0, "end": end}, name)

    def test_monitor_offsets(self):
        name = "a" * 64
        self.assertEqual(server.operation_arguments("monitor-state", {}, name), [[]])
        self.assertEqual(server.operation_arguments("monitor-state",
            {"offsets": [{"name": name, "start": 3}]}, name), [[[name, 3]]])
        for arguments in [
            {"offsets": None}, {"offsets": {}}, {"offsets": [1]},
            {"offsets": [{"name": name}]},
            {"offsets": [{"name": "bad", "start": 0}]},
            {"offsets": [{"name": name, "start": True}]},
            {"offsets": [{"name": name, "start": -1}]},
            {"offsets": [{"name": name, "start": 0}] * 2},
        ]:
            with self.subTest(arguments=arguments):
                with self.assertRaises(ValueError):
                    server.operation_arguments("monitor-state", arguments, name)

    def test_remote_decode_failure(self):
        reader, writer = socket.socketpair()
        connection = object.__new__(server.Swank)
        connection.socket = reader
        connection.deadline = time.monotonic() + 3
        try:
            writer.sendall(b"000001\xff")
            with self.assertRaises(server.ProtocolError):
                connection.receive()
        finally:
            writer.close()
            connection.close()

    def test_debugger_abort_drains_original_reply(self):
        reader, writer = socket.socketpair()
        connection = object.__new__(server.Swank)
        connection.socket = reader
        connection.deadline = time.monotonic() + 3
        connection.next_id = 0
        connection.output = []
        received = []
        writer.settimeout(3)
        def packet(text):
            encoded = text.encode()
            writer.sendall(f"{len(encoded):06x}".encode() + encoded)
        def receive(stream):
            header = stream.read(6)
            if len(header) != 6:
                raise AssertionError("Short SWANK test header.")
            count = int(header, 16)
            text = stream.read(count)
            if len(text) != count:
                raise AssertionError("Short SWANK test body.")
            return server.parse(text.decode())
        def guest():
            with writer, writer.makefile("rb") as stream:
                received.append(receive(stream))
                packet('(:debug 7 1 ("Test error") nil nil)')
                received.append(receive(stream))
                packet('(:debug-return 7 1 nil)')
                packet('(:return (:abort "Test error") 1)')
        thread = threading.Thread(target=guest)
        thread.start()
        try:
            with self.assertRaisesRegex(server.ProtocolError, "entered its debugger"):
                connection.rpc([server.Symbol("cl:error"), "Test error"])
        finally:
            connection.close()
            thread.join()
        self.assertEqual(received[1][1], [server.Symbol("swank:throw-to-toplevel")])
        self.assertEqual(received[1][3], 7)

    def test_idle_session_locks_are_removed(self):
        app = server.Application("127.0.0.1", 4006, 2)
        for _ in range(10):
            with app.session_lock(secrets.token_hex(32), time.monotonic() + 2):
                self.assertEqual(len(app.sessions), 1)
            self.assertEqual(app.sessions, {})


class ConnectionTests(unittest.TestCase):
    def setUp(self):
        self.app = server.Application("127.0.0.1", 4006, 15)
        self.name = "a" * 64
        self.connection = mock.Mock(output=[])
        self.connection.transient_request.return_value = None
        self.factory = mock.patch.object(server, "Swank", return_value=self.connection)
        self.factory_mock = self.factory.start()
        self.addCleanup(self.factory.stop)
        self.addCleanup(self.app.close)

    def dispatch(self, operation="jobs"):
        return self.app.dispatch((self.name, operation, []))

    def test_reuse_and_request_reset(self):
        self.connection.deadline = time.monotonic() + 15
        self.connection.rpc.side_effect = lambda form: self.connection.output.append("module output")
        before = time.monotonic()
        self.dispatch()
        self.assertEqual(self.connection.output, ["module output"])
        first_deadline = self.factory_mock.call_args.args[2]
        self.assertGreaterEqual(first_deadline, before + 15)
        self.assertLessEqual(first_deadline, time.monotonic() + 15)
        self.connection.output.append("previous output")
        self.dispatch()
        self.factory_mock.assert_called_once()
        self.connection.rpc.assert_called_once_with(
            [server.Symbol("swank:swank-require"), server.Symbol(":swank-mezzano-debugger")])
        self.assertEqual(self.connection.output, [])
        self.assertGreaterEqual(self.connection.deadline, first_deadline)
        self.connection.close.assert_not_called()

    def test_rejection_keeps_transport_and_release_closes_it(self):
        self.connection.transient_request.side_effect = [server.ServiceError(":invalid-frame"), None, None]
        with self.assertRaises(server.ServiceError):
            self.dispatch()
        self.dispatch()
        self.factory_mock.assert_called_once()
        self.connection.close.assert_not_called()
        self.dispatch("release-session")
        self.connection.close.assert_called_once()
        self.assertEqual(self.app.sessions, {})

    def test_failure_discards_transport_without_replay(self):
        replacement = mock.Mock(output=[])
        replacement.transient_request.return_value = None
        self.factory_mock.side_effect = [self.connection, replacement]
        self.connection.transient_request.side_effect = TimeoutError("Lost reply")
        with self.assertRaisesRegex(TimeoutError, "Lost reply"):
            self.dispatch("start-listener")
        self.connection.transient_request.assert_called_once_with(self.name, "start-listener")
        self.connection.close.assert_called_once()
        self.assertEqual(self.app.sessions, {})
        self.dispatch("resume-session")
        replacement.transient_request.assert_called_once_with(self.name, "resume-session")
        self.assertEqual(self.factory_mock.call_count, 2)

    def test_idle_and_active_connections(self):
        self.dispatch()
        entry = self.app.sessions[self.name]
        entry.last_used = time.monotonic() - 59
        self.app.close_idle()
        self.connection.close.assert_not_called()
        with self.app.session_lock(self.name, time.monotonic() + 1):
            entry.last_used = time.monotonic() - 61
            self.app.close_idle()
            self.connection.close.assert_not_called()
        entry.last_used = time.monotonic() - 61
        self.app.close_idle()
        self.connection.close.assert_called_once()
        self.assertEqual(self.app.sessions, {})

    def test_queued_request_deadline_and_other_session(self):
        self.dispatch()
        entry = self.app.sessions[self.name]
        queued = threading.Event()
        result = []
        def caller():
            queued.set()
            try:
                with self.app.session_lock(self.name, time.monotonic() + .05):
                    result.append("acquired")
            except TimeoutError:
                result.append("expired")
        with self.app.session_lock(self.name, time.monotonic() + 1):
            thread = threading.Thread(target=caller)
            thread.start()
            self.assertTrue(queued.wait(1))
            with self.app.session_lock("b" * 64, time.monotonic() + .05):
                self.assertEqual(len(self.app.sessions), 2)
            entry.last_used = time.monotonic() - 61
            self.app.close_idle()
            self.connection.close.assert_not_called()
            thread.join(1)
            self.assertFalse(thread.is_alive())
            self.assertEqual(result, ["expired"])
            self.assertEqual(entry.users, 1)
        self.assertEqual(entry.users, 0)
        self.assertEqual(len(self.app.sessions), 1)

    def test_server_shutdown_waits_for_active_request(self):
        entered, release, closed, completed = (threading.Event() for _ in range(4))
        def request(*arguments):
            entered.set()
            if not release.wait(3):
                raise TimeoutError("Test caller did not release request")
            completed.set()
            return None
        self.connection.transient_request.side_effect = request
        http_server = server.Server(("127.0.0.1", 0), server.Handler)
        http_server.application = self.app
        http_server.allowed_hosts = {"127.0.0.1"}
        serving = threading.Thread(target=http_server.serve_forever)
        replies = []
        def close():
            http_server.server_close()
            closed.set()
        def client():
            connection = http.client.HTTPConnection("127.0.0.1", http_server.server_port, timeout=3)
            try:
                connection.request("POST", "/api", json.dumps({"session": self.name, "operation": "jobs"}),
                                   {"Content-Type": "application/json", "X-Mezzano-Request": "1"})
                response = connection.getresponse()
                replies.append((response.status, json.loads(response.read())))
            except http.client.RemoteDisconnected:
                replies.append("disconnected")
            finally:
                connection.close()
        caller = threading.Thread(target=client)
        closer = threading.Thread(target=close)
        serving.start()
        caller.start()
        try:
            self.assertTrue(entered.wait(1))
            http_server.shutdown()
            serving.join(1)
            closer.start()
            self.assertFalse(closed.wait(.05))
            self.connection.close.assert_not_called()
        finally:
            release.set()
            http_server.shutdown()
            serving.join(3)
            caller.join(3)
            if closer.ident is not None:
                closer.join(3)
            else:
                http_server.server_close()
        self.assertFalse(caller.is_alive())
        self.assertFalse(closer.is_alive())
        self.assertEqual(replies, ["disconnected"])
        self.assertTrue(completed.is_set())
        self.connection.transient_request.assert_called_once()
        self.connection.close.assert_called_once()

    def test_shutdown_cancels_incomplete_http_requests(self):
        for body in (False, True):
            with self.subTest(body=body):
                entered, stopped, closed, written = (threading.Event() for _ in range(4))
                class Handler(server.Handler):
                    def handle_one_request(self):
                        entered.set()
                        super().handle_one_request()
                http_server = server.Server(("127.0.0.1", 0), Handler)
                http_server.application = server.Application("127.0.0.1", 4006, 15)
                http_server.allowed_hosts = {"127.0.0.1"}
                serving = threading.Thread(target=http_server.serve_forever)
                serving.start()
                connection = socket.create_connection(http_server.server_address, timeout=2)
                prefix = f"POST /api HTTP/1.0\r\nHost: 127.0.0.1:{http_server.server_port}\r\n"
                if body:
                    prefix += "Content-Type: application/json\r\nX-Mezzano-Request: 1\r\nContent-Length: 1000000\r\n\r\n{"
                connection.sendall(prefix.encode())
                def trickle():
                    while not stopped.wait(.01):
                        try:
                            connection.sendall(b" ")
                        except ConnectionError:
                            return
                        written.set()
                sender = threading.Thread(target=trickle)
                def close():
                    http_server.server_close()
                    closed.set()
                closer = threading.Thread(target=close)
                sender.start()
                try:
                    self.assertTrue(entered.wait(1))
                    self.assertTrue(written.wait(1))
                    http_server.shutdown()
                    serving.join(1)
                    closer.start()
                    self.assertTrue(closed.wait(1), "Shutdown waited for incomplete HTTP input")
                    self.assertEqual(http_server.requests, set())
                    self.factory_mock.assert_not_called()
                finally:
                    stopped.set()
                    connection.close()
                    sender.join(2)
                    http_server.shutdown()
                    serving.join(2)
                    if closer.ident is not None:
                        closer.join(2)
                    else:
                        http_server.server_close()
                self.assertFalse(sender.is_alive())
                self.assertFalse(closer.is_alive())

    def test_http_thread_start_failure_releases_request(self):
        http_server = server.Server(("127.0.0.1", 0), server.Handler)
        http_server.application = self.app
        accepted, client = socket.socketpair()
        try:
            with mock.patch.object(threading.Thread, "start", side_effect=RuntimeError("thread start failed")):
                with self.assertRaisesRegex(RuntimeError, "thread start failed"):
                    http_server.process_request(accepted, ("127.0.0.1", 0))
            self.assertEqual(accepted.fileno(), -1)
            self.assertEqual(http_server.requests, set())
            http_server.server_close()
            self.assertTrue(self.app.closed)
        finally:
            accepted.close()
            client.close()
            http_server.server_close()

    def test_http_bind_failure_preserves_original_error(self):
        with socket.socket() as occupied:
            occupied.bind(("127.0.0.1", 0))
            occupied.listen()
            with self.assertRaises(OSError):
                server.Server(occupied.getsockname(), server.Handler)

    def test_shutdown_closes_every_idle_session(self):
        self.dispatch()
        other = mock.Mock(output=[])
        other.transient_request.return_value = None
        self.factory_mock.return_value = other
        self.app.dispatch(("b" * 64, "jobs", []))
        self.app.close()
        self.connection.close.assert_called_once()
        other.close.assert_called_once()
        self.assertEqual(self.app.sessions, {})
        with self.assertRaisesRegex(ConnectionError, "shutting down"):
            self.dispatch()


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http = server.Server(("127.0.0.1", 0), server.Handler)
        cls.http.allowed_hosts = {"127.0.0.1"}
        cls.http.application = server.Application("127.0.0.1", 1, 1)
        cls.thread = threading.Thread(target=cls.http.serve_forever)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join()

    def post(self, headers, data=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.http.server_port, timeout=3)
        try:
            conn.request("POST", "/api", json.dumps(data or {}), headers)
            reply = conn.getresponse()
            body = json.loads(reply.read())
            return reply.status, body
        finally:
            conn.close()

    def raw_post(self, headers, body=b"", end_input=False):
        conn = http.client.HTTPConnection("127.0.0.1", self.http.server_port, timeout=3)
        try:
            conn.putrequest("POST", "/api")
            conn.putheader("Content-Type", "application/json")
            conn.putheader("X-Mezzano-Request", "1")
            for key, value in headers:
                conn.putheader(key, value)
            conn.endheaders(body)
            if end_input:
                conn.sock.shutdown(socket.SHUT_WR)
            reply = conn.getresponse()
            return reply.status, json.loads(reply.read())
        finally:
            conn.close()

    def test_content_length_boundaries(self):
        with mock.patch.object(self.http.application, "dispatch") as dispatch:
            cases = [[], [("Content-Length", "2"), ("Content-Length", "2")],
                     [("Content-Length", "2, 2")], [("Content-Length", "-1")],
                     [("Content-Length", "+2")], [("Content-Length", "2.0")]]
            for headers in cases:
                with self.subTest(headers=headers):
                    status, reply = self.raw_post(headers, b"{}")
                    self.assertEqual(status, 400)
                    self.assertEqual(reply["error"], "Expected one Content-Length.")
                    self.assertIs(reply["uncertain"], False)
            status, reply = self.raw_post([("Content-Length", "3")], b"{}", end_input=True)
            self.assertEqual(status, 400)
            self.assertEqual(reply["error"], "Incomplete HTTP request body.")
            self.assertIs(reply["uncertain"], False)
            status, reply = self.raw_post([("Content-Length", str(server.LIMIT + 1))])
            self.assertEqual(status, 413)
            self.assertEqual(reply["error"], "Request exceeds one MiB.")
            dispatch.assert_not_called()

            name = "a" * 64
            data = {"session": name, "operation": "start-evaluation",
                    "arguments": {"name": name, "source": '"λ"'}}
            body = json.dumps(data, ensure_ascii=False).encode("utf-8")
            body += b" " * (server.LIMIT - len(body))
            self.assertEqual(len(body), 1024 * 1024)
            dispatch.return_value = {"value": "accepted", "diagnostics": []}
            status, reply = self.raw_post([("Content-Length", str(len(body)))], body)
            self.assertEqual(status, 200)
            self.assertEqual(reply, dispatch.return_value)
            dispatch.assert_called_once()
            prepared = dispatch.call_args.args[0]
            self.assertEqual(prepared[:2], (name, "start-evaluation"))
            self.assertEqual(prepared[2][:2], [name, '"λ"'])

    def test_transfer_encoding_rejected(self):
        with mock.patch.object(self.http.application, "dispatch") as dispatch:
            for headers in [[("Transfer-Encoding", "chunked")],
                            [("Transfer-Encoding", "chunked"), ("Content-Length", "5")],
                            [("Transfer-Encoding", "gzip")]]:
                with self.subTest(headers=headers):
                    status, reply = self.raw_post(headers, b"0\r\n\r\n")
                    self.assertEqual(status, 400)
                    self.assertEqual(reply["error"], "Transfer-Encoding is unsupported.")
            dispatch.assert_not_called()

    def test_herald_font_routes(self):
        for name in ("hl8", "5x5"):
            with self.subTest(font=name):
                conn = http.client.HTTPConnection("127.0.0.1", self.http.server_port, timeout=3)
                try:
                    conn.request("GET", f"/fonts/{name}.ttf")
                    reply = conn.getresponse()
                    self.assertEqual(reply.status, 200)
                    self.assertEqual(reply.getheader("Content-Type"), "font/ttf")
                    self.assertEqual(reply.read(), (server.ROOT / "fonts" / f"{name}.ttf").read_bytes())
                finally:
                    conn.close()

    def test_browser_origin_and_host(self):
        good = {"Content-Type": "application/json", "X-Mezzano-Request": "1"}
        cases = [{**good, "Origin": "http://unrelated.example"},
                 {**good, "Host": "unrelated.example:" + str(self.http.server_port)},
                 {"Content-Type": "application/json"},
                 {**good, "Content-Type": "text/plain"},
                 {**good, "Sec-Fetch-Site": "cross-site"}]
        for headers in cases:
            with self.subTest(headers=headers):
                self.assertEqual(self.post(headers)[0], 403)
        self.assertEqual(self.post(good)[0], 400)



    def test_malformed_json_fields(self):
        headers = {"Content-Type": "application/json", "X-Mezzano-Request": "1"}
        name = "a" * 64
        for data in [{"session": name, "operation": []},
                     {"session": name, "operation": "jobs", "arguments": []},
                     {"session": name, "operation": "submit",
                      "arguments": {"stop": [":stop", name, 1], "id": 0, "command": {}}}]:
            with self.subTest(data=data):
                status, reply = self.post(headers, data)
                self.assertEqual(status, 400)
                self.assertIs(reply["uncertain"], False)

    def test_uncertain_remote_reply_over_http(self):
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        listener.settimeout(3)
        previous = self.http.application
        self.http.application = server.Application("127.0.0.1", listener.getsockname()[1], 3)
        received = []
        name = "b" * 64
        def guest():
            connection, _ = listener.accept()
            connection.settimeout(3)
            with connection, connection.makefile("rb") as stream:
                for rpc_id in range(1, 3):
                    header = stream.read(6)
                    if len(header) != 6:
                        raise AssertionError("Short SWANK test header.")
                    count = int(header, 16)
                    text = stream.read(count)
                    if len(text) != count:
                        raise AssertionError("Short SWANK test body.")
                    form = server.parse(text.decode())
                    received.append(form)
                    if rpc_id == 2:
                        connection.sendall(b"000001\xff")
                    else:
                        value = "nil" if rpc_id == 1 else '(:ok "' + name + '")'
                        payload = f"(:return (:ok {value}) {rpc_id})".encode()
                        connection.sendall(f"{len(payload):06x}".encode() + payload)
        thread = threading.Thread(target=guest)
        thread.start()
        try:
            status, reply = self.post(
                {"Content-Type": "application/json", "X-Mezzano-Request": "1"},
                {"session": name, "operation": "start-evaluation",
                 "arguments": {"name": "c" * 64, "source": "(values)"}})
            self.assertEqual(status, 502)
            self.assertIs(reply["uncertain"], True)
            self.assertEqual(len(received), 2)
        finally:
            thread.join()
            listener.close()
            self.http.application.close()
            self.http.application = previous


def live_test(port):
    http_server = server.Server(("127.0.0.1", 0), server.Handler)
    http_server.allowed_hosts = {"127.0.0.1"}
    http_server.application = server.Application("127.0.0.1", port, 15)
    worker = threading.Thread(target=http_server.serve_forever)
    worker.start()
    session = secrets.token_hex(32)
    jobs = []
    owned_stops = []
    print("Fixture session", session, flush=True)

    def request(operation, _expected_error=None, **arguments):
        if operation == "start-evaluation":
            print("Fixture evaluation", arguments["name"], flush=True)
        conn = http.client.HTTPConnection("127.0.0.1", http_server.server_port, timeout=20)
        body = json.dumps({"session": session, "operation": operation, "arguments": arguments})
        try:
            conn.request("POST", "/api", body, {"Content-Type": "application/json",
                         "X-Mezzano-Request": "1",
                         "Origin": f"http://127.0.0.1:{http_server.server_port}"})
            reply = conn.getresponse()
            result = json.loads(reply.read())
            if _expected_error:
                assert reply.status == 409 and result["error"] == _expected_error, result
                assert result["uncertain"] is False, result
                return
            if reply.status != 200:
                raise AssertionError((operation, reply.status, result))
            return result["value"]
        finally:
            conn.close()

    def wait(job, predicate):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            info = request("job-information", job=job)
            if predicate(info):
                return info
            time.sleep(.03)
        raise AssertionError(("Job did not reach expected state", info))

    def stop_for(job):
        info = wait(job, lambda item: bool(item["stops"]))
        stop = info["stops"][0]
        owned_stops.append(stop)
        return stop

    def command(stop, operation, argument=None):
        info = request("information", stop=stop)
        command_id = info["next-command-id"]
        args = {"stop": stop, "id": command_id, "command": operation, "argument": argument}
        assert request("submit", **args) == command_id
        assert request("submit", **args) == command_id
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            result = request("result", stop=stop, id=command_id)
            if result["state"] not in (":pending", ":running"):
                return result
            time.sleep(.02)
        raise AssertionError(("Debugger command timed out", operation, result))

    def restart(stop, name):
        result = command(stop, "restarts")
        assert result["state"] == ":returned", result
        option = next(option for option in result["result"] if option["name"] == name)
        return command(stop, "invoke-restart", option["index"])

    def raw(source):
        connection = server.Swank("127.0.0.1", port, time.monotonic() + 15)
        try:
            return connection.rpc(server.parse(source))
        finally:
            connection.close()

    session_form = f'(cl:gethash {server.lisp(session)} swank/mezzano-debugger::*sessions*)'

    def handle_count():
        return raw(f'(cl:hash-table-count (swank/mezzano-debugger::session-handles {session_form}))')

    def assert_released_monitor_object(kind, value):
        encoded = server.lisp([server.Symbol(value[0]), *value[1:]])
        extra = "(cl:make-hash-table :test (cl:function cl:equal))" if kind == "job" else ""
        result = raw(f'''(swank/mezzano-debugger::with-lock
          (cl:let ((session {session_form}))
            (swank/mezzano-debugger::monitor-{kind} session
              (swank/mezzano-debugger::decode-handle session :{kind} (cl:quote {encoded}))
              {extra})))''')
        assert result is None, (kind, result)

    try:
        connection = server.Swank("127.0.0.1", port, time.monotonic() + 10)
        try:
            with unittest.TestCase().assertRaisesRegex(server.ProtocolError, "entered its debugger"):
                connection.rpc([server.Symbol("cl:error"), "Mezzano HTTP transport abort test"])
        finally:
            connection.close()
        assert request("open-session") == session
        transport = http_server.application.sessions[session].connection
        assert transport.next_id == 2
        name = secrets.token_hex(32)
        source = '(format t "λ中文~%")\n(values 42 :done)'
        job = request("start-evaluation", name=name, source=source)
        jobs.append(job)
        assert request("start-evaluation", name=name, source=source) == job
        info = wait(job, lambda info: info["state"] != ":running")
        assert info["state"] == ":returned", info
        assert info["values"] == ["42", ":DONE"], info
        assert request("job-output", job=job, start=0)["text"] == "λ中文\n"
        assert request("job-output", job=job, start=0)["end"] == 4
        assert request("resume-session") == session
        assert http_server.application.sessions[session].connection is transport
        assert raw(f"(cl:list (swank/mezzano-debugger::session-connection {session_form}) "
                   f"(swank/mezzano-debugger::session-controller {session_form}))") == [None, None]
        http_server.application.sessions[session].last_used = time.monotonic() - 61
        http_server.service_actions()
        assert session not in http_server.application.sessions
        assert transport.socket.fileno() == -1
        assert request("resume-session") == session
        replacement = http_server.application.sessions[session].connection
        assert replacement is not transport and replacement.next_id == 2
        assert job in request("jobs")
        monitor = request("monitor-state")
        row = next(row for row in monitor["jobs"] if row["token"] == job)
        assert row["information"] == info, row
        assert row["output"] == {"start": 0, "text": "λ中文\n", "end": 4}, row
        listener = request("listener-information")
        for field in ("package", "mode", "prompt", "default-pathname", "busy-p"):
            assert monitor["listener"][field] == listener[field], (field, monitor["listener"][field])
        handles = handle_count()
        monitor = request("monitor-state", offsets=[{"name": name, "start": 1}])
        row = next(row for row in monitor["jobs"] if row["token"] == job)
        assert row["output"] == {"start": 1, "text": "中文\n", "end": 4}, row
        assert handle_count() == handles
        monitor = request("monitor-state", offsets=[{"name": name, "start": 4}])
        row = next(row for row in monitor["jobs"] if row["token"] == job)
        assert row["output"] == {"start": 4, "text": "", "end": 4}, row
        assert handle_count() == handles
        request("monitor-state", offsets=[{"name": name, "start": 5}],
                _expected_error=":invalid-output-range")
        growing_name, short_name = secrets.token_hex(32), secrets.token_hex(32)
        growing = request("start-evaluation", name=growing_name, interactive=True,
                          source='(progn (write-string (make-string 70000 :initial-element #\\λ)) '
                                 '(finish-output) (read-line) (write-string "tail😀") (values))')
        jobs.append(growing)
        assert wait(growing, lambda info: info["input-waiting-p"])["output-length"] == 70000
        short = request("start-evaluation", name=short_name,
                        source='(progn (write-string "small") (values))')
        jobs.append(short)
        wait(short, lambda info: info["state"] == ":returned")
        fixture_tokens = [job, growing, short]
        fixture_names = [name, growing_name, short_name]
        starts = dict.fromkeys(fixture_names, 0)
        prefixes = dict.fromkeys(fixture_names, "")
        token_form = server.lisp([[server.Symbol(token[0]), *token[1:]] for token in fixture_tokens])
        for _ in range(3):
            assignments = " ".join(f'(cl:setf (cl:gethash {server.lisp(key)} starts) {start})'
                                   for key, start in starts.items())
            rows = server.json_value(raw(f"""(swank/mezzano-debugger::with-lock
              (cl:let ((session {session_form}) (starts (cl:make-hash-table :test (cl:function cl:equal))))
                {assignments}
                (swank/mezzano-debugger::fill-monitor-output
                  (cl:mapcar (cl:lambda (token)
                    (cl:let ((handle (swank/mezzano-debugger::decode-handle session :job token)))
                      (cl:cons handle (swank/mezzano-debugger::monitor-job session handle starts))))
                    (cl:quote {token_form})) 2)))"""))
            assert [row["token"] for row in rows] == fixture_tokens
            assert sum(len(row["output"]["text"]) for row in rows) == 2
            for row in rows:
                key, output = row["information"]["name"], row["output"]
                assert output["start"] == starts[key]
                assert len(output["text"]) == output["end"] - output["start"]
                starts[key] = output["end"]
                prefixes[key] += output["text"]
        assert all(start > 0 for start in starts.values()), starts
        assert prefixes[name] == "λ中文\n"[:starts[name]]
        assert prefixes[growing_name] == "λ" * starts[growing_name]
        assert prefixes[short_name] == "small"[:starts[short_name]]

        expected = {name: "λ中文\n", growing_name: "λ" * 70000 + "tail😀", short_name: "small"}
        starts = dict.fromkeys(fixture_names, 0)
        received = dict.fromkeys(fixture_names, "")
        for round_number in range(40):
            monitor = request("monitor-state", offsets=[{"name": key, "start": start}
                                                         for key, start in starts.items()])
            rows = monitor["jobs"] or []
            assert sum(len(row["output"]["text"]) for row in rows) <= 65536
            for row in rows:
                key, output = row["information"]["name"], row["output"]
                assert output["start"] == starts.get(key, 0)
                assert output["end"] <= row["information"]["output-length"]
                assert len(output["text"]) == output["end"] - output["start"]
                starts[key] = output["end"]
                if key in received:
                    received[key] += output["text"]
                    assert expected[key].startswith(received[key])
            if round_number == 0:
                assert received[short_name] == "small"
                assert 0 < len(received[growing_name]) < 70000
                request("job-input", job=growing, offset=0, text="continue\n")
                assert wait(growing, lambda info: info["state"] == ":returned")["output-length"] == 70005
            if received == expected:
                break
        assert received == expected, {key: len(value) for key, value in received.items()}
        print("Bounded monitor output: exact Unicode prefixes, growing and short jobs, "
              "and three unread jobs sharing two characters passed.", flush=True)
        zero = request("start-evaluation", name=secrets.token_hex(32), source="(values)")
        jobs.append(zero)
        assert wait(zero, lambda info: info["state"] == ":returned")["values"] is None
        interactive = request("start-evaluation", name=secrets.token_hex(32),
                              source="(read-line)", interactive=True)
        jobs.append(interactive)
        wait(interactive, lambda info: info["input-waiting-p"])
        assert request("job-input", job=interactive, offset=0, text="hello\n") == 6
        assert wait(interactive, lambda info: info["state"] == ":returned")["values"] == ['"hello"', "NIL"]
        assert request("job-input", job=interactive, offset=0, text="hello\n") == 6
        function_name = "lispm-http-test-" + secrets.token_hex(6)
        source = f"""(defun {function_name} (a b)
             (declare (optimize (debug 3) (safety 3)))
             (cerror "Continue the HTTP test." "HTTP debugger stop.")
             (+ a b))
        (unwind-protect ({function_name} 111 222) (fmakunbound '{function_name}))"""
        stopped_job = request("start-evaluation", name=secrets.token_hex(32), source=source)
        jobs.append(stopped_job)
        stop = stop_for(stopped_job)
        monitor = request("monitor-state")
        row = next(row for row in monitor["jobs"] if row["token"] == stopped_job)
        assert stop in row["information"]["stops"], row
        row = next(row for row in monitor["stops"] if row["token"] == stop)
        assert row["information"]["state"] == ":stopped", row
        assert "HTTP debugger stop." in command(stop, "condition")["result"]
        frames = command(stop, "frames")["result"]
        frame = next(item for item in frames if function_name.upper() in item["function"])
        locals_ = command(stop, "locals", frame["frame"])["result"]
        assert {"111", "222"} <= {item["value"] for item in locals_ if item["available-p"]}, locals_
        assert restart(stop, "CONTINUE")["state"] == ":unwound"
        assert wait(stopped_job, lambda info: info["state"] == ":returned")["values"] == ["333"]
        assert request("information", stop=stop)["state"] == ":closed"
        monitor = request("monitor-state")
        row = next(row for row in monitor["stops"] if row["token"] == stop)
        assert row["information"]["state"] == ":closed", row

        interrupt_job = request("start-evaluation", name=secrets.token_hex(32),
            source='(unwind-protect (loop (sleep 0.01)) (format t "cleanup"))')
        jobs.append(interrupt_job)
        info = request("job-information", job=interrupt_job)
        interrupt_id = info["next-interrupt-id"]
        assert request("interrupt-job", job=interrupt_job, id=interrupt_id) == interrupt_id
        assert request("interrupt-job", job=interrupt_job, id=interrupt_id) == interrupt_id
        interrupt_stop = stop_for(interrupt_job)
        assert restart(interrupt_stop, "ABORT")["state"] == ":unwound"
        assert wait(interrupt_job, lambda info: info["state"] != ":running")["state"] == ":aborted"
        assert request("job-output", job=interrupt_job, start=0)["text"] == "cleanup"
        assert request("job-interrupt-result", job=interrupt_job, id=interrupt_id)["state"] == ":unwound"

        condition_name = "lispm-http-condition-" + secrets.token_hex(6)
        source = f"""(define-condition {condition_name} (error) ()
          (:report (lambda (condition stream) (declare (ignore condition))
                     (cerror "Resume the printer." "HTTP child printer stop.")
                     (write-string "HTTP parent condition." stream))))
        (unwind-protect (error '{condition_name}) (setf (find-class '{condition_name}) nil))"""
        nested_job = request("start-evaluation", name=secrets.token_hex(32), source=source)
        jobs.append(nested_job)
        parent = stop_for(nested_job)
        command_id = request("information", stop=parent)["next-command-id"]
        request("submit", stop=parent, id=command_id, command="condition")
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            info = request("information", stop=parent)
            if info["child"]:
                child = info["child"]
                break
            time.sleep(.02)
        else:
            raise AssertionError("Printer did not enter a child stop.")
        owned_stops.append(child)
        assert request("result", stop=parent, id=command_id)["state"] == ":running"
        assert "HTTP child printer stop." in command(child, "condition")["result"]
        assert restart(child, "CONTINUE")["state"] == ":unwound"
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            result = request("result", stop=parent, id=command_id)
            if result["state"] == ":returned":
                break
            time.sleep(.02)
        assert result["result"] == "HTTP parent condition.", result
        assert restart(parent, "ABORT")["state"] == ":unwound"
        assert wait(nested_job, lambda info: info["state"] != ":running")["state"] == ":aborted"
    finally:
        try:
            for job in jobs:
                info = request("job-information", job=job)
                if info["state"] == ":running" and not info["stops"]:
                    request("interrupt-job", job=job, id=info["next-interrupt-id"])
                    info = wait(job, lambda item: bool(item["stops"]) or item["state"] != ":running")
                deadline = time.monotonic() + 15
                while info["state"] == ":running":
                    if time.monotonic() >= deadline:
                        raise AssertionError(f"Cleanup could not stop owned job {job!r}.")
                    for stop in info["stops"] or []:
                        while request("information", stop=stop)["child"]:
                            stop = request("information", stop=stop)["child"]
                        if stop not in owned_stops:
                            owned_stops.append(stop)
                        if request("information", stop=stop)["state"] == ":stopped":
                            restart(stop, "ABORT")
                    info = request("job-information", job=job)
                    time.sleep(.02)
            for stop in reversed(owned_stops):
                assert request("information", stop=stop)["state"] == ":closed"
                request("release-stop", stop=stop)
                request("information", stop=stop, _expected_error=":released-stop")
                assert_released_monitor_object("stop", stop)
            for job in jobs:
                request("release-job", job=job)
                request("job-information", job=job, _expected_error=":released-job")
                assert_released_monitor_object("job", job)
            monitor = request("monitor-state")
            assert not any(row["token"] in jobs for row in monitor["jobs"] or [])
            assert not any(row["token"] in owned_stops for row in monitor["stops"] or [])
            transport = http_server.application.sessions[session].connection
            request("release-session")
            assert session not in http_server.application.sessions
            assert transport.socket.fileno() == -1
            request("resume-session", _expected_error=":expired-session")
        finally:
            http_server.shutdown()
            http_server.server_close()
            worker.join()
    print("HTTP debugger: condition, frames, locals, duplicate submission, continuation, "
          "interruption, abort cleanup, child printer recovery, and closed-stop release passed.")
    print("HTTP -> SWANK -> Mezzano: Unicode, output offsets, values, zero values, replay, "
          "session resume, interactive input, and terminal release passed.")
    print("Retained transport: one initialization, detached guest ownership, idle socket closure, "
          "same-session resume, and immediate release closure passed.")
    print("Monitor state: Unicode increments, invalid offsets, stable handles, "
          "active and closed stops, and captured-handle release omission passed.")



if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--live-port", type=int)
    args = parser.parse_args()
    result = unittest.TextTestRunner(verbosity=2).run(
        unittest.defaultTestLoader.loadTestsFromModule(__import__(__name__)))
    if not result.wasSuccessful():
        raise SystemExit(1)
    if args.live_port:
        live_test(args.live_port)
