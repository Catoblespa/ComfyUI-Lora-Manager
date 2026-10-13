# Trigger Sets (커스텀 기능) — 요구사항 명세

> 포크: https://github.com/Catoblespa/ComfyUI-Lora-Manager (브랜치 `feature/trigger-sets`)
> 원본: https://github.com/willmiao/ComfyUI-Lora-Manager (`upstream`)
> 기준 버전: v1.2.1
>
> 2026-05-27에 한 번 구현했으나 커밋/푸시 전에 2026-08-21 노드 업데이트로 덮어써져 소실됨.
> 이 문서는 당시 대화 기록(`~/.claude/history.jsonl`, session `8da5505d`)에서 복원한 요구사항이다.

## 1. 개요

LoRA 하나에 여러 벌의 트리거 단어 묶음("트리거셋")을 저장해두고,
`TriggerWord Toggle (LoraManager)` 노드에서 실행 전에 원하는 트리거셋을 골라
`filtered_trigger_words` 출력으로 받는다.

- 예: 캐릭터 LoRA의 "기본 의상" 트리거셋 / "신의상" 트리거셋.
- 트리거셋 = 이름 + 그 셋에 속한 트리거 단어 그룹 목록.

## 2. 데이터 모델

### 2.1 저장 형식 (LoRA `.metadata.json`)

```json
"trigger_sets": [
  { "id": "set-<random>", "name": "신의상", "groups": ["word a, word b", "word c"] }
]
```

- `groups` 원소 하나 = 기존 `trainedWords`의 원소 하나(그룹 모드에서 그룹 1개)와 같은 의미.
- **기본 트리거셋(Default)은 저장하지 않는다.** 기존 `civitai.trainedWords`가 곧 기본 트리거셋이다.
- 2번째 트리거셋부터만 `trigger_sets`에 저장한다.
- **안전성 최우선**: 기존 `trainedWords` 데이터는 절대 덮어쓰거나 변형하지 않는다.
- 저장 위치는 CivitAI 메타데이터 동기화(`MetadataSyncService`)가 덮어쓰지 않는 곳이어야 한다.
  - `civitai` 하위가 아니라 최상위 키를 쓴다.
  - 동기화/재스캔 후에도 보존되는지 테스트로 확인한다.
  - 구버전 구현은 `triggerSets`(camelCase) 키를 썼다. 읽을 때는 이것도 인식한다.

### 2.2 API

- 트리거 단어 조회 응답에 `trigger_sets`를 추가한다. 기본 셋은 `{id: "default", name: "Default", groups: trainedWords}`로 합성해 맨 앞에 둔다.
  - 이전 구현의 응답 예: `{"success": true, "trigger_words": [], "trigger_sets": [{"id":"default","name":"Default","groups":[...]}, ...]}`
- 트리거셋 저장/수정 엔드포인트 (모달에서 사용).

## 3. 모달 (LoRA 상세 → 트리거 단어 섹션)

- 기존 트리거 단어 편집 UI는 그대로 두고, 트리거셋 추가/편집/이름변경/삭제 UI를 추가한다.
- 트리거셋에는 별명(이름)을 붙여 수정할 수 있다. 기본 셋은 항상 "기본 트리거셋"으로 표시한다.
- 저장 후 모달을 다시 열어도 어떤 트리거셋이 있는지 보여야 한다.
  - 이전 구현 버그: 저장 후 재진입하면 목록이 안 보이고, 새로 추가하면 기존 것을 덮어썼다.
- 트리거 단어 영역과 트리거셋 영역은 화면 폭을 전부 써야 한다. 절반만 쓰면 안 된다.

## 4. TriggerWord Toggle 노드

### 4.1 동작 규칙 (확정된 결정)

1. **라디오 방식**: LoRA 하나당 동시에 하나의 트리거셋만 ON이다.
2. **Set 단위 게이팅**: 셋을 끄면 그 셋의 그룹들은 출력에서 빠진다. 각 그룹의 개별 on/off 상태는 보존된다(셋을 다시 켜면 원래대로 돌아온다).
3. `default_active`는 LoRA가 켜져서 그룹이 처음 표시될 때의 초기값으로만 쓴다.
4. `group_mode=false`일 때는 트리거셋 구조를 유지하고, 셋 안에서 그룹 내부만 단어 단위로 평탄화한다.
5. 노드에서 실행 전에(Queue Prompt 없이) 라디오로 활성 셋을 고를 수 있어야 한다. 실행하면 선택한 셋 기준으로 출력한다.

### 4.2 UI

- 트리거셋 라디오 영역은 그룹 토글 영역보다 **위**에 둔다.
- 각 트리거셋 라디오에 **어느 LoRA의 셋인지** 표시한다. 여러 LoRA가 켜져 있어도 구분할 수 있어야 한다.
- 트리거셋이 없는 LoRA는 기존과 똑같이 보인다.

### 4.3 반드시 막아야 할 버그 (이전 구현에서 발생)

- [ ] 셋 라디오를 바꿨는데 실제 `filtered_trigger_words` 출력이 바뀌지 않음.
- [ ] Loader에서 LoRA를 끄면 그 LoRA의 트리거/트리거셋이 Toggle에서 빠지지 않음. 특히 트리거셋이 있는 LoRA가 2개 이상이거나, 셋 있는 LoRA와 없는 LoRA를 섞어 쓸 때.
- [ ] LoRA 2개가 켜져 있으면 첫 LoRA 기준으로만 보임.
- [ ] **Loader↔Toggle 쌍 독립성**: `Lora Loader.trigger_words` → `TriggerWord Toggle.trigger_words`로 연결된 쌍이 여러 개 있을 때, 한 쌍의 Loader를 on/off하면 다른 쌍의 Toggle에 트리거/트리거셋이 나타나거나 반응함. 각 Toggle은 자기 `trigger_words` 입력에 연결된 Loader 체인의 데이터만 써야 한다.
  - 관련 코드: `web/comfyui/utils.js`의 `updateConnectedTriggerWords` / `getConnectedTriggerToggleNodes`, `py/routes/lora_routes.py`의 `get_trigger_words`. 하나의 `trigger_word_update` 메시지가 여러 노드로 전송되고, 응답에 트리거셋 정보가 섞이는 경로를 주의한다.

### 4.4 상태 저장/복원

- 워크플로를 저장하면 Toggle 노드의 그룹/단어 on/off 상태와 선택한 트리거셋이 모두 저장되고 복원돼야 한다.
- 생성된 이미지를 드래그앤드롭해서 워크플로를 불러올 때도 동일하게 복원돼야 한다.
  - 원본에도 있던 기능이다. 트리거셋 작업 중에 깨졌다가 다시 고쳤다. 회귀 테스트가 필요하다.
- **후방호환**: 트리거셋 기능 이전에 저장된 워크플로/이미지를 불러와도 on/off 상태가 정상 복원돼야 한다.
  - 이전 구현의 미해결 TODO였다.
  - 저장된 `widgets_values` 인덱스가 바뀌지 않게, 새 위젯은 기존 위젯 뒤에 추가하거나 기존 값 안에 넣는다.

## 5. 작업 규칙

- 원본 업데이트는 ComfyUI Manager가 아니라 git으로 받는다: `git fetch upstream --tags` → 새 릴리스 태그로 `git rebase`.
- 작은 단위로 커밋하고 `origin`에 자주 푸시한다.
- 백엔드는 `pytest`, 프론트는 `npm test`로 테스트를 추가한다.

## 6. 진행 상황

- [x] git 세팅 (origin=포크, upstream=원본, v1.2.1 기준 `feature/trigger-sets`)
- [x] 요구사항 명세 복원 (이 문서)
- [x] 데이터 모델 + API (`py/utils/trigger_sets.py`, `py/routes/lora_routes.py`)
- [x] 모달 UI (`static/js/components/shared/TriggerSets.js`)
- [x] Toggle 노드 (라디오, 게이팅, LoRA 표시) (`web/comfyui/trigger_sets_utils.js`, `trigger_word_toggle.js`)
- [x] 쌍 독립성 / LoRA off 시 제거 버그 방지 (노드별 seq, 전역 상태 없음)
- [x] 저장/복원 + 구버전 이미지 후방호환 (숨김 위젯 `trigger_set_state`는 맨 뒤, 구버전 tag는 text로 매칭)
- [ ] ComfyUI 실사용 E2E 확인 (모달 → 노드 3쌍 → 실행 출력 → 워크플로/이미지 복원)

## 7. 구현 메모

- 저장 위치: 최상위 `trigger_sets` + `active_trigger_set_id`.
  - 첫 구현이 쓰던 `civitai.triggerSets` / `civitai.activeTriggerSetId`도 읽는다.
  - 모달에서 한 번 저장하면 최상위 키로 옮겨진다.
- `active_trigger_set_id`: 노드에 LoRA가 처음 나타날 때 처음 선택될 셋이다. 그 뒤로는 노드별로 선택한 셋을 따른다.
- 노드 상태: `trigger_set_state` 숨김 위젯(JSON)에 `{loras, selected, stash}`를 저장한다.
  - `stash`에는 셋별 그룹 on/off 상태를 보관해서, 셋을 바꿨다가 돌아와도 상태가 복원된다.
- `trigger_word_update` 이벤트의 `message`는 원본과 똑같다. 셋 정보는 `loras` 필드로만 전달된다.
