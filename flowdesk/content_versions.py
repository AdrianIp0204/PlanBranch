"""Pure upgrades for manual snapshots; frozen planning records are never rewritten."""
from copy import deepcopy


CONTENT_VERSION = 2
SUPPORTED_CONTENT_VERSIONS = {1, 2}
BRIEF_FIELDS = ("goal", "audience", "requirements", "constraints", "outOfScope", "decisions", "assumptions")


def empty_brief():
    return {field: "" for field in BRIEF_FIELDS}


def upgrade_content(raw):
    """Return a display/edit copy, including defaults for older saved content."""
    result = deepcopy(raw)
    if not isinstance(result, dict):
        return result
    version = result.get("schemaVersion")
    if type(version) is not int or version not in SUPPORTED_CONTENT_VERSIONS:
        raise ValueError("Unsupported project schema version; expected 1 or 2.")
    if version == 1:
        result.setdefault("brief", empty_brief())
        result["schemaVersion"] = 2
    return result


def manual_identity(content):
    """Match released v1 hashes when a schema upgrade adds only empty defaults.

    This representation is only for freshness comparisons. Request receipts and
    immutable proposal identities must continue hashing their exact JSON bytes.
    """
    result = deepcopy(content)
    result["schemaVersion"] = 1
    if result.get("brief") == empty_brief():
        result.pop("brief")
    return result
