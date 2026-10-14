# /// script
# requires-python = ">=3.13"
# dependencies = []
# ///
"""HTTP transport for Mezzano's retained evaluation and debugger service."""

import argparse
from contextlib import contextmanager
import json
import re
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
NAME = re.compile(r"[0-9a-f]{64}\Z")
SYMBOL = re.compile(r"[^()\s\"';|#]+\Z")
LIMIT = 1024 * 1024


class Symbol(str):
    pass


class ProtocolError(Exception):
    pass


class ServiceError(Exception):
    def __init__(self, reason):
        self.reason = str(reason)
        super().__init__(self.reason)


def parse(text):
    position = 0

    def read(depth=0):
        nonlocal position
        if depth > 128:
            raise ProtocolError("SWANK nesting exceeds 128 levels.")
        while position < len(text) and text[position].isspace():
            position += 1
        if position == len(text):
            raise ProtocolError("Incomplete SWANK expression.")
        char = text[position]
        position += 1
        if char == "(":
            result = []
            while True:
                while position < len(text) and text[position].isspace():
                    position += 1
                if position == len(text):
                    raise ProtocolError("Unclosed SWANK list.")
                if text[position] == ")":
                    position += 1
                    return result
                result.append(read(depth + 1))
        if char == '"':
            result = []
            while position < len(text):
                char = text[position]
                position += 1
                if char == '"':
                    return "".join(result)
                if char == "\\":
                    if position == len(text):
                        break
                    char = text[position]
                    position += 1
                result.append(char)
            raise ProtocolError("Unclosed SWANK string.")
        start = position - 1
        while position < len(text) and not text[position].isspace() and text[position] not in "()":
            position += 1
        word = text[start:position]
        if not SYMBOL.fullmatch(word) or word == ".":
            raise ProtocolError(f"Unsupported SWANK token: {word!r}.")
        if word.lower() == "nil":
            return None
        if word.lower() == "t":
            return True
        if re.fullmatch(r"[+-]?[0-9]+", word):
            return int(word)
        return Symbol(word.lower())

    result = read()
    if text[position:].strip():
        raise ProtocolError("Trailing SWANK expression.")
    return result


def lisp(value):
    if isinstance(value, Symbol):
        if not SYMBOL.fullmatch(value):
            raise ValueError("Invalid protocol symbol.")
        return value
    if value is None or value is False:
        return "nil"
    if value is True:
        return "t"
    if type(value) is int:
        return str(value)
    if isinstance(value, str):
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
    if isinstance(value, list):
        return "(" + " ".join(map(lisp, value)) + ")"
    raise ValueError("Unsupported Lisp argument.")


def json_value(value):
    if isinstance(value, list):
        if value and len(value) % 2 == 0 and all(
            isinstance(key, Symbol) and key.startswith(":") for key in value[::2]
        ):
            keys = [str(key)[1:] for key in value[::2]]
            if len(set(keys)) != len(keys):
                raise ProtocolError("Duplicate reply property.")
            return {key: json_value(item) for key, item in zip(keys, value[1::2])}
        return [json_value(item) for item in value]
    return value


class Swank:
    def __init__(self, host, port, deadline):
        self.deadline = deadline
        self.socket = socket.create_connection((host, port), self.remaining())
        self.next_id = 0
        self.output = []

    def remaining(self):
        seconds = self.deadline - time.monotonic()
        if seconds <= 0:
            raise TimeoutError("SWANK request deadline expired.")
        return seconds

    def close(self):
        self.socket.close()

    def send(self, value):
        payload = lisp(value).encode("utf-8")
        if len(payload) >= 0x1000000:
            raise ValueError("SWANK request exceeds the length field.")
        self.socket.settimeout(self.remaining())
        self.socket.sendall(f"{len(payload):06x}".encode("ascii") + payload)

    def read(self, count):
        parts = bytearray()
        while len(parts) < count:
            self.socket.settimeout(self.remaining())
            part = self.socket.recv(count - len(parts))
            if not part:
                raise ConnectionError(f"SWANK closed after {len(parts)} of {count} bytes.")
            parts.extend(part)
        return bytes(parts)

    def receive(self):
        header = self.read(6)
        if not re.fullmatch(b"[0-9a-fA-F]{6}", header):
            raise ProtocolError("Invalid SWANK length header.")
        try:
            return parse(self.read(int(header, 16)).decode("utf-8"))
        except (ValueError, UnicodeError) as error:
            raise ProtocolError(f"Invalid SWANK encoding: {error}.") from error

    def rpc(self, form):
        self.next_id += 1
        request_id = self.next_id
        self.send([Symbol(":emacs-rex"), form, "CL-USER", True, request_id])
        debug_error = None
        abort_id = None
        while True:
            message = self.receive()
            if not isinstance(message, list) or not message or not isinstance(message[0], Symbol):
                raise ProtocolError("Invalid SWANK message.")
            event = message[0]
            if event == ":ping":
                if len(message) != 3 or type(message[1]) is not int:
                    raise ProtocolError("Malformed SWANK ping.")
                self.send([Symbol(":emacs-pong"), message[1], message[2]])
            elif event in (":write-string", ":background-message"):
                if len(message) not in (2, 3) or not isinstance(message[1], str):
                    raise ProtocolError("Malformed SWANK output event.")
                self.output.append(message[1])
            elif event in (":new-package", ":new-features", ":indentation-update",
                           ":debug-activate", ":debug-return"):
                continue
            elif event == ":return":
                if len(message) != 3 or type(message[2]) is not int:
                    raise ProtocolError("Malformed SWANK return event.")
                if message[2] == abort_id:
                    continue
                if message[2] != request_id:
                    raise ProtocolError("Unexpected SWANK reply ID.")
                if debug_error:
                    raise ProtocolError(debug_error)
                reply = message[1]
                if not isinstance(reply, list) or len(reply) != 2 or reply[0] != ":ok":
                    raise ProtocolError(f"SWANK RPC failed: {reply!r}.")
                return reply[1]
            elif event == ":debug":
                if len(message) < 4 or type(message[1]) is not int:
                    raise ProtocolError("Malformed SWANK debugger event.")
                debug_error = f"SWANK entered its debugger: {message!r}."
                self.next_id += 1
                abort_id = self.next_id
                self.send([Symbol(":emacs-rex"), [Symbol("swank:throw-to-toplevel")],
                           "CL-USER", message[1], abort_id])
            else:
                raise ProtocolError(f"Unexpected SWANK event: {message!r}.")

    def checked(self, form):
        reply = self.rpc(form)
        if not isinstance(reply, list) or len(reply) != 2:
            raise ProtocolError("Malformed retained-service reply.")
        if reply[0] == ":error":
            raise ServiceError(reply[1])
        if reply[0] != ":ok":
            raise ProtocolError("Malformed retained-service status.")
        return reply[1]

    def attach(self, name, create=False):
        self.rpc([Symbol("swank:swank-require"), Symbol(":swank-mezzano-debugger")])
        operation = "open-session" if create else "resume-session"
        while True:
            try:
                return self.checked([Symbol("swank/mezzano-debugger:" + operation), name])
            except ServiceError as error:
                if error.reason != ":session-attached":
                    raise
                time.sleep(min(0.01, self.remaining()))

    def request(self, name, operation, *arguments):
        return self.checked([Symbol("swank/mezzano-debugger:request"), name,
                             Symbol(":" + operation),
                             *[[Symbol("quote"), value] for value in arguments]])


def require_name(value):
    if not isinstance(value, str) or not NAME.fullmatch(value):
        raise ValueError("A session or evaluation name must contain 64 lowercase hexadecimal digits.")
    return value


def fields(data, required, optional=()):
    if not isinstance(data, dict) or set(data) - set(required) - set(optional) or set(required) - set(data):
        raise ValueError("Unexpected or missing request fields.")
    return data


def string(value):
    if not isinstance(value, str):
        raise ValueError("Expected a string.")
    return value


def integer(value):
    if type(value) is not int or value < 0:
        raise ValueError("Expected a nonnegative integer.")
    return value


def boolean(value):
    if type(value) is not bool:
        raise ValueError("Expected a Boolean.")
    return value


def token(value, kind, session):
    if (not isinstance(value, list) or len(value) != 3 or value[0] != ":" + kind
            or value[1] != session):
        raise ValueError("Invalid session token.")
    return [Symbol(value[0]), value[1], integer(value[2])]


def operation_arguments(operation, args, session):
    if operation == "monitor-state":
        fields(args, (), ("offsets",))
        offsets = args.get("offsets", [])
        if not isinstance(offsets, list):
            raise ValueError("Output offsets must be a list.")
        result, names = [], set()
        for offset in offsets:
            fields(offset, ("name", "start"))
            name = require_name(offset["name"])
            if name in names:
                raise ValueError("Duplicate output offset.")
            names.add(name)
            result.append([name, integer(offset["start"])])
        return [result]
    if operation in ("jobs", "release-session", "listener-information", "processes"):
        fields(args, ())
        return []
    if operation == "stops":
        fields(args, (), ("include_closed",))
        return [boolean(args.get("include_closed", False))]
    if operation == "save-private-document":
        fields(args, ("name", "pathname", "topics"))
        if not isinstance(args["topics"], list):
            raise ValueError("Documentation topics must be a list of strings.")
        return [require_name(args["name"]), string(args["pathname"]),
                [string(topic) for topic in args["topics"]]]
    if operation == "read-private-document":
        fields(args, ("pathname",))
        return [string(args["pathname"])]
    if operation == "document-query":
        fields(args, ("action",), ("topic", "query", "mode", "adjacent"))
        action = string(args["action"])
        mode = string(args.get("mode", "substring"))
        if action not in ("catalog", "topic", "search", "contents", "overview"):
            raise ValueError("Unsupported documentation action.")
        if mode not in ("exact", "initial", "substring"):
            raise ValueError("Unsupported documentation search mode.")
        if action in ("topic", "contents", "overview") and "topic" not in args:
            raise ValueError("A documentation topic is required.")
        if action == "search" and "query" not in args:
            raise ValueError("Documentation search terms are required.")
        return [Symbol(":" + action), Symbol(":topic"),
                string(args["topic"]) if "topic" in args else None,
                Symbol(":query"), string(args.get("query", "")), Symbol(":mode"), Symbol(":" + mode),
                Symbol(":adjacent"), boolean(args.get("adjacent", False))]
    if operation == "document-assistance":
        fields(args, ("source", "cursor", "action"))
        source, cursor = string(args["source"]), integer(args["cursor"])
        action = string(args["action"])
        if action not in ("inspect", "space", "complete", "help", "parse"):
            raise ValueError("Unsupported documentation assistance action.")
        if cursor > len(source):
            raise ValueError("Input cursor exceeds the source length.")
        return [source, cursor, Symbol(":" + action)]
    if operation == "listener-assistance":
        fields(args, ("source", "cursor", "action"), ("context", "presentation"))
        action = string(args["action"])
        context = string(args.get("context", "listener"))
        if action not in ("inspect", "space", "complete", "help", "parse", "insert"):
            raise ValueError("Unsupported assistance action.")
        if context not in ("listener", "debugger"):
            raise ValueError("Unsupported command context.")
        source, cursor = string(args["source"]), integer(args["cursor"])
        if cursor > len(source):
            raise ValueError("Input cursor exceeds the source length.")
        if action == "insert" and "presentation" not in args:
            raise ValueError("Pathname insertion requires a presentation.")
        return [source, cursor, Symbol(":" + action),
                Symbol(":context"), Symbol(":" + context), Symbol(":presentation"),
                string(args["presentation"]) if "presentation" in args else None]
    if operation == "start-listener":
        fields(args, ("name", "source"), ("interactive",))
        return [require_name(args["name"]), string(args["source"]),
                Symbol(":interactive"), boolean(args.get("interactive", False))]
    if operation == "start-evaluation":
        fields(args, ("name", "source"), ("package", "input", "interactive"))
        return [require_name(args["name"]), string(args["source"]),
                Symbol(":package"), string(args.get("package", "CL-USER")),
                Symbol(":input"), string(args.get("input", "")),
                Symbol(":interactive"), boolean(args.get("interactive", False))]
    if operation in ("job-information", "release-job"):
        fields(args, ("job",))
        return [token(args["job"], "job", session)]
    if operation == "job-output":
        fields(args, ("job", "start"), ("end",))
        values = [token(args["job"], "job", session), integer(args["start"])]
        if "end" in args:
            values.append(integer(args["end"]))
        return values
    if operation == "job-input":
        fields(args, ("job", "offset", "text"), ("eof",))
        return [token(args["job"], "job", session), integer(args["offset"]), string(args["text"]),
                Symbol(":eof"), boolean(args.get("eof", False))]
    if operation in ("interrupt-job", "job-interrupt-result"):
        fields(args, ("job", "id"))
        return [token(args["job"], "job", session), integer(args["id"])]
    if operation in ("information", "release-stop"):
        fields(args, ("stop",))
        return [token(args["stop"], "stop", session)]
    if operation == "result":
        fields(args, ("stop", "id"))
        return [token(args["stop"], "stop", session), integer(args["id"])]
    if operation == "submit":
        fields(args, ("stop", "id", "command"), ("argument",))
        command = string(args["command"])
        if command not in ("condition", "restarts", "frames", "locals", "proceed", "invoke-restart",
                           "invoke-restart-interactively", "invoke-restart-with-arguments", "abort", "help"):
            raise ValueError("Unsupported debugger command.")
        argument = args.get("argument")
        if command == "locals":
            argument = token(argument, "frame", session)
        elif command in ("invoke-restart", "invoke-restart-interactively"):
            argument = integer(argument)
        elif command == "invoke-restart-with-arguments":
            if argument is not None:
                argument = integer(argument)
        elif argument is not None:
            raise ValueError("This debugger command takes no argument.")
        return [token(args["stop"], "stop", session), integer(args["id"]),
                Symbol(":" + command), argument]
    raise ValueError("Unsupported operation.")


class Application:
    def __init__(self, host, port, timeout):
        self.host, self.port, self.timeout = host, port, timeout
        self.locks = {}
        self.lock = threading.Lock()

    @staticmethod
    def prepare(data):
        fields(data, ("session", "operation"), ("arguments",))
        name = require_name(data["session"])
        operation = string(data["operation"])
        arguments = data.get("arguments", {})
        if operation in ("open-session", "resume-session"):
            fields(arguments, ())
            values = []
        else:
            values = operation_arguments(operation, arguments, name)
        return name, operation, values

    @contextmanager
    def session_lock(self, name):
        with self.lock:
            entry = self.locks.setdefault(name, [threading.Lock(), 0])
            entry[1] += 1
        acquired = False
        try:
            acquired = entry[0].acquire(timeout=self.timeout)
            if not acquired:
                raise TimeoutError("The session's HTTP request queue exceeded its deadline.")
            yield
        finally:
            if acquired:
                entry[0].release()
            with self.lock:
                entry[1] -= 1
                if entry[1] == 0:
                    del self.locks[name]

    def dispatch(self, prepared):
        name, operation, values = prepared
        deadline = time.monotonic() + self.timeout
        with self.session_lock(name):
            connection = Swank(self.host, self.port, deadline)
            try:
                attached = connection.attach(name, create=operation == "open-session")
                if operation in ("open-session", "resume-session"):
                    result = attached
                elif operation in ("submit", "release-stop"):
                    lease = connection.request(name, "attach", values[0])
                    result = connection.request(name, operation, lease, *values[1:])
                else:
                    result = connection.request(name, operation, *values)
                return {"value": json_value(result), "diagnostics": connection.output}
            finally:
                connection.close()


class Handler(BaseHTTPRequestHandler):
    server_version = "MezzanoHTTP/1"
    protocol_version = "HTTP/1.0"

    def setup(self):
        self.request.settimeout(self.server.application.timeout)
        super().setup()

    def respond(self, status, body, content_type="application/json; charset=utf-8"):
        if not isinstance(body, bytes):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; script-src 'self'; style-src 'self'; "
                         "object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(body)

    def valid_host(self):
        hosts = self.headers.get_all("Host", [])
        if len(hosts) != 1:
            return False
        try:
            parsed = urlsplit("http://" + hosts[0])
            return (parsed.hostname in self.server.allowed_hosts
                    and parsed.port == self.server.server_port
                    and not parsed.username and not parsed.password
                    and not parsed.path and not parsed.query and not parsed.fragment)
        except ValueError:
            return False

    def do_GET(self):
        if not self.valid_host():
            self.respond(403, {"error": "Unrecognized HTTP Host."})
            return
        if self.path == "/favicon.ico":
            self.respond(204, b"", "image/x-icon")
            return
        files = {"/": ("index.html", "text/html; charset=utf-8"),
                 "/app.js": ("app.js", "text/javascript; charset=utf-8"),
                 "/peek.js": ("peek.js", "text/javascript; charset=utf-8"),
                 "/document-examiner.js": ("document-examiner.js", "text/javascript; charset=utf-8"),
                 "/style.css": ("style.css", "text/css; charset=utf-8")}
        for name in ("hl8", "5x5", "tvfont", "cptfont", "cptfontcb", "cptfonti", "hl12", "hl12b", "hl12i", "hl12bi",
                     "tr12i", "jess14", "jess13", "swiss12b-ccaps", "eurex24i"):
            files[f"/fonts/{name}.ttf"] = (f"fonts/{name}.ttf", "font/ttf")
        path = urlsplit(self.path).path
        if path not in files:
            self.respond(404, {"error": "Unknown resource."})
            return
        filename, content_type = files[path]
        try:
            content = (ROOT / filename).read_bytes()
        except OSError as error:
            self.respond(500, {"error": str(error)})
            return
        self.respond(200, content, content_type)

    def do_POST(self):
        if not self.valid_host():
            self.respond(403, {"error": "Unrecognized HTTP Host."})
            return
        if self.path != "/api":
            self.respond(404, {"error": "Unknown operation endpoint."})
            return
        origin = self.headers.get("Origin")
        expected = "http://" + self.headers["Host"]
        if origin is not None and origin != expected:
            self.respond(403, {"error": "Foreign request Origin."})
            return
        if (self.headers.get("X-Mezzano-Request") != "1"
                or self.headers.get_content_type() != "application/json"
                or self.headers.get("Sec-Fetch-Site") not in (None, "same-origin", "none")):
            self.respond(403, {"error": "Expected a same-origin JSON request."})
            return
        if self.headers.get("Transfer-Encoding"):
            self.respond(400, {"error": "Transfer-Encoding is unsupported."})
            return
        try:
            lengths = self.headers.get_all("Content-Length", [])
            if len(lengths) != 1 or not lengths[0].isdigit():
                raise ValueError("Expected one Content-Length.")
            length = int(lengths[0])
            if length > LIMIT:
                self.respond(413, {"error": "Request exceeds one MiB."})
                return
            self.connection.settimeout(self.server.application.timeout)
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError("Incomplete HTTP request body.")
            data = json.loads(raw)
            prepared = self.server.application.prepare(data)
        except (ValueError, UnicodeError, RecursionError) as error:
            self.respond(400, {"error": str(error), "uncertain": False})
            return
        except OSError as error:
            self.respond(408, {"error": str(error), "uncertain": False})
            return
        try:
            result = self.server.application.dispatch(prepared)
        except ServiceError as error:
            self.respond(409, {"error": error.reason, "uncertain": False})
        except (OSError, ProtocolError) as error:
            self.respond(502, {"error": str(error), "uncertain": True})
        else:
            self.respond(200, result)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--listen", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--swank-host", default="127.0.0.1")
    parser.add_argument("--swank-port", type=int, default=4006)
    parser.add_argument("--timeout", type=float, default=15)
    parser.add_argument("--allow-host", action="append", default=[])
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.listen, args.port), Handler)
    server.application = Application(args.swank_host, args.swank_port, args.timeout)
    server.allowed_hosts = {"localhost", "127.0.0.1", socket.gethostname(), socket.getfqdn(),
                            *args.allow_host}
    print(f"Mezzano HTTP listening on {args.listen}:{server.server_port}", flush=True)
    print(f"Allowed HTTP hosts: {', '.join(sorted(server.allowed_hosts))}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
