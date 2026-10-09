#!/usr/bin/env python3
"""Verify a Disclosure Ledger export without the app, or even a browser.

    python3 tools/verify_ledger.py docs/examples/ledger.json
    python3 tools/verify_ledger.py ledger.json --quiet      # exit code only

The ledger is a SHA-256 hash chain:

    hash[n] = sha256( hash[n-1] + "\\n" + canonical({seq, timestamp, type, payload}) )
    hash[0].prevHash = "0" * 64

`canonical` is JSON with object keys sorted, no insignificant whitespace, and
numbers reduced to the form JavaScript's String() would produce. The rules are
re-implemented here from scratch (standard library only) so that a Python check
is genuinely independent of the JavaScript that wrote the file.

Exit status: 0 when the chain verifies, 1 when it does not, 2 on a bad file.
"""

import argparse
import hashlib
import json
import sys

GENESIS = "0" * 64


def canonical(value):
    """Byte-for-byte the same string as chain.js canonical() for ledger payloads."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            return "null"
        if value.is_integer():
            return str(int(value))
        return str(round(value, 6))
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonical(item) for item in value) + "]"
    if isinstance(value, dict):
        parts = [json.dumps(key, ensure_ascii=False) + ":" + canonical(value[key]) for key in sorted(value.keys())]
        return "{" + ",".join(parts) + "}"
    raise TypeError("cannot canonicalise %r" % type(value).__name__)


def core_of(record):
    return {
        "seq": record.get("seq"),
        "timestamp": record.get("timestamp"),
        "type": record.get("type"),
        "payload": record.get("payload"),
    }


def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def expected_hash(record, prev_hash):
    return digest(prev_hash + "\n" + canonical(core_of(record)))


def verify(records):
    issues = []
    if not records:
        return {"ok": False, "checked": 0, "issues": [{"index": -1, "code": "empty", "detail": "no records"}]}
    for index, record in enumerate(records):
        if not isinstance(record, dict):
            issues.append({"index": index, "code": "malformed", "detail": "record is not an object"})
            continue
        if record.get("seq") != index + 1:
            issues.append({"index": index, "code": "seq", "detail": "expected seq %d, found %s" % (index + 1, record.get("seq"))})
        want_prev = GENESIS if index == 0 else records[index - 1].get("hash")
        if record.get("prevHash") != want_prev:
            issues.append({"index": index, "code": "prev", "detail": "previous-hash link does not match"})
        stored = record.get("hash")
        if not isinstance(stored, str) or len(stored) != 64:
            issues.append({"index": index, "code": "hash", "detail": "hash is not a 64-character digest"})
            continue
        try:
            recomputed = expected_hash(record, record.get("prevHash"))
        except (TypeError, ValueError) as error:
            issues.append({"index": index, "code": "payload", "detail": "payload cannot be canonicalised: %s" % error})
            continue
        if recomputed != stored:
            issues.append({
                "index": index,
                "code": "hash",
                "detail": "record %s (%s) does not match its stored digest" % (record.get("seq"), record.get("type")),
            })
    return {"ok": not issues, "checked": len(records), "issues": issues}


def load(path):
    if path == "-":
        data = json.load(sys.stdin)
    else:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    if isinstance(data, list):
        return data
    if isinstance(data, dict) and isinstance(data.get("records"), list):
        return data["records"]
    raise ValueError("no records array in this file")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("ledger", help="ledger .json file, or - for stdin")
    parser.add_argument("--quiet", action="store_true", help="print nothing, only set the exit code")
    parser.add_argument("--json", action="store_true", help="print the verdict as JSON")
    args = parser.parse_args(argv)

    try:
        records = load(args.ledger)
    except (OSError, ValueError) as error:
        sys.stderr.write("cannot read the ledger: %s\n" % error)
        return 2
    except json.JSONDecodeError as error:
        sys.stderr.write("that file is not valid JSON: %s\n" % error)
        return 2

    result = verify(records)
    if args.json:
        print(json.dumps(result, indent=2))
    elif not args.quiet:
        if result["ok"]:
            print("OK: %d records, chain intact (verified independently of the app)." % result["checked"])
        else:
            print("FAILED: %d problem(s) in %d record(s)." % (len(result["issues"]), result["checked"]))
            for issue in result["issues"]:
                print("  record %d · %s — %s" % (issue["index"] + 1, issue["code"], issue["detail"]))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
