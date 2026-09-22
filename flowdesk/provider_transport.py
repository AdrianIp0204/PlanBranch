"""Bounded JSON and native-stream HTTP: no proxies, redirects, or retries.

Cancellation closes the active socket. An already accepted cloud request may
still be billed by its provider; no uncertain request is automatically repeated.
"""
from __future__ import annotations

import http.client
import json
import queue
import socket
import threading
import time
from urllib.parse import urlsplit


MAX_REQUEST_BYTES = 2_000_000
MAX_RESPONSE_BYTES = 4_000_000
_SLOTS = threading.BoundedSemaphore(4)


class ProviderError(RuntimeError):
    """A message safe to display, without request bodies or HTTP diagnostics."""


class ProviderCancelled(ProviderError):
    pass


def encode_json(value):
    try:
        return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    except (TypeError, ValueError, UnicodeError, RecursionError):
        raise ProviderError("The model request is not valid JSON.") from None


def decode_json(value):
    def reject(_):
        raise ValueError
    try:
        return json.loads(value, parse_constant=reject)
    except (TypeError, ValueError, UnicodeError, RecursionError):
        raise ProviderError("The provider returned an unreadable response. No changes were applied.") from None


def _http_error(status):
    if status in (401, 403):
        return "The provider rejected authentication or model access. Check its API key and account permissions outside PlanBranch."
    if status == 429:
        return "The provider's usage or rate limit was reached. Check its limits before retrying."
    if status == 404:
        return "The selected model or API endpoint is unavailable. Check the model ID and provider configuration."
    if status in (400, 422):
        return "The provider rejected this model's request format or options. Choose a supported model or model-default reasoning."
    if status == 413:
        return "The provider rejected the request size. Reduce the conversation or task context."
    if 300 <= status < 400:
        return "The provider attempted an HTTP redirect. Redirects are disabled; check the configured endpoint."
    return "The provider could not complete the request. Check its availability before retrying."


def request_json(endpoint, path, *, data=None, headers=None, timeout=180, cancel=None,
                 max_response_bytes=MAX_RESPONSE_BYTES, stream_parser=None):
    """Complete-response requests bounded in bytes, elapsed time and concurrency.

    The polling owner can stop even if DNS/SSL is blocked. Such a worker retains
    its semaphore slot until it exits, bounding abandoned workers to four.
    """
    if cancel is not None and cancel.is_set():
        raise ProviderCancelled("Model request cancelled.")
    packet = None if data is None else encode_json(data)
    if packet is not None and len(packet) > MAX_REQUEST_BYTES:
        raise ProviderError("This model request is too large. Reduce its context before retrying.")
    if not _SLOTS.acquire(blocking=False):
        raise ProviderError("Too many model requests are still active. Wait before retrying.")
    finished = queue.Queue(maxsize=1)
    stop = threading.Event()
    connection = None
    active_socket = [None]
    deadline = time.monotonic() + max(.01, min(float(timeout), 180))
    try:
        url = urlsplit(endpoint)
        factory = http.client.HTTPSConnection if url.scheme == "https" else http.client.HTTPConnection
        connection = factory(url.hostname, url.port, timeout=max(.01, min(float(timeout), 180)))
    except (ValueError, TypeError):
        _SLOTS.release()
        raise ProviderError("The provider endpoint is invalid.") from None

    def close():
        # shutdown wakes recv/getresponse on both Windows and Linux.
        # HTTPConnection drops its reference after a Connection: close header,
        # while HTTPResponse may still be waiting on that same live socket.
        sock = active_socket[0] or connection.sock
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        connection.close()

    def run():
        try:
            connection.connect()
            active_socket[0] = connection.sock
            if stop.is_set():
                return
            request_headers = {"Content-Type": "application/json",
                               "Accept": "text/event-stream, application/x-ndjson, application/json" if stream_parser else "application/json",
                               **(headers or {})}
            connection.request("GET" if data is None else "POST", path, body=packet, headers=request_headers)
            response = connection.getresponse()
            if response.status != 200:
                raise ProviderError(_http_error(response.status))
            length = response.getheader("Content-Length")
            if length is not None and (not length.isdigit() or int(length) > max_response_bytes):
                raise ProviderError("The provider response exceeded the supported size.")
            if response.getheader("Content-Encoding", "identity") not in ("identity", ""):
                raise ProviderError("The provider returned an unsupported compressed response.")
            content_type = response.getheader("Content-Type", "application/json").split(";", 1)[0].strip().lower()
            streaming = stream_parser is not None and content_type != "application/json"
            if streaming and content_type not in ("text/event-stream", "application/x-ndjson", "application/jsonl"):
                raise ProviderError("The provider returned an unsupported stream format.")
            chunks, size = [], 0
            while not stop.is_set():
                chunk = response.read1(min(65536, max_response_bytes + 1 - size))
                if not chunk:
                    break
                size += len(chunk)
                if size > max_response_bytes:
                    raise ProviderError("The provider response exceeded the supported size.")
                if streaming:
                    stream_parser.feed(chunk)
                    if stream_parser.terminal:
                        break
                else:
                    chunks.append(chunk)
            if not stop.is_set():
                if not streaming and length is not None and size != int(length):
                    raise ProviderError("The provider response ended unexpectedly. No changes were applied.")
                value = stream_parser.finish() if streaming else decode_json(b"".join(chunks))
                if not isinstance(value, dict):
                    raise ProviderError("The provider returned an invalid response.")
                finished.put((value, None))
        except ProviderError as exc:
            if not stop.is_set():
                finished.put((None, exc))
        except Exception:
            # Raw socket/HTTP failures can contain headers, URLs and credentials.
            if not stop.is_set():
                finished.put((None, ProviderError("The provider connection failed or timed out. Check its availability before retrying.")))
        finally:
            connection.close()
            _SLOTS.release()

    threading.Thread(target=run, name="planbranch-provider-http", daemon=True).start()
    try:
        while True:
            if cancel is not None and cancel.is_set():
                raise ProviderCancelled("Model request cancelled.")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ProviderError("The model request timed out. It was not retried automatically.")
            try:
                value, error = finished.get(timeout=min(.05, remaining))
            except queue.Empty:
                continue
            if error is not None:
                raise error
            return value
    finally:
        stop.set()
        close()
