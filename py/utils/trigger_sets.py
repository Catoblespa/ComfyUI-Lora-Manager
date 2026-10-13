"""Trigger sets: named alternative trigger word groups stored per LoRA.

The default set is never persisted; it is always ``civitai.trainedWords``.
Additional sets live in the top-level ``trigger_sets`` key of the model's
``.metadata.json`` so that CivitAI metadata sync never touches them.

The first fork implementation stored them as ``civitai.triggerSets`` (plus
``civitai.activeTriggerSetId``); those locations are still read and are
migrated to the top-level keys on the next save.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from typing import Any, Dict, List

from .metadata_manager import MetadataManager

logger = logging.getLogger(__name__)

TRIGGER_SETS_KEY = "trigger_sets"
ACTIVE_SET_KEY = "active_trigger_set_id"
LEGACY_TRIGGER_SETS_KEY = "triggerSets"
LEGACY_ACTIVE_SET_KEY = "activeTriggerSetId"
DEFAULT_SET_ID = "default"
MAX_TRIGGER_SETS = 50


class TriggerSetValidationError(ValueError):
    """Raised when client supplied trigger sets are malformed."""


def _metadata_path(model_path: str) -> str:
    if model_path.endswith(".metadata.json"):
        return model_path
    return f"{os.path.splitext(model_path)[0]}.metadata.json"


def _clean_groups(groups: Any) -> List[str]:
    if not isinstance(groups, list):
        return []
    cleaned = []
    for group in groups:
        if isinstance(group, str) and group.strip():
            cleaned.append(group.strip())
    return cleaned


def normalize_trigger_sets(raw: Any) -> List[Dict[str, Any]]:
    """Leniently normalize stored trigger sets, dropping malformed entries."""
    if not isinstance(raw, list):
        return []

    normalized = []
    seen_ids = set()
    for index, entry in enumerate(raw):
        if not isinstance(entry, dict):
            continue
        set_id = str(entry.get("id") or "").strip()
        if not set_id or set_id == DEFAULT_SET_ID or set_id in seen_ids:
            continue
        name = str(entry.get("name") or "").strip() or f"Set {index + 2}"
        seen_ids.add(set_id)
        normalized.append(
            {"id": set_id, "name": name, "groups": _clean_groups(entry.get("groups"))}
        )
    return normalized


def _first_present(metadata: Dict[str, Any], key: str, legacy_key: str) -> Any:
    if metadata.get(key) is not None:
        return metadata[key]
    if metadata.get(legacy_key) is not None:
        return metadata[legacy_key]
    civitai = metadata.get("civitai")
    if isinstance(civitai, dict):
        return civitai.get(legacy_key)
    return None


def extract_trigger_sets(metadata: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Read trigger sets from a metadata dict, accepting the legacy locations."""
    if not isinstance(metadata, dict):
        return []
    return normalize_trigger_sets(
        _first_present(metadata, TRIGGER_SETS_KEY, LEGACY_TRIGGER_SETS_KEY)
    )


def extract_active_set_id(metadata: Dict[str, Any], trigger_sets: List[Dict[str, Any]]) -> str:
    """Return the preferred initial set id, falling back to the default set."""
    if not isinstance(metadata, dict):
        return DEFAULT_SET_ID
    active = _first_present(metadata, ACTIVE_SET_KEY, LEGACY_ACTIVE_SET_KEY)
    if isinstance(active, str) and any(s["id"] == active for s in trigger_sets):
        return active
    return DEFAULT_SET_ID


def _read_sidecar(model_path: str) -> Dict[str, Any]:
    if not model_path:
        return {}
    metadata_path = _metadata_path(model_path)
    if not os.path.exists(metadata_path):
        return {}
    try:
        with open(metadata_path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
            return data if isinstance(data, dict) else {}
    except Exception as exc:
        logger.warning("Failed to read trigger sets from %s: %s", metadata_path, exc)
        return {}


def load_trigger_sets(model_path: str) -> List[Dict[str, Any]]:
    """Load trigger sets directly from the sidecar file (not the cache)."""
    return extract_trigger_sets(_read_sidecar(model_path))


def load_trigger_set_info(model_path: str) -> Dict[str, Any]:
    """Load trigger sets and the preferred active set id from the sidecar."""
    metadata = _read_sidecar(model_path)
    trigger_sets = extract_trigger_sets(metadata)
    return {
        "trigger_sets": trigger_sets,
        "active_set_id": extract_active_set_id(metadata, trigger_sets),
    }


def validate_trigger_sets(raw: Any) -> List[Dict[str, Any]]:
    """Strictly validate client supplied trigger sets for saving."""
    if not isinstance(raw, list):
        raise TriggerSetValidationError("trigger_sets must be a list")
    if len(raw) > MAX_TRIGGER_SETS:
        raise TriggerSetValidationError(f"At most {MAX_TRIGGER_SETS} trigger sets are allowed")

    validated = []
    seen_ids = set()
    for entry in raw:
        if not isinstance(entry, dict):
            raise TriggerSetValidationError("Each trigger set must be an object")
        name = entry.get("name")
        if not isinstance(name, str) or not name.strip():
            raise TriggerSetValidationError("Each trigger set needs a name")
        set_id = str(entry.get("id") or "").strip() or f"set-{uuid.uuid4().hex[:12]}"
        if set_id == DEFAULT_SET_ID:
            raise TriggerSetValidationError("'default' is reserved for the base trigger words")
        if set_id in seen_ids:
            raise TriggerSetValidationError(f"Duplicate trigger set id: {set_id}")
        seen_ids.add(set_id)
        validated.append(
            {"id": set_id, "name": name.strip(), "groups": _clean_groups(entry.get("groups"))}
        )
    return validated


async def save_trigger_sets(model_path: str, trigger_sets: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Persist trigger sets into an existing sidecar without touching other fields."""
    metadata_path = _metadata_path(model_path)
    if not os.path.exists(metadata_path):
        raise FileNotFoundError(metadata_path)

    # Read the raw sidecar rather than the parsed model payload: a sidecar that
    # fails schema parsing would otherwise come back nearly empty and be
    # overwritten, losing data.
    with open(metadata_path, "r", encoding="utf-8") as handle:
        metadata = json.load(handle)
    if not isinstance(metadata, dict):
        raise ValueError(f"Unexpected metadata format in {metadata_path}")
    previous_active = _first_present(metadata, ACTIVE_SET_KEY, LEGACY_ACTIVE_SET_KEY)

    # Migrate away from the legacy locations; trainedWords is never touched.
    for key in (LEGACY_TRIGGER_SETS_KEY, LEGACY_ACTIVE_SET_KEY):
        metadata.pop(key, None)
    civitai = metadata.get("civitai")
    if isinstance(civitai, dict):
        civitai.pop(LEGACY_TRIGGER_SETS_KEY, None)
        civitai.pop(LEGACY_ACTIVE_SET_KEY, None)

    if trigger_sets:
        metadata[TRIGGER_SETS_KEY] = trigger_sets
    else:
        metadata.pop(TRIGGER_SETS_KEY, None)

    if isinstance(previous_active, str) and any(s["id"] == previous_active for s in trigger_sets):
        metadata[ACTIVE_SET_KEY] = previous_active
    else:
        metadata.pop(ACTIVE_SET_KEY, None)

    if not await MetadataManager.save_metadata(model_path, metadata):
        raise OSError(f"Failed to save metadata for {model_path}")
    return trigger_sets


def build_trigger_set_list(trigger_words: List[str], extra_sets: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Prepend the synthesized default set built from trainedWords."""
    default_set = {
        "id": DEFAULT_SET_ID,
        "name": "Default",
        "groups": _clean_groups(list(trigger_words or [])),
    }
    return [default_set, *extra_sets]
