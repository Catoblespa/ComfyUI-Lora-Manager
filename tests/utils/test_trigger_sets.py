import json

import pytest

from py.utils.trigger_sets import (
    DEFAULT_SET_ID,
    TriggerSetValidationError,
    build_trigger_set_list,
    load_trigger_set_info,
    save_trigger_sets,
    validate_trigger_sets,
)


def _sidecar(tmp_path, data):
    model = tmp_path / "rin.safetensors"
    model.write_bytes(b"")
    (tmp_path / "rin.metadata.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return str(model)


def test_reads_first_fork_layout_inside_civitai(tmp_path):
    model = _sidecar(
        tmp_path,
        {
            "civitai": {
                "trainedWords": ["iomC"],
                "triggerSets": [
                    {"id": "set-a", "name": "기본의상", "groups": ["iomA", "white hair, grey hair"]},
                    {"id": "set-b", "name": "한복", "groups": ["iomB", ""]},
                ],
                "activeTriggerSetId": "set-b",
            }
        },
    )

    info = load_trigger_set_info(model)

    assert [s["name"] for s in info["trigger_sets"]] == ["기본의상", "한복"]
    assert info["trigger_sets"][1]["groups"] == ["iomB"]
    assert info["active_set_id"] == "set-b"


def test_top_level_key_wins_and_unknown_active_falls_back(tmp_path):
    model = _sidecar(
        tmp_path,
        {
            "trigger_sets": [{"id": "new", "name": "New", "groups": ["x"]}],
            "active_trigger_set_id": "missing",
            "civitai": {"triggerSets": [{"id": "old", "name": "Old", "groups": ["y"]}]},
        },
    )

    info = load_trigger_set_info(model)

    assert [s["id"] for s in info["trigger_sets"]] == ["new"]
    assert info["active_set_id"] == DEFAULT_SET_ID


def test_missing_or_broken_sidecar_returns_empty(tmp_path):
    assert load_trigger_set_info(str(tmp_path / "none.safetensors"))["trigger_sets"] == []
    (tmp_path / "bad.metadata.json").write_text("{not json", encoding="utf-8")
    assert load_trigger_set_info(str(tmp_path / "bad.safetensors"))["trigger_sets"] == []


async def test_save_keeps_every_other_field_even_if_schema_incomplete(tmp_path):
    original = {
        "file_name": "rin",
        "notes": "keep",
        "civitai": {"trainedWords": ["iomC"], "customImages": [{"id": "a"}], "triggerSets": []},
    }
    model = _sidecar(tmp_path, original)

    await save_trigger_sets(model, validate_trigger_sets([{"name": "한복", "groups": ["iomB"]}]))

    saved = json.loads((tmp_path / "rin.metadata.json").read_text(encoding="utf-8"))
    assert saved["notes"] == "keep"
    assert saved["civitai"]["trainedWords"] == ["iomC"]
    assert saved["civitai"]["customImages"] == [{"id": "a"}]
    assert "triggerSets" not in saved["civitai"]
    assert saved["trigger_sets"][0]["name"] == "한복"


async def test_save_requires_existing_sidecar(tmp_path):
    with pytest.raises(FileNotFoundError):
        await save_trigger_sets(str(tmp_path / "ghost.safetensors"), [])


@pytest.mark.parametrize(
    "payload",
    [
        "nope",
        [{"name": ""}],
        [{"id": "default", "name": "x"}],
        [{"id": "a", "name": "x"}, {"id": "a", "name": "y"}],
    ],
)
def test_validate_rejects_bad_input(payload):
    with pytest.raises(TriggerSetValidationError):
        validate_trigger_sets(payload)


def test_default_set_is_synthesized_from_trained_words():
    sets = build_trigger_set_list(["a, b", " "], [{"id": "s", "name": "S", "groups": []}])
    assert sets[0] == {"id": DEFAULT_SET_ID, "name": "Default", "groups": ["a, b"]}
    assert sets[1]["id"] == "s"
