import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
  CONVERTED_TYPE,
  collectActiveLorasFromChain,
  getLinkFromGraph,
  getNodeFromGraph,
  updateConnectedTriggerWords,
} from "./utils.js";
import { addTagsWidget } from "./tags_widget.js";
import { getWheelSensitivity } from "./settings.js";
import {
  DEFAULT_SET_ID,
  buildTagsForLoras,
  buildTagsFromGroups,
  cloneTag,
  isStaleUpdate,
  lorasWithSelectableSets,
  parseSetState,
  serializeSetState,
  shortLoraName,
  splitMessageGroups,
  splitTopLevelCommas,
  switchSet,
} from "./trigger_sets_utils.js";

function normalizeTagText(text) {
  return typeof text === "string" ? text.trim().toLowerCase() : "";
}

function collectHighlightTokens(wordsArray) {
  const tokens = new Set();

  const addToken = (text) => {
    const normalized = normalizeTagText(text);
    if (normalized) {
      tokens.add(normalized);
    }
  };

  wordsArray.forEach((rawWord) => {
    if (typeof rawWord !== "string") {
      return;
    }

    addToken(rawWord);

    const groupParts = rawWord.split(/,{2,}/);
    groupParts.forEach((groupPart) => {
      addToken(groupPart);
      splitTopLevelCommas(groupPart).forEach(addToken);
    });

    splitTopLevelCommas(rawWord).forEach(addToken);
  });

  return tokens;
}

function persistSetState(node) {
  if (node.triggerSetStateWidget && node._lmSetState) {
    node.triggerSetStateWidget.value = serializeSetState(node._lmSetState);
  }
}

// Ask the LoRA Manager node feeding our trigger_words input to resend its
// trigger words, so set info is available right after a workflow loads
// (including workflows saved before trigger sets existed).
function requestTriggerRefresh(node) {
  const inputIndex = (node.inputs || []).findIndex((input) => input?.name === "trigger_words");
  const linkId = inputIndex >= 0 ? node.inputs[inputIndex].link : null;
  if (linkId === null || linkId === undefined) {
    return;
  }
  const link = getLinkFromGraph(node.graph, linkId);
  const source = link ? node.graph?.getNodeById?.(link.origin_id) : null;
  if (!source || typeof source.comfyClass !== "string" || !source.comfyClass.endsWith("(LoraManager)")) {
    return;
  }
  updateConnectedTriggerWords(source, collectActiveLorasFromChain(source));
}

// Radio rows (one per LoRA that has extra trigger sets), rendered above the tags.
function renderTriggerSetHeader(node, container) {
  const state = node._lmSetState;
  if (!node._lmUseSets || !state) {
    return;
  }
  const loras = lorasWithSelectableSets(state);
  if (loras.length === 0) {
    return;
  }

  const bar = document.createElement("div");
  bar.className = "lm-trigger-set-bar";

  loras.forEach((lora) => {
    const row = document.createElement("div");
    row.className = "lm-trigger-set-row";

    const label = document.createElement("span");
    label.className = "lm-trigger-set-lora";
    label.textContent = shortLoraName(lora.name);
    label.title = lora.name;
    row.appendChild(label);

    const selectedId = state.selected[lora.name] || DEFAULT_SET_ID;
    lora.trigger_sets.forEach((set) => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "lm-trigger-set-option";
      if (set.id === selectedId) {
        option.classList.add("lm-trigger-set-option--active");
      }
      option.textContent = set.id === DEFAULT_SET_ID ? "Default" : set.name;
      option.title = (set.groups || []).join("\n");
      option.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        node.selectTriggerSet?.(lora.name, set.id);
      });
      row.appendChild(option);
    });

    bar.appendChild(row);
  });

  container.appendChild(bar);
}

app.registerExtension({
  name: "LoraManager.TriggerWordToggle",

  setup() {
    api.addEventListener("trigger_word_update", (event) => {
      const { id, graph_id: graphId, message, loras, seq } = event.detail;
      this.handleTriggerWordUpdate(id, graphId, message, loras, seq);
    });
  },

  async nodeCreated(node) {
    if (node.comfyClass !== "TriggerWord Toggle (LoraManager)") {
      return;
    }

    node.serialize_widgets = true;
    node.addInput("trigger_words", "string", {
      shape: 7,
    });

    requestAnimationFrame(async () => {
      const wheelSensitivity = getWheelSensitivity();
      const groupModeWidget = node.widgets[0];
      const defaultActiveWidget = node.widgets[1];
      const strengthAdjustmentWidget = node.widgets[2];
      const initialStrengthAdjustment = Boolean(strengthAdjustmentWidget?.value);

      const result = addTagsWidget(node, "toggle_trigger_words", {
        defaultVal: [],
      }, null, wheelSensitivity, {
        allowStrengthAdjustment: initialStrengthAdjustment,
        renderHeader: (container) => renderTriggerSetHeader(node, container),
      });

      node.tagWidget = result.widget;
      node.tagWidget.allowStrengthAdjustment = initialStrengthAdjustment;

      const applyHighlightState = () => {
        if (!node.tagWidget) {
          return;
        }

        const highlightSet = node._highlightedTriggerWords || new Set();
        const updatedTags = (node.tagWidget.value || []).map((tag) => {
          if (Array.isArray(tag.items)) {
            const items = tag.items.map((item) => ({
              ...item,
              highlighted: highlightSet.size > 0 && highlightSet.has(normalizeTagText(item.text)),
            }));

            return {
              ...tag,
              items,
              highlighted:
                highlightSet.size > 0 &&
                (highlightSet.has(normalizeTagText(tag.text)) ||
                  items.some((item) => item.highlighted)),
            };
          }

          return {
            ...tag,
            highlighted: highlightSet.size > 0 && highlightSet.has(normalizeTagText(tag.text)),
          };
        });

        node.tagWidget.value = updatedTags;
      };

      node.highlightTriggerWords = (triggerWords) => {
        const wordsArray = Array.isArray(triggerWords)
          ? triggerWords
          : triggerWords
            ? [triggerWords]
            : [];
        node._highlightedTriggerWords = collectHighlightTokens(wordsArray);
        applyHighlightState();
      };

      if (node.__pendingHighlightWords !== undefined) {
        const pending = node.__pendingHighlightWords;
        delete node.__pendingHighlightWords;
        node.highlightTriggerWords(pending);
      }

      node.applyTriggerHighlightState = applyHighlightState;

      const hiddenWidget = node.addWidget("text", "orinalMessage", "");
      hiddenWidget.type = CONVERTED_TYPE;
      hiddenWidget.hidden = true;
      hiddenWidget.computeSize = () => [0, -4];
      node.originalMessageWidget = hiddenWidget;

      // Added after every pre-existing widget so saved widgets_values of
      // workflows/images created before trigger sets keep their indices.
      const setStateWidget = node.addWidget("text", "trigger_set_state", "");
      setStateWidget.type = CONVERTED_TYPE;
      setStateWidget.hidden = true;
      setStateWidget.computeSize = () => [0, -4];
      node.triggerSetStateWidget = setStateWidget;

      const tagWidgetIndex = node.widgets.indexOf(result.widget);
      const originalMessageWidgetIndex = node.widgets.indexOf(hiddenWidget);
      const setStateWidgetIndex = node.widgets.indexOf(setStateWidget);
      if (node.widgets_values && node.widgets_values.length > 0) {
        if (setStateWidgetIndex >= 0 && setStateWidgetIndex < node.widgets_values.length) {
          const savedState = node.widgets_values[setStateWidgetIndex];
          if (savedState) {
            setStateWidget.value = typeof savedState === "string" ? savedState : JSON.stringify(savedState);
          }
        }
        // Restore the set state before the tags so the header renders with them.
        node._lmSetState = parseSetState(setStateWidget.value);
        node._lmUseSets = node._lmSetState.loras.length > 0;

        if (tagWidgetIndex >= 0) {
          const savedValue = node.widgets_values[tagWidgetIndex];
          if (savedValue) {
            result.widget.value = Array.isArray(savedValue) ? savedValue : [];
          }
        }
        if (originalMessageWidgetIndex >= 0) {
          const originalMessage = node.widgets_values[originalMessageWidgetIndex];
          if (originalMessage) {
            hiddenWidget.value = originalMessage;
          }
        }
      } else {
        node._lmSetState = parseSetState(setStateWidget.value);
        node._lmUseSets = false;
      }

      node.selectTriggerSet = (loraName, setId) => {
        const state = node._lmSetState;
        if (!state || !node.tagWidget) {
          return;
        }
        node.tagWidget.closeGroupEditor?.();
        const currentTags = (node.tagWidget.value || []).map(cloneTag);
        if (!switchSet(state, currentTags, loraName, setId)) {
          return;
        }
        this.updateTagsBasedOnMode(
          node,
          node.originalMessageWidget?.value || "",
          groupModeWidget?.value ?? false,
          Boolean(strengthAdjustmentWidget?.value)
        );
      };

      // An update may have arrived before this widget existed (common while a
      // workflow loads); apply it now instead of losing it. Otherwise ask the
      // connected loader for fresh trigger words and sets.
      const pendingUpdate = node.__pendingTriggerUpdate;
      delete node.__pendingTriggerUpdate;
      if (pendingUpdate) {
        this.applyTriggerWordUpdate(node, pendingUpdate.message, pendingUpdate.loras);
      } else {
        requestTriggerRefresh(node);
      }

      requestAnimationFrame(() => node.applyTriggerHighlightState?.());

      groupModeWidget.callback = (value) => {
        node.tagWidget?.closeGroupEditor?.();
        if (node.originalMessageWidget?.value || node._lmUseSets) {
          this.updateTagsBasedOnMode(
            node,
            node.originalMessageWidget?.value || "",
            value,
            Boolean(strengthAdjustmentWidget?.value)
          );
        }
      };

      defaultActiveWidget.callback = (value) => {
        if (!node.tagWidget || !node.tagWidget.value) {
          return;
        }

        const groupMode = groupModeWidget?.value ?? false;

        const updatedTags = node.tagWidget.value.map((tag) => {
          if (!Array.isArray(tag.items)) {
            return {
              ...tag,
              active: value,
            };
          }

          // In group mode, default_active only controls the group-level switch.
          // Children's individual active states are managed exclusively via the group editor.
          if (groupMode) {
            return {
              ...tag,
              active: value,
            };
          }

          return {
            ...tag,
            active: value,
            items: tag.items.map((item) => ({
              ...item,
              active: value,
            })),
          };
        });
        node.tagWidget.value = updatedTags;
        node.applyTriggerHighlightState?.();
      };

      if (strengthAdjustmentWidget) {
        strengthAdjustmentWidget.callback = (value) => {
          const allowStrengthAdjustment = Boolean(value);
          if (node.tagWidget) {
            node.tagWidget.allowStrengthAdjustment = allowStrengthAdjustment;
            node.tagWidget.closeGroupEditor?.();
          }
          this.updateTagsBasedOnMode(
            node,
            node.originalMessageWidget?.value || "",
            groupModeWidget?.value ?? false,
            allowStrengthAdjustment
          );
        };
      }

      result.widget.serializeValue = function() {
        const value = this.value || [];
        return value.map((tag) => {
          if (Array.isArray(tag.items)) {
            return {
              ...tag,
              text:
                tag.strength !== undefined && tag.strength !== null
                  ? `(${tag.text}:${tag.strength.toFixed(2)})`
                  : tag.text,
              items: tag.items.map((item) => ({ ...item })),
            };
          }

          if (tag.strength !== undefined && tag.strength !== null) {
            return {
              ...tag,
              text: `(${tag.text}:${tag.strength.toFixed(2)})`,
            };
          }

          return tag;
        });
      };
    });
  },

  handleTriggerWordUpdate(id, graphId, message, loras, seq) {
    const node = getNodeFromGraph(graphId, id);
    if (!node || node.comfyClass !== "TriggerWord Toggle (LoraManager)") {
      console.warn("Node not found or not a TriggerWordToggle:", id);
      return;
    }

    if (isStaleUpdate(node, seq)) {
      return;
    }

    if (!node.tagWidget) {
      node.__pendingTriggerUpdate = { message, loras };
      return;
    }

    this.applyTriggerWordUpdate(node, message, loras);
  },

  applyTriggerWordUpdate(node, message, loras) {
    if (node.originalMessageWidget) {
      node.originalMessageWidget.value = message;
    }

    if (Array.isArray(loras)) {
      if (!node._lmSetState) {
        node._lmSetState = parseSetState(node.triggerSetStateWidget?.value);
      }
      node._lmSetState.loras = loras;
      node._lmUseSets = true;
    }

    if (node.tagWidget) {
      const groupMode = node.widgets[0] ? node.widgets[0].value : false;
      const allowStrengthAdjustment = Boolean(node.widgets[2]?.value);
      node.tagWidget.allowStrengthAdjustment = allowStrengthAdjustment;
      this.updateTagsBasedOnMode(node, message, groupMode, allowStrengthAdjustment);
    }
  },

  updateTagsBasedOnMode(node, message, groupMode, allowStrengthAdjustment = false) {
    if (!node.tagWidget) {
      return;
    }
    node.tagWidget.closeGroupEditor?.();
    node.tagWidget.allowStrengthAdjustment = allowStrengthAdjustment;

    const existingTags = (node.tagWidget.value || []).map(cloneTag);
    const defaultActive = node.widgets[1] ? node.widgets[1].value : true;
    let tagArray;

    if (node._lmUseSets && node._lmSetState) {
      tagArray = buildTagsForLoras({
        loras: node._lmSetState.loras,
        state: node._lmSetState,
        existingTags,
        groupMode,
        defaultActive,
        allowStrengthAdjustment,
      });
      persistSetState(node);
    } else {
      const groups = groupMode ? splitMessageGroups(message) : [message];
      tagArray = buildTagsFromGroups(
        groups,
        existingTags,
        groupMode,
        defaultActive,
        allowStrengthAdjustment
      );
    }

    node.tagWidget.value = tagArray;
    node.applyTriggerHighlightState?.();
  },
});
