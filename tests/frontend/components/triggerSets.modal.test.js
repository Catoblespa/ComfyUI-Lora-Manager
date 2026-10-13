import { describe, it, expect, beforeEach, vi } from "vitest";

const { TRIGGER_SETS_MODULE, I18N_HELPERS_MODULE, UI_HELPERS_MODULE } = vi.hoisted(() => ({
    TRIGGER_SETS_MODULE: new URL('../../../static/js/components/shared/TriggerSets.js', import.meta.url).pathname,
    I18N_HELPERS_MODULE: new URL('../../../static/js/utils/i18nHelpers.js', import.meta.url).pathname,
    UI_HELPERS_MODULE: new URL('../../../static/js/utils/uiHelpers.js', import.meta.url).pathname,
}));

vi.mock(I18N_HELPERS_MODULE, () => ({
    translate: vi.fn((key, params, fallback) => fallback || key),
}));

const showToast = vi.fn();
vi.mock(UI_HELPERS_MODULE, () => ({ showToast }));

const FILE_PATH = "E:/loras/rin.safetensors";

function jsonResponse(data, ok = true) {
    return Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(data) });
}

async function flush() {
    for (let i = 0; i < 5; i += 1) {
        await Promise.resolve();
    }
}

describe("Trigger sets modal editor", () => {
    let stored;
    let module;

    beforeEach(async () => {
        vi.resetModules();
        showToast.mockClear();
        stored = [{ id: "set-a", name: "한복", groups: ["iomB", "white hanbok, korean clothes"] }];

        globalThis.fetch = vi.fn((url, options) => {
            if (options?.method === "POST") {
                const body = JSON.parse(options.body);
                stored = body.trigger_sets.map((set, i) => ({ id: set.id || `set-new-${i}`, ...set }));
                return jsonResponse({ success: true, trigger_sets: stored });
            }
            return jsonResponse({ success: true, trigger_sets: stored });
        });

        module = await import(TRIGGER_SETS_MODULE);
        document.body.innerHTML = `
            <div class="modal-content">
                <div class="trigger-words">
                    <div class="trigger-word-tag" data-word="iomC"></div>
                    <div class="trigger-word-tag" data-word="school uniform"></div>
                </div>
                ${module.renderTriggerSetsSection(FILE_PATH)}
            </div>`;
    });

    it("loads stored sets so they are visible when the modal is reopened", async () => {
        await module.setupTriggerSets(FILE_PATH);

        expect(fetch).toHaveBeenCalledWith(`/api/lm/loras/trigger-sets?file_path=${encodeURIComponent(FILE_PATH)}`);
        const names = [...document.querySelectorAll(".trigger-set-name")].map((i) => i.value);
        expect(names).toEqual(["한복"]);
        expect(document.querySelectorAll(".trigger-set-group").length).toBe(2);
    });

    it("adding a set keeps existing sets instead of overwriting them", async () => {
        await module.setupTriggerSets(FILE_PATH);

        document.querySelector(".trigger-sets-add-btn").click();
        const cards = document.querySelectorAll(".trigger-set-card");
        expect(cards.length).toBe(2);

        cards[1].querySelector(".trigger-set-copy-btn").click();
        const input = document.querySelectorAll(".trigger-set-group-input")[1];
        input.value = "maid, apron";
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

        document.querySelector(".trigger-sets-save-btn").click();
        await vi.waitFor(() =>
            expect(showToast).toHaveBeenCalledWith("toast.triggerSets.saved", {}, "success")
        );

        const post = fetch.mock.calls.find(([, options]) => options?.method === "POST");
        const sent = JSON.parse(post[1].body).trigger_sets;
        expect(sent.map((s) => s.name)).toEqual(["한복", "Trigger set 3"]);
        expect(sent[0].id).toBe("set-a");
        expect(sent[1].groups).toEqual(["iomC", "school uniform", "maid, apron"]);
        expect(showToast).toHaveBeenCalledWith("toast.triggerSets.saved", {}, "success");
        expect(document.querySelectorAll(".trigger-set-card").length).toBe(2);
    });

    it("refuses to save a set without a name", async () => {
        await module.setupTriggerSets(FILE_PATH);

        const nameInput = document.querySelector(".trigger-set-name");
        nameInput.value = "  ";
        nameInput.dispatchEvent(new Event("input"));
        document.querySelector(".trigger-sets-save-btn").click();
        await flush();

        expect(fetch.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
        expect(showToast).toHaveBeenCalledWith("toast.triggerSets.nameRequired", {}, "error");
    });
});
