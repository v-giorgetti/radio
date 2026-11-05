"""Planning and output parsing for externally generated, ongoing radio streams."""
import math
import re


def cohort_plan(previous, target, fill_seconds=5):
    """Plan only the new cohort; request rate is based on the cumulative target."""
    if (not isinstance(previous, int) or isinstance(previous, bool)
            or not isinstance(target, int) or isinstance(target, bool)
            or not 0 <= previous < target <= 15000
            or previous % 100 or target % 100):
        raise ValueError("levels must increase from zero, be divisible by 100, and not exceed 15000")
    if (not isinstance(fill_seconds, (int, float)) or isinstance(fill_seconds, bool)
            or not math.isfinite(fill_seconds) or fill_seconds <= 0):
        raise ValueError("fill_seconds must be positive and finite")
    additional = target - previous
    clients = additional // 100
    desired_rate = target / fill_seconds
    return {
        "previous": previous, "target": target, "additional_streams": additional,
        "clients": clients, "streams_per_session": 100,
        "desired_stream_rate": desired_rate, "rps_per_client": desired_rate / clients,
        "expected_fill_seconds": additional / desired_rate,
    }


def parse_h2load(text):
    """Extract observed counters, without treating unfinished responses as failures.

    `started` counts submitted requests; it is not an active-listener measurement.
    Missing/zero body traffic must be distinguished from expected zero completions.
    """
    protocol_matches = re.findall(r"^\s*Application protocol:\s*(\S+)", text, re.MULTILINE)
    protocol = protocol_matches[-1] if protocol_matches else None
    requests = {key: None for key in ("total", "started", "done", "succeeded", "failed", "errored", "timeout")}
    statuses = {key: None for key in ("2xx", "3xx", "4xx", "5xx")}
    request_lines = re.findall(r"^\s*requests:\s*(.*)$", text, re.MULTILINE)
    if request_lines:
        for value, key in re.findall(r"(\d+)\s+(total|started|done|succeeded|failed|errored|timeout)\b", request_lines[-1]):
            requests[key] = int(value)
    status_lines = re.findall(r"^\s*status codes:\s*(.*)$", text, re.MULTILINE)
    if status_lines:
        for value, key in re.findall(r"(\d+)\s+([2345]xx)\b", status_lines[-1]):
            statuses[key] = int(value)
    total_bytes = data_bytes = None
    traffic_lines = re.findall(r"^\s*traffic:\s*(.*)$", text, re.MULTILINE)
    if traffic_lines:
        total_match = re.search(r"\((\d+)\)\s+total\b", traffic_lines[-1])
        data_match = re.search(r"\((\d+)\)\s+data\b", traffic_lines[-1])
        total_bytes = int(total_match[1]) if total_match else None
        data_bytes = int(data_match[1]) if data_match else None
    missing = []
    if protocol is None:
        missing.append("protocol")
    if any(value is None for value in requests.values()):
        missing.append("requests")
    if any(value is None for value in statuses.values()):
        missing.append("status_codes")
    if not total_bytes:
        missing.append("traffic_total_bytes")
    if not data_bytes:
        missing.append("traffic_data_bytes")
    return {
        "protocol": protocol, "requests": requests, "status_codes": statuses,
        "traffic_total_bytes": total_bytes, "traffic_data_bytes": data_bytes,
        "header_errors": statuses["4xx"] + statuses["5xx"] if statuses["4xx"] is not None and statuses["5xx"] is not None else None,
        "missing": missing,
    }
