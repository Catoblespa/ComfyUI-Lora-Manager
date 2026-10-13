// Pure helpers for the TriggerWord Toggle node, including trigger sets.
// Kept free of ComfyUI imports so they can be unit tested.

export const DEFAULT_SET_ID = "default";

export function splitTopLevelCommas(text) {
  if (typeof text !== "string" || !text.trim()) {
    return [];
  }

  const parts = [];
  let current = "";
  let depth = 0;

  for (const char of text) {
    if (char === "(") {
      depth += 1;
      current += char;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }
    if (char === "," && depth === 0) {
      const trimmed = current.trim();
      if (trimmed) {
        parts.push(trimmed);
      }
      current = "";
      continue;
    }
    current += char;
  }

  const trimmed = current.trim();
  if (trimmed) {
    parts.push(trimmed);
  }

  return parts;
}

export function isGroupTag(tag) {
  return Array.isArray(tag?.items);
}

export function parseSerializedText(text) {
  const normalizedText = typeof text === "string" ? text.trim() : "";
  const strengthMatch = normalizedText.match(/^\((.+):([\d.]+)\)$/);
  if (!strengthMatch) {
    return {
      text: normalizedText,
      strength: null,
    };
  }

  const parsedStrength = Number(strengthMatch[2]);
  return {
    text: strengthMatch[1].trim(),
    strength: Number.isFinite(parsedStrength) ? parsedStrength : null,
  };
}

export function cloneTag(tag) {
  if (!isGroupTag(tag)) {
    return { ...tag };
  }
  return {
    ...tag,
    items: tag.items.map((item) => ({ ...item })),
  };
}

export function buildLegacyTagState(existingTags, allowStrengthAdjustment) {
  return existingTags.reduce((acc, tag) => {
    const parsed = parseSerializedText(tag.text);
    const key = parsed.text;
    if (!acc[key]) {
      acc[key] = [];
    }
    acc[key].push({
      active: tag.active,
      strength:
        allowStrengthAdjustment
          ? (tag.strength !== undefined && tag.strength !== null ? tag.strength : parsed.strength)
          : null,
    });
    return acc;
  }, {});
}

export function buildGroupState(existingTags, allowStrengthAdjustment) {
  return existingTags.reduce((acc, tag) => {
    const parsed = parseSerializedText(tag.text);
    const key = parsed.text;
    if (!acc[key]) {
      acc[key] = [];
    }

    const itemState = {};
    if (Array.isArray(tag.items)) {
      tag.items.forEach((item) => {
        const itemKey = item.text;
        if (!itemState[itemKey]) {
          itemState[itemKey] = [];
        }
        itemState[itemKey].push({
          active: item.active,
        });
      });
    } else {
      splitTopLevelCommas(tag.text).forEach((itemText) => {
        if (!itemState[itemText]) {
          itemState[itemText] = [];
        }
        itemState[itemText].push({
          active: tag.active,
        });
      });
    }

    acc[key].push({
      active: tag.active,
      strength:
        allowStrengthAdjustment
          ? (tag.strength !== undefined && tag.strength !== null ? tag.strength : parsed.strength)
          : null,
      itemState,
    });
    return acc;
  }, {});
}

export function consumeQueuedState(stateMap, key) {
  const queue = stateMap[key];
  if (queue && queue.length > 0) {
    return queue.shift();
  }
  return null;
}

// Build tags from a list of group strings, restoring state from existingTags
// by text. This is the original (pre trigger set) behaviour of the node.
export function buildTagsFromGroups(groups, existingTags, groupMode, defaultActive, allowStrengthAdjustment) {
  if (groupMode) {
    const existingGroupState = buildGroupState(existingTags, allowStrengthAdjustment);
    return groups.map((group) => {
      const existing = consumeQueuedState(existingGroupState, group);
      const itemState = existing?.itemState || {};
      const items = splitTopLevelCommas(group).map((itemText) => {
        const savedItem = consumeQueuedState(itemState, itemText);
        return {
          text: itemText,
          active: savedItem ? savedItem.active : true,
          highlighted: false,
          strength: null,
        };
      });

      return {
        text: group,
        active: existing ? existing.active : defaultActive,
        highlighted: false,
        strength: existing ? existing.strength : null,
        items,
      };
    });
  }

  const existingTagState = buildLegacyTagState(existingTags, allowStrengthAdjustment);
  return groups.flatMap((group) => splitTopLevelCommas(group)).map((word) => {
    const existing = consumeQueuedState(existingTagState, word);
    return {
      text: word,
      active: existing ? existing.active : defaultActive,
      highlighted: false,
      strength: existing ? existing.strength : null,
    };
  });
}

export function splitMessageGroups(message) {
  if (typeof message !== "string" || !message.trim()) {
    return [];
  }
  return (message.includes(",,") ? message.split(/,{2,}/) : [message])
    .map((group) => group.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Trigger sets
// ---------------------------------------------------------------------------

export function createEmptySetState() {
  return { loras: [], selected: {}, stash: {} };
}

// Accepts the hidden widget value (JSON string or object) and always returns
// a well-formed state object.
export function parseSetState(raw) {
  let value = raw;
  if (typeof value === "string") {
    if (!value.trim()) {
      return createEmptySetState();
    }
    try {
      value = JSON.parse(value);
    } catch {
      return createEmptySetState();
    }
  }
  if (!value || typeof value !== "object") {
    return createEmptySetState();
  }
  return {
    loras: Array.isArray(value.loras) ? value.loras : [],
    selected: value.selected && typeof value.selected === "object" ? { ...value.selected } : {},
    stash: value.stash && typeof value.stash === "object" ? { ...value.stash } : {},
  };
}

export function serializeSetState(state) {
  return JSON.stringify({
    loras: state.loras,
    selected: state.selected,
    stash: state.stash,
  });
}

function findSet(lora, setId) {
  return (lora.trigger_sets || []).find((set) => set.id === setId) || null;
}

export function resolveSelectedSetId(lora, state) {
  const chosen = state.selected[lora.name];
  if (chosen && findSet(lora, chosen)) {
    return chosen;
  }
  if (lora.active_set_id && findSet(lora, lora.active_set_id)) {
    return lora.active_set_id;
  }
  return DEFAULT_SET_ID;
}

function getSetGroups(lora, setId) {
  const set = findSet(lora, setId);
  if (set) {
    return set.groups || [];
  }
  return setId === DEFAULT_SET_ID ? lora.trigger_words || [] : [];
}

// Build the tag list for the given LoRAs. Each LoRA contributes the groups of
// its selected set only, so groups of inactive sets never reach the output.
// Tags of LoRAs no longer present are dropped. Existing state is restored
// from (1) current tags of the same lora/set, (2) the stash for that set,
// (3) legacy tags without lora info, matched by text (old workflows).
export function buildTagsForLoras({
  loras,
  state,
  existingTags = [],
  groupMode,
  defaultActive,
  allowStrengthAdjustment = false,
}) {
  const legacyTags = existingTags.filter((tag) => !tag.lora).map(cloneTag);
  const tags = [];

  for (const lora of loras) {
    const setId = resolveSelectedSetId(lora, state);
    state.selected[lora.name] = setId;

    const sameSet = existingTags
      .filter((tag) => tag.lora === lora.name && tag.setId === setId)
      .map(cloneTag);
    const stashed = state.stash[lora.name]?.[setId] || [];
    const source = sameSet.length > 0 ? sameSet : stashed.length > 0 ? stashed.map(cloneTag) : legacyTags;

    const built = buildTagsFromGroups(
      getSetGroups(lora, setId),
      source,
      groupMode,
      defaultActive,
      allowStrengthAdjustment
    );
    built.forEach((tag) => {
      tag.lora = lora.name;
      tag.setId = setId;
      tags.push(tag);
    });
  }

  state.loras = loras;
  return tags;
}

// Remember the current tags of a lora's active set and select another set.
export function switchSet(state, tags, loraName, setId) {
  const currentSetId = state.selected[loraName];
  if (currentSetId === setId) {
    return false;
  }
  const currentTags = tags.filter((tag) => tag.lora === loraName && tag.setId === currentSetId);
  if (currentSetId && currentTags.length > 0) {
    state.stash[loraName] = {
      ...(state.stash[loraName] || {}),
      [currentSetId]: currentTags.map(cloneTag),
    };
  }
  state.selected[loraName] = setId;
  return true;
}

export function lorasWithSelectableSets(state) {
  return (state.loras || []).filter((lora) => (lora.trigger_sets || []).length > 1);
}

export function shortLoraName(name) {
  if (typeof name !== "string") {
    return "";
  }
  const base = name.split(/[\\/]/).pop();
  return base.replace(/\.(safetensors|ckpt|pt|bin)$/i, "");
}

// Responses for the same node can arrive out of order; only the newest
// request may update it. Updates without a sequence are always applied.
export function isStaleUpdate(node, seq) {
  return typeof seq === "number" && typeof node._lmTriggerSeq === "number" && seq < node._lmTriggerSeq;
}
