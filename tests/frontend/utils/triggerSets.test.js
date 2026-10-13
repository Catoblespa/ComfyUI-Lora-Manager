import { describe, it, expect } from "vitest";
import {
  DEFAULT_SET_ID,
  buildTagsForLoras,
  buildTagsFromGroups,
  isStaleUpdate,
  lorasWithSelectableSets,
  parseSetState,
  serializeSetState,
  shortLoraName,
  switchSet,
} from "../../../web/comfyui/trigger_sets_utils.js";

const rin = {
  name: "스텔라이브/아오쿠모 린",
  trigger_words: ["iomC", "school uniform, pleated skirt"],
  active_set_id: DEFAULT_SET_ID,
  trigger_sets: [
    { id: DEFAULT_SET_ID, name: "Default", groups: ["iomC", "school uniform, pleated skirt"] },
    { id: "set-maid", name: "기본의상", groups: ["iomA", "maid, apron"] },
    { id: "set-hanbok", name: "한복", groups: ["iomB", "white hanbok, korean clothes"] },
  ],
};

const plain = {
  name: "style_lora",
  trigger_words: ["flat color"],
  active_set_id: DEFAULT_SET_ID,
  trigger_sets: [{ id: DEFAULT_SET_ID, name: "Default", groups: ["flat color"] }],
};

function build(state, loras, existingTags = [], groupMode = true) {
  return buildTagsForLoras({ loras, state, existingTags, groupMode, defaultActive: true });
}

describe("trigger sets", () => {
  it("emits only the selected set's groups and tags them with their lora", () => {
    const state = parseSetState("");
    const tags = build(state, [rin, plain]);

    expect(tags.map((t) => t.text)).toEqual(["iomC", "school uniform, pleated skirt", "flat color"]);
    expect(tags.map((t) => t.lora)).toEqual([rin.name, rin.name, plain.name]);
    expect(state.selected).toEqual({ [rin.name]: DEFAULT_SET_ID, [plain.name]: DEFAULT_SET_ID });
  });

  it("uses the stored active set id for a LoRA shown for the first time", () => {
    const state = parseSetState("");
    const tags = build(state, [{ ...rin, active_set_id: "set-hanbok" }]);
    expect(tags[0].text).toBe("iomB");
  });

  it("switching sets keeps each set's own on/off state", () => {
    const state = parseSetState("");
    let tags = build(state, [rin]);
    tags[1].items[1].active = false; // pleated skirt off in Default

    switchSet(state, tags, rin.name, "set-hanbok");
    tags = build(state, [rin], tags);
    expect(tags.map((t) => t.text)).toEqual(["iomB", "white hanbok, korean clothes"]);
    expect(tags.every((t) => t.setId === "set-hanbok")).toBe(true);
    tags[0].active = false; // iomB off in 한복

    switchSet(state, tags, rin.name, DEFAULT_SET_ID);
    tags = build(state, [rin], tags);
    expect(tags[1].items.map((i) => i.active)).toEqual([true, false]);

    switchSet(state, tags, rin.name, "set-hanbok");
    tags = build(state, [rin], tags);
    expect(tags[0].active).toBe(false);
  });

  it("drops the tags of a LoRA that was turned off, even with several set LoRAs", () => {
    const other = { ...rin, name: "other", active_set_id: "set-maid" };
    const state = parseSetState("");
    let tags = build(state, [rin, other, plain]);
    expect(new Set(tags.map((t) => t.lora))).toEqual(new Set([rin.name, "other", plain.name]));

    tags = build(state, [plain], tags);
    expect(tags.map((t) => t.lora)).toEqual([plain.name]);
  });

  it("restores on/off state from tags saved before trigger sets existed", () => {
    const legacyTags = [
      { text: "iomC", active: false, items: [{ text: "iomC", active: true }] },
      {
        text: "school uniform, pleated skirt",
        active: true,
        items: [
          { text: "school uniform", active: true },
          { text: "pleated skirt", active: false },
        ],
      },
    ];
    const tags = build(parseSetState(""), [rin], legacyTags);
    expect(tags[0].active).toBe(false);
    expect(tags[1].items[1].active).toBe(false);
  });

  it("flattens groups to words inside the set when group mode is off", () => {
    const state = parseSetState("");
    state.selected[rin.name] = "set-maid";
    const tags = build(state, [rin], [], false);
    expect(tags.map((t) => t.text)).toEqual(["iomA", "maid", "apron"]);
    expect(tags.every((t) => !t.items)).toBe(true);
  });

  it("round-trips through the hidden widget value and tolerates garbage", () => {
    const state = parseSetState("");
    build(state, [rin]);
    state.selected[rin.name] = "set-hanbok";

    const restored = parseSetState(serializeSetState(state));
    expect(restored.selected[rin.name]).toBe("set-hanbok");
    expect(restored.loras[0].name).toBe(rin.name);
    expect(parseSetState("{broken")).toEqual({ loras: [], selected: {}, stash: {} });
  });

  it("falls back to the default set when the selected set was deleted", () => {
    const state = parseSetState(JSON.stringify({ selected: { [rin.name]: "gone" } }));
    const tags = build(state, [rin]);
    expect(tags[0].setId).toBe(DEFAULT_SET_ID);
  });

  it("only lists LoRAs that actually have extra sets", () => {
    const state = parseSetState("");
    build(state, [rin, plain]);
    expect(lorasWithSelectableSets(state).map((l) => l.name)).toEqual([rin.name]);
    expect(shortLoraName("a/b/아오쿠모 린.safetensors")).toBe("아오쿠모 린");
  });
});

describe("legacy tag building", () => {
  it("matches the original non-group split of a whole message", () => {
    const tags = buildTagsFromGroups(["a, b,, (c, d:1.2)"], [], false, true, false);
    expect(tags.map((t) => t.text)).toEqual(["a", "b", "(c, d:1.2)"]);
  });
});

describe("stale updates", () => {
  it("ignores responses older than the latest request for that node", () => {
    const node = { _lmTriggerSeq: 3 };
    expect(isStaleUpdate(node, 2)).toBe(true);
    expect(isStaleUpdate(node, 3)).toBe(false);
    expect(isStaleUpdate(node, undefined)).toBe(false);
    expect(isStaleUpdate({}, 1)).toBe(false);
  });
});
