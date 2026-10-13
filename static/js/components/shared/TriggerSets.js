/**
 * TriggerSets.js
 * Editor for named alternative trigger word sets of a LoRA (custom fork feature).
 * The default set is always the regular trigger words and is not edited here.
 */
import { showToast } from '../../utils/uiHelpers.js';
import { translate } from '../../utils/i18nHelpers.js';
import { escapeAttribute } from './utils.js';

const TRIGGER_SETS_ENDPOINT = '/api/lm/loras/trigger-sets';

/**
 * Render the trigger sets section placeholder
 * @param {string} filePath - Model file path
 * @returns {string} HTML content
 */
export function renderTriggerSetsSection(filePath) {
    return `
        <div class="info-item full-width trigger-sets" data-file-path="${escapeAttribute(filePath || '')}">
            <div class="trigger-sets-header">
                <label>${translate('modals.model.triggerSets.label', {}, 'Trigger Sets')}</label>
                <button type="button" class="trigger-sets-add-btn metadata-edit-btn" title="${translate('modals.model.triggerSets.add', {}, 'Add trigger set')}">
                    <i class="fas fa-plus"></i>
                </button>
            </div>
            <div class="trigger-sets-hint">${translate('modals.model.triggerSets.hint', {}, 'The default set is the trigger words above. Pick a set in the TriggerWord Toggle node.')}</div>
            <div class="trigger-sets-list"></div>
            <div class="trigger-sets-controls" style="display:none;">
                <button type="button" class="metadata-save-btn trigger-sets-save-btn">
                    <i class="fas fa-save"></i> ${translate('common.actions.save', {}, 'Save')}
                </button>
            </div>
        </div>
    `;
}

async function fetchTriggerSets(filePath) {
    const response = await fetch(`${TRIGGER_SETS_ENDPOINT}?file_path=${encodeURIComponent(filePath)}`);
    const data = await response.json();
    if (!response.ok || !data.success) {
        throw new Error(data.error || `HTTP ${response.status}`);
    }
    return data.trigger_sets || [];
}

async function postTriggerSets(filePath, triggerSets) {
    const response = await fetch(TRIGGER_SETS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_path: filePath, trigger_sets: triggerSets }),
    });
    const data = await response.json();
    if (!response.ok || !data.success) {
        throw new Error(data.error || `HTTP ${response.status}`);
    }
    return data.trigger_sets || [];
}

function getDefaultTriggerWords(section) {
    const modal = section.closest('.modal-content') || document;
    return Array.from(modal.querySelectorAll('.trigger-words .trigger-word-tag'))
        .map((tag) => tag.dataset.word)
        .filter(Boolean);
}

function createGroupChip(group, onDelete) {
    const chip = document.createElement('div');
    chip.className = 'trigger-word-tag trigger-set-group';
    chip.title = group;

    const text = document.createElement('span');
    text.className = 'trigger-word-content';
    text.textContent = group;
    chip.appendChild(text);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'trigger-set-group-delete';
    remove.title = translate('modals.model.triggerSets.deleteGroup', {}, 'Remove group');
    remove.innerHTML = '<i class="fas fa-times"></i>';
    remove.addEventListener('click', (event) => {
        event.stopPropagation();
        onDelete();
    });
    chip.appendChild(remove);
    return chip;
}

/**
 * Set up the trigger sets editor for the open modal
 * @param {string} filePath - Model file path
 */
export async function setupTriggerSets(filePath) {
    const section = document.querySelector('.trigger-sets');
    if (!section) return;

    const list = section.querySelector('.trigger-sets-list');
    const controls = section.querySelector('.trigger-sets-controls');
    const saveBtn = section.querySelector('.trigger-sets-save-btn');
    const addBtn = section.querySelector('.trigger-sets-add-btn');

    let sets = [];
    let dirty = false;

    const markDirty = () => {
        dirty = true;
        controls.style.display = '';
    };

    const render = () => {
        list.replaceChildren();

        if (sets.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'trigger-sets-empty';
            empty.textContent = translate('modals.model.triggerSets.empty', {}, 'No extra trigger sets');
            list.appendChild(empty);
            return;
        }

        sets.forEach((set, setIndex) => {
            const card = document.createElement('div');
            card.className = 'trigger-set-card';

            const header = document.createElement('div');
            header.className = 'trigger-set-card-header';

            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.className = 'trigger-set-name';
            nameInput.value = set.name;
            nameInput.placeholder = translate('modals.model.triggerSets.namePlaceholder', {}, 'Set name');
            nameInput.addEventListener('input', () => {
                set.name = nameInput.value;
                markDirty();
            });
            header.appendChild(nameInput);

            const copyBtn = document.createElement('button');
            copyBtn.type = 'button';
            copyBtn.className = 'trigger-set-copy-btn';
            copyBtn.title = translate('modals.model.triggerSets.copyDefault', {}, 'Add groups from the default trigger words');
            copyBtn.innerHTML = '<i class="fas fa-clone"></i>';
            copyBtn.addEventListener('click', () => {
                const existing = new Set(set.groups);
                getDefaultTriggerWords(section).forEach((group) => {
                    if (!existing.has(group)) set.groups.push(group);
                });
                markDirty();
                render();
            });
            header.appendChild(copyBtn);

            const deleteBtn = document.createElement('button');
            deleteBtn.type = 'button';
            deleteBtn.className = 'trigger-set-delete-btn';
            deleteBtn.title = translate('modals.model.triggerSets.delete', {}, 'Delete trigger set');
            deleteBtn.innerHTML = '<i class="fas fa-trash"></i>';
            deleteBtn.addEventListener('click', () => {
                sets.splice(setIndex, 1);
                markDirty();
                render();
            });
            header.appendChild(deleteBtn);
            card.appendChild(header);

            const groups = document.createElement('div');
            groups.className = 'trigger-words-tags trigger-set-groups';
            set.groups.forEach((group, groupIndex) => {
                groups.appendChild(createGroupChip(group, () => {
                    set.groups.splice(groupIndex, 1);
                    markDirty();
                    render();
                }));
            });
            card.appendChild(groups);

            const groupInput = document.createElement('input');
            groupInput.type = 'text';
            groupInput.className = 'metadata-input trigger-set-group-input';
            groupInput.placeholder = translate('modals.model.triggerSets.groupPlaceholder', {}, 'Add a group (comma separated words), press Enter');
            groupInput.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                const value = groupInput.value.trim();
                if (!value) return;
                set.groups.push(value);
                markDirty();
                render();
                list.querySelectorAll('.trigger-set-group-input')[setIndex]?.focus();
            });
            card.appendChild(groupInput);

            list.appendChild(card);
        });
    };

    const load = async () => {
        sets = (await fetchTriggerSets(filePath)).map((set) => ({ ...set, groups: [...set.groups] }));
        dirty = false;
        controls.style.display = 'none';
        render();
    };

    addBtn.addEventListener('click', () => {
        const name = translate('modals.model.triggerSets.newName', { index: sets.length + 2 }, `Trigger set ${sets.length + 2}`);
        sets.push({ name, groups: [] });
        markDirty();
        render();
        list.querySelectorAll('.trigger-set-name')[sets.length - 1]?.focus();
    });

    saveBtn.addEventListener('click', async () => {
        if (!dirty) return;
        // Commit text typed into a group input but not confirmed with Enter.
        list.querySelectorAll('.trigger-set-group-input').forEach((input, index) => {
            const value = input.value.trim();
            if (value && sets[index]) sets[index].groups.push(value);
        });
        if (sets.some((set) => !set.name.trim())) {
            showToast('toast.triggerSets.nameRequired', {}, 'error');
            return;
        }
        try {
            saveBtn.disabled = true;
            await postTriggerSets(filePath, sets);
            // Reload from disk so the editor always reflects what was persisted.
            await load();
            showToast('toast.triggerSets.saved', {}, 'success');
        } catch (error) {
            console.error('Error saving trigger sets:', error);
            showToast('toast.triggerSets.saveFailed', {}, 'error');
        } finally {
            saveBtn.disabled = false;
        }
    });

    try {
        await load();
    } catch (error) {
        console.error('Error loading trigger sets:', error);
        list.textContent = translate('modals.model.triggerSets.loadFailed', {}, 'Failed to load trigger sets');
    }
}
