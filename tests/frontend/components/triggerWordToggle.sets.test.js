import { describe, it, expect, beforeEach, vi } from "vitest";

const { APP_MODULE, API_MODULE, UTILS_MODULE, TAGS_MODULE, SETTINGS_MODULE, TOGGLE_MODULE } = vi.hoisted(() => ({
  APP_MODULE: new URL("../../../scripts/app.js", import.meta.url).pathname,
  API_MODULE: new URL("../../../scripts/api.js", import.meta.url).pathname,
  UTILS_MODULE: new URL("../../../web/comfyui/utils.js", import.meta.url).pathname,
  TAGS_MODULE: new URL("../../../web/comfyui/tags_widget.js", import.meta.url).pathname,
  SETTINGS_MODULE: new URL("../../../web/comfyui/settings.js", import.meta.url).pathname,
  TOGGLE_MODULE: new URL("../../../web/comfyui/trigger_word_toggle.js", import.meta.url).pathname,
}));

const extensionState = { current: null };
const nodesById = new Map();

vi.mock(APP_MODULE, () => ({
  app: {
    registerExtension: (extension) => {
      extensionState.current = extension;
    },
  },
}));

vi.mock(API_MODULE, () => ({ api: { addEventListener: vi.fn() } }));

const updateConnectedTriggerWords = vi.fn();
const collectActiveLorasFromChain = vi.fn(() => new Set(["rin"]));

vi.mock(UTILS_MODULE, () => ({
  CONVERTED_TYPE: "converted-widget",
  getNodeFromGraph: (_graphId, id) => nodesById.get(id) ?? null,
  getLinkFromGraph: (graph, linkId) => graph?.links?.[linkId] ?? null,
  updateConnectedTriggerWords,
  collectActiveLorasFromChain,
}));

vi.mock(SETTINGS_MODULE, () => ({ getWheelSensitivity: () => 0.02 }));

const headerCalls = [];
vi.mock(TAGS_MODULE, () => ({
  addTagsWidget: (node, name, opts, _cb, _wheel, options) => {
    const widget = { name, value: opts.defaultVal, closeGroupEditor: vi.fn() };
    let current = widget.value;
    Object.defineProperty(widget, "value", {
      get: () => current,
      set: (v) => {
        current = v;
        const container = document.createElement("div");
        options.renderHeader?.(container, widget);
        headerCalls.push(container);
      },
    });
    node.widgets.push(widget);
    return { widget };
  },
}));

const rin = {
  name: "rin",
  trigger_words: ["iomC"],
  active_set_id: "default",
  trigger_sets: [
    { id: "default", name: "Default", groups: ["iomC"] },
    { id: "set-hanbok", name: "한복", groups: ["iomB, hanbok"] },
  ],
};

function createNode(widgetsValues) {
  const node = {
    id: 1,
    comfyClass: "TriggerWord Toggle (LoraManager)",
    widgets: [
      { name: "group_mode", value: true },
      { name: "default_active", value: true },
      { name: "allow_strength_adjustment", value: false },
    ],
    widgets_values: widgetsValues,
    addInput: vi.fn(),
    addWidget(type, name, value) {
      const widget = { type, name, value };
      this.widgets.push(widget);
      return widget;
    },
  };
  nodesById.set(node.id, node);
  return node;
}

async function setupNode(widgetsValues, beforeInit) {
  await import(TOGGLE_MODULE);
  const node = createNode(widgetsValues);
  beforeInit?.(node);
  await extensionState.current.nodeCreated(node);
  return node;
}

function connectLoader(node) {
  const loader = { id: 7, comfyClass: "Lora Loader (LoraManager)" };
  node.inputs = [{ name: "trigger_words", link: 3 }];
  node.graph = {
    links: { 3: { origin_id: 7 } },
    getNodeById: (id) => (id === 7 ? loader : null),
  };
  return loader;
}

describe("TriggerWord Toggle trigger sets", () => {
  beforeEach(() => {
    vi.resetModules();
    nodesById.clear();
    headerCalls.length = 0;
    updateConnectedTriggerWords.mockClear();
    vi.stubGlobal("requestAnimationFrame", (cb) => cb());
  });

  it("keeps an update that arrives before the widget exists (workflow load)", async () => {
    let rafCallback = null;
    vi.stubGlobal("requestAnimationFrame", (cb) => {
      if (!rafCallback) {
        rafCallback = cb;
      } else {
        cb();
      }
    });
    await import(TOGGLE_MODULE);
    const node = createNode([true, true, false, [], ""]);
    await extensionState.current.nodeCreated(node);

    // Loader restored first and already sent its trigger words.
    extensionState.current.handleTriggerWordUpdate(1, null, "iomC", [{ ...rin, active_set_id: "set-hanbok" }]);
    rafCallback();

    expect(node.tagWidget.value.map((t) => t.text)).toEqual(["iomB, hanbok"]);
    expect(headerCalls.at(-1).querySelectorAll(".lm-trigger-set-option").length).toBe(2);
    expect(updateConnectedTriggerWords).not.toHaveBeenCalled();
  });

  it("asks the connected loader for fresh trigger sets once ready", async () => {
    let loader;
    await setupNode([true, true, false, [], "iomC"], (node) => {
      loader = connectLoader(node);
    });
    expect(updateConnectedTriggerWords).toHaveBeenCalledWith(loader, new Set(["rin"]));
  });

  it("does not request a refresh when nothing is connected", async () => {
    await setupNode(undefined);
    expect(updateConnectedTriggerWords).not.toHaveBeenCalled();
  });

  it("appends the set state widget after all pre-existing widgets", async () => {
    const node = await setupNode(undefined);
    expect(node.widgets.map((w) => w.name)).toEqual([
      "group_mode",
      "default_active",
      "allow_strength_adjustment",
      "toggle_trigger_words",
      "orinalMessage",
      "trigger_set_state",
    ]);
  });

  it("restores an old workflow without set state and keeps its toggles", async () => {
    const savedTags = [{ text: "iomC", active: false, items: [{ text: "iomC", active: true }] }];
    const node = await setupNode([true, true, false, savedTags, "iomC"]);
    expect(node.tagWidget.value[0]).toMatchObject({ text: "iomC", active: false });

    extensionState.current.handleTriggerWordUpdate(1, null, "iomC", [rin], 1);
    expect(node.tagWidget.value[0].active).toBe(false);
    expect(node.tagWidget.value[0].lora).toBe("rin");
  });

  it("switches sets from the header and persists the selection", async () => {
    const node = await setupNode(undefined);
    extensionState.current.handleTriggerWordUpdate(1, null, "iomC", [rin]);

    const header = headerCalls.at(-1);
    const options = [...header.querySelectorAll(".lm-trigger-set-option")];
    expect(options.map((o) => o.textContent)).toEqual(["Default", "한복"]);

    options[1].click();
    expect(node.tagWidget.value.map((t) => t.text)).toEqual(["iomB, hanbok"]);
    expect(JSON.parse(node.triggerSetStateWidget.value).selected).toEqual({ rin: "set-hanbok" });
  });

  it("ignores a response older than the latest request", async () => {
    const node = await setupNode(undefined);
    node._lmTriggerSeq = 2;

    extensionState.current.handleTriggerWordUpdate(1, null, "", [], 2);
    extensionState.current.handleTriggerWordUpdate(1, null, "iomC", [rin], 1);

    expect(node.tagWidget.value).toEqual([]);
    expect(node.originalMessageWidget.value).toBe("");
  });
});
