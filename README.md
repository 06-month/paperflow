# PaperFlow
<p align="center">
  <strong>Zotero Reader 안에서 논문을 읽는 AI 보조 도구.</strong>
</p>
<p align="center">
  Zotero를 벗어나지 않고 요약, 번역, 메타데이터 확인, 논문 기반 질의응답을 처리합니다.
</p>
<p align="center">
  <img alt="Version" src="https://img.shields.io/badge/version-0.5.3-blue">
  <img alt="Status" src="https://img.shields.io/badge/status-experimental-orange">
  <img alt="Zotero" src="https://img.shields.io/badge/Zotero-7%2B-red">
  <img alt="AI" src="https://img.shields.io/badge/AI-Gemini-7c3aed">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-green">
</p>

---

<p align="center">
  <img src="assets/paperflow.png" alt="PaperFlow Zotero Reader Sidebar" width="960">
</p>

## 개요

**PaperFlow**는 논문 요약, 번역, 메타데이터 확인, 그리고 논문 맥락을 인식하는 대화를 제공하는 Zotero
Reader 사이드바입니다.
Zotero Reader 안에 AI 읽기 계층을 직접 넣어서, PDF 뷰어와 번역기, LLM 대화창, 노트 앱 사이를 오가지 않고도
생성된 요약을 검토하고 번역을 확인하며 처리 메타데이터를 보고 논문에 대해 질문할 수 있게 합니다.

PaperFlow는 범용 번역기가 아닙니다. 학술 논문 읽기 workflow를 위한 **Zotero 네이티브 연구 보조 도구**입니다.

```
읽기 → 요약 → 번역 → 확인 → 질문
```

---

## 현재 기능

| 기능 | 설명 | 상태 |
|---|---|---|
| Zotero Reader 사이드바 | Zotero Reader / item pane 내부 사이드바 통합 | 구현됨 |
| 요약 뷰 | 생성된 논문 요약을 절 단위로 표시 | 구현됨 |
| 번역 뷰 | 생성된 한국어 번역 산출물 표시 | 구현됨 |
| 메타 뷰 | chunk 진행률, artifact ID, 완료 상태 표시 | 구현됨 |
| Chunk 기반 처리 | 긴 논문을 작은 chunk로 나눠 처리 | 구현됨 |
| 부분 저장 및 이어하기 | 절 경계마다 진행 상황을 저장하고, 중단된 번역을 텍스트 해시로 이어서 진행 | 구현됨 |
| Artifact 재사용 | 기존 노트, 번역, 메타데이터를 다시 불러옴 | 구현됨 |
| 레이아웃 인식 번역 | 페이지 이미지와 PDF 원본 텍스트 좌표를 함께 사용해 단락 및 2단 구성의 읽기 순서를 보존 | 구현됨 (텍스트 fallback 포함) |
| 원본 시각 영역 | 렌더링된 원본 페이지에서 Figure/Table 영역을 온전히 재구성하고, 번역된 캡션을 그 바로 아래에 배치 | 구현됨 (Gemini 레이아웃 분석) |
| LaTeX 수식 | 인라인/디스플레이 수식을 LaTeX로 변환하고 네이티브 MathML로 렌더링하며, 번호가 붙은 수식은 `$$...$$` 원본으로 보존 | 구현됨 |
| 디스크 사용 없음 | 페이지 렌더와 Figure/Table crop은 메모리에만 두고, Zotero artifact만 기록 | 구현됨 |
| Gemini 병렬 처리 | 페이지 분석과 번역 chunk를 동시 실행하며, 동시 실행 수를 설정할 수 있고 RPM/RPD 제한을 race-safe하게 처리 | 구현됨 |
| 선택 영역 대화 첨부 | PDF, 요약, 번역 뷰에서 텍스트를 드래그하면 출처 라벨과 함께 대화에 자동 첨부 | 구현됨 |
| 파일 첨부 (Finder) | `+` 버튼으로 OS 파일 선택창을 열어 이미지, PDF, 텍스트 파일 첨부 | 구현됨 |
| 클립보드 이미지 붙여넣기 | ⌘V로 클립보드 이미지를 썸네일로 붙여넣고, 사용자 말풍선에 인라인으로 전송 | 구현됨 |
| Gemini 멀티모달 대화 | 이미지와 PDF를 `inline_data`로 Gemini에 전송 | 구현됨 |
| 다중 turn 대화 이력 | 이전 turn을 유지해 후속 질문 처리 | 구현됨 |
| AI 답변 렌더링 | Markdown 표/목록/코드와 인라인·디스플레이 LaTeX를 사이드바와 독립 패널 대화 양쪽에서 렌더링 | 구현됨 |
| Rate limiter (영속) | 재시작해도 일일 할당량을 추적하며, Google의 태평양 시간 자정 리셋에 맞춤 | 구현됨 |
| API key 보안 | key를 URL이 아니라 `x-goog-api-key` 헤더로 전송 | 구현됨 |
| 원문 정렬 번역 | 번역을 원본 PDF span으로 다시 매핑 | 계획 |
| Zotero 하이라이트 연동 | 번역된 구절에서 하이라이트 생성 | 계획 |

---

## 설치

GitHub Releases에서 최신 XPI를 내려받습니다.

```
https://github.com/06-month/paperflow/releases/tag/v0.5.3
```

**Zotero에 설치하기:**

1. Zotero를 엽니다.
2. **도구 → 플러그인**으로 이동합니다.
3. 톱니바퀴 아이콘 → **Install Plugin From File**을 클릭합니다.
4. 내려받은 `.xpi` 파일을 선택합니다.
5. Zotero를 재시작합니다.
6. **Zotero 환경설정** → **PaperFlow** 탭을 엽니다.
7. Gemini API key를 입력하고 연결 테스트를 실행합니다.

---

## 기본 사용법

### 논문 번역하기

1. PDF가 첨부된 Zotero 항목을 선택합니다(또는 PDF를 직접 선택합니다).
2. **도구 → Translate Paper**를 실행합니다.
3. 진행 창에 chunk별 상태가 표시됩니다. × 버튼은 작업을 취소하지 않고 창만 닫으며, 번역은 백그라운드에서
   계속됩니다.
4. 이전 번역이 있으면 **이어하기**(완료된 chunk 재사용) 또는 **다시 번역**을 선택할 수 있습니다.

### Reader 사이드바 사용하기

1. Zotero Reader에서 논문을 엽니다.
2. **PaperFlow** 사이드바 섹션을 엽니다.
3. **요약**, **번역**, **메타** 뷰를 전환합니다.
4. 하단 대화 패널에서 질문합니다.

**도구 → Open PaperFlow Panel**에서도 첨부, 선택 영역, 붙여넣기, 다중 turn, Markdown, LaTeX 등 동일한
대화 기능을 사용할 수 있습니다.

### 대화에 맥락 첨부하기

| 방법 | 동작 |
|---|---|
| PDF에서 텍스트 드래그 | 선택한 텍스트가 **PDF 원문** 카드로 자동 첨부 |
| 요약 뷰에서 텍스트 드래그 | **Summary** 카드로 자동 첨부 |
| 번역 뷰에서 텍스트 드래그 | **Translation** 카드로 자동 첨부 |
| `+` 버튼 | Finder를 열어 이미지, PDF, 텍스트 파일 선택 |
| 대화 입력창에서 ⌘V | 클립보드 이미지를 썸네일로 붙여넣기 |

선택 카드는 출처를 굵은 제목으로 표시하고 선택한 텍스트를 140자에서 자릅니다. 전송 전에 × 를 눌러 첨부를
제거할 수 있습니다. 대화 바깥의 다른 곳을 클릭하면 드래그 선택 칩이 자동으로 사라집니다.

---

## 동작 방식

```
Zotero 항목 / PDF
      ↓
PDF.js 페이지 렌더 + 원본 텍스트 좌표
      ↓
Gemini 페이지 레이아웃 JSON (heading / paragraph / figure / table / caption / LaTeX 수식)
      ↓
안정적인 block ID, 읽기 순서, 캡션 연결, 수식 토큰
      ↓
번역 대상 block → chunking (chunk당 ≤1500 토큰)
      ↓
Gemini block 병렬 번역 (gemini-3.1-flash-lite)
      ↓
번역 텍스트 + 원본 시각 요소/캡션 + 렌더링된 수식을 교차 배치
      ↓
pt-meta.json (기준 데이터)  →  translated.ko.html  →  Zotero 노트
      ↓
Reader 사이드바 (요약 / 번역 / 메타 / 대화)
      ↓
논문 맥락을 인식하는 대화, 첨부 지원
```

**Zotero 항목별 artifact 파일:**

| 파일 | 용도 |
|---|---|
| `pt-meta.json` | 구조화된 JSON. chunk 번역, 요약, 텍스트 해시, 완료 상태 |
| `translated.ko.html` | 메타 JSON에서 파생한 표시용 HTML |
| `[PaperFlow] note` | 서식이 적용된 요약이 담긴 Zotero 노트 |

이 세 artifact는 그 자체로 완결되어 있습니다. 페이지 렌더와 Figure/Table crop은 번역이 진행되는 동안에만
메모리에 존재합니다. 시각 요소는 base64 data URI로 `translated.ko.html`에 포함되므로, 완료된 번역을
표시하는 데 Zotero 외부의 디스크 파일이 전혀 필요하지 않습니다.

---

## 개발 빌드

```sh
# 문법 검사
find addon -name '*.js' -exec node --check {} \;

# XPI 빌드
bash scripts/build.sh
# → dist/paperflow.xpi
```

`dist/paperflow.xpi`를 Zotero에 설치하고 재시작한 뒤, 오류 콘솔에서 런타임 오류를 확인합니다.

---

## 프로젝트 구조

```
paperflow/
├─ addon/
│  ├─ manifest.json
│  ├─ bootstrap.js
│  ├─ prefs.js
│  ├─ content/
│  │  ├─ preferences.xhtml / preferences.js
│  │  ├─ panel.xhtml / panel.js / panel.css
│  │  ├─ readerSidebar.css
│  │  └─ icons/
│  ├─ locale/en-US/paperflow.ftl
│  └─ src/
│     ├─ addon.js
│     ├─ modules/
│     │  ├─ readerSidebar.js   ← 사이드바 UI, 대화, 첨부
│     │  ├─ translator.js      ← Gemini 번역 파이프라인
│     │  ├─ chat.js            ← 다중 turn 이력을 갖는 Gemini 대화
│     │  ├─ storage.js         ← artifact 읽기/쓰기 (pt-meta.json, HTML, 노트)
│     │  ├─ jobQueue.js        ← 부분 저장을 지원하는 chunk 작업 스케줄러
│     │  ├─ rateLimiter.js     ← 영속적인 일일 할당량 추적
│     │  ├─ chunker.js
│     │  ├─ cleaner.js
│     │  ├─ extractor.js
│     │  ├─ layoutAnalyzer.js  ← 페이지 렌더, 텍스트 좌표, Gemini 레이아웃 JSON, 원본 crop
│     │  └─ itemResolver.js
│     └─ utils/
│        ├─ constants.js       ← VERSION, MODEL_NAME, geminiEndpoint()
│        ├─ prefs.js
│        ├─ errors.js
│        ├─ logger.js
│        └─ tokenEstimate.js
├─ scripts/build.sh
├─ dist/paperflow.xpi
├─ updates.json
├─ CHANGELOG.md
└─ README.md
```

---

## 로드맵

### 원문 정렬 번역

번역된 구절을 원본 PDF의 해당 span과 정렬합니다. 번역된 문장에서 PDF 원문 위치로 이동할 수 있게 합니다.

### Zotero 주석 연동

번역되거나 선택된 구절로부터 원본 PDF에 Zotero 하이라이트를 생성합니다. 요약과 설명을 Zotero 주석에
연결합니다.

### 멀티모달 논문 이해

그림, 표, 수식, 캡션을 설명합니다. 시각 요소를 주변 텍스트 및 실험 주장과 연결합니다.

### 문헌 조사 workflow

여러 논문을 기여, 방법, 데이터셋, 한계 기준으로 비교합니다. 구조화된 읽기 노트를 Markdown, Obsidian,
Notion으로 내보냅니다.

---

## 참고 사항과 한계

- PaperFlow는 실험적인 도구입니다. Zotero 내부 API는 변경될 수 있습니다.
- 번역과 대화에는 Gemini API 접근 권한이 필요합니다.
- AI 출력은 비판적으로 검토해야 합니다. 번역과 요약에 오류가 있을 수 있습니다.
- 아주 긴 논문은 모델의 토큰 한계, rate limit, API 오류에 걸릴 수 있습니다.
- 레이아웃 인식 번역은 렌더링된 PDF 페이지와 포함된 텍스트를 Gemini로 전송합니다. PaperFlow 환경설정에서
  끌 수 있으며, 실패 시 기존 텍스트 전용 파이프라인으로 자동 전환됩니다.
- Figure/Table 경계는 모델이 판단한 결과이며, 연결된 캡션은 제외하되 탐지된 객체 주위를 보수적으로
  확장합니다. 원본 PDF는 변경되지 않습니다.
- 로컬 분할 산출물은 Zotero 데이터 디렉터리 아래에 다시 생성되며, 기존 `document.md` 파일은 논문별
  `.backup` 디렉터리에 백업됩니다.
- 원문 정렬 번역, Zotero 주석 매핑, 멀티모달 이해는 로드맵 항목이며 아직 완전히 구현되지 않았습니다.

---

## 기여

PaperFlow는 개인 연구 생산성 프로젝트로 시작했지만, 협업은 환영합니다.

관심 분야: Zotero 네이티브 연구 workflow, AI 보조 논문 읽기, 원문 정렬 번역, 주석 인식 시스템,
학술 지식 도구.

연락처: junjeon@edu.hanbat.ac.kr

---

## 라이선스

MIT License. 자세한 내용은 `LICENSE`를 참고하세요.
