/**
 * ============================================================================
 * 지속가능한 미래를 위한 2050 로봇 박람회 (app.js)
 * ============================================================================
 * - [탭 1] 🛠️ 로봇 설계실 (이름 로그인 비공개 개별 공간, 7단계 입력, 예시 태그, 실시간 코칭, 2종 자동 변환, 자동 이어쓰기)
 * - [탭 2] 🏛️ 미래 로봇 박람회 전시관 (부스 카드 갤러리, MP4/영상 링크 첨부, 좌우 분할 상세 모달)
 * - [탭 3] 🔒 교사 관리자 화면 (비밀번호 인증, 실시간 현황/필터, 상세 확인 및 수정, 피드백 수정 요청/전시 승인, 버전 이력 비교)
 * - 실시간 동기화: LocalStorage(0.1초 즉시 저장) + Supabase Realtime/DB & Storage(4초 자동 전송 + 단계 이동 시 즉시 전송)
 */

// ============================================================================
// 1. 상수 및 스토리지 키 설정
// ============================================================================
const STORAGE_KEYS = {
  STUDENTS_DB: 'robot_expo_2050_students_v5',
  INITIALIZED: 'robot_expo_2050_initialized_v5',
  CURRENT_STUDENT: 'robot_expo_2050_current_student_v5',
  LAST_TYPED_NAME: 'robot_expo_2050_last_name_v5',
  TEACHER_UNLOCKED: 'robot_expo_2050_teacher_unlocked_v2',
  TEACHER_PIN_HASH: 'robot_expo_2050_teacher_pin_hash_v2',
  SUPABASE_URL: 'robot_expo_2050_supabase_url_v2',
  SUPABASE_ANON_KEY: 'robot_expo_2050_supabase_key_v2',
  DELETED_MAP: 'robot_expo_2050_deleted_map_v5',
  AI_QUOTA_EXHAUSTED: 'robot_expo_2050_ai_quota_exhausted_v1',
  STUDENT_AI_DAILY: 'robot_expo_2050_student_ai_daily_v1',
  LIKED_BOOTHS: 'robot_expo_2050_liked_booths_v5',
  VIEWER_TOKEN: 'robot_expo_2050_viewer_token_v1',
};

const QUOTA_GUARD_ID = '__AI_QUOTA_GUARD__';
const MAX_STUDENT_DAILY_AI_FEEDBACK = 3;
const MAX_DAILY_FREE_AI_CALLS = 200;
const MIN_BOOTH_COMMENT_LENGTH = 20;
const MASKED_SECRET_PLACEHOLDER = '••••••••••••••••••••••••••••••••';

// Supabase 영구 기본 연결 설정 (어떤 기기에서도 추가 입력 없이 즉시 실시간 동기화)
const DEFAULT_SUPABASE_URL = 'https://cyjnrwtnbcxcobfzuhwc.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN5am5yd3RuYmN4Y29iZnp1aHdjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ5NDQwMDcsImV4cCI6MjExMDUyMDAwN30._CZ5ID1XvcUnHECs7YGkYkLSLTeBAOMrrXptkKQnxAA';
const SUPABASE_TABLE = 'robot_expo_students';
const SUPABASE_VIDEO_BUCKET = 'robot-videos';
// 관리자 비밀번호 SHA-256 해시값 (평문 노출 방지)
const DEFAULT_TEACHER_PIN_HASH = '3b4bee7de5f1464e59301f5cab582e9ada969bb1964a64a8dfa392c071480337';

// 타이핑 중 클라우드 자동 전송 간격: 4초 (로컬 스토리지는 0.1초 이내 즉시 저장, 단계 이동 시 즉시 전송)
const AUTO_SYNC_DEBOUNCE_MS = 4000;
// Supabase Realtime 웹소켓이 기본 동작하므로 보조 폴링 간격은 30초로 완화하여 Egress 트래픽 절감
const CLOUD_POLL_INTERVAL_MS = 30000;

// 상태 정의
const STATUS_META = {
  drafting: {
    key: 'drafting',
    label: '작성중',
    studentBadge: '✍️ 작성중',
    badgeClass: 'bg-slate-100 text-slate-700 border border-slate-300',
  },
  submitted: {
    key: 'submitted',
    label: '제출완료',
    studentBadge: '📩 제출완료 (교사 확인 대기)',
    badgeClass: 'bg-blue-100 text-blue-700 border border-blue-200',
  },
  revision: {
    key: 'revision',
    label: '수정요청',
    studentBadge: '🚨 수정요청 도착!',
    badgeClass: 'bg-orange-100 text-orange-800 border border-orange-300',
  },
  approved: {
    key: 'approved',
    label: '전시승인',
    studentBadge: '✅ 전시승인 완료!',
    badgeClass: 'bg-emerald-100 text-emerald-800 border border-emerald-300',
  },
};

// ============================================================================
// 2. 프롬프트 & 개조식 기획서 조합 함수 및 초기 더미 데이터
// ============================================================================
function parseCoreValuesHashtags(rawStr) {
  if (!rawStr) return [];
  const tokens = String(rawStr)
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const formatted = tokens.map((t) => (t.startsWith('#') ? t : `#${t}`));
  return Array.from(new Set(formatted));
}

function formatCoreValuesString(rawStr) {
  const tags = parseCoreValuesHashtags(rawStr);
  return tags.join(' ');
}

function cleanForVisualPrompt(str) {
  if (!str) return '';
  return String(str)
    .replace(/#/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.。]+$/, '');
}

// 학생 입력에서 비시각적 설명·배경·서술형 어미를 제거하고 영상 촬영 배경(Scene)을 도출
function extractVisualSceneSetting(inputs = {}) {
  const combined = `${inputs.purpose || ''} ${inputs.mainFunction || ''} ${inputs.appearance || ''} ${inputs.sensorTarget || ''}`;

  if (/화성|붉은\s*행성/.test(combined)) {
    return '붉은 모래 사막과 첨단 돔 기지가 펼쳐진 2050년 화성 탐사 현장';
  }
  if (/우주|궤도|위성|소행성|정거장|은하/.test(combined)) {
    return '푸른 지구와 별빛이 빛나는 2050년 우주 정거장 궤도 공간';
  }
  if (/바다|해양|수중|해안|산호|물고기|심해|잠수/.test(combined)) {
    return '햇빛이 투명하게 투과되는 2050년 푸른 바닷속 수중 생태계와 해안가';
  }
  if (/산불|화재|소방|불길|화염|재난/.test(combined)) {
    return '연기와 불길이 피어오르는 긴박한 미래 산림·도심 재난 구조 현장';
  }
  if (/숲|산림|나무|씨앗|식물|토양|생태/.test(combined)) {
    return '푸른 나무와 빛나는 자연이 어우러진 2050년 미래 생태 숲 현장';
  }
  if (/딥페이크|가짜\s*뉴스|사이버|해킹|디지털|크래커|온라인|거짓\s*정보/.test(combined)) {
    return '입체 홀로그램 스크린이 공중에 떠 있는 2050년 미래형 스마트 미디어 공간';
  }
  if (/병원|의료|수술|응급|환자|치료|약/.test(combined)) {
    return '투명 홀로그램 의료 모니터가 빛나는 2050년 미래형 스마트 메디컬 센터';
  }
  if (/노인|아이|돌봄|가정|거실|집|반려|감정|우울|위로|말동무/.test(combined)) {
    return '따뜻한 햇살과 미래형 스마트 가전이 어우러진 2050년 미래 가정 실내 공간';
  }
  if (/학교|교실|학생|공부|교육/.test(combined)) {
    return '투명 홀로그램 칠판과 첨단 교구가 갖춰진 2050년 미래형 스마트 교실';
  }
  if (/미세먼지|대기|공기|하늘|드론|비행/.test(combined)) {
    return '친환경 고층 빌딩과 맑은 하늘길이 펼쳐진 2050년 미래 스마트 시티 상공';
  }
  if (/쓰레기|분리배출|청소|재활용|환경\s*오염/.test(combined)) {
    return '깨끗한 녹지 공원과 친환경 거리가 어우러진 2050년 미래 에코 스마트 시티';
  }
  return '첨단 미래 건축물과 자연이 조화를 이루는 2050년 스마트 시티 현장';
}

// 로봇 외형 설명에서 불필요한 이유/서술어를 제거하고 시각적 형태·구조·재질 묘사로 변환
function extractVisualAppearancePhrase(rawAppearance) {
  const cleaned = cleanForVisualPrompt(rawAppearance);
  if (!cleaned) return '유선형 메카닉 바디와 정교한 다관절 구조';

  // 비시각적 이유절 및 서술형 어미 정리
  let visual = cleaned
    .replace(/[가-힣a-zA-Z0-9\s]+(가야\s*되니까|위해서|위해|보이라고|주면)\s*/g, '')
    .replace(/사람들에게\s*친근한/g, '친근한')
    .replace(/모양이다|형태이다|구조이다/g, '형태')
    .replace(/달려\s*있다|장착되어\s*있다|설치되어\s*있다/g, '장착된')
    .replace(/되어\s*있다|이루어져\s*있다/g, '이루어진')
    .replace(/생겼다|보인다|만든다|이동하게\s*한다/g, '')
    .replace(/이다(?=[.,\s]|$)/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // 문장이 너무 길면 핵심 외형 요소(앞부분 2개 문장/절)만 깔끔하게 추출
  const parts = visual
    .split(/[.。]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const concise = parts.slice(0, 3).join(', ').replace(/\s*외형\s*$/, '').trim();
  return concise || '미래지향적인 다관절 메카닉 구조';
}

// 센서 및 감지 대상에서 추상적 판단 서술어를 빼고 화면에 보이는 '센서 빛 + 스캔 대상'으로 변환
function extractVisualSensorScene(inputs = {}) {
  let sensor = cleanForVisualPrompt(inputs.sensorName) || '첨단 광학·초음파 센서';
  sensor = sensor
    .replace(/->|➔|→/g, '·')
    .replace(/(돌봄\s*시스템|가사\s*자동화\s*기술|통신용\s*센서)/g, '스마트 감지 센서')
    .trim();

  let target = cleanForVisualPrompt(inputs.sensorTarget) || '주변 환경과 목표물';
  target = target
    .replace(/(감지해|감지하여|측정해|측정하여|스캔해).*$/g, '')
    .replace(/(우울한지|아닌지|가짜인지|진위\s*여부를|거리를).*$/g, '')
    .replace(/(판별한다|감지한다|측정한다|인식한다|구별한다|찾아낸다|활동한다|간다).*$/g, '')
    .replace(/(를|을|이|가)\s*$/, '')
    .trim();

  if (!target || target.length < 2) {
    if (/체온|열|심박|감정/.test(inputs.sensorTarget || '')) {
      target = '앞사람의 표정과 생체 열 신호';
    } else if (/쓰레기|플라스틱|바다/.test(inputs.sensorTarget || '')) {
      target = '수중의 해양 쓰레기와 주변 생물';
    } else {
      target = '주변 지형과 목표 대상';
    }
  }

  return `장착된 ${sensor}에 푸른 스캔 라이트가 켜지며(${target}) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면`;
}

// 주요 기능 및 센서 반응에서 비시각적 설명(피해 예방, 부담 감소 등)을 제거하고 눈에 보이는 물리적 동작으로 변환
function extractVisualActionPhrase(inputs = {}) {
  const combined = `${inputs.sensorAction || ''} ${inputs.mainFunction || ''} ${inputs.purpose || ''}`;
  const visualActions = [];

  if (/딥페이크|가짜\s*뉴스|가짜\s*영상|거짓\s*정보/.test(combined)) {
    visualActions.push('공중의 홀로그램 화면에 디지털 영상 분석 그래픽과 판별 마크를 선명하게 띄우고');
  }
  if (/위로|감정|우울|말동무|돌봄|교감|노인|아이/.test(combined)) {
    visualActions.push('사람 곁으로 부드럽게 다가가 친근한 제스처와 따뜻한 라이트로 다정하게 교감하며');
  }
  if (/집게|수거|쓰레기|줍|청소|분리배출/.test(combined)) {
    visualActions.push('다관절 집게팔을 정교하게 뻗어 목표물을 집어 올리고 수거 장치를 작동시키며');
  }
  if (/정화|필터|미세\s*플라스틱|바닷물|공기\s*정화/.test(combined)) {
    visualActions.push('몸체의 정화 필터로 오염 물질을 흡입해 걸러낸 뒤 맑고 깨끗한 흐름을 내보내며');
  }
  if (/3[dD]\s*프린|출력|기지|건설|조립/.test(combined)) {
    visualActions.push('양옆의 기계팔과 노즐을 움직여 구조물을 층층이 3D 프린팅하고 지정된 위치에 정밀 배치하며');
  }
  if (/피하|피해|회피|장애물|물고기|소행성/.test(combined)) {
    visualActions.push('주변 생물과 장애물을 민첩하게 방향을 틀어 안전하게 회피 이동하며');
  }
  if (/태양광|충전|배터리/.test(combined)) {
    visualActions.push('외장 태양광 패널을 매끄럽게 펼쳐 에너지를 충전하며');
  }
  if (/화재|산불|진화|물대포|구조/.test(combined)) {
    visualActions.push('강력한 소화 분사 장치를 가동해 불길을 진압하고 안전 통로를 확보하며');
  }

  if (visualActions.length > 0) {
    return visualActions.slice(0, 2).join(', ');
  }

  // 기본 정제: 추상적 목적/효과 문구를 제거하고 동작 표현으로 변환
  let fallback = cleanForVisualPrompt(`${inputs.sensorAction || ''}, ${inputs.mainFunction || ''}`)
    .replace(/[^,.]*(피해가\s*없도록|피해받는\s*일이\s*없도록|부담을\s*줄일|도움이?\s*될|필요가\s*없다)[^,.]*/g, '')
    .replace(/판별하는\s*시스템/g, '홀로그램 분석 화면을 표시')
    .replace(/(판별한다|한다|된다|이다|모습이다|사용한다|보낸다)(?=[.,\s]|$)/g, '작동')
    .replace(/\s+/g, ' ')
    .trim();

  if (!fallback || fallback.length < 5) {
    return '정교한 기계 관절과 구동 장치를 움직여 임무를 수행하며';
  }
  return `${fallback.slice(0, 65)}하며`;
}

// 학생 작성 내용을 그대로 이어붙이지 않고 AI 영상 생성기에 최적화된 시각적 장면 묘사 프롬프트로 변환
function buildPromptFromInputs(inputs = {}) {
  const robotName = cleanForVisualPrompt(inputs.robotName) || '미래형 로봇';
  const sceneSetting = extractVisualSceneSetting(inputs);
  const visualAppearance = extractVisualAppearancePhrase(inputs.appearance);
  const sensorScene = extractVisualSensorScene(inputs);
  const actionPhrase = extractVisualActionPhrase(inputs);
  const videoStyle = cleanForVisualPrompt(inputs.videoStyle) || '고화질 3D 애니메이션 스타일';

  return `[AI 영상 제작] ${sceneSetting}에서, ${visualAppearance} 외형을 갖춘 로봇 '${robotName}'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. ${sensorScene}에 이어, 로봇이 ${actionPhrase} 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 ${videoStyle} 동영상.`;
}

function buildSpecSheetFromInputs(inputs = {}) {
  return {
    robotAndAppearance: {
      title: '🤖 출품 로봇명 & 외형',
      robotName: (inputs.robotName || '미정').trim(),
      appearance: (inputs.appearance || '-').trim(),
    },
    purpose: {
      title: '🎯 개발 배경 및 목적',
      content: (inputs.purpose || '-').trim(),
    },
    mainFunction: {
      title: '⚙️ 핵심 작동 기능 및 구조',
      content: (inputs.mainFunction || '-').trim(),
    },
    sensorMechanism: {
      title: '📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)',
      sensorName: (inputs.sensorName || '-').trim(),
      sensorTarget: (inputs.sensorTarget || '-').trim(),
      sensorAction: (inputs.sensorAction || '-').trim(),
    },
    scienceTech: {
      title: '🔬 적용 융합 과학기술',
      content: (inputs.scienceTech || '-').trim(),
    },
    coreValues: {
      title: '💎 추구하는 핵심 가치',
      content: formatCoreValuesString(inputs.coreValues) || '-',
    },
    videoStyle: {
      title: '🎨 영상 연출 스타일',
      content: (inputs.videoStyle || '고화질 3D 애니메이션 스타일').trim(),
    },
  };
}

function getInitialDummyStudents() {
  // 초기 더미 학생 데이터 없음 (모든 이전 데이터 삭제 완료, 새로운 학생 기록만 저장)
  return [];
}

const LEGACY_DUMMY_ROBOT_NAMES = new Set([
  '아쿠아 가디언 X-50',
  '바다 청소 로봇',
  '파이어 스파이더',
  '실버케어 버디 S2',
  '실버케어 버디',
  '에어퓨어 드론봇',
  '사이버 수호 애니멀 An-angel1',
  '아쿠아 클린봇 T-2050',
]);

function isLegacyDummyStudent(student) {
  if (!student) return false;
  const robotName = String(student.inputs?.robotName || '').trim();
  if (LEGACY_DUMMY_ROBOT_NAMES.has(robotName)) return true;
  return false;
}

// ============================================================================
// 3. 전역 애플리케이션 상태
// ============================================================================
let state = {
  activeTab: 'studio',                // 'studio' | 'expo' | 'teacher'
  students: [],                       // 전체 학생 배열
  deletedMap: {},                     // 삭제된 학생 식별자/이름 -> 삭제 시각(ms)
  currentStudentId: null,             // [탭 1] 현재 로그인한 학생 식별자(이름)
  lastLocalStudentTypingAt: 0,        // 학생이 마지막으로 타이핑한 시각(ms) - 작성 중 덮어쓰기 방지
  expoFilter: 'all',                  // 'all' | 'approved' | 'video'
  teacherUnlocked: false,             // [탭 3] 교사 인증 여부
  teacherFilter: 'all',               // 'all' | 'drafting' | 'submitted' | 'revision' | 'approved'
  selectedTeacherStudentId: null,     // [탭 3] 우측 패널에 선택된 학생
  teacherRenderedStudentId: null,     // [탭 3] 우측 패널에 현재 렌더링된 학생 식별자
  teacherDetailDirty: false,          // [탭 3] 교사가 우측 상세 패널에서 수정 중인지 여부 (초기화 방지)
  activeBoothStudentId: null,         // [탭 2] 부스 상세 모달 학생
  editingBoothCommentId: null,        // [탭 2] 현재 수정 중인 응원 댓글 ID
  videoAttachTargetId: null,          // 영상 첨부 모달 대상 학생
  videoModalTab: 'file',              // 'file' | 'url'
  pendingVideoFileData: null,         // 업로드 대기 중인 로컬 비디오 파일 객체
  supabaseUrl: DEFAULT_SUPABASE_URL,         // Supabase Project URL
  supabaseAnonKey: DEFAULT_SUPABASE_ANON_KEY, // Supabase anon public key
  isSyncing: false,
  lastSyncedAt: null,
  aiQuotaExhausted: false,                   // 무료 한도 도달 시 전체 AI 피드백 기능 영구 차단 플래그
  isRequestingAiFeedback: false,             // AI 피드백 요청 진행 중 여부
};

let supabaseClient = null;
let supabaseRealtimeChannel = null;

// 탭 간 실시간 통신 채널
const broadcastChannel = typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel('robot_expo_2050_realtime_channel')
  : null;

if (broadcastChannel) {
  broadcastChannel.onmessage = (event) => {
    if (event.data && event.data.type === 'DB_UPDATED') {
      loadStudentsFromLocalStorage();
      refreshAllViews(false);
    }
  };
}

window.addEventListener('storage', (e) => {
  if (e.key === STORAGE_KEYS.STUDENTS_DB) {
    loadStudentsFromLocalStorage();
    refreshAllViews(false);
  }
});

// ============================================================================
// 4. IndexedDB (로컬 MP4 영상 파일 캐시 및 오프라인 백업 저장소)
// ============================================================================
const VIDEO_DB_NAME = 'RobotExpo2050VideoDB';
const VIDEO_STORE_NAME = 'videos';
const localVideoObjectUrls = {};

function openVideoIndexedDB() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error('IndexedDB not supported'));
      return;
    }
    const req = indexedDB.open(VIDEO_DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(VIDEO_STORE_NAME)) {
        db.createObjectStore(VIDEO_STORE_NAME, { keyPath: 'studentId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveVideoBlobToIndexedDB(studentId, fileBlob, fileName) {
  try {
    const db = await openVideoIndexedDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(VIDEO_STORE_NAME, 'readwrite');
      const store = tx.objectStore(VIDEO_STORE_NAME);
      store.put({
        studentId: String(studentId),
        blob: fileBlob,
        fileName: fileName || 'robot_video.mp4',
        savedAt: new Date().toISOString(),
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    if (localVideoObjectUrls[studentId]) {
      URL.revokeObjectURL(localVideoObjectUrls[studentId]);
    }
    localVideoObjectUrls[studentId] = URL.createObjectURL(fileBlob);
    return localVideoObjectUrls[studentId];
  } catch (err) {
    console.warn('IndexedDB 영상 저장 실패, ObjectURL 폴백 사용:', err);
    localVideoObjectUrls[studentId] = URL.createObjectURL(fileBlob);
    return localVideoObjectUrls[studentId];
  }
}

async function loadAllVideoBlobsFromIndexedDB() {
  try {
    const db = await openVideoIndexedDB();
    const records = await new Promise((resolve, reject) => {
      const tx = db.transaction(VIDEO_STORE_NAME, 'readonly');
      const store = tx.objectStore(VIDEO_STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    records.forEach((rec) => {
      if (rec && rec.studentId && rec.blob) {
        if (localVideoObjectUrls[rec.studentId]) {
          URL.revokeObjectURL(localVideoObjectUrls[rec.studentId]);
        }
        localVideoObjectUrls[rec.studentId] = URL.createObjectURL(rec.blob);
      }
    });
  } catch (err) {
    console.warn('IndexedDB 로드 생략:', err);
  }
}

// ============================================================================
// 5. 초기화 및 데이터 로드 / Supabase 실시간 DB & Storage 연동
// ============================================================================
document.addEventListener('DOMContentLoaded', async () => {
  initStorageAndState();
  await loadAllVideoBlobsFromIndexedDB();
  bindFormEvents();
  refreshAllViews(true);

  initSupabaseClient();
  if (isCloudConfigured()) {
    pullFromCloudNow(true);
  }
  startRealtimeSyncLoop();
});

function loadDeletedMapFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.DELETED_MAP);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        state.deletedMap = parsed;
        return;
      }
    }
  } catch (err) {
    console.warn('삭제 목록 로드 생략:', err);
  }
  state.deletedMap = {};
}

function saveDeletedMapToStorage() {
  try {
    localStorage.setItem(STORAGE_KEYS.DELETED_MAP, JSON.stringify(state.deletedMap || {}));
  } catch (err) {
    console.warn('삭제 목록 저장 생략:', err);
  }
}

function isStudentMarkedDeleted(student) {
  if (!student) return false;
  if (isLegacyDummyStudent(student)) return true;
  if (!state.deletedMap) return false;
  const idKey = String(student.studentId || '').trim();
  const nameKey = String(student.studentName || '').trim();
  const deletedAt = Math.max(Number(state.deletedMap[idKey] || 0), Number(state.deletedMap[nameKey] || 0));
  if (!deletedAt) return false;
  const studentTime = new Date(student.updatedAt || 0).getTime() || 0;
  return studentTime <= deletedAt;
}

function clearDeletedMark(idOrName) {
  const key = String(idOrName || '').trim();
  if (!key || !state.deletedMap) return;
  if (state.deletedMap[key]) {
    delete state.deletedMap[key];
    saveDeletedMapToStorage();
    syncDeletedMapToCloudGuard(null, key);
  }
}

function purgeDeletedStudentsFromState() {
  const beforeLen = state.students.length;
  state.students = state.students.filter((s) => !isStudentMarkedDeleted(s));
  if (state.currentStudentId && !findStudentById(state.currentStudentId)) {
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = null;
    }
    state.currentStudentId = null;
    localStorage.removeItem(STORAGE_KEYS.CURRENT_STUDENT);
  }
  if (state.students.length !== beforeLen) {
    saveStudentsToLocalStorage(false);
  }
}

async function syncDeletedMapToCloudGuard(addedKey = null, removedKey = null) {
  if (!isSupabaseConfigured()) return;
  if (!supabaseClient) initSupabaseClient();
  if (!supabaseClient) return;

  try {
    const { data } = await supabaseClient
      .from(SUPABASE_TABLE)
      .select('inputs')
      .eq('student_id', QUOTA_GUARD_ID)
      .maybeSingle();

    const existingInputs = data && data.inputs && typeof data.inputs === 'object' ? data.inputs : {};
    const remoteDeletedMap =
      existingInputs.deletedMap && typeof existingInputs.deletedMap === 'object'
        ? { ...existingInputs.deletedMap }
        : {};

    Object.entries(state.deletedMap || {}).forEach(([k, v]) => {
      const t = Number(v) || 0;
      if (t > 0 && (!remoteDeletedMap[k] || t > Number(remoteDeletedMap[k]))) {
        remoteDeletedMap[k] = t;
      }
    });

    if (addedKey && state.deletedMap[addedKey]) {
      remoteDeletedMap[addedKey] = state.deletedMap[addedKey];
    }
    if (removedKey) {
      delete remoteDeletedMap[removedKey];
    }

    const updatedInputs = {
      ...existingInputs,
      deletedMap: remoteDeletedMap,
    };

    const row = {
      student_id: QUOTA_GUARD_ID,
      student_name: QUOTA_GUARD_ID,
      status: 'system_guard',
      inputs: updatedInputs,
      video_prompt: '',
      spec_sheet: {},
      teacher_feedback: '',
      feedback_at: '',
      video: { type: 'none', url: '', title: '' },
      likes: 0,
      current_version: 0,
      history: [],
      updated_at: new Date().toISOString(),
    };

    await supabaseClient.from(SUPABASE_TABLE).upsert(row, { onConflict: 'student_id' });
  } catch (err) {
    console.warn('클라우드 삭제 가드 동기화 생략:', err);
  }
}

function normalizeValidBoothComments(rawList, deletedCommentIds = []) {
  if (!Array.isArray(rawList)) return [];
  const deletedSet = new Set(Array.isArray(deletedCommentIds) ? deletedCommentIds : []);
  return rawList.filter(
    (c) =>
      c &&
      typeof c === 'object' &&
      c.v === 2 &&
      !deletedSet.has(c.id) &&
      String(c.text || '').trim().length >= MIN_BOOTH_COMMENT_LENGTH
  );
}

function getBoothComments(student) {
  if (!student || !student.inputs) return [];
  return normalizeValidBoothComments(student.inputs.boothComments, student.inputs.deletedCommentIds);
}

function getBoothLikesCount(student) {
  return getBoothComments(student).length;
}

function initStorageAndState() {
  // 이전 버전(v1~v4) 및 이전 Supabase 프로젝트 캐시 일괄 정리
  try {
    [
      'robot_expo_2050_students_v2',
      'robot_expo_2050_initialized_v2',
      'robot_expo_2050_current_student_v2',
      'robot_expo_2050_last_name_v2',
      'robot_expo_2050_deleted_map_v1',
      'robot_expo_2050_liked_booths_v1',
      'robot_expo_2050_students_v3',
      'robot_expo_2050_initialized_v3',
      'robot_expo_2050_current_student_v3',
      'robot_expo_2050_last_name_v3',
      'robot_expo_2050_deleted_map_v3',
      'robot_expo_2050_liked_booths_v3',
      'robot_expo_2050_students_v4',
      'robot_expo_2050_initialized_v4',
      'robot_expo_2050_deleted_map_v4',
      'robot_expo_2050_supabase_url_v1',
      'robot_expo_2050_supabase_key_v1',
    ].forEach((k) => localStorage.removeItem(k));
  } catch {
    // ignore
  }

  loadDeletedMapFromStorage();
  const isInit = localStorage.getItem(STORAGE_KEYS.INITIALIZED);
  const rawDb = localStorage.getItem(STORAGE_KEYS.STUDENTS_DB);

  if (!isInit || rawDb === null) {
    const dummy = getInitialDummyStudents();
    localStorage.setItem(STORAGE_KEYS.INITIALIZED, 'true');
    localStorage.setItem(STORAGE_KEYS.STUDENTS_DB, JSON.stringify(dummy));
    state.students = dummy;
  } else {
    loadStudentsFromLocalStorage();
  }

  // 사이트를 새로 열었을 때도 이전에 작업하던 학생 세션 및 작성 내용을 즉시 이어서 복원
  const savedStudentId = (localStorage.getItem(STORAGE_KEYS.CURRENT_STUDENT) || '').trim();
  if (savedStudentId) {
    const found = findStudentByIdOrName(savedStudentId);
    if (found) {
      state.currentStudentId = found.studentId;
    } else {
      // 로컬 배열에서 누락되었더라도 세션이 존재하면 빈 학생 객체를 즉시 복원하여 튕김 방지
      const restored = createEmptyStudentObject(savedStudentId);
      state.students.push(restored);
      state.currentStudentId = restored.studentId;
      saveStudentsToLocalStorage(false);
    }
  }

  // 마지막에 입력했던 이름을 로그인 입력창에 미리 채워두기
  const lastTypedName = localStorage.getItem(STORAGE_KEYS.LAST_TYPED_NAME);
  const loginNameInput = document.getElementById('login-student-name');
  if (loginNameInput && lastTypedName && findStudentByIdOrName(lastTypedName)) {
    loginNameInput.value = lastTypedName;
  } else if (lastTypedName && !findStudentByIdOrName(lastTypedName)) {
    localStorage.removeItem(STORAGE_KEYS.LAST_TYPED_NAME);
  }

  // 교사 잠금 해제 상태 복원
  state.teacherUnlocked = sessionStorage.getItem(STORAGE_KEYS.TEACHER_UNLOCKED) === 'true';

  // AI 무료 한도 도달 상태 복원
  const savedQuotaDate = localStorage.getItem(STORAGE_KEYS.AI_QUOTA_EXHAUSTED);
  if (savedQuotaDate === getKstDateString()) {
    state.aiQuotaExhausted = true;
  }

  // Supabase URL & Key 복원 (구버전 URL이 남아있는 경우 새 프로젝트 URL로 자동 전환)
  const savedSbUrl = (localStorage.getItem(STORAGE_KEYS.SUPABASE_URL) || '').trim();
  const savedSbKey = (localStorage.getItem(STORAGE_KEYS.SUPABASE_ANON_KEY) || '').trim();
  const isOldProjectUrl = savedSbUrl.includes('ybdxajahpvqbsglolnqi');
  state.supabaseUrl = (!savedSbUrl || isOldProjectUrl) ? DEFAULT_SUPABASE_URL : savedSbUrl;
  state.supabaseAnonKey = (!savedSbKey || isOldProjectUrl) ? DEFAULT_SUPABASE_ANON_KEY : savedSbKey;
  localStorage.setItem(STORAGE_KEYS.SUPABASE_URL, state.supabaseUrl);
  localStorage.setItem(STORAGE_KEYS.SUPABASE_ANON_KEY, state.supabaseAnonKey);

  initSupabaseClient();
  updateSyncStatusHeader();
}

function createEmptyStudentObject(studentName) {
  const cleanName = String(studentName || '').trim();
  return {
    studentId: cleanName,
    studentName: cleanName,
    status: 'drafting',
    inputs: {
      robotName: '',
      appearance: '',
      purpose: '',
      mainFunction: '',
      sensorName: '',
      sensorTarget: '',
      sensorAction: '',
      scienceTech: '',
      coreValues: '',
      videoStyle: '',
    },
    videoPrompt: '',
    specSheet: null,
    teacherFeedback: '',
    feedbackAt: '',
    video: { type: 'none', url: '', title: '' },
    likes: 0,
    currentVersion: 0,
    history: [],
    updatedAt: new Date().toISOString(),
  };
}

function loadStudentsFromLocalStorage() {
  loadDeletedMapFromStorage();
  const currentId = state.currentStudentId || (localStorage.getItem(STORAGE_KEYS.CURRENT_STUDENT) || '').trim();
  const currentActiveStudentSnapshot = currentId ? findStudentById(currentId) : null;

  try {
    const raw = localStorage.getItem(STORAGE_KEYS.STUDENTS_DB);
    if (raw !== null) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        let upgraded = false;
        const filtered = parsed.filter((st) => {
          if (isStudentMarkedDeleted(st)) {
            upgraded = true;
            return false;
          }
          return true;
        });
        filtered.forEach((st) => {
          if (st && st.inputs) {
            const deletedCommentIds = Array.isArray(st.inputs.deletedCommentIds) ? st.inputs.deletedCommentIds : [];
            const validComments = normalizeValidBoothComments(st.inputs.boothComments, deletedCommentIds);
            if (!Array.isArray(st.inputs.boothComments) || st.inputs.boothComments.length !== validComments.length) {
              st.inputs.boothComments = validComments;
              upgraded = true;
            }
            if (st.likes !== validComments.length) {
              st.likes = validComments.length;
              upgraded = true;
            }
            const customPrompt = String(st.inputs.customVideoPrompt || '').trim();
            if (customPrompt) {
              if (st.videoPrompt !== customPrompt) {
                st.videoPrompt = customPrompt;
                upgraded = true;
              }
            } else if (st.videoPrompt && !st.videoPrompt.startsWith('[AI 영상 제작]')) {
              st.videoPrompt = buildPromptFromInputs(st.inputs);
              upgraded = true;
            }
          }
          if (st?.video?.type === 'sample') {
            st.video = { type: 'none', url: '', title: '' };
            upgraded = true;
          }
          if (Array.isArray(st?.history)) {
            st.history.forEach((h) => {
              const hCustom = String(h?.inputs?.customVideoPrompt || '').trim();
              if (h && h.inputs && !hCustom && h.videoPrompt && !h.videoPrompt.startsWith('[AI 영상 제작]')) {
                h.videoPrompt = buildPromptFromInputs(h.inputs);
                upgraded = true;
              }
            });
          }
        });

        // 만약 다른 탭/스토리지 이벤트로 인해 현재 로그인한 학생이 목록에서 빠졌다면(삭제되지 않은 경우에 한해) 복원
        if (
          currentId &&
          !filtered.some((s) => s.studentId === currentId || s.studentName === currentId) &&
          currentActiveStudentSnapshot &&
          !isStudentMarkedDeleted(currentActiveStudentSnapshot)
        ) {
          filtered.push(currentActiveStudentSnapshot);
        }

        state.students = filtered;
        if (upgraded) {
          localStorage.setItem(STORAGE_KEYS.STUDENTS_DB, JSON.stringify(filtered));
        }
        return;
      }
    }
  } catch (err) {
    console.error('LocalStorage 파싱 오류:', err);
  }
  if (currentActiveStudentSnapshot) {
    state.students = [currentActiveStudentSnapshot];
  } else {
    state.students = [];
  }
}

function saveStudentsToLocalStorage(notifyTabs = true) {
  try {
    localStorage.setItem(STORAGE_KEYS.INITIALIZED, 'true');
    localStorage.setItem(STORAGE_KEYS.STUDENTS_DB, JSON.stringify(state.students));
    if (notifyTabs && broadcastChannel) {
      broadcastChannel.postMessage({ type: 'DB_UPDATED', timestamp: Date.now() });
    }
  } catch (err) {
    console.error('LocalStorage 저장 오류:', err);
  }
}

function findStudentById(studentId) {
  if (!studentId) return null;
  const target = String(studentId).trim();
  return state.students.find(
    (s) => String(s.studentId).trim() === target || String(s.studentName).trim() === target
  ) || null;
}

function findStudentByIdOrName(query) {
  return findStudentById(query);
}

// ============================================================================
// 5-2. Supabase & Cloud 연동 헬퍼
// ============================================================================
function isSupabaseConfigured() {
  const url = state.supabaseUrl || DEFAULT_SUPABASE_URL;
  const key = state.supabaseAnonKey || DEFAULT_SUPABASE_ANON_KEY;
  return Boolean(
    url &&
    url.startsWith('https://') &&
    url.includes('.supabase.co') &&
    key &&
    key.length > 20
  );
}

function isGasConfigured() {
  return false;
}

function isCloudConfigured() {
  return isSupabaseConfigured();
}

function initSupabaseClient() {
  if (!state.supabaseUrl) state.supabaseUrl = DEFAULT_SUPABASE_URL;
  if (!state.supabaseAnonKey) state.supabaseAnonKey = DEFAULT_SUPABASE_ANON_KEY;

  if (!isSupabaseConfigured()) {
    supabaseClient = null;
    if (supabaseRealtimeChannel) {
      try {
        supabaseRealtimeChannel.unsubscribe();
      } catch {
        // ignore
      }
      supabaseRealtimeChannel = null;
    }
    updateSyncStatusHeader();
    return null;
  }

  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    console.warn('Supabase SDK가 아직 로드되지 않았습니다.');
    return null;
  }

  try {
    supabaseClient = window.supabase.createClient(state.supabaseUrl, state.supabaseAnonKey, {
      auth: { persistSession: false },
    });
    subscribeSupabaseRealtime();
    updateSyncStatusHeader();
    return supabaseClient;
  } catch (err) {
    console.error('Supabase 클라이언트 초기화 실패:', err);
    supabaseClient = null;
    return null;
  }
}

function studentToSupabaseRow(student) {
  const nameVal = String(student.studentName || student.studentId || '').trim();
  const idVal = String(student.studentId || nameVal).trim();
  const validComments = getBoothComments(student);
  const cleanInputs = {
    ...(student.inputs || {}),
    boothComments: validComments,
  };
  return {
    student_id: idVal,
    student_name: nameVal,
    status: String(student.status || 'drafting'),
    inputs: cleanInputs,
    video_prompt: String(student.videoPrompt || ''),
    spec_sheet: student.specSheet || {},
    teacher_feedback: String(student.teacherFeedback || ''),
    feedback_at: String(student.feedbackAt || ''),
    video: student.video || { type: 'none', url: '', title: '' },
    likes: validComments.length,
    current_version: Number(student.currentVersion) || 0,
    history: Array.isArray(student.history) ? student.history : [],
    updated_at: student.updatedAt || new Date().toISOString(),
  };
}

function getKstDateString() {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

function checkQuotaGuardRow(row) {
  if (!row) return false;
  const idVal = String(row.student_id || row.student_name || '').trim();
  if (idVal !== QUOTA_GUARD_ID && row.status !== 'system_guard') return false;
  const inp = row.inputs && typeof row.inputs === 'object' ? row.inputs : {};
  const todayStr = getKstDateString();
  if (inp.date === todayStr && (inp.exhausted || Number(inp.totalCalls) >= MAX_DAILY_FREE_AI_CALLS)) {
    state.aiQuotaExhausted = true;
    localStorage.setItem(STORAGE_KEYS.AI_QUOTA_EXHAUSTED, todayStr);
  }
  if (inp.deletedMap && typeof inp.deletedMap === 'object') {
    loadDeletedMapFromStorage();
    let changed = false;
    Object.entries(inp.deletedMap).forEach(([delKey, delTime]) => {
      const numTime = Number(delTime) || 0;
      if (numTime > 0 && (!state.deletedMap[delKey] || numTime > Number(state.deletedMap[delKey]))) {
        state.deletedMap[delKey] = numTime;
        changed = true;
      }
    });
    if (changed) {
      saveDeletedMapToStorage();
      purgeDeletedStudentsFromState();
    }
  }
  return true;
}

function supabaseRowToStudent(row) {
  if (!row) return null;
  if (checkQuotaGuardRow(row)) return null;
  const nameVal = String(row.student_name || row.student_id || '').trim();
  const idVal = String(row.student_id || nameVal).trim();
  if (!idVal || idVal === QUOTA_GUARD_ID) return null;

  const rawInputs = row.inputs && typeof row.inputs === 'object' ? row.inputs : {};
  const rawVideo = row.video && typeof row.video === 'object' ? row.video : { type: 'none', url: '', title: '' };
  const deletedCommentIds = Array.isArray(rawInputs.deletedCommentIds) ? rawInputs.deletedCommentIds : [];
  const validComments = normalizeValidBoothComments(rawInputs.boothComments, deletedCommentIds);
  const customVideoPrompt = String(rawInputs.customVideoPrompt || '').trim();

  const normalizedInputs = {
    robotName: String(rawInputs.robotName || ''),
    appearance: String(rawInputs.appearance || ''),
    purpose: String(rawInputs.purpose || ''),
    mainFunction: String(rawInputs.mainFunction || ''),
    sensorName: String(rawInputs.sensorName || ''),
    sensorTarget: String(rawInputs.sensorTarget || ''),
    sensorAction: String(rawInputs.sensorAction || ''),
    scienceTech: String(rawInputs.scienceTech || ''),
    coreValues: String(rawInputs.coreValues || ''),
    videoStyle: String(rawInputs.videoStyle || ''),
    customVideoPrompt,
    aiFeedback: rawInputs.aiFeedback && typeof rawInputs.aiFeedback === 'object' ? rawInputs.aiFeedback : null,
    boothComments: validComments,
    deletedCommentIds,
  };

  let videoPrompt = customVideoPrompt || String(row.video_prompt || '');
  if (!customVideoPrompt && videoPrompt && !videoPrompt.startsWith('[AI 영상 제작]')) {
    videoPrompt = buildPromptFromInputs(normalizedInputs);
  }

  return {
    studentId: idVal,
    studentName: nameVal,
    status: String(row.status || 'drafting').trim(),
    inputs: normalizedInputs,
    videoPrompt,
    specSheet: row.spec_sheet || null,
    teacherFeedback: String(row.teacher_feedback || ''),
    feedbackAt: String(row.feedback_at || ''),
    video: {
      type: String(rawVideo.type || 'none'),
      url: String(rawVideo.url || ''),
      title: String(rawVideo.title || ''),
      thumbnail: String(rawVideo.thumbnail || ''),
    },
    likes: validComments.length,
    currentVersion: Number(row.current_version) || 0,
    history: Array.isArray(row.history) ? row.history : [],
    updatedAt: String(row.updated_at || new Date().toISOString()),
    _syncedWithCloud: true,
  };
}

function subscribeSupabaseRealtime() {
  if (!supabaseClient) return;
  if (supabaseRealtimeChannel) {
    try {
      supabaseRealtimeChannel.unsubscribe();
    } catch {
      // ignore
    }
    supabaseRealtimeChannel = null;
  }

  try {
    supabaseRealtimeChannel = supabaseClient
      .channel('robot_expo_students_realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: SUPABASE_TABLE },
        (payload) => {
          handleSupabaseRealtimePayload(payload);
        }
      )
      .subscribe();
  } catch (err) {
    console.warn('Supabase Realtime 구독 생략:', err);
  }
}

let realtimeRefreshTimer = null;

function scheduleRealtimeViewRefresh() {
  if (realtimeRefreshTimer) return;
  realtimeRefreshTimer = setTimeout(() => {
    realtimeRefreshTimer = null;
    saveStudentsToLocalStorage(false);
    refreshAllViews(false);
  }, 250);
}

function handleSupabaseRealtimePayload(payload) {
  if (!payload) return;

  if (payload.eventType === 'DELETE') {
    const deletedId = String(payload.old?.student_id || '').trim();
    if (!deletedId || deletedId === QUOTA_GUARD_ID) return;

    // 삭제된 학생이 다시 자동 저장으로 부활하지 않도록 삭제 시각 기록 및 세션 정리
    const tombstoneTime = Date.now() + 5000;
    if (!state.deletedMap) state.deletedMap = {};
    state.deletedMap[deletedId] = tombstoneTime;
    saveDeletedMapToStorage();

    if (state.currentStudentId === deletedId) {
      if (autoSaveTimer) {
        clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
      }
      state.currentStudentId = null;
      localStorage.removeItem(STORAGE_KEYS.CURRENT_STUDENT);
    }

    state.students = state.students.filter(
      (s) => s.studentId !== deletedId && s.studentName !== deletedId
    );
    saveStudentsToLocalStorage(false);
    refreshAllViews(false);
    return;
  }

  if (payload.new) {
    if (checkQuotaGuardRow(payload.new)) {
      updateStudentAiFeedbackButtonState();
      updateTeacherAiFeedbackButtonState();
      refreshAllViews(false);
      return;
    }
    const remStudent = supabaseRowToStudent(payload.new);
    if (!remStudent || isStudentMarkedDeleted(remStudent)) return;
    mergeSingleRemoteStudent(remStudent);
    scheduleRealtimeViewRefresh();
  }
}

// 상단 동기화 표시기 업데이트 (문구 없이 색깔 원으로만 표시)
function updateSyncStatusHeader(customMessage) {
  const dot = document.getElementById('sync-status-dot');
  if (!dot) return;

  if (customMessage) {
    dot.className = 'w-3 h-3 rounded-full bg-blue-500 animate-ping transition-all';
    return;
  }

  if (isSupabaseConfigured() && supabaseClient) {
    dot.className = 'w-3 h-3 rounded-full bg-emerald-500 transition-all';
  } else {
    dot.className = 'w-3 h-3 rounded-full bg-rose-500 transition-all';
  }
}

// 단일 학생 변경사항만 개별 행(Row)으로 Supabase에 비동기 전송 (절대 전체 삭제 안 함)
async function syncStudentToCloud(student, newVersionEntry = null) {
  if (!student) return;
  if (isStudentMarkedDeleted(student)) return;
  if (!isCloudConfigured()) return;

  try {
    updateSyncStatusHeader('실시간 저장 중...');

    // Supabase 개별 행 Upsert
    if (isSupabaseConfigured()) {
      if (!supabaseClient) initSupabaseClient();
      if (supabaseClient) {
        const row = studentToSupabaseRow(student);
        const { error } = await supabaseClient
          .from(SUPABASE_TABLE)
          .upsert(row, { onConflict: 'student_id' });
        if (error) {
          console.warn('Supabase 개별 학생 저장 경고:', error.message);
        } else {
          student._syncedWithCloud = true;
          state.lastSyncedAt = new Date().toISOString();
        }
      }
    }

    const indicator = document.getElementById('workspace-autosave-indicator');
    if (indicator && state.currentStudentId === student.studentId) {
      indicator.textContent = '☁️ 실시간 저장 완료 (' + new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ')';
    }
  } catch (err) {
    console.warn('클라우드 개별 학생 동기화 지연 (기기에 안전히 저장됨):', err);
  } finally {
    updateSyncStatusHeader();
  }
}

// 기존 호출부 호환용 별칭
async function syncStudentToGas(student, newVersionEntry = null) {
  return syncStudentToCloud(student, newVersionEntry);
}

// Supabase 클라우드에서 전체 학생 목록을 불러와 안전하게 병합
async function pullFromCloudNow(silent = false) {
  if (!isCloudConfigured()) {
    if (!silent) showToast('먼저 Supabase 연결 정보를 설정해 주세요.', 'warning');
    return false;
  }
  if (state.isSyncing) return false;
  state.isSyncing = true;

  try {
    if (!silent) updateSyncStatusHeader('실시간 동기화 중...');

    let fetchedStudents = null;

    // Supabase에서 전체 학생 행 조회
    if (isSupabaseConfigured()) {
      if (!supabaseClient) initSupabaseClient();
      if (supabaseClient) {
        const { data, error } = await supabaseClient
          .from(SUPABASE_TABLE)
          .select('*')
          .order('updated_at', { ascending: true });

        if (error) throw new Error(error.message);
        if (Array.isArray(data)) {
          fetchedStudents = data.map(supabaseRowToStudent).filter(Boolean);
        }
      }
    }

    if (Array.isArray(fetchedStudents)) {
      const deletedRemoteIds = mergeRemoteStudents(fetchedStudents);
      state.lastSyncedAt = new Date().toISOString();
      saveStudentsToLocalStorage(false);
      refreshAllViews(false);

      // 삭제 기록(Tombstone)이나 초기 더미가 원격에 남아있으면 해당 ID만 개별 삭제
      if (deletedRemoteIds.length > 0) {
        for (const delId of deletedRemoteIds) {
          deleteStudentFromCloud(delId, delId);
        }
      }
    }

    if (!silent) {
      showToast('⚡ 최신 학생 데이터를 실시간 동기화했습니다!', 'success');
    }
    return true;
  } catch (err) {
    console.warn('클라우드 데이터 가져오기 지연:', err);
    if (!silent) {
      showToast(`동기화 확인 필요: ${err.message}`, 'error');
    }
    return false;
  } finally {
    state.isSyncing = false;
    updateSyncStatusHeader();
  }
}

async function pullFromGasNow(silent = false) {
  return pullFromCloudNow(silent);
}

function mergeDeletedCommentIds(loc, rem) {
  const a = Array.isArray(loc?.inputs?.deletedCommentIds) ? loc.inputs.deletedCommentIds : [];
  const b = Array.isArray(rem?.inputs?.deletedCommentIds) ? rem.inputs.deletedCommentIds : [];
  return Array.from(new Set([...a, ...b].filter(Boolean)));
}

function resolveBoothCommentsByTimestamp(loc, rem, locTime, remTime) {
  const deletedCommentIds = mergeDeletedCommentIds(loc, rem);
  const deletedSet = new Set(deletedCommentIds);
  const locComments = normalizeValidBoothComments(loc?.inputs?.boothComments, deletedCommentIds);
  const remComments = normalizeValidBoothComments(rem?.inputs?.boothComments, deletedCommentIds);

  // 만약 한쪽에서 댓글 삭제가 일어나 댓글 수가 줄어든 최신 상태이고 deletedCommentIds가 없던 구버전 레코드라면 최신 타임스탬프 우선
  const byId = new Map();
  const firstList = remTime >= locTime ? locComments : remComments;
  const secondList = remTime >= locTime ? remComments : locComments;

  firstList.forEach((c) => {
    if (c && c.id && !deletedSet.has(c.id)) {
      byId.set(c.id, c);
    }
  });
  secondList.forEach((c) => {
    if (c && c.id && !deletedSet.has(c.id)) {
      const prev = byId.get(c.id);
      if (!prev) {
        byId.set(c.id, c);
      } else {
        const prevT = new Date(prev.updatedAt || prev.createdAt || 0).getTime() || 0;
        const currT = new Date(c.updatedAt || c.createdAt || 0).getTime() || 0;
        if (currT >= prevT) {
          byId.set(c.id, c);
        }
      }
    }
  });

  const mergedList = Array.from(byId.values()).sort((x, y) => {
    const tx = new Date(x.createdAt || 0).getTime() || 0;
    const ty = new Date(y.createdAt || 0).getTime() || 0;
    return tx - ty;
  });

  return normalizeValidBoothComments(mergedList, deletedCommentIds);
}

// 단일 원격 학생 병합 (작성 중 학생 보호 & 관리자 수정 중 보호)
function mergeSingleRemoteStudent(rem) {
  if (!rem) return;
  const key = String(rem.studentName || rem.studentId || '').trim();
  if (!key || isStudentMarkedDeleted(rem)) return;

  const idx = state.students.findIndex(
    (s) => String(s.studentName || s.studentId).trim() === key
  );

  if (idx === -1) {
    rem.likes = getBoothLikesCount(rem);
    rem._syncedWithCloud = true;
    state.students.push(rem);
    return;
  }

  const loc = state.students[idx];
  const remTime = new Date(rem.updatedAt || 0).getTime() || 0;
  const locTime = new Date(loc.updatedAt || 0).getTime() || 0;
  const mergedDeletedCommentIds = mergeDeletedCommentIds(loc, rem);
  const mergedComments = resolveBoothCommentsByTimestamp(loc, rem, locTime, remTime);
  const mergedLikes = mergedComments.length;

  const isCurrentActiveStudent =
    state.currentStudentId &&
    (state.currentStudentId === loc.studentId || state.currentStudentId === loc.studentName);

  // 현재 이 기기에서 로그인해 작성 중인 학생인 경우:
  // 학생이 작성 중인 입력값(inputs, videoPrompt, specSheet)은 절대 원격의 이전 데이터로 덮어쓰지 않고 보호!
  // 단, 선생님이 보낸 피드백(status, teacherFeedback, feedbackAt)이나 응원수(likes), 응원 댓글(boothComments)은 실시간으로 반영
  if (isCurrentActiveStudent && state.activeTab === 'studio') {
    const isActivelyTyping = Date.now() - (state.lastLocalStudentTypingAt || 0) < 30000;
    if (isActivelyTyping || locTime >= remTime) {
      state.students[idx] = {
        ...loc,
        inputs: {
          ...(loc.inputs || {}),
          boothComments: mergedComments,
          deletedCommentIds: mergedDeletedCommentIds,
        },
        status: remTime >= locTime ? rem.status : loc.status,
        teacherFeedback: remTime >= locTime ? rem.teacherFeedback : loc.teacherFeedback,
        feedbackAt: remTime >= locTime ? rem.feedbackAt : loc.feedbackAt,
        likes: mergedLikes,
        _syncedWithCloud: true,
      };
      return;
    }
    // 학생이 타이핑을 멈춘 상태에서 선생님이 직접 학생 내용을 수정해 더 최신 시간(remTime > locTime)으로 보낸 경우
    state.students[idx] = {
      ...rem,
      inputs: {
        ...(remTime > locTime ? rem.inputs : loc.inputs),
        boothComments: mergedComments,
        deletedCommentIds: mergedDeletedCommentIds,
      },
      likes: mergedLikes,
      _syncedWithCloud: true,
    };
    return;
  }

  if (remTime >= locTime) {
    state.students[idx] = {
      ...rem,
      inputs: {
        ...(rem.inputs || {}),
        boothComments: mergedComments,
        deletedCommentIds: mergedDeletedCommentIds,
      },
      likes: mergedLikes,
      _syncedWithCloud: true,
    };
  } else {
    state.students[idx] = {
      ...loc,
      inputs: {
        ...(loc.inputs || {}),
        boothComments: mergedComments,
        deletedCommentIds: mergedDeletedCommentIds,
      },
      likes: mergedLikes,
      _syncedWithCloud: true,
    };
  }
}

// 전체 원격 학생 목록과 로컬 목록 병합 (작성 중인 학생 보호 + 삭제된 데이터 재부활 원천 차단)
function mergeRemoteStudents(remoteList) {
  loadDeletedMapFromStorage();

  const localMap = {};
  state.students.forEach((s) => {
    const key = String(s.studentName || s.studentId).trim();
    if (key) localMap[key] = s;
  });

  const merged = [];
  const seenKeys = new Set();
  const deletedRemoteIds = [];

  remoteList.forEach((rem) => {
    const key = String(rem.studentName || rem.studentId || '').trim();
    if (!key) return;

    // 삭제 기록(Tombstone)이나 레거시 더미에 해당하는 데이터는 절대 복구하지 않고 클라우드에서도 삭제
    if (isStudentMarkedDeleted(rem)) {
      deletedRemoteIds.push(key);
      return;
    }

    seenKeys.add(key);

    const loc = localMap[key];
    if (!loc) {
      rem.likes = getBoothLikesCount(rem);
      rem._syncedWithCloud = true;
      merged.push(rem);
      return;
    }

    const remTime = new Date(rem.updatedAt || 0).getTime() || 0;
    const locTime = new Date(loc.updatedAt || 0).getTime() || 0;
    const mergedDeletedCommentIds = mergeDeletedCommentIds(loc, rem);
    const mergedComments = resolveBoothCommentsByTimestamp(loc, rem, locTime, remTime);
    const mergedLikes = mergedComments.length;

    const isCurrentActiveStudent =
      state.currentStudentId &&
      (state.currentStudentId === rem.studentId || state.currentStudentId === rem.studentName);

    if (isCurrentActiveStudent && state.activeTab === 'studio') {
      const isActivelyTyping = Date.now() - (state.lastLocalStudentTypingAt || 0) < 30000;
      if (isActivelyTyping || locTime >= remTime) {
        merged.push({
          ...loc,
          inputs: {
            ...(loc.inputs || {}),
            boothComments: mergedComments,
            deletedCommentIds: mergedDeletedCommentIds,
          },
          status: remTime >= locTime ? rem.status : loc.status,
          teacherFeedback: remTime >= locTime ? rem.teacherFeedback : loc.teacherFeedback,
          feedbackAt: remTime >= locTime ? rem.feedbackAt : loc.feedbackAt,
          likes: mergedLikes,
          _syncedWithCloud: true,
        });
      } else {
        merged.push({
          ...rem,
          inputs: {
            ...(rem.inputs || {}),
            boothComments: mergedComments,
            deletedCommentIds: mergedDeletedCommentIds,
          },
          likes: mergedLikes,
          _syncedWithCloud: true,
        });
      }
      return;
    }

    if (remTime >= locTime) {
      merged.push({
        ...rem,
        inputs: {
          ...(rem.inputs || {}),
          boothComments: mergedComments,
          deletedCommentIds: mergedDeletedCommentIds,
        },
        likes: mergedLikes,
        _syncedWithCloud: true,
      });
    } else {
      merged.push({
        ...loc,
        inputs: {
          ...(loc.inputs || {}),
          boothComments: mergedComments,
          deletedCommentIds: mergedDeletedCommentIds,
        },
        likes: mergedLikes,
        _syncedWithCloud: true,
      });
    }
  });

  // 로컬에만 있고 원격(Supabase)에 없는 학생 처리:
  // 1) 삭제 기록(isStudentMarkedDeleted)에 있거나, 이미 클라우드와 동기화되었던(_syncedWithCloud) 학생이 원격에서 사라졌다면
  //    관리자가 삭제한 것이므로 로컬에서도 제거하여 시간이 지나 다시 부활하는 현상을 원천 차단!
  // 2) 방금 로그인하여 아직 첫 클라우드 전송 전인 신규 작성 학생(!loc._syncedWithCloud)은 안전하게 보존!
  state.students.forEach((loc) => {
    const key = String(loc.studentName || loc.studentId).trim();
    if (!key || seenKeys.has(key)) return;

    if (isStudentMarkedDeleted(loc)) {
      if (state.currentStudentId === key) {
        if (autoSaveTimer) {
          clearTimeout(autoSaveTimer);
          autoSaveTimer = null;
        }
        state.currentStudentId = null;
        localStorage.removeItem(STORAGE_KEYS.CURRENT_STUDENT);
      }
      return;
    }

    const isCurrentActiveStudent =
      state.currentStudentId &&
      (state.currentStudentId === loc.studentId || state.currentStudentId === loc.studentName);
    const locTime = new Date(loc.updatedAt || 0).getTime() || 0;
    const isRecentlyModifiedLocally = Date.now() - locTime < 20000;

    if (!loc._syncedWithCloud && (isCurrentActiveStudent || isRecentlyModifiedLocally)) {
      merged.push(loc);
    } else if (isCurrentActiveStudent && (Date.now() - (state.lastLocalStudentTypingAt || 0) < 15000)) {
      merged.push(loc);
    }
  });

  state.students = merged;
  return deletedRemoteIds;
}

// 로컬 학생 데이터를 Supabase에 개별 안전 병합 업로드
async function pushAllLocalToCloud(silent = false) {
  if (!isCloudConfigured()) {
    if (!silent) showToast('먼저 Supabase 연결을 설정해 주세요.', 'warning');
    return false;
  }
  try {
    updateSyncStatusHeader('개별 안전 병합 중...');
    const validStudents = state.students.filter((s) => !isStudentMarkedDeleted(s));

    if (isSupabaseConfigured()) {
      if (!supabaseClient) initSupabaseClient();
      if (supabaseClient && validStudents.length > 0) {
        const rows = validStudents.map(studentToSupabaseRow);
        const { error } = await supabaseClient
          .from(SUPABASE_TABLE)
          .upsert(rows, { onConflict: 'student_id' });
        if (error) throw new Error(error.message);
      }
    }

    state.lastSyncedAt = new Date().toISOString();
    updateSyncStatusHeader();
    if (!silent) {
      showToast(`⬆️ 학생 ${validStudents.length}명의 데이터를 삭제 없이 안전하게 Supabase에 병합 업로드했습니다!`, 'success');
    }
    return true;
  } catch (err) {
    updateSyncStatusHeader();
    if (!silent) {
      showToast(`데이터 업로드 오류: ${err.message}`, 'error');
    }
    return false;
  }
}

const pushAllLocalToGas = pushAllLocalToCloud;

function startRealtimeSyncLoop() {
  setInterval(() => {
    if (document.visibilityState === 'visible' && isCloudConfigured()) {
      pullFromCloudNow(true);
    }
  }, CLOUD_POLL_INTERVAL_MS);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isCloudConfigured()) {
      pullFromCloudNow(true);
    }
  });
}

function manualSyncNow() {
  if (isCloudConfigured()) {
    pullFromCloudNow(false);
  } else {
    loadStudentsFromLocalStorage();
    refreshAllViews(true);
    showToast('💾 로컬 스토리지 최신 상태로 동기화되었습니다.', 'info');
  }
}

// ============================================================================
// 6. 메인 탭 전환, 오른쪽 상단 홈화면 이동 & 전체 화면 리프레시
// ============================================================================
function switchMainTab(tabName) {
  state.activeTab = tabName;

  const tabs = ['studio', 'expo', 'teacher'];
  tabs.forEach((t) => {
    const viewEl = document.getElementById(`view-${t}`);
    const btnEl = document.getElementById(`tab-btn-${t}`);
    if (viewEl) {
      viewEl.classList.toggle('hidden', t !== tabName);
    }
    if (btnEl) {
      if (t === tabName) {
        btnEl.className = 'tab-nav-btn flex-1 md:flex-initial flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-sm font-bold transition-all whitespace-nowrap bg-white text-blue-600 shadow-sm';
      } else {
        btnEl.className = 'tab-nav-btn flex-1 md:flex-initial flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-sm font-bold transition-all whitespace-nowrap text-slate-600 hover:text-slate-900';
      }
    }
  });

  refreshAllViews(false);
}

// 오른쪽 상단 [🏠 홈화면] 버튼: 로그인 화면으로 돌아가기 (작성 데이터는 안전하게 보존됨)
function goHomeToLogin() {
  // 현재 입력 중인 내용이 있으면 먼저 안전하게 저장
  const currentStudent = findStudentById(state.currentStudentId);
  if (currentStudent && state.activeTab === 'studio') {
    currentStudent.inputs = getStudioFormInputs();
    currentStudent.updatedAt = new Date().toISOString();
    saveStudentsToLocalStorage();
  }

  state.currentStudentId = null;
  localStorage.removeItem(STORAGE_KEYS.CURRENT_STUDENT);

  const resultsEl = document.getElementById('generated-results-section');
  if (resultsEl) resultsEl.classList.add('hidden');

  switchMainTab('studio');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  showToast('🏠 로그인 화면(홈)으로 이동했습니다. 이름을 입력하면 작성하던 내용을 이어서 볼 수 있어요!', 'info');
}

function refreshAllViews(populateInputs = false) {
  const prevScrollY = window.scrollY;
  updateTopNavBadges();
  if (populateInputs || state.activeTab === 'studio') {
    renderStudioWorkspace(populateInputs);
  }
  renderExpoBooths();
  renderTeacherSection();
  updateSyncStatusHeader();
  if (state.activeBoothStudentId) {
    const activeStudent = findStudentById(state.activeBoothStudentId);
    if (activeStudent) {
      renderBoothLikeAndComments(activeStudent, false);
    }
  }
  if (!populateInputs && state.activeTab === 'teacher' && Math.abs(window.scrollY - prevScrollY) > 5) {
    window.scrollTo({ top: prevScrollY, behavior: 'instant' });
  }
}

function updateTopNavBadges() {
  const studioBadge = document.getElementById('tab-studio-badge');
  const currentStudent = findStudentById(state.currentStudentId);
  if (studioBadge) {
    if (currentStudent && currentStudent.status === 'revision') {
      studioBadge.classList.remove('hidden');
      studioBadge.textContent = '수정요청!';
    } else {
      studioBadge.classList.add('hidden');
    }
  }

  const expoStudents = getExpoEligibleStudents();
  const expoCountEl = document.getElementById('tab-expo-count');
  if (expoCountEl) {
    expoCountEl.textContent = String(expoStudents.length);
  }
}

// ============================================================================
// 7. [탭 1] 🛠️ 로봇 설계실 (이름 로그인, 7단계 폼, 실시간 코칭, 2종 변환, 제출)
// ============================================================================
function sha256HexSync(ascii) {
  function rightRotate(value, amount) {
    return (value >>> amount) | (value << (32 - amount));
  }
  const mathPow = Math.pow;
  const maxWord = mathPow(2, 32);
  const lengthProperty = 'length';
  let i, j;
  let result = '';
  const words = [];
  const asciiBitLength = ascii[lengthProperty] * 8;
  let hash = [];
  const k = [];
  let primeCounter = 0;
  const isComposite = {};
  for (let candidate = 2; primeCounter < 64; candidate++) {
    if (!isComposite[candidate]) {
      for (i = 0; i < 313; i += candidate) {
        isComposite[i] = candidate;
      }
      hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
      k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
    }
  }
  ascii += '\x80';
  while ((ascii[lengthProperty] % 64) - 56) ascii += '\x00';
  for (i = 0; i < ascii[lengthProperty]; i++) {
    j = ascii.charCodeAt(i);
    if (j >> 8) return '';
    words[i >> 2] |= j << ((3 - (i % 4)) * 8);
  }
  words[words[lengthProperty]] = (asciiBitLength / maxWord) | 0;
  words[words[lengthProperty]] = asciiBitLength;
  for (j = 0; j < words[lengthProperty]; ) {
    const w = words.slice(j, (j += 16));
    const oldHash = hash;
    hash = hash.slice(0, 8);
    for (i = 0; i < 64; i++) {
      const w15 = w[i - 15], w2 = w[i - 2];
      const a = hash[0], e = hash[4];
      const temp1 =
        hash[7] +
        (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)) +
        ((e & hash[5]) ^ (~e & hash[6])) +
        k[i] +
        (w[i] =
          i < 16
            ? w[i]
            : (w[i - 16] +
                (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3)) +
                w[i - 7] +
                (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))) |
              0);
      const temp2 =
        (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)) +
        ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
      hash = [(temp1 + temp2) | 0].concat(hash);
      hash[4] = (hash[4] + temp1) | 0;
    }
    for (i = 0; i < 8; i++) {
      hash[i] = (hash[i] + oldHash[i]) | 0;
    }
  }
  for (i = 0; i < 8; i++) {
    for (j = 3; j + 1; j--) {
      const b = (hash[i] >> (j * 8)) & 255;
      result += (b < 16 ? 0 : '') + b.toString(16);
    }
  }
  return result;
}

function bindFormEvents() {
  const loginForm = document.getElementById('student-login-form');
  if (loginForm) {
    loginForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const nameInput = document.getElementById('login-student-name');
      const studentName = (nameInput?.value || '').trim();
      if (!studentName) {
        showToast('이름을 입력해 주세요!', 'warning');
        return;
      }
      loginAsStudent(studentName);
    });
  }

  const teacherAuthForm = document.getElementById('teacher-auth-form');
  if (teacherAuthForm) {
    teacherAuthForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const pwInput = document.getElementById('teacher-password-input');
      const errEl = document.getElementById('teacher-auth-error');
      const savedPinHash = localStorage.getItem(STORAGE_KEYS.TEACHER_PIN_HASH) || DEFAULT_TEACHER_PIN_HASH;
      const inputHash = sha256HexSync((pwInput.value || '').trim());

      if (inputHash && inputHash === savedPinHash) {
        state.teacherUnlocked = true;
        sessionStorage.setItem(STORAGE_KEYS.TEACHER_UNLOCKED, 'true');
        pwInput.value = '';
        if (errEl) errEl.classList.add('hidden');
        renderTeacherSection();
        showToast('🔓 교사 관리자 화면 잠금이 해제되었습니다.', 'success');
      } else {
        if (errEl) errEl.classList.remove('hidden');
        showToast('비밀번호가 일치하지 않습니다.', 'error');
      }
    });
  }
}

function loginAsStudent(studentName) {
  const cleanName = String(studentName || '').trim();
  if (!cleanName) return;

  clearDeletedMark(cleanName);

  let student = findStudentByIdOrName(cleanName);
  if (!student) {
    student = {
      studentId: cleanName,
      studentName: cleanName,
      status: 'drafting',
      inputs: {
        robotName: '',
        appearance: '',
        purpose: '',
        mainFunction: '',
        sensorName: '',
        sensorTarget: '',
        sensorAction: '',
        scienceTech: '',
        coreValues: '',
        videoStyle: '',
      },
      videoPrompt: '',
      specSheet: null,
      teacherFeedback: '',
      feedbackAt: '',
      video: { type: 'none', url: '', title: '' },
      likes: 0,
      currentVersion: 0,
      history: [],
      updatedAt: new Date().toISOString(),
    };
    state.students.push(student);
    saveStudentsToLocalStorage();
    syncStudentToCloud(student);
  }

  state.currentStudentId = student.studentId;
  localStorage.setItem(STORAGE_KEYS.CURRENT_STUDENT, student.studentId);
  localStorage.setItem(STORAGE_KEYS.LAST_TYPED_NAME, student.studentName);

  refreshAllViews(true);
  showToast(`🤖 ${student.studentName} 연구원님, 환영합니다! 작성 내용은 자동으로 이어서 저장됩니다.`, 'success');
}

function logoutStudent() {
  goHomeToLogin();
}

function renderStudioWorkspace(populateInputs = false) {
  const loginPanel = document.getElementById('student-login-panel');
  const workspacePanel = document.getElementById('student-workspace-panel');
  if (!loginPanel || !workspacePanel) return;

  // 현재 로그인한 학생 ID가 없다면 로그인 화면 표시
  if (!state.currentStudentId) {
    loginPanel.classList.remove('hidden');
    workspacePanel.classList.add('hidden');
    return;
  }

  // 현재 로그인한 학생이 배열에서 일시적으로 누락되었더라도 절대 로그인 화면으로 튕기지 않고 현재 입력창 상태로 즉시 복원!
  let student = findStudentById(state.currentStudentId);
  if (!student) {
    student = createEmptyStudentObject(state.currentStudentId);
    student.inputs = getStudioFormInputs();
    state.students.push(student);
    saveStudentsToLocalStorage(false);
  }

  loginPanel.classList.add('hidden');
  workspacePanel.classList.remove('hidden');

  const labelEl = document.getElementById('workspace-student-label');
  const statusBadgeEl = document.getElementById('workspace-status-badge');
  const versionBadgeEl = document.getElementById('workspace-version-badge');
  const historyCountEl = document.getElementById('student-history-count');

  const meta = STATUS_META[student.status] || STATUS_META.drafting;
  if (labelEl) labelEl.textContent = student.studentName;
  if (statusBadgeEl) {
    statusBadgeEl.className = `inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-extrabold ${meta.badgeClass}`;
    statusBadgeEl.textContent = meta.studentBadge;
  }
  if (versionBadgeEl) {
    versionBadgeEl.textContent = student.currentVersion > 0
      ? `현재 버전: v${student.currentVersion} (${(student.history || []).length}회 제출)`
      : '미제출 (작성중)';
  }
  if (historyCountEl) {
    historyCountEl.textContent = String((student.history || []).length);
  }

  renderStudentFeedbackBanner(student);

  if (populateInputs) {
    const inp = student.inputs || {};
    setInputValue('input-robot-name', inp.robotName || '');
    setInputValue('input-appearance', inp.appearance || '');
    setInputValue('input-purpose', inp.purpose || '');
    setInputValue('input-main-function', inp.mainFunction || '');
    setInputValue('input-sensor-name', inp.sensorName || '');
    setInputValue('input-sensor-target', inp.sensorTarget || '');
    setInputValue('input-sensor-action', inp.sensorAction || '');
    setInputValue('input-science-tech', inp.scienceTech || '');
    setInputValue('input-core-values', inp.coreValues || '');
    setInputValue('input-video-style', inp.videoStyle || '');

    if (student.videoPrompt && student.specSheet) {
      renderGeneratedOutputs(student.videoPrompt, student.specSheet);
    } else {
      const resultsSection = document.getElementById('generated-results-section');
      if (resultsSection) resultsSection.classList.add('hidden');
    }
  }

  highlightSelectedVideoStyleCard();
  evaluateCoachingAndProgress();
  renderStudentAiFeedbackBoxes(student);
  updateStudentAiFeedbackButtonState(student);
}

function renderStudentFeedbackBanner(student) {
  const banner = document.getElementById('student-feedback-banner');
  if (!banner) return;

  if (student.status === 'revision') {
    banner.className = 'rounded-2xl p-5 border-2 border-orange-400 bg-gradient-to-r from-orange-50 via-amber-50 to-orange-50 text-orange-950 revision-banner-pulse block';
    const timeLabel = student.feedbackAt ? formatDateTime(student.feedbackAt) : '방금 전';
    banner.innerHTML = `
      <div class="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
        <div class="flex items-start gap-3">
          <div class="w-11 h-11 rounded-2xl bg-orange-500 text-white flex items-center justify-center text-2xl shrink-0 shadow-md">
            🚨
          </div>
          <div class="space-y-1.5">
            <div class="flex flex-wrap items-center gap-2">
              <span class="px-2.5 py-0.5 rounded-full text-xs font-extrabold bg-orange-600 text-white">수정요청 도착!</span>
              <span class="text-xs font-bold text-orange-700">선생님의 코칭 피드백을 확인하고 내용을 보완해 다시 제출해 보세요!</span>
              <span class="text-[11px] text-orange-600/80">(${escapeHtml(timeLabel)})</span>
            </div>
            <div class="bg-white/90 border border-orange-200 rounded-xl p-3.5 text-sm font-semibold text-slate-800 leading-relaxed shadow-sm">
              “${escapeHtml(student.teacherFeedback || '입력 항목을 조금 더 구체적으로 보완해 다시 제출해 주세요!')}”
            </div>
          </div>
        </div>
      </div>
    `;
    return;
  }

  if (student.status === 'approved') {
    banner.className = 'rounded-2xl p-5 border-2 border-emerald-400 bg-gradient-to-r from-emerald-50 to-teal-50 text-emerald-950 block';
    banner.innerHTML = `
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div class="flex items-start gap-3">
          <div class="w-11 h-11 rounded-2xl bg-emerald-600 text-white flex items-center justify-center text-2xl shrink-0 shadow-md">
            🎉
          </div>
          <div class="space-y-1">
            <div class="flex items-center gap-2">
              <span class="px-2.5 py-0.5 rounded-full text-xs font-extrabold bg-emerald-600 text-white">전시승인 완료</span>
              <span class="text-sm font-extrabold text-emerald-900">선생님께서 로봇 기획서를 최종 전시 승인하셨어요!</span>
            </div>
            ${student.teacherFeedback ? `<p class="text-xs sm:text-sm text-emerald-800 font-medium mt-1">💬 선생님 피드백: “${escapeHtml(student.teacherFeedback)}”</p>` : ''}
          </div>
        </div>
        <button
          type="button"
          onclick="switchMainTab('expo'); openBoothDetailModal('${escapeHtml(student.studentId)}')"
          class="px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-extrabold whitespace-nowrap shadow-sm transition self-start sm:self-center"
        >
          🏛️ 내 박람회 전시 부스 보러가기 →
        </button>
      </div>
    `;
    return;
  }

  if (student.teacherFeedback) {
    banner.className = 'rounded-2xl p-4 border border-blue-200 bg-blue-50/80 text-blue-950 block';
    banner.innerHTML = `
      <div class="flex items-start gap-3">
        <span class="text-xl">💬</span>
        <div class="text-xs sm:text-sm">
          <strong class="font-extrabold text-blue-900">선생님의 이전 피드백 메모:</strong>
          <p class="text-slate-700 mt-1">“${escapeHtml(student.teacherFeedback)}”</p>
        </div>
      </div>
    `;
    return;
  }

  banner.className = 'hidden';
  banner.innerHTML = '';
}

function setInputValue(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val;
}

function getStudioFormInputs() {
  const currentStudent = findStudentById(state.currentStudentId);
  const existingAiFeedback = currentStudent?.inputs?.aiFeedback || null;
  const existingBoothComments = Array.isArray(currentStudent?.inputs?.boothComments)
    ? currentStudent.inputs.boothComments
    : [];
  const existingDeletedCommentIds = Array.isArray(currentStudent?.inputs?.deletedCommentIds)
    ? currentStudent.inputs.deletedCommentIds
    : [];
  const existingCustomPrompt = String(currentStudent?.inputs?.customVideoPrompt || '').trim();
  return {
    robotName: (document.getElementById('input-robot-name')?.value || '').trim(),
    appearance: (document.getElementById('input-appearance')?.value || '').trim(),
    purpose: (document.getElementById('input-purpose')?.value || '').trim(),
    mainFunction: (document.getElementById('input-main-function')?.value || '').trim(),
    sensorName: (document.getElementById('input-sensor-name')?.value || '').trim(),
    sensorTarget: (document.getElementById('input-sensor-target')?.value || '').trim(),
    sensorAction: (document.getElementById('input-sensor-action')?.value || '').trim(),
    scienceTech: (document.getElementById('input-science-tech')?.value || '').trim(),
    coreValues: (document.getElementById('input-core-values')?.value || '').trim(),
    videoStyle: (document.getElementById('input-video-style')?.value || '').trim(),
    customVideoPrompt: existingCustomPrompt,
    aiFeedback: existingAiFeedback,
    boothComments: existingBoothComments,
    deletedCommentIds: existingDeletedCommentIds,
  };
}

// 1~5단계 예시 태그 버튼 클릭 시 입력창에 텍스트 추가
function appendTagToInput(inputId, rawTag) {
  const el = document.getElementById(inputId);
  if (!el) return;

  const cleanPhrase = rawTag.replace(/^#/, '').replace(/_/g, ' ').trim();
  const currentVal = el.value.trim();

  if (!currentVal) {
    el.value = cleanPhrase;
  } else if (!currentVal.includes(cleanPhrase)) {
    const sep = currentVal.endsWith(',') || currentVal.endsWith('.') ? ' ' : ', ';
    el.value = `${currentVal}${sep}${cleanPhrase}`;
  } else {
    showToast(`이미 '${cleanPhrase}' 내용이 포함되어 있어요!`, 'info');
  }

  el.focus();
  handleStudioInputChange();
  handleStudioStepMove();
}

// 6단계: 추구하는 가치 해시태그 추가 함수
function appendHashtagValue(tagStr) {
  const el = document.getElementById('input-core-values');
  if (!el) return;

  const normalizedTag = tagStr.startsWith('#') ? tagStr : `#${tagStr}`;
  const existing = parseCoreValuesHashtags(el.value);

  if (existing.includes(normalizedTag)) {
    showToast(`이미 ${normalizedTag} 해시태그가 추가되어 있어요!`, 'info');
  } else {
    existing.push(normalizedTag);
    el.value = existing.join(' ');
  }

  el.focus();
  handleStudioInputChange();
  handleStudioStepMove();
}

// 6단계 입력창 포커스 해제 시 자동으로 단어 앞에 # 붙이기
function normalizeCoreValuesHashtags() {
  const el = document.getElementById('input-core-values');
  if (!el || !el.value.trim()) return;
  el.value = formatCoreValuesString(el.value);
  handleStudioInputChange();
}

// 7단계: 영상 스타일 보기 선택 함수
function selectVideoStyleOption(styleValue) {
  const el = document.getElementById('input-video-style');
  if (!el) return;
  el.value = styleValue;
  highlightSelectedVideoStyleCard();
  handleStudioInputChange();
  handleStudioStepMove();
}

function highlightSelectedVideoStyleCard() {
  const currentStyle = (document.getElementById('input-video-style')?.value || '').trim();
  document.querySelectorAll('.video-style-card').forEach((card) => {
    const cardVal = (card.getAttribute('data-style-val') || '').trim();
    if (currentStyle && cardVal === currentStyle) {
      card.className = 'video-style-card text-left p-3.5 rounded-2xl border-2 border-blue-600 bg-blue-50/90 shadow-sm transition flex flex-col justify-between gap-1';
    } else {
      card.className = 'video-style-card text-left p-3.5 rounded-2xl border-2 border-slate-200 hover:border-blue-400 bg-slate-50/70 transition flex flex-col justify-between gap-1';
    }
  });
}

let autoSaveTimer = null;

// 글자 입력 시: 브라우저에는 0.1초 이내 즉시 저장 + 클라우드(Supabase/시트)로는 4초 간격 자동 전송
function handleStudioInputChange() {
  state.lastLocalStudentTypingAt = Date.now();
  highlightSelectedVideoStyleCard();
  evaluateCoachingAndProgress();

  const student = findStudentById(state.currentStudentId);
  if (!student) return;

  student.inputs = getStudioFormInputs();
  student.updatedAt = new Date().toISOString();
  saveStudentsToLocalStorage();

  const indicator = document.getElementById('workspace-autosave-indicator');
  if (indicator) {
    indicator.textContent = '💾 기기에 즉시 저장됨 (' + new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ')';
  }

  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  const jitterMs = Math.floor(Math.random() * 600);
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = null;
    syncStudentToCloud(student);
  }, AUTO_SYNC_DEBOUNCE_MS + jitterMs);
}

// 다음 단계 입력칸으로 이동하거나(onchange) 태그/스타일 선택 시 즉시 클라우드로 전송
function handleStudioStepMove() {
  const student = findStudentById(state.currentStudentId);
  if (!student) return;

  student.inputs = getStudioFormInputs();
  student.updatedAt = new Date().toISOString();
  saveStudentsToLocalStorage();

  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
  syncStudentToCloud(student);
}

/**
 * 7단계 실시간 코칭 질문 조건 검사 및 주황색 코칭 박스 제어
 * - 1단계: 외형 특징 15자 미만 시 코칭 표시
 * - 2단계: 제작 목적 15자 미만 시 코칭 표시
 * - 3단계: 주요 기능 50자 미만 시 코칭 표시
 * - 4단계: 4-2 또는 4-3이 10자 미만 시 코칭 표시
 * - 5단계: 과학 기술 50자 미만 시 코칭 표시
 * - 6단계: 추구하는 가치 해시태그 단어가 2개 미만 시 코칭 표시
 * - 7단계: 영상 스타일이 비어있을 시 코칭 표시
 */
function evaluateCoachingAndProgress() {
  const inputs = getStudioFormInputs();
  const valueHashtags = parseCoreValuesHashtags(inputs.coreValues);

  // 글자수 / 단어수 카운터 업데이트
  updateCharCounter('char-count-appearance', inputs.appearance.length, 15);
  updateCharCounter('char-count-purpose', inputs.purpose.length, 15);
  updateCharCounter('char-count-main-function', inputs.mainFunction.length, 50);
  updateCharCounter('char-count-sensor-target', inputs.sensorTarget.length, 10);
  updateCharCounter('char-count-sensor-action', inputs.sensorAction.length, 10);
  updateCharCounter('char-count-science-tech', inputs.scienceTech.length, 50);

  const countValEl = document.getElementById('count-core-values');
  if (countValEl) {
    if (valueHashtags.length >= 2) {
      countValEl.textContent = `✅ ${valueHashtags.length}개 해시태그 완료!`;
      countValEl.className = 'text-[11px] font-bold text-emerald-600';
    } else {
      countValEl.textContent = `${valueHashtags.length}개 / 최소 2개 이상 단어 필요`;
      countValEl.className = 'text-[11px] font-bold text-orange-600';
    }
  }

  // 각 단계 통과 조건
  const step1Pass = inputs.robotName.length >= 1 && inputs.appearance.length >= 15;
  const step2Pass = inputs.purpose.length >= 15;
  const step3Pass = inputs.mainFunction.length >= 50;
  const step4Pass = inputs.sensorName.length >= 2 && inputs.sensorTarget.length >= 10 && inputs.sensorAction.length >= 10;
  const step5Pass = inputs.scienceTech.length >= 50;
  const step6Pass = valueHashtags.length >= 2;
  const step7Pass = inputs.videoStyle.length >= 2;

  toggleCoachingBox('coaching-step-1', 'step1-status-pill', inputs.appearance.length < 15, step1Pass);
  toggleCoachingBox('coaching-step-2', 'step2-status-pill', inputs.purpose.length < 15, step2Pass);
  toggleCoachingBox('coaching-step-3', 'step3-status-pill', inputs.mainFunction.length < 50, step3Pass);
  toggleCoachingBox(
    'coaching-step-4',
    'step4-status-pill',
    inputs.sensorTarget.length < 10 || inputs.sensorAction.length < 10,
    step4Pass
  );
  toggleCoachingBox('coaching-step-5', 'step5-status-pill', inputs.scienceTech.length < 50, step5Pass);
  toggleCoachingBox('coaching-step-6', 'step6-status-pill', valueHashtags.length < 2, step6Pass);
  toggleCoachingBox('coaching-step-7', 'step7-status-pill', !step7Pass, step7Pass);

  // 전체 7단계 달성도 바 업데이트
  const allSteps = [step1Pass, step2Pass, step3Pass, step4Pass, step5Pass, step6Pass, step7Pass];
  const passedCount = allSteps.filter(Boolean).length;
  const percent = Math.round((passedCount / 7) * 100);

  const progressText = document.getElementById('coaching-progress-text');
  const progressBar = document.getElementById('coaching-progress-bar');

  if (progressText) {
    progressText.textContent = `7단계 중 ${passedCount}단계 구체화 완료 (${percent}%)`;
    progressText.className = passedCount === 7
      ? 'text-xs font-extrabold text-emerald-700 bg-emerald-100 px-2.5 py-1 rounded-full'
      : 'text-xs font-bold text-blue-600 bg-blue-50 px-2.5 py-1 rounded-full';
  }
  if (progressBar) {
    progressBar.style.width = `${percent}%`;
  }
}

function updateCharCounter(elId, len, minLen) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (len >= minLen) {
    el.textContent = `✅ ${len}자 (구체화 완료!)`;
    el.className = 'text-[11px] font-bold text-emerald-600';
  } else {
    el.textContent = `${len}자 / 권장 ${minLen}자 이상 (${minLen - len}자 더 적어보세요)`;
    el.className = 'text-[11px] font-bold text-orange-600';
  }
}

function toggleCoachingBox(boxId, pillId, showOrangeCoaching, isStepComplete) {
  const box = document.getElementById(boxId);
  const pill = document.getElementById(pillId);

  if (box) {
    box.classList.toggle('hidden', !showOrangeCoaching);
  }
  if (pill) {
    if (isStepComplete) {
      pill.textContent = '✅ 구체화 완료';
      pill.className = 'px-2.5 py-1 rounded-full text-xs font-extrabold bg-emerald-100 text-emerald-800 whitespace-nowrap';
    } else {
      pill.textContent = '💡 구체화 코칭 중';
      pill.className = 'px-2.5 py-1 rounded-full text-xs font-bold bg-orange-100 text-orange-800 whitespace-nowrap';
    }
  }
}

// B. [✨ 프롬프트 자동 변환하기]
function generatePrompts() {
  const student = findStudentById(state.currentStudentId);
  if (!student) return;

  normalizeCoreValuesHashtags();
  const inputs = getStudioFormInputs();
  if (!inputs.robotName) {
    showToast('1-1. 로봇 이름을 먼저 입력해 주세요!', 'warning');
    document.getElementById('input-robot-name')?.focus();
    return;
  }

  // 자동 변환 버튼 클릭 시 최신 1~7단계 입력 내용을 바탕으로 기본 영상 프롬프트 새로 생성
  inputs.customVideoPrompt = '';
  const customPrompt = String(inputs.customVideoPrompt || '').trim();
  const videoPrompt = customPrompt || buildPromptFromInputs(inputs);
  const specSheet = buildSpecSheetFromInputs(inputs);

  student.inputs = inputs;
  student.videoPrompt = videoPrompt;
  student.specSheet = specSheet;
  student.updatedAt = new Date().toISOString();

  closeVideoPromptEditorUI();

  saveStudentsToLocalStorage();
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
  syncStudentToCloud(student);

  renderGeneratedOutputs(videoPrompt, specSheet);

  const section = document.getElementById('generated-results-section');
  if (section) {
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  showToast('✨ AI 영상 프롬프트와 박람회 개조식 기획서가 생성되었습니다!', 'success');
}

function renderGeneratedOutputs(videoPrompt, specSheet) {
  const section = document.getElementById('generated-results-section');
  const promptEl = document.getElementById('output-video-prompt');
  const specContainer = document.getElementById('output-spec-sheet-container');

  if (!section || !promptEl || !specContainer) return;
  section.classList.remove('hidden');

  const student = findStudentById(state.currentStudentId);
  const effectivePrompt = String(student?.inputs?.customVideoPrompt || '').trim() || videoPrompt;

  promptEl.textContent = effectivePrompt;
  const customInput = document.getElementById('input-custom-video-prompt');
  if (customInput && document.activeElement !== customInput) {
    customInput.value = effectivePrompt;
  }
  specContainer.innerHTML = renderSpecSheetHtml(specSheet);
  updateStudentAiFeedbackButtonState();
}

function closeVideoPromptEditorUI() {
  const editorBox = document.getElementById('video-prompt-editor-box');
  const btn = document.getElementById('btn-edit-video-prompt');
  const label = document.getElementById('btn-edit-video-prompt-label');
  if (editorBox) editorBox.classList.add('hidden');
  if (btn) {
    btn.className =
      'w-full py-3 px-4 rounded-xl bg-amber-50 hover:bg-amber-100 text-amber-900 border-2 border-amber-300 font-extrabold text-sm transition flex items-center justify-center gap-2';
  }
  if (label) {
    label.textContent = '영상 프롬프트 수정하기';
  }
}

function toggleEditVideoPrompt() {
  const student = findStudentById(state.currentStudentId);
  if (!student) return;

  const editorBox = document.getElementById('video-prompt-editor-box');
  const customInput = document.getElementById('input-custom-video-prompt');
  const promptEl = document.getElementById('output-video-prompt');
  const btn = document.getElementById('btn-edit-video-prompt');
  const label = document.getElementById('btn-edit-video-prompt-label');
  if (!editorBox || !customInput || !promptEl) return;

  const isCurrentlyOpen = !editorBox.classList.contains('hidden');

  if (!isCurrentlyOpen) {
    const currentPrompt =
      String(student.inputs?.customVideoPrompt || '').trim() ||
      String(promptEl.textContent || '').trim() ||
      buildPromptFromInputs(student.inputs || {});

    customInput.value = currentPrompt;
    editorBox.classList.remove('hidden');
    if (btn) {
      btn.className =
        'w-full py-3 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white border-2 border-emerald-600 font-extrabold text-sm shadow-sm transition flex items-center justify-center gap-2';
    }
    if (label) {
      label.textContent = '영상 프롬프트 수정 완료';
    }
    customInput.focus();
  } else {
    handleCustomVideoPromptInput();
    closeVideoPromptEditorUI();
    showToast('✏️ 수정한 영상 프롬프트가 반영되었습니다! 이제 [영상 프롬프트 복사하기]를 누르면 수정본이 복사됩니다.', 'success');
  }
}

function handleCustomVideoPromptInput() {
  state.lastLocalStudentTypingAt = Date.now();
  const student = findStudentById(state.currentStudentId);
  if (!student) return;

  const customInput = document.getElementById('input-custom-video-prompt');
  const promptEl = document.getElementById('output-video-prompt');
  if (!customInput) return;

  const editedText = (customInput.value || '').trim();
  const defaultPrompt = buildPromptFromInputs(student.inputs || {});

  if (!student.inputs) student.inputs = {};

  if (editedText) {
    student.inputs.customVideoPrompt = editedText;
    student.videoPrompt = editedText;
    if (promptEl) promptEl.textContent = editedText;
  } else {
    student.inputs.customVideoPrompt = '';
    student.videoPrompt = defaultPrompt;
    if (promptEl) promptEl.textContent = defaultPrompt;
  }

  student.updatedAt = new Date().toISOString();
  saveStudentsToLocalStorage();

  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = null;
    syncStudentToCloud(student);
  }, AUTO_SYNC_DEBOUNCE_MS);
}

function resetCustomVideoPromptToDefault() {
  const student = findStudentById(state.currentStudentId);
  if (!student) return;

  const defaultPrompt = buildPromptFromInputs(student.inputs || {});
  if (!student.inputs) student.inputs = {};
  student.inputs.customVideoPrompt = '';
  student.videoPrompt = defaultPrompt;
  student.updatedAt = new Date().toISOString();

  const customInput = document.getElementById('input-custom-video-prompt');
  const promptEl = document.getElementById('output-video-prompt');
  if (customInput) customInput.value = defaultPrompt;
  if (promptEl) promptEl.textContent = defaultPrompt;

  saveStudentsToLocalStorage();
  syncStudentToCloud(student);
  showToast('🔄 원래 자동 변환된 기본 영상 프롬프트로 되돌렸습니다.', 'info');
}

function renderSpecSheetHtml(spec) {
  if (!spec) return '<p class="text-xs text-slate-400">아직 생성된 개조식 기획서가 없습니다.</p>';

  const valueTags = parseCoreValuesHashtags(spec.coreValues?.content || '');
  const valueBadgesHtml = valueTags.length > 0
    ? valueTags.map((tag) => `<span class="px-2.5 py-0.5 rounded-full bg-indigo-100 text-indigo-800 font-extrabold text-xs">${escapeHtml(tag)}</span>`).join(' ')
    : `<span class="text-slate-500">${escapeHtml(spec.coreValues?.content || '-')}</span>`;

  return `
    <div class="space-y-2.5 text-xs sm:text-sm">
      <!-- 1. 출품 로봇명 & 외형 -->
      <div class="bg-slate-50 rounded-2xl p-3.5 border border-slate-200">
        <div class="font-extrabold text-blue-900 mb-1.5 flex items-center justify-between">
          <span>${escapeHtml(spec.robotAndAppearance?.title || '🤖 출품 로봇명 & 외형')}</span>
          <span class="px-2 py-0.5 rounded bg-blue-600 text-white text-xs font-extrabold">${escapeHtml(spec.robotAndAppearance?.robotName || '-')}</span>
        </div>
        <ul class="list-disc list-inside text-slate-700 space-y-1 leading-relaxed">
          <li><strong>로봇명:</strong> ${escapeHtml(spec.robotAndAppearance?.robotName || '-')}</li>
          <li><strong>외형 및 기계 구조:</strong> ${escapeHtml(spec.robotAndAppearance?.appearance || '-')}</li>
        </ul>
      </div>

      <!-- 2. 개발 배경 및 목적 -->
      <div class="bg-slate-50 rounded-2xl p-3.5 border border-slate-200">
        <div class="font-extrabold text-blue-900 mb-1">${escapeHtml(spec.purpose?.title || '🎯 개발 배경 및 목적')}</div>
        <ul class="list-disc list-inside text-slate-700 leading-relaxed">
          <li>${escapeHtml(spec.purpose?.content || '-')}</li>
        </ul>
      </div>

      <!-- 3. 핵심 작동 기능 및 구조 -->
      <div class="bg-slate-50 rounded-2xl p-3.5 border border-slate-200">
        <div class="font-extrabold text-blue-900 mb-1">${escapeHtml(spec.mainFunction?.title || '⚙️ 핵심 작동 기능 및 구조')}</div>
        <ul class="list-disc list-inside text-slate-700 leading-relaxed">
          <li>${escapeHtml(spec.mainFunction?.content || '-')}</li>
        </ul>
      </div>

      <!-- 4. 스마트 감지 메커니즘 -->
      <div class="bg-indigo-50/70 rounded-2xl p-3.5 border border-indigo-200">
        <div class="font-extrabold text-indigo-950 mb-1.5">${escapeHtml(spec.sensorMechanism?.title || '📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)')}</div>
        <ul class="space-y-1 text-slate-700 leading-relaxed">
          <li>• <strong>탑재 센서명:</strong> <span class="font-semibold text-indigo-700">${escapeHtml(spec.sensorMechanism?.sensorName || '-')}</span></li>
          <li>• <strong>세부 감지 대상:</strong> ${escapeHtml(spec.sensorMechanism?.sensorTarget || '-')}</li>
          <li>• <strong>감지 후 작동 연동:</strong> ${escapeHtml(spec.sensorMechanism?.sensorAction || '-')}</li>
        </ul>
      </div>

      <!-- 5. 적용 융합 과학기술 -->
      <div class="bg-slate-50 rounded-2xl p-3.5 border border-slate-200">
        <div class="font-extrabold text-blue-900 mb-1">${escapeHtml(spec.scienceTech?.title || '🔬 적용 융합 과학기술')}</div>
        <ul class="list-disc list-inside text-slate-700 leading-relaxed">
          <li>${escapeHtml(spec.scienceTech?.content || '-')}</li>
        </ul>
      </div>

      <!-- 6. 추구하는 핵심 가치 & 7. 영상 연출 스타일 -->
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        <div class="bg-slate-50 rounded-2xl p-3.5 border border-slate-200">
          <div class="font-extrabold text-blue-900 mb-1.5">${escapeHtml(spec.coreValues?.title || '💎 추구하는 핵심 가치')}</div>
          <div class="flex flex-wrap gap-1.5">${valueBadgesHtml}</div>
        </div>
        <div class="bg-slate-50 rounded-2xl p-3.5 border border-slate-200">
          <div class="font-extrabold text-blue-900 mb-1">${escapeHtml(spec.videoStyle?.title || '🎨 영상 연출 스타일')}</div>
          <div class="text-slate-700 font-medium leading-snug">${escapeHtml(spec.videoStyle?.content || '-')}</div>
        </div>
      </div>
    </div>
  `;
}

// [📋 영상 프롬프트 복사하기]
async function copyVideoPrompt(customPromptText) {
  let textToCopy = customPromptText || '';

  if (!textToCopy) {
    const editorBox = document.getElementById('video-prompt-editor-box');
    const customInput = document.getElementById('input-custom-video-prompt');
    const student = findStudentById(state.currentStudentId);

    // 수정 입력창이 열려 있으면 현재 입력창의 값을 즉시 반영하여 복사
    if (editorBox && !editorBox.classList.contains('hidden') && customInput) {
      handleCustomVideoPromptInput();
      textToCopy = (customInput.value || '').trim();
    }

    // 학생이 프롬프트를 수정한 적이 있으면 수정된 프롬프트 복사, 수정하지 않았으면 원래 프롬프트 복사
    if (!textToCopy && student?.inputs?.customVideoPrompt) {
      textToCopy = String(student.inputs.customVideoPrompt).trim();
    }
    if (!textToCopy) {
      textToCopy = (document.getElementById('output-video-prompt')?.textContent || '').trim();
    }
  }

  if (!textToCopy.trim()) {
    showToast('복사할 프롬프트가 없습니다. 먼저 프롬프트를 변환해 주세요!', 'warning');
    return;
  }

  try {
    await navigator.clipboard.writeText(textToCopy);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = textToCopy;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }

  const btn = document.getElementById('btn-copy-video-prompt');
  if (btn && !customPromptText) {
    const orig = btn.innerHTML;
    btn.innerHTML = '<span>✅</span><span>클립보드에 복사 완료!</span>';
    setTimeout(() => {
      btn.innerHTML = orig;
    }, 2200);
  }
  showToast('📋 AI 영상 프롬프트가 클립보드에 복사되었습니다!', 'success');
}

// ============================================================================
// 7-2. [🤖 AI에게 피드백 받기] (학생 1~5번 하단 개별 표시 · 하루 최대 3회 제한 · 무료 한도 초과 시 전체 차단)
// ============================================================================
function getLocalStudentAiDailyMap() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.STUDENT_AI_DAILY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch {
    // ignore
  }
  return {};
}

function saveLocalStudentAiDailyCount(studentName, dateStr, count) {
  try {
    const map = getLocalStudentAiDailyMap();
    map[studentName] = { date: dateStr, count: Number(count) || 0 };
    localStorage.setItem(STORAGE_KEYS.STUDENT_AI_DAILY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

function getStudentDailyAiCount(student) {
  if (!student) return 0;
  const todayStr = getKstDateString();
  const nameKey = String(student.studentName || student.studentId || '').trim();
  const localMap = getLocalStudentAiDailyMap();
  const localCount = localMap[nameKey]?.date === todayStr ? Number(localMap[nameKey].count) || 0 : 0;
  const studentCount =
    student.inputs?.aiFeedback?.date === todayStr ? Number(student.inputs.aiFeedback.count) || 0 : 0;
  return Math.max(localCount, studentCount);
}

function terminateAllAiFeedbackFeatures() {
  const todayStr = getKstDateString();
  state.aiQuotaExhausted = true;
  localStorage.setItem(STORAGE_KEYS.AI_QUOTA_EXHAUSTED, todayStr);
  updateStudentAiFeedbackButtonState();
  updateTeacherAiFeedbackButtonState();
  showToast('더 이상 AI 피드백을 받을 수 없습니다.', 'error');
}

function updateStudentAiFeedbackButtonState(studentArg) {
  const btn = document.getElementById('btn-student-ai-feedback');
  const labelEl = document.getElementById('btn-student-ai-feedback-label');
  const badgeEl = document.getElementById('student-ai-feedback-count-badge');
  const helperEl = document.getElementById('student-ai-feedback-helper');
  if (!btn) return;

  if (state.aiQuotaExhausted) {
    btn.disabled = true;
    btn.className =
      'w-full py-3.5 px-5 rounded-xl bg-slate-300 text-slate-600 font-extrabold text-sm sm:text-base cursor-not-allowed flex items-center justify-center gap-2';
    if (labelEl) labelEl.textContent = '더 이상 AI 피드백을 받을 수 없습니다.';
    if (badgeEl) badgeEl.classList.add('hidden');
    if (helperEl) {
      helperEl.textContent = '더 이상 AI 피드백을 받을 수 없습니다.';
      helperEl.className = 'text-[11px] text-center text-rose-600 font-bold';
    }
    return;
  }

  const student = studentArg || findStudentById(state.currentStudentId);
  const usedCount = getStudentDailyAiCount(student);
  const remaining = Math.max(0, MAX_STUDENT_DAILY_AI_FEEDBACK - usedCount);

  if (usedCount >= MAX_STUDENT_DAILY_AI_FEEDBACK) {
    btn.disabled = true;
    btn.className =
      'w-full py-3.5 px-5 rounded-xl bg-slate-200 text-slate-500 font-extrabold text-sm sm:text-base cursor-not-allowed flex items-center justify-center gap-2';
    if (labelEl) labelEl.textContent = 'AI에게 피드백 받기 (오늘 횟수 소진)';
    if (badgeEl) {
      badgeEl.classList.remove('hidden');
      badgeEl.textContent = `(오늘 ${usedCount}/${MAX_STUDENT_DAILY_AI_FEEDBACK}회 완료)`;
      badgeEl.className = 'px-2 py-0.5 rounded-full text-xs font-extrabold bg-slate-300 text-slate-700';
    }
    if (helperEl) {
      helperEl.textContent = '오늘의 AI 피드백 받기 횟수(하루 최대 3번)를 모두 사용했어요! 위 1~5번 칸 아래의 AI 피드백을 보며 수정해 보세요.';
      helperEl.className = 'text-[11px] text-center text-slate-500 font-semibold';
    }
    return;
  }

  btn.disabled = Boolean(state.isRequestingAiFeedback);
  btn.className =
    'w-full py-3.5 px-5 rounded-xl bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-700 hover:to-indigo-700 text-white font-extrabold text-sm sm:text-base shadow-lg shadow-violet-500/25 transition flex items-center justify-center gap-2';
  if (labelEl) {
    labelEl.textContent = state.isRequestingAiFeedback ? 'AI 선생님이 1~5번 내용을 살펴보는 중...' : 'AI에게 피드백 받기';
  }
  if (badgeEl) {
    badgeEl.classList.remove('hidden');
    badgeEl.textContent = `(오늘 남은 횟수: ${remaining}/${MAX_STUDENT_DAILY_AI_FEEDBACK}회)`;
    badgeEl.className = 'px-2 py-0.5 rounded-full text-xs font-extrabold bg-white/20 text-white';
  }
  if (helperEl) {
    helperEl.textContent = '버튼을 누르면 내가 작성한 1~5번 입력칸 바로 아래에 AI의 피드백이 나타납니다(하루 최대 3번)';
    helperEl.className = 'text-[11px] text-center text-violet-700 font-semibold';
  }
}

function renderStudentAiFeedbackBoxes(studentArg) {
  const student = studentArg || findStudentById(state.currentStudentId);
  const fb = student?.inputs?.aiFeedback || null;

  const stepMeta = [
    { num: 1, key: 'step1', title: '🤖 [1단계 AI 피드백] 로봇 이름 & 외형 특징 보완점' },
    { num: 2, key: 'step2', title: '🤖 [2단계 AI 피드백] 제작 목적 & 과학적 배경 보완점' },
    { num: 3, key: 'step3', title: '🤖 [3단계 AI 피드백] 주요 기능 & 로봇 공학 장치 보완점' },
    { num: 4, key: 'step4', title: '🤖 [4단계 AI 피드백] 감지 센서 & 작동 연결 보완점' },
    { num: 5, key: 'step5', title: '🤖 [5단계 AI 피드백] 적용된 과학·공학 기술 보완점' },
  ];

  stepMeta.forEach(({ num, key, title }) => {
    const boxEl = document.getElementById(`ai-feedback-step-${num}`);
    if (!boxEl) return;
    const textVal = fb && fb[key] ? String(fb[key]).trim() : '';
    if (!textVal) {
      boxEl.classList.add('hidden');
      boxEl.innerHTML = '';
      return;
    }
    boxEl.classList.remove('hidden');
    boxEl.innerHTML = `
      <div class="flex items-start gap-2.5">
        <span class="w-7 h-7 rounded-xl bg-violet-600 text-white flex items-center justify-center text-sm shrink-0 shadow-sm">🤖</span>
        <div class="space-y-1 flex-1">
          <div class="font-extrabold text-violet-900 text-xs sm:text-sm flex items-center justify-between">
            <span>${escapeHtml(title)}</span>
            <span class="text-[11px] font-bold text-violet-600 bg-violet-100 px-2 py-0.5 rounded-full">AI 멘토 코칭</span>
          </div>
          <p class="text-slate-800 font-medium leading-relaxed whitespace-pre-line">${escapeHtml(textVal)}</p>
        </div>
      </div>
    `;
  });
}

async function requestStudentAiFeedback() {
  if (state.aiQuotaExhausted) {
    terminateAllAiFeedbackFeatures();
    return;
  }

  const student = findStudentById(state.currentStudentId);
  if (!student) return;

  const usedCount = getStudentDailyAiCount(student);
  if (usedCount >= MAX_STUDENT_DAILY_AI_FEEDBACK) {
    updateStudentAiFeedbackButtonState(student);
    showToast('오늘의 AI 피드백 받기 횟수(하루 최대 3번)를 모두 사용했어요!', 'warning');
    return;
  }

  const inputs = getStudioFormInputs();
  if (!inputs.robotName) {
    showToast('1-1. 로봇 이름을 먼저 입력해 주세요!', 'warning');
    document.getElementById('input-robot-name')?.focus();
    return;
  }

  if (state.isRequestingAiFeedback) return;
  state.isRequestingAiFeedback = true;
  updateStudentAiFeedbackButtonState(student);

  try {
    const response = await fetch('/.netlify/functions/ai-feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'student',
        studentId: student.studentId,
        studentName: student.studentName,
        inputs: {
          robotName: inputs.robotName,
          appearance: inputs.appearance,
          purpose: inputs.purpose,
          mainFunction: inputs.mainFunction,
          sensorName: inputs.sensorName,
          sensorTarget: inputs.sensorTarget,
          sensorAction: inputs.sensorAction,
          scienceTech: inputs.scienceTech,
        },
      }),
    });

    const data = await response.json().catch(() => ({}));

    if (data && data.quotaExhausted) {
      terminateAllAiFeedbackFeatures();
      return;
    }

    if (data && data.studentLimitReached) {
      const todayStr = getKstDateString();
      saveLocalStudentAiDailyCount(student.studentName, todayStr, MAX_STUDENT_DAILY_AI_FEEDBACK);
      if (!student.inputs) student.inputs = {};
      student.inputs.aiFeedback = {
        ...(student.inputs.aiFeedback || {}),
        date: todayStr,
        count: MAX_STUDENT_DAILY_AI_FEEDBACK,
      };
      saveStudentsToLocalStorage();
      updateStudentAiFeedbackButtonState(student);
      showToast(data.message || '오늘의 AI 피드백 받기 횟수(하루 최대 3번)를 모두 사용했어요!', 'warning');
      return;
    }

    if (!response.ok || !data || !data.ok || !data.feedback) {
      throw new Error(data?.error || 'AI 피드백 서버와 연결할 수 없습니다.');
    }

    const todayStr = data.date || getKstDateString();
    const newCount = Math.max(usedCount + 1, Number(data.usedCount) || usedCount + 1);

    saveLocalStudentAiDailyCount(student.studentName, todayStr, newCount);

    student.inputs = {
      ...inputs,
      aiFeedback: {
        date: todayStr,
        count: newCount,
        step1: data.feedback.step1 || '',
        step2: data.feedback.step2 || '',
        step3: data.feedback.step3 || '',
        step4: data.feedback.step4 || '',
        step5: data.feedback.step5 || '',
        updatedAt: new Date().toISOString(),
      },
    };
    student.updatedAt = new Date().toISOString();

    saveStudentsToLocalStorage();
    syncStudentToCloud(student);

    renderStudentAiFeedbackBoxes(student);

    if (data.quotaExhausted) {
      terminateAllAiFeedbackFeatures();
      return;
    }

    const firstBox = document.getElementById('ai-feedback-step-1');
    if (firstBox) {
      firstBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    showToast(
      `🤖 1~5번 각 입력칸 바로 아래에 AI 선생님의 맞춤 피드백이 도착했어요! (오늘 ${newCount}/${MAX_STUDENT_DAILY_AI_FEEDBACK}회 사용)`,
      'success'
    );
  } catch (err) {
    showToast(err.message || 'AI 피드백을 불러오는 중 오류가 발생했습니다.', 'error');
  } finally {
    state.isRequestingAiFeedback = false;
    updateStudentAiFeedbackButtonState(student);
  }
}

// [📩 선생님께 제출]
function submitToExpoAndTeacher() {
  const student = findStudentById(state.currentStudentId);
  if (!student) return;

  normalizeCoreValuesHashtags();
  const inputs = getStudioFormInputs();
  if (!inputs.robotName) {
    showToast('1-1. 로봇 이름을 입력해야 제출할 수 있어요!', 'warning');
    document.getElementById('input-robot-name')?.focus();
    return;
  }

  const valueTags = parseCoreValuesHashtags(inputs.coreValues);
  if (valueTags.length < 2) {
    showToast('6. 추구하는 가치를 해시태그(#) 단어 2가지 이상 입력해 주세요!', 'warning');
    document.getElementById('input-core-values')?.focus();
    return;
  }

  if (!inputs.videoStyle) {
    showToast('7. 영상 스타일을 선택해 주세요!', 'warning');
    document.getElementById('input-video-style')?.focus();
    return;
  }

  const customPrompt = String(inputs.customVideoPrompt || '').trim();
  const videoPrompt = customPrompt || buildPromptFromInputs(inputs);
  const specSheet = buildSpecSheetFromInputs(inputs);

  const nextVersionNum = (Number(student.currentVersion) || 0) + 1;
  const versionLabel = nextVersionNum === 1
    ? '버전 1 (최초 제출)'
    : `버전 ${nextVersionNum} (${nextVersionNum - 1}차 수정)`;

  const nowIso = new Date().toISOString();
  const newVersionEntry = {
    version: nextVersionNum,
    label: versionLabel,
    submittedAt: nowIso,
    inputs: JSON.parse(JSON.stringify(inputs)),
    videoPrompt,
    specSheet: JSON.parse(JSON.stringify(specSheet)),
    teacherFeedbackBefore: student.teacherFeedback || '',
  };

  if (!Array.isArray(student.history)) {
    student.history = [];
  }
  student.history.push(newVersionEntry);
  student.currentVersion = nextVersionNum;
  student.inputs = inputs;
  student.videoPrompt = videoPrompt;
  student.specSheet = specSheet;
  student.status = 'submitted';
  student.updatedAt = nowIso;

  saveStudentsToLocalStorage();
  syncStudentToCloud(student, newVersionEntry);
  refreshAllViews(false);

  showToast(`🎉 [${versionLabel}] 제출 완료! 선생님께서 [전시 승인]하시면 박람회 전시관에 부스가 공개됩니다.`, 'success');
}

function openCurrentStudentHistoryModal() {
  if (!state.currentStudentId) return;
  openHistoryCompareModal(state.currentStudentId);
}

// ============================================================================
// 8. [탭 2] 🏛️ 미래 로봇 박람회 전시관 (전시 승인된 부스만 표시, 영상 첨부, 상세 모달)
// ============================================================================
function getExpoEligibleStudents() {
  return state.students.filter((s) => s.status === 'approved');
}

let lastExpoRenderSignature = '';
const inMemoryVideoThumbnails = {};
const attemptedVideoThumbnails = new Set();

function renderExpoBooths(forceRender = false) {
  const grid = document.getElementById('expo-booth-grid');
  if (!grid) return;

  const allBooths = getExpoEligibleStudents();
  const hasVideoCount = allBooths.filter((s) => s.video && s.video.type && s.video.type !== 'none').length;

  const statTotal = document.getElementById('expo-stat-total');
  const statVideo = document.getElementById('expo-stat-video');
  if (statTotal) statTotal.textContent = String(allBooths.length);
  if (statVideo) statVideo.textContent = String(hasVideoCount);

  const query = (document.getElementById('expo-search-input')?.value || '').trim().toLowerCase();

  const filtered = allBooths.filter((s) => {
    if (query) {
      const hay = `${s.studentName} ${s.inputs?.robotName || ''} ${s.inputs?.purpose || ''} ${s.inputs?.coreValues || ''}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    return true;
  });

  // 백그라운드 동기화 시 전시관 데이터가 변경되지 않았다면 불필요한 DOM 재생성 및 이미지 재로드를 원천 차단
  const currentSig = JSON.stringify({
    unlocked: Boolean(state.teacherUnlocked),
    q: query,
    items: filtered.map((s) => [
      s.studentId,
      s.updatedAt,
      s.status,
      getBoothLikesCount(s),
      s.video?.type || 'none',
      s.video?.url || '',
      (s.video?.thumbnail || inMemoryVideoThumbnails[s.studentId] || '').slice(0, 64),
    ]),
  });

  if (!forceRender && currentSig === lastExpoRenderSignature && grid.children.length > 0) {
    return;
  }
  lastExpoRenderSignature = currentSig;

  if (filtered.length === 0) {
    grid.innerHTML = `
      <div class="col-span-full bg-white rounded-3xl p-12 text-center border border-slate-200">
        <div class="text-4xl mb-3">🏛️</div>
        <h3 class="text-base font-extrabold text-slate-800">현재 전시 승인된 로봇 박람회 부스가 없습니다</h3>
        <p class="text-xs text-slate-500 mt-1">[탭 1: 로봇 설계실]에서 제출한 뒤 선생님의 [전시 승인]을 받으면 이곳에 부스가 전시됩니다.</p>
      </div>
    `;
    return;
  }

  grid.innerHTML = filtered.map((student, idx) => {
    const boothNum = String(idx + 1).padStart(2, '0');
    const meta = STATUS_META[student.status] || STATUS_META.submitted;
    const hasVideo = student.video && student.video.type && student.video.type !== 'none';
    const robotName = student.inputs?.robotName || '출품 로봇';
    const spec = student.specSheet || buildSpecSheetFromInputs(student.inputs || {});
    const valueTags = parseCoreValuesHashtags(student.inputs?.coreValues || spec.coreValues?.content || '');

    return `
      <article class="booth-card bg-white rounded-3xl border border-slate-200/90 shadow-sm overflow-hidden flex flex-col justify-between">
        <div>
          <!-- 부스 상단 영상/홀로그램 썸네일 영역 (상세 관람 버튼만 표시) -->
          <div
            onclick="openBoothDetailModal('${escapeHtml(student.studentId)}')"
            class="relative aspect-video bg-slate-950 cursor-pointer overflow-hidden group"
          >
            ${renderBoothCardThumbnail(student)}

            <div class="absolute bottom-3 right-3 pointer-events-none">
              <span class="px-2.5 py-1 rounded-lg bg-white/90 text-slate-900 font-extrabold text-[11px] group-hover:bg-blue-600 group-hover:text-white transition shadow">
                상세 관람 →
              </span>
            </div>
          </div>

          <!-- 부스 본문: 개조식 로봇 기획서 핵심 요약 -->
          <div class="p-5 space-y-3" onclick="openBoothDetailModal('${escapeHtml(student.studentId)}')" role="button">
            <div>
              <span class="text-xs font-bold text-blue-600">🧑‍🔬 ${escapeHtml(student.studentName)} 연구원</span>
              <h3 class="text-lg font-extrabold text-slate-900 leading-snug mt-0.5">${escapeHtml(robotName)}</h3>
            </div>

            ${valueTags.length > 0 ? `
              <div class="flex flex-wrap gap-1">
                ${valueTags.map((t) => `<span class="px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 font-bold text-[11px]">${escapeHtml(t)}</span>`).join('')}
              </div>
            ` : ''}

            <div class="bg-slate-50 rounded-2xl p-3.5 border border-slate-200/80 space-y-2 text-xs">
              <div class="flex items-start gap-2">
                <span class="shrink-0">🎯</span>
                <p class="text-slate-700 line-clamp-2"><strong class="text-slate-900">목적:</strong> ${escapeHtml(spec.purpose?.content || '-')}</p>
              </div>
              <div class="flex items-start gap-2">
                <span class="shrink-0">⚙️</span>
                <p class="text-slate-700 line-clamp-2"><strong class="text-slate-900">핵심기능:</strong> ${escapeHtml(spec.mainFunction?.content || '-')}</p>
              </div>
              <div class="flex items-start gap-2">
                <span class="shrink-0">📡</span>
                <p class="text-slate-700 line-clamp-1"><strong class="text-slate-900">감지센서:</strong> ${escapeHtml(spec.sensorMechanism?.sensorName || '-')}</p>
              </div>
              <div class="flex items-start gap-2">
                <span class="shrink-0">🔬</span>
                <p class="text-slate-700 line-clamp-1"><strong class="text-slate-900">융합기술:</strong> ${escapeHtml(spec.scienceTech?.content || '-')}</p>
              </div>
            </div>
          </div>
        </div>

        <!-- 부스 하단 버튼 영역: 영상 첨부하기 & 응원하기 (+ 관리자 잠금 해제 시 수정/삭제 버튼 표시) -->
        <div class="px-5 pb-5 pt-1 space-y-2">
          <div class="flex items-center gap-2">
            <button
              type="button"
              onclick="openVideoAttachModal('${escapeHtml(student.studentId)}')"
              class="flex-1 py-2.5 px-3 rounded-xl text-xs font-extrabold ${hasVideo ? 'bg-slate-100 hover:bg-slate-200 text-slate-700' : 'bg-blue-600 hover:bg-blue-700 text-white shadow-sm'} transition flex items-center justify-center gap-1.5"
            >
              <span>🎥</span>
              <span>${hasVideo ? '로봇 소개 영상 변경하기' : '로봇 소개 영상 첨부하기'}</span>
            </button>

            <div
              class="py-2.5 px-3.5 rounded-xl text-xs font-extrabold bg-rose-50 text-rose-600 border border-rose-200 flex items-center gap-1 select-none"
              title="받은 하트 수 (댓글 수와 동일 · 상세 관람에서 20자 이상 응원 댓글 작성 시 하트 추가)"
            >
              <span>❤️</span>
              <span>${getBoothLikesCount(student)}</span>
            </div>
          </div>

          ${state.teacherUnlocked ? `
            <div class="flex items-center gap-2 pt-1.5 border-t border-slate-100">
              <button
                type="button"
                onclick="openAdminEditStudentModal('${escapeHtml(student.studentId)}')"
                class="flex-1 py-2 px-3 rounded-xl text-xs font-bold bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-200 transition flex items-center justify-center gap-1"
              >
                <span>✏️</span>
                <span>관리자 수정</span>
              </button>
              <button
                type="button"
                onclick="deleteStudentByAdmin('${escapeHtml(student.studentId)}')"
                class="py-2 px-3 rounded-xl text-xs font-bold bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 transition flex items-center justify-center gap-1"
              >
                <span>🗑️</span>
                <span>부스 삭제</span>
              </button>
            </div>
          ` : ''}
        </div>
      </article>
    `;
  }).join('');
}

function getYouTubeThumbnailUrl(url) {
  if (!url) return '';
  const regExp = /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
  const match = String(url).match(regExp);
  return match ? `https://img.youtube.com/vi/${match[1]}/hqdefault.jpg` : '';
}

function resolveBoothThumbnailImageSrc(student) {
  if (!student || !student.video || !student.video.type || student.video.type === 'none') {
    return '';
  }
  const savedThumb = String(student.video.thumbnail || '').trim();
  if (savedThumb && (savedThumb.startsWith('data:image/') || savedThumb.startsWith('https://'))) {
    return savedThumb;
  }
  const memThumb = inMemoryVideoThumbnails[student.studentId];
  if (memThumb) return memThumb;

  if (student.video.type === 'url' && student.video.url) {
    const ytThumb = getYouTubeThumbnailUrl(student.video.url);
    if (ytThumb) return ytThumb;
  }
  return '';
}

// 부스 미리보기 카드: 동영상 자동 재생(<video>)을 절대 사용하지 않고 정적 썸네일 사진(<img> 또는 포스터)만 표시하여 Cached Egress 원천 차단
function renderBoothCardThumbnail(student) {
  const hasVideo = Boolean(student.video && student.video.type && student.video.type !== 'none');
  const robotEmoji = pickRobotEmoji(student.inputs);
  const robotName = student.inputs?.robotName || 'FUTURE ROBOT';
  const thumbSrc = resolveBoothThumbnailImageSrc(student);

  // 영상은 있으나 아직 썸네일 사진이 추출되지 않은 경우 1회에 한해 첫 프레임 캡처 예약
  if (hasVideo && !thumbSrc) {
    scheduleVideoThumbnailCapture(student);
  }

  if (thumbSrc) {
    return `
      <div class="w-full h-full relative bg-slate-950 overflow-hidden">
        <img
          src="${escapeHtml(thumbSrc)}"
          alt="${escapeHtml(robotName)} 썸네일"
          loading="lazy"
          class="w-full h-full object-cover opacity-95 group-hover:scale-105 transition duration-500"
        />
        <div class="absolute inset-0 bg-gradient-to-t from-slate-950/60 via-transparent to-transparent pointer-events-none"></div>
        <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div class="w-11 h-11 rounded-full bg-slate-950/65 border border-white/40 text-white flex items-center justify-center shadow-lg group-hover:scale-110 group-hover:bg-blue-600/85 transition">
            <span class="text-sm ml-0.5">▶</span>
          </div>
        </div>
      </div>
    `;
  }

  return `
    <div class="w-full h-full bg-gradient-to-br from-slate-900 via-indigo-950 to-blue-950 holo-scanline flex flex-col items-center justify-center p-4 text-center relative">
      <div class="w-16 h-16 rounded-full bg-cyan-400/15 border border-cyan-400/40 flex items-center justify-center text-4xl animate-float-robot shadow-lg shadow-cyan-500/20">
        ${robotEmoji}
      </div>
      <div class="text-xs font-extrabold text-cyan-300 mt-2 tracking-wide truncate max-w-[85%]">
        ${escapeHtml(robotName)}
      </div>
      <div class="text-[10px] text-slate-400 mt-0.5 truncate max-w-[80%]">
        📡 ${escapeHtml(student.inputs?.sensorName || 'AI Sensor System')}
      </div>
      ${
        hasVideo
          ? `<div class="mt-1.5 px-2 py-0.5 rounded-full bg-blue-500/25 border border-blue-400/40 text-[10px] font-bold text-blue-200">🎬 소개 영상 등록됨</div>`
          : ''
      }
    </div>
  `;
}

function pickRobotEmoji(inputs = {}) {
  const text = `${inputs.robotName || ''} ${inputs.purpose || ''} ${inputs.appearance || ''}`;
  if (text.includes('바다') || text.includes('해양') || text.includes('수중') || text.includes('아쿠아')) return '🐬';
  if (text.includes('산불') || text.includes('소방') || text.includes('화재') || text.includes('파이어')) return '🚒';
  if (text.includes('노인') || text.includes('응급') || text.includes('돌봄') || text.includes('의료')) return '🩺';
  if (text.includes('우주') || text.includes('위성')) return '🛰️';
  if (text.includes('대기') || text.includes('공기') || text.includes('드론')) return '🛸';
  return '🤖';
}

function getOrCreateViewerToken() {
  try {
    let token = localStorage.getItem(STORAGE_KEYS.VIEWER_TOKEN);
    if (!token) {
      token = `vt_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(STORAGE_KEYS.VIEWER_TOKEN, token);
    }
    return token;
  } catch {
    return 'vt_fallback_session';
  }
}

function getCurrentCommentAuthorName() {
  const loggedIn = String(state.currentStudentId || localStorage.getItem(STORAGE_KEYS.CURRENT_STUDENT) || '').trim();
  if (loggedIn) return loggedIn;
  const lastTyped = String(localStorage.getItem(STORAGE_KEYS.LAST_TYPED_NAME) || '').trim();
  if (lastTyped) return lastTyped;
  return '관람 학생';
}

// 자신이 작성한 댓글인지 엄격히 판별 (다른 사람의 댓글은 절대 수정·삭제 불가)
function isMyBoothComment(comment) {
  if (!comment || typeof comment !== 'object') return false;
  const currentStudent = String(state.currentStudentId || localStorage.getItem(STORAGE_KEYS.CURRENT_STUDENT) || '').trim();
  const myToken = getOrCreateViewerToken();

  if (currentStudent) {
    if (comment.authorStudentId) {
      return String(comment.authorStudentId).trim() === currentStudent;
    }
    return String(comment.author || '').trim() === currentStudent && comment.viewerToken === myToken;
  }

  return Boolean(!comment.authorStudentId && comment.viewerToken && comment.viewerToken === myToken);
}

// 댓글 개수 = 하트 개수이므로, 현재 관람자가 이 부스에 남긴 댓글이 있으면 이미 하트를 누른 상태
function hasUserLikedBooth(student) {
  if (!student) return false;
  const comments = getBoothComments(student);
  return comments.some((c) => isMyBoothComment(c));
}

function updateBoothCommentCharCount() {
  const inputEl = document.getElementById('modal-booth-like-comment-input');
  const countEl = document.getElementById('modal-booth-comment-char-count');
  if (!inputEl || !countEl) return;

  if (inputEl.disabled) {
    countEl.textContent = '';
    countEl.className = 'hidden';
    return;
  }

  const len = (inputEl.value || '').trim().length;
  if (len >= MIN_BOOTH_COMMENT_LENGTH) {
    countEl.textContent = `✅ ${len}자 (작성 완료! 지금 하트를 누를 수 있어요)`;
    countEl.className = 'font-bold text-emerald-600';
  } else {
    countEl.textContent = `${len}자 / 최소 ${MIN_BOOTH_COMMENT_LENGTH}자 이상 작성해 주세요 (${MIN_BOOTH_COMMENT_LENGTH - len}자 더 필요)`;
    countEl.className = 'font-bold text-rose-600';
  }
}

function renderBoothLikeAndComments(student, resetInput = false) {
  if (!student) return;
  const countBadge = document.getElementById('modal-booth-like-count-badge');
  const inputEl = document.getElementById('modal-booth-like-comment-input');
  const btnEl = document.getElementById('modal-btn-like-booth');
  const btnLabelEl = document.getElementById('modal-btn-like-booth-label');
  const listEl = document.getElementById('modal-booth-comments-list');

  const comments = getBoothComments(student);
  student.likes = comments.length;
  const likeCount = comments.length;

  if (countBadge) {
    countBadge.textContent = `❤️ ${likeCount}`;
  }

  const alreadyLiked = hasUserLikedBooth(student);
  if (inputEl) {
    if (alreadyLiked) {
      inputEl.value = '';
      inputEl.disabled = true;
      inputEl.placeholder = '이미 이 작품에 응원 댓글과 하트를 남겼어요!';
      inputEl.className =
        'flex-1 px-3.5 py-2.5 rounded-xl border border-slate-200 bg-slate-100 text-slate-500 outline-none text-xs sm:text-sm cursor-not-allowed';
    } else {
      inputEl.disabled = false;
      if (resetInput) inputEl.value = '';
      inputEl.placeholder = '어떤 점이 좋았는지 최소 20자 이상 작성해야 하트를 누를 수 있어요!';
      inputEl.className =
        'flex-1 px-3.5 py-2.5 rounded-xl border border-rose-200 focus:border-rose-500 outline-none text-xs sm:text-sm bg-white';
    }
  }

  if (btnEl) {
    if (alreadyLiked) {
      btnEl.disabled = true;
      btnEl.className =
        'px-4 py-2.5 rounded-xl text-xs font-extrabold bg-slate-200 text-slate-500 cursor-not-allowed flex items-center justify-center gap-1.5 shrink-0';
      if (btnLabelEl) btnLabelEl.textContent = '하트 완료';
    } else {
      btnEl.disabled = false;
      btnEl.className =
        'px-4 py-2.5 rounded-xl text-xs font-extrabold bg-rose-600 hover:bg-rose-700 text-white shadow-sm transition flex items-center justify-center gap-1.5 shrink-0';
      if (btnLabelEl) btnLabelEl.textContent = '하트 누르기';
    }
  }

  updateBoothCommentCharCount();

  if (listEl) {
    if (comments.length === 0) {
      listEl.innerHTML = `
        <div class="bg-white/80 rounded-xl p-3 border border-rose-100 text-center text-xs text-slate-400">
          아직 등록된 응원 댓글이 없어요. 어떤 점이 좋았는지 20자 이상 작성하고 첫 번째 ❤️ 하트를 눌러보세요!
        </div>
      `;
    } else {
      const reversed = [...comments].reverse();
      listEl.innerHTML = reversed
        .map((c) => {
          const isMine = isMyBoothComment(c);
          const isEditing = isMine && state.editingBoothCommentId === c.id;
          const safeId = escapeHtml(c.id || '');

          if (isEditing) {
            const currentLen = (c.text || '').trim().length;
            return `
              <div class="bg-white rounded-xl p-3 border-2 border-rose-400 shadow-sm space-y-2">
                <div class="flex items-center justify-between text-[11px]">
                  <span class="font-extrabold text-rose-700 flex items-center gap-1">
                    <span>✏️</span>
                    <span>내 응원 댓글 수정 중 (${escapeHtml(c.author || '관람 학생')})</span>
                  </span>
                  <span id="edit-comment-char-${safeId}" class="font-bold text-emerald-600">${currentLen}자 / 최소 20자</span>
                </div>
                <textarea
                  id="edit-comment-input-${safeId}"
                  rows="2"
                  maxlength="200"
                  oninput="updateEditBoothCommentCharCount('${safeId}')"
                  class="w-full px-3 py-2 rounded-lg border border-rose-300 focus:border-rose-500 outline-none text-xs text-slate-800 leading-relaxed"
                >${escapeHtml(c.text || '')}</textarea>
                <div class="flex items-center justify-end gap-1.5">
                  <button
                    type="button"
                    onclick="cancelEditBoothComment()"
                    class="px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-100 hover:bg-slate-200 text-slate-600 transition"
                  >
                    취소
                  </button>
                  <button
                    type="button"
                    onclick="saveEditedBoothComment('${safeId}')"
                    class="px-3 py-1.5 rounded-lg text-xs font-extrabold bg-rose-600 hover:bg-rose-700 text-white transition"
                  >
                    수정 저장
                  </button>
                </div>
              </div>
            `;
          }

          return `
            <div class="bg-white rounded-xl p-3 border border-rose-100 shadow-sm space-y-1.5">
              <div class="flex items-center justify-between text-[11px] gap-2">
                <div class="flex items-center gap-1.5">
                  <span class="font-extrabold text-slate-800 flex items-center gap-1">
                    <span>❤️</span>
                    <span>${escapeHtml(c.author || '관람 학생')}</span>
                  </span>
                  ${isMine ? '<span class="px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 font-extrabold text-[10px]">내 댓글</span>' : ''}
                </div>
                <div class="flex items-center gap-2">
                  <span class="text-slate-400 font-medium">${formatDateTime(c.updatedAt || c.createdAt)}</span>
                  ${
                    isMine
                      ? `
                    <div class="flex items-center gap-1">
                      <button
                        type="button"
                        onclick="startEditBoothComment('${safeId}')"
                        class="px-2 py-0.5 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-[11px] transition"
                      >
                        수정
                      </button>
                      <button
                        type="button"
                        onclick="deleteBoothComment('${safeId}')"
                        class="px-2 py-0.5 rounded bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 font-bold text-[11px] transition"
                      >
                        삭제
                      </button>
                    </div>
                  `
                      : ''
                  }
                </div>
              </div>
              <p class="text-xs text-slate-700 leading-relaxed break-words">${escapeHtml(c.text || '')}</p>
            </div>
          `;
        })
        .join('');
    }
  }
}

function submitBoothLikeWithComment() {
  const student = findStudentById(state.activeBoothStudentId);
  if (!student) return;

  if (hasUserLikedBooth(student)) {
    showToast('한 작품당 하트는 1번만 누를 수 있어요!', 'warning');
    renderBoothLikeAndComments(student, false);
    return;
  }

  const inputEl = document.getElementById('modal-booth-like-comment-input');
  const commentText = (inputEl?.value || '').trim();
  if (!commentText) {
    showToast('어떤 점이 좋았는지 작성해야 하트를 누를 수 있어요!', 'warning');
    inputEl?.focus();
    return;
  }

  if (commentText.length < MIN_BOOTH_COMMENT_LENGTH) {
    showToast(
      `작품 응원 메시지는 최소 ${MIN_BOOTH_COMMENT_LENGTH}자 이상 작성해야 하트를 누를 수 있어요! (현재 ${commentText.length}자)`,
      'warning'
    );
    inputEl?.focus();
    return;
  }

  const loggedInStudent = String(
    state.currentStudentId || localStorage.getItem(STORAGE_KEYS.CURRENT_STUDENT) || ''
  ).trim();
  const authorName = getCurrentCommentAuthorName();

  if (!student.inputs) student.inputs = {};
  const validComments = getBoothComments(student);

  const newComment = {
    v: 2,
    id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    author: authorName,
    authorStudentId: loggedInStudent,
    viewerToken: getOrCreateViewerToken(),
    text: commentText,
    createdAt: new Date().toISOString(),
  };

  validComments.push(newComment);
  student.inputs.boothComments = validComments;
  student.likes = validComments.length;
  student.updatedAt = new Date().toISOString();

  saveStudentsToLocalStorage();
  syncStudentToCloud(student);

  renderBoothLikeAndComments(student, true);
  renderExpoBooths();
  showToast('❤️ 좋았던 점 응원 댓글과 함께 하트가 전달되었어요!', 'success');
}

function startEditBoothComment(commentId) {
  const student = findStudentById(state.activeBoothStudentId);
  if (!student) return;
  const target = getBoothComments(student).find((c) => c.id === commentId);
  if (!target || !isMyBoothComment(target)) {
    showToast('자신이 작성한 댓글만 수정할 수 있습니다.', 'warning');
    return;
  }
  state.editingBoothCommentId = commentId;
  renderBoothLikeAndComments(student, false);
}

function cancelEditBoothComment() {
  state.editingBoothCommentId = null;
  const student = findStudentById(state.activeBoothStudentId);
  if (student) {
    renderBoothLikeAndComments(student, false);
  }
}

function updateEditBoothCommentCharCount(commentId) {
  const inputEl = document.getElementById(`edit-comment-input-${commentId}`);
  const countEl = document.getElementById(`edit-comment-char-${commentId}`);
  if (!inputEl || !countEl) return;
  const len = (inputEl.value || '').trim().length;
  if (len >= MIN_BOOTH_COMMENT_LENGTH) {
    countEl.textContent = `✅ ${len}자 / 최소 ${MIN_BOOTH_COMMENT_LENGTH}자`;
    countEl.className = 'font-bold text-emerald-600';
  } else {
    countEl.textContent = `${len}자 / 최소 ${MIN_BOOTH_COMMENT_LENGTH}자 (${MIN_BOOTH_COMMENT_LENGTH - len}자 더 필요)`;
    countEl.className = 'font-bold text-rose-600';
  }
}

function saveEditedBoothComment(commentId) {
  const student = findStudentById(state.activeBoothStudentId);
  if (!student) return;

  const comments = getBoothComments(student);
  const idx = comments.findIndex((c) => c.id === commentId);
  if (idx === -1) return;

  const target = comments[idx];
  if (!isMyBoothComment(target)) {
    showToast('자신이 작성한 댓글만 수정할 수 있습니다.', 'warning');
    return;
  }

  const inputEl = document.getElementById(`edit-comment-input-${commentId}`);
  const newText = (inputEl?.value || '').trim();
  if (newText.length < MIN_BOOTH_COMMENT_LENGTH) {
    showToast(
      `작품 응원 메시지는 최소 ${MIN_BOOTH_COMMENT_LENGTH}자 이상 작성해 주세요! (현재 ${newText.length}자)`,
      'warning'
    );
    inputEl?.focus();
    return;
  }

  comments[idx] = {
    ...target,
    text: newText,
    updatedAt: new Date().toISOString(),
  };

  state.editingBoothCommentId = null;
  student.inputs.boothComments = comments;
  student.likes = comments.length;
  student.updatedAt = new Date().toISOString();

  saveStudentsToLocalStorage();
  syncStudentToCloud(student);

  renderBoothLikeAndComments(student, false);
  renderExpoBooths();
  showToast('✏️ 응원 댓글이 수정되었습니다!', 'success');
}

function deleteBoothComment(commentId) {
  const student = findStudentById(state.activeBoothStudentId);
  if (!student) return;

  const comments = getBoothComments(student);
  const target = comments.find((c) => c.id === commentId);
  if (!target) return;

  if (!isMyBoothComment(target)) {
    showToast('자신이 작성한 댓글만 삭제할 수 있습니다.', 'warning');
    return;
  }

  const remaining = comments.filter((c) => c.id !== commentId);
  state.editingBoothCommentId = null;
  if (!student.inputs) student.inputs = {};
  student.inputs.boothComments = remaining;
  const deletedIds = Array.isArray(student.inputs.deletedCommentIds) ? [...student.inputs.deletedCommentIds] : [];
  if (commentId && !deletedIds.includes(commentId)) {
    deletedIds.push(commentId);
  }
  student.inputs.deletedCommentIds = deletedIds;
  student.likes = remaining.length;
  student.updatedAt = new Date().toISOString();

  saveStudentsToLocalStorage();
  syncStudentToCloud(student);

  renderBoothLikeAndComments(student, true);
  renderExpoBooths();
  showToast('🗑️ 응원 댓글이 삭제되어 하트 수가 1개 줄어들었습니다.', 'info');
}

// 부스 상세 모달 열기
function openBoothDetailModal(studentId) {
  const student = findStudentById(studentId);
  if (!student) return;
  state.activeBoothStudentId = student.studentId;
  state.editingBoothCommentId = null;

  const modal = document.getElementById('booth-detail-modal');
  if (!modal) return;

  const allBooths = getExpoEligibleStudents();
  const idx = allBooths.findIndex((s) => s.studentId === student.studentId);
  const boothNum = idx >= 0 ? String(idx + 1).padStart(2, '0') : '01';
  const meta = STATUS_META[student.status] || STATUS_META.submitted;

  document.getElementById('modal-booth-number').textContent = `BOOTH #${boothNum}`;
  document.getElementById('modal-booth-title').textContent = student.inputs?.robotName || '출품 로봇';
  document.getElementById('modal-booth-creator').textContent = `기획 연구원: ${student.studentName}`;
  document.getElementById('modal-booth-status').textContent = meta.label;
  document.getElementById('modal-booth-version').textContent = `Version ${student.currentVersion || 1}`;

  const promptText = student.videoPrompt || buildPromptFromInputs(student.inputs || {});
  document.getElementById('modal-booth-video-prompt').textContent = promptText;

  const attachBtn = document.getElementById('modal-btn-attach-video');
  if (attachBtn) {
    attachBtn.onclick = () => openVideoAttachModal(student.studentId);
  }

  const playerBox = document.getElementById('modal-video-player-box');
  if (playerBox) {
    playerBox.innerHTML = renderBoothVideoPlayerHtml(student);
  }

  const specBox = document.getElementById('modal-booth-spec-sheet');
  if (specBox) {
    const spec = student.specSheet || buildSpecSheetFromInputs(student.inputs || {});
    specBox.innerHTML = renderSpecSheetHtml(spec);
  }

  renderBoothLikeAndComments(student, true);

  modal.classList.remove('hidden');
}

function closeBoothDetailModal() {
  const modal = document.getElementById('booth-detail-modal');
  if (!modal) return;
  const playerBox = document.getElementById('modal-video-player-box');
  if (playerBox) playerBox.innerHTML = '';
  modal.classList.add('hidden');
  state.activeBoothStudentId = null;
}

function renderBoothVideoPlayerHtml(student) {
  const video = student.video || { type: 'none', url: '', title: '' };

  if (video.type === 'local') {
    const blobUrl = localVideoObjectUrls[student.studentId] || (video.url && video.url.startsWith('data:video') ? video.url : '');
    if (blobUrl) {
      return `
        <video
          src="${blobUrl}"
          controls
          autoplay
          loop
          playsinline
          class="w-full h-full object-contain bg-black"
        ></video>
      `;
    }
  }

  if (video.type === 'url' && video.url) {
    const rawUrl = extractSafeHttpsUrl(video.url);
    if (rawUrl) {
      const ytEmbed = toYouTubeEmbedUrl(rawUrl);
      if (ytEmbed) {
        return `
          <iframe
            src="${escapeHtml(ytEmbed)}"
            allowfullscreen
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            class="w-full h-full border-0"
          ></iframe>
        `;
      }

      const webEmbedUrl = toWebEmbedUrl(rawUrl);
      if (webEmbedUrl) {
        return `
          <iframe
            src="${escapeHtml(webEmbedUrl)}"
            allowfullscreen="allowfullscreen"
            allow="fullscreen; autoplay"
            class="w-full h-full border-0"
          ></iframe>
        `;
      }

      return `
        <video
          src="${escapeHtml(rawUrl)}"
          controls
          autoplay
          loop
          playsinline
          class="w-full h-full object-contain bg-black"
        ></video>
      `;
    }
  }

  return `
    <div class="text-center p-6 space-y-3">
      <div class="w-16 h-16 rounded-2xl bg-white/10 text-white flex items-center justify-center text-3xl mx-auto">
        🎥
      </div>
      <div class="text-white font-extrabold text-sm sm:text-base">
        아직 로봇 소개 영상이 첨부되지 않았어요
      </div>
      <p class="text-xs text-slate-400 max-w-sm mx-auto">
        제작한 MP4 로봇 소개 영상을 업로드하거나, 영상 공유 링크를 등록해 부스 스크린을 켜보세요!
      </p>
      <button
        type="button"
        onclick="openVideoAttachModal('${escapeHtml(student.studentId)}')"
        class="px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-extrabold shadow-lg transition inline-flex items-center gap-1.5"
      >
        <span>🎥</span>
        <span>로봇 소개 영상 첨부하기</span>
      </button>
    </div>
  `;
}

function extractSafeHttpsUrl(inputStr) {
  if (!inputStr) return null;
  const trimmed = String(inputStr).trim();
  const srcMatch = trimmed.match(/src=["']([^"']+)["']/i);
  const candidate = (srcMatch ? srcMatch[1] : trimmed).trim();
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'https:') return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function toWebEmbedUrl(inputStr) {
  const safeUrl = extractSafeHttpsUrl(inputStr);
  if (!safeUrl || !safeUrl.includes('/design/')) return null;

  const base = safeUrl.split('?')[0].replace(/\/(edit|watch)$/, '/view');
  const viewUrl = base.endsWith('/view') ? base : `${base.replace(/\/$/, '')}/view`;
  return `${viewUrl}?embed`;
}

function toYouTubeEmbedUrl(url) {
  if (!url) return null;
  const regExp = /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
  const match = url.match(regExp);
  return match ? `https://www.youtube.com/embed/${match[1]}` : null;
}

function openVideoAttachModal(studentId) {
  const student = findStudentById(studentId);
  if (!student) return;

  state.videoAttachTargetId = student.studentId;
  state.pendingVideoFileData = null;

  const labelEl = document.getElementById('video-modal-student-label');
  if (labelEl) {
    labelEl.textContent = `${student.studentName} · ${student.inputs?.robotName || '로봇 부스'}`;
  }

  const fileInput = document.getElementById('video-file-input');
  if (fileInput) fileInput.value = '';
  document.getElementById('selected-video-file-info')?.classList.add('hidden');

  const urlInput = document.getElementById('video-url-input');
  if (urlInput) {
    urlInput.value = student.video?.type === 'url' ? student.video.url : '';
  }

  switchVideoModalTab('file');
  document.getElementById('video-attach-modal')?.classList.remove('hidden');
}

function closeVideoAttachModal() {
  document.getElementById('video-attach-modal')?.classList.add('hidden');
  state.videoAttachTargetId = null;
  state.pendingVideoFileData = null;
}

function switchVideoModalTab(tabKey) {
  state.videoModalTab = tabKey;
  ['file', 'url'].forEach((k) => {
    const btn = document.getElementById(`vtab-btn-${k}`);
    const panel = document.getElementById(`vtab-panel-${k}`);
    if (panel) panel.classList.toggle('hidden', k !== tabKey);
    if (btn) {
      btn.className = k === tabKey
        ? 'py-2.5 px-3 rounded-lg text-xs font-bold bg-white text-blue-600 shadow-sm transition'
        : 'py-2.5 px-3 rounded-lg text-xs font-bold text-slate-600 hover:text-slate-900 transition';
    }
  });
}

function handleVideoFileSelected(event) {
  const file = event.target?.files?.[0];
  if (!file) return;

  state.pendingVideoFileData = file;
  const infoBox = document.getElementById('selected-video-file-info');
  const nameEl = document.getElementById('selected-video-filename');
  if (infoBox && nameEl) {
    const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
    nameEl.textContent = `🎬 ${file.name} (${sizeMb} MB)`;
    infoBox.classList.remove('hidden');
  }
}

function captureVideoThumbnailDataUrl(fileOrUrl) {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') {
      resolve('');
      return;
    }
    let objectUrl = '';
    const video = document.createElement('video');
    let settled = false;

    const cleanup = () => {
      if (objectUrl) {
        try {
          URL.revokeObjectURL(objectUrl);
        } catch {
          // ignore
        }
      }
      video.removeAttribute('src');
      try {
        video.load();
      } catch {
        // ignore
      }
    };

    const finish = (dataUrl) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(dataUrl || '');
    };

    const timer = setTimeout(() => finish(''), 6000);

    try {
      video.muted = true;
      video.playsInline = true;
      video.preload = 'metadata';

      if (typeof fileOrUrl === 'string') {
        video.crossOrigin = 'anonymous';
        video.src = fileOrUrl;
      } else if (fileOrUrl instanceof Blob) {
        objectUrl = URL.createObjectURL(fileOrUrl);
        video.src = objectUrl;
      } else {
        clearTimeout(timer);
        finish('');
        return;
      }

      video.addEventListener(
        'loadeddata',
        () => {
          const targetTime = video.duration && video.duration > 0.6 ? 0.5 : 0.1;
          try {
            video.currentTime = targetTime;
          } catch {
            drawFrame();
          }
        },
        { once: true }
      );

      const drawFrame = () => {
        clearTimeout(timer);
        try {
          const vw = video.videoWidth || 480;
          const vh = video.videoHeight || 270;
          const targetW = 480;
          const targetH = Math.max(200, Math.round((vh / vw) * targetW));
          const canvas = document.createElement('canvas');
          canvas.width = targetW;
          canvas.height = targetH;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(video, 0, 0, targetW, targetH);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
          finish(dataUrl && dataUrl.startsWith('data:image/jpeg') ? dataUrl : '');
        } catch {
          finish('');
        }
      };

      video.addEventListener('seeked', drawFrame, { once: true });
      video.addEventListener('error', () => {
        clearTimeout(timer);
        finish('');
      }, { once: true });
    } catch {
      clearTimeout(timer);
      finish('');
    }
  });
}

function scheduleVideoThumbnailCapture(student) {
  if (!student || !student.studentId || !student.video) return;
  const key = `${student.studentId}_${student.video.url || student.video.title || ''}`;
  if (attemptedVideoThumbnails.has(key)) return;
  attemptedVideoThumbnails.add(key);

  let source = '';
  if (student.video.type === 'local' && localVideoObjectUrls[student.studentId]) {
    source = localVideoObjectUrls[student.studentId];
  } else if (
    student.video.type === 'url' &&
    student.video.url &&
    (/\.(mp4|webm|mov)(\?|$)/i.test(student.video.url) || student.video.url.includes('/storage/v1/object/public/'))
  ) {
    source = extractSafeHttpsUrl(student.video.url) || '';
  }

  if (!source) return;

  captureVideoThumbnailDataUrl(source).then((dataUrl) => {
    if (!dataUrl) return;
    inMemoryVideoThumbnails[student.studentId] = dataUrl;
    if (student.video) {
      student.video.thumbnail = dataUrl;
      saveStudentsToLocalStorage(false);
    }
    renderExpoBooths(true);
  });
}

async function uploadVideoToSupabaseStorage(studentId, file) {
  if (!isSupabaseConfigured()) return null;
  if (!supabaseClient) initSupabaseClient();
  if (!supabaseClient) return null;

  try {
    const ext = (file.name.split('.').pop() || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp4';
    const safeKey = encodeURIComponent(String(studentId || 'student').trim()).replace(/%/g, '');
    const filePath = `booths/booth_${safeKey}_${Date.now()}.${ext}`;

    const { error: uploadError } = await supabaseClient.storage
      .from(SUPABASE_VIDEO_BUCKET)
      .upload(filePath, file, {
        cacheControl: '31536000',
        upsert: true,
        contentType: file.type || 'video/mp4',
      });

    if (uploadError) {
      console.warn('Supabase Storage 영상 업로드 실패:', uploadError.message);
      return null;
    }

    const { data } = supabaseClient.storage
      .from(SUPABASE_VIDEO_BUCKET)
      .getPublicUrl(filePath);

    return data?.publicUrl || null;
  } catch (err) {
    console.warn('Supabase Storage 업로드 예외:', err);
    return null;
  }
}

async function saveAttachedVideo() {
  const student = findStudentById(state.videoAttachTargetId);
  if (!student) return;

  const saveBtn = document.getElementById('btn-save-attached-video');
  const origBtnHtml = saveBtn ? saveBtn.innerHTML : '';

  try {
    if (state.videoModalTab === 'file') {
      if (!state.pendingVideoFileData) {
        showToast('업로드할 MP4 영상 파일을 먼저 선택해 주세요!', 'warning');
        return;
      }
      const file = state.pendingVideoFileData;
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '⏳ 썸네일 추출 및 영상 업로드 중...';
      }

      // 0) 동영상 파일에서 정적 썸네일 사진(JPEG Data URL) 자동 추출 (부스 미리보기에서 동영상 대신 사진만 표시하기 위함)
      const thumbnailDataUrl = await captureVideoThumbnailDataUrl(file);
      if (thumbnailDataUrl) {
        inMemoryVideoThumbnails[student.studentId] = thumbnailDataUrl;
      }

      // 1) 로컬 IndexedDB에도 캐시 저장
      await saveVideoBlobToIndexedDB(student.studentId, file, file.name);

      // 2) Supabase Storage가 연동되어 있으면 클라우드 버킷(robot-videos)에 업로드하여 상세 모달에서만 재생되는 공개 URL 획득
      const cloudVideoUrl = await uploadVideoToSupabaseStorage(student.studentId, file);
      if (cloudVideoUrl) {
        student.video = {
          type: 'url',
          url: cloudVideoUrl,
          title: file.name,
          thumbnail: thumbnailDataUrl || '',
        };
      } else {
        student.video = {
          type: 'local',
          url: 'LOCAL_INDEXED_DB',
          title: file.name,
          thumbnail: thumbnailDataUrl || '',
        };
      }
    } else if (state.videoModalTab === 'url') {
      const rawUrl = (document.getElementById('video-url-input')?.value || '').trim();
      if (!rawUrl) {
        showToast('영상 공유 링크 또는 동영상 URL을 입력해 주세요!', 'warning');
        return;
      }
      const safeUrl = extractSafeHttpsUrl(rawUrl);
      if (!safeUrl) {
        showToast('보안을 위해 https:// 로 시작하는 유효한 영상 링크 또는 동영상 URL만 등록할 수 있습니다.', 'warning');
        return;
      }
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '⏳ 썸네일 확인 및 등록 중...';
      }
      let thumbnailDataUrl = getYouTubeThumbnailUrl(safeUrl);
      if (!thumbnailDataUrl && /\.(mp4|webm|mov)(\?|$)/i.test(safeUrl)) {
        thumbnailDataUrl = await captureVideoThumbnailDataUrl(safeUrl);
      }
      if (thumbnailDataUrl) {
        inMemoryVideoThumbnails[student.studentId] = thumbnailDataUrl;
      }
      student.video = {
        type: 'url',
        url: safeUrl,
        title: '로봇 소개 영상',
        thumbnail: thumbnailDataUrl || '',
      };
    }

    student.updatedAt = new Date().toISOString();
    saveStudentsToLocalStorage();
    await syncStudentToCloud(student);

    const targetId = student.studentId;
    closeVideoAttachModal();
    refreshAllViews(false);
    renderExpoBooths(true);

    if (state.activeBoothStudentId === targetId) {
      openBoothDetailModal(targetId);
    }
    showToast('🎥 박람회 부스에 로봇 소개 영상과 썸네일 사진이 등록되었습니다!', 'success');
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.innerHTML = origBtnHtml || '✅ 부스에 영상 등록하기';
    }
  }
}

// ============================================================================
// 9. [탭 3] 🔒 교사 관리자 화면 (실시간 현황/필터, 상세 확인, 수정 요청, 전시 승인, 이력 비교)
// ============================================================================
function renderTeacherSection() {
  const authPanel = document.getElementById('teacher-auth-panel');
  const dashPanel = document.getElementById('teacher-dashboard-panel');
  if (!authPanel || !dashPanel) return;

  if (!state.teacherUnlocked) {
    authPanel.classList.remove('hidden');
    dashPanel.classList.add('hidden');
    return;
  }

  authPanel.classList.add('hidden');
  dashPanel.classList.remove('hidden');
  renderTeacherDashboard();
}

function lockTeacherDashboard() {
  state.teacherUnlocked = false;
  sessionStorage.removeItem(STORAGE_KEYS.TEACHER_UNLOCKED);
  renderTeacherSection();
  showToast('🔒 교사 관리자 화면이 잠겼습니다.', 'info');
}

function setTeacherFilter(filterKey) {
  state.teacherFilter = filterKey;
  document.querySelectorAll('.teacher-stat-card').forEach((card) => {
    const key = card.getAttribute('data-teacher-filter');
    if (key === filterKey) {
      card.classList.add('border-blue-600');
      card.classList.remove('border-slate-200');
    } else {
      card.classList.remove('border-blue-600');
      card.classList.add('border-slate-200');
    }
  });
  renderTeacherDashboard();
}

function renderTeacherDashboard() {
  const totalCount = state.students.length;
  const draftingCount = state.students.filter((s) => s.status === 'drafting').length;
  const submittedCount = state.students.filter((s) => s.status === 'submitted').length;
  const revisionCount = state.students.filter((s) => s.status === 'revision').length;
  const approvedCount = state.students.filter((s) => s.status === 'approved').length;

  setText('t-stat-all', `${totalCount}명`);
  setText('t-stat-drafting', `${draftingCount}명`);
  setText('t-stat-submitted', `${submittedCount}명`);
  setText('t-stat-revision', `${revisionCount}명`);
  setText('t-stat-approved', `${approvedCount}명`);

  const searchQuery = (document.getElementById('teacher-search-input')?.value || '').trim().toLowerCase();
  const filtered = state.students.filter((s) => {
    if (state.teacherFilter !== 'all' && s.status !== state.teacherFilter) return false;
    if (searchQuery) {
      const hay = `${s.studentName} ${s.inputs?.robotName || ''}`.toLowerCase();
      if (!hay.includes(searchQuery)) return false;
    }
    return true;
  });

  setText('teacher-table-count', `${filtered.length}명`);

  const tbody = document.getElementById('teacher-student-tbody');
  if (!tbody) return;

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="py-10 text-center text-slate-400 text-xs">
          해당 조건의 학생 데이터가 없습니다.
        </td>
      </tr>
    `;
  } else {
    tbody.innerHTML = filtered.map((st) => {
      const meta = STATUS_META[st.status] || STATUS_META.drafting;
      const isSelected = st.studentId === state.selectedTeacherStudentId;
      const hasVideo = st.video && st.video.type && st.video.type !== 'none';
      const versionNum = Number(st.currentVersion) || 0;

      return `
        <tr
          onclick="selectTeacherStudent('${escapeHtml(st.studentId)}')"
          class="cursor-pointer transition border-l-4 ${isSelected ? 'border-l-blue-600 bg-blue-50/80' : 'border-l-transparent hover:bg-slate-50/90'}"
        >
          <td class="py-3 px-4 whitespace-nowrap">
            <div class="font-extrabold text-slate-900 text-xs sm:text-sm">${escapeHtml(st.studentName)}</div>
            <div class="text-[11px] text-slate-400 font-medium mt-0.5">${formatDateTime(st.updatedAt)}</div>
          </td>
          <td class="py-3 px-3">
            <div class="font-bold text-slate-800 text-xs sm:text-sm truncate max-w-[150px]" title="${escapeHtml(st.inputs?.robotName || '')}">
              ${escapeHtml(st.inputs?.robotName || '(미입력)')}
            </div>
          </td>
          <td class="py-3 px-2.5 text-center whitespace-nowrap">
            <span class="inline-flex px-2.5 py-0.5 rounded-full text-[11px] font-extrabold ${meta.badgeClass}">
              ${meta.label}
            </span>
          </td>
          <td class="py-3 px-2.5 text-center whitespace-nowrap">
            ${versionNum > 0 ? `
              <button
                type="button"
                onclick="event.stopPropagation(); openHistoryCompareModal('${escapeHtml(st.studentId)}')"
                class="px-2.5 py-1 rounded-lg text-xs font-extrabold ${versionNum > 1 ? 'bg-indigo-100 text-indigo-800 hover:bg-indigo-200' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'} transition inline-flex items-center justify-center"
                title="버전별 제출 이력 비교하기"
              >
                v${versionNum}
              </button>
            ` : '<span class="text-xs text-slate-400 font-medium">-</span>'}
          </td>
          <td class="py-3 px-2.5 text-center whitespace-nowrap">
            ${hasVideo
              ? '<span class="inline-flex items-center px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200 text-[11px] font-bold">첨부됨</span>'
              : '<span class="text-xs text-slate-400">-</span>'}
          </td>
          <td class="py-3 px-4 text-right whitespace-nowrap">
            <div class="inline-flex items-center justify-end gap-1.5">
              <button
                type="button"
                onclick="event.stopPropagation(); selectTeacherStudent('${escapeHtml(st.studentId)}')"
                class="px-2.5 py-1.5 rounded-lg text-xs font-extrabold ${isSelected ? 'bg-blue-600 text-white shadow-sm' : 'bg-slate-100 hover:bg-slate-200 text-slate-700'} transition"
                title="학생 로봇 기획서 수정"
              >
                수정
              </button>
              <button
                type="button"
                onclick="event.stopPropagation(); deleteStudentByAdmin('${escapeHtml(st.studentId)}')"
                class="px-2.5 py-1.5 rounded-lg text-xs font-bold bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 transition"
                title="학생 및 로봇 데이터 삭제"
              >
                삭제
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  if (!findStudentById(state.selectedTeacherStudentId) && state.students.length > 0) {
    state.selectedTeacherStudentId = state.students[0].studentId;
  }
  renderTeacherDetailPanel(false);
}

function selectTeacherStudent(studentId) {
  const isSameStudent =
    state.selectedTeacherStudentId === studentId &&
    state.teacherDetailRenderedStudentId === studentId &&
    Boolean(document.getElementById('teacher-detail-scroll-box'));

  state.selectedTeacherStudentId = studentId;
  if (isSameStudent) {
    renderTeacherDashboard();
    return;
  }

  state.teacherDetailDirty = false;
  state.teacherDetailRenderedStudentId = null;
  renderTeacherDashboard();
  renderTeacherDetailPanel(true);
}

function markTeacherDetailDirty(studentId) {
  state.teacherDetailDirty = true;
  if (studentId) {
    state.teacherDetailRenderedStudentId = studentId;
  }
  const badge = document.getElementById('td-editing-lock-badge');
  if (badge) {
    badge.classList.remove('hidden');
  }
}

function isTeacherEditingDetailPanel(studentId) {
  const panel = document.getElementById('teacher-detail-panel');
  if (!panel) return false;
  if (state.teacherDetailRenderedStudentId !== studentId) return false;
  if (state.teacherDetailDirty) return true;
  const activeEl = document.activeElement;
  if (activeEl && panel.contains(activeEl) && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'SELECT')) {
    return true;
  }
  return false;
}

function renderTeacherDetailPanel(forceRender = false) {
  const panel = document.getElementById('teacher-detail-panel');
  if (!panel) return;

  const student = findStudentById(state.selectedTeacherStudentId);
  if (!student) {
    state.teacherDetailRenderedStudentId = null;
    state.teacherDetailDirty = false;
    panel.innerHTML = `<div class="p-8 text-center text-slate-400 text-sm">좌측 목록에서 학생을 선택하세요.</div>`;
    return;
  }

  const isSameRenderedStudent =
    state.teacherDetailRenderedStudentId === student.studentId &&
    Boolean(document.getElementById('teacher-detail-scroll-box'));

  // ★ 핵심 보호: 이미 동일한 학생의 상세 패널이 열려 있는 동안에는 백그라운드 자동 동기화(forceRender=false)가
  // DOM을 재생성하여 스크롤을 맨 위로 초기화하거나 작성 중인 내용을 덮어쓰지 않도록 원천 차단 ★
  if (!forceRender && (isSameRenderedStudent || isTeacherEditingDetailPanel(student.studentId))) {
    return;
  }

  const prevScrollBox = document.getElementById('teacher-detail-scroll-box');
  const savedScrollTop = isSameRenderedStudent && prevScrollBox ? prevScrollBox.scrollTop : 0;
  const savedWindowScrollY = window.scrollY;

  state.teacherDetailRenderedStudentId = student.studentId;
  if (forceRender) {
    state.teacherDetailDirty = false;
  }

  const meta = STATUS_META[student.status] || STATUS_META.drafting;
  const inp = student.inputs || {};
  const promptText = student.videoPrompt || buildPromptFromInputs(inp);
  const historyCount = (student.history || []).length;
  const valueTags = parseCoreValuesHashtags(inp.coreValues);
  const safeStudentId = escapeHtml(student.studentId);

  panel.innerHTML = `
    <div class="bg-slate-900 text-white px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
      <div>
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-base font-extrabold">${escapeHtml(student.studentName)}</span>
          <span class="px-2.5 py-0.5 rounded-full text-[11px] font-extrabold ${meta.badgeClass}">${meta.label}</span>
          ${student.currentVersion > 0 ? `<span class="px-2 py-0.5 rounded-md bg-white/10 text-slate-200 text-[11px] font-bold">v${student.currentVersion}</span>` : ''}
          <span id="td-editing-lock-badge" class="${state.teacherDetailDirty ? '' : 'hidden'} px-2 py-0.5 rounded-full text-[10px] font-extrabold bg-amber-400 text-slate-950">
            🔒 수정 중
          </span>
        </div>
        <p class="text-xs text-slate-300 mt-0.5 truncate max-w-xs">
          🤖 ${escapeHtml(inp.robotName || '(로봇명 미입력)')}
        </p>
      </div>

      <div class="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          onclick="openHistoryCompareModal('${safeStudentId}')"
          class="px-2.5 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs font-bold transition flex items-center gap-1"
        >
          <span>🕒</span>
          <span>이력 비교</span>
        </button>
        <button
          type="button"
          onclick="deleteStudentByAdmin('${safeStudentId}')"
          class="px-2.5 py-1.5 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 border border-rose-400/30 text-xs font-bold transition flex items-center gap-1"
        >
          <span>삭제</span>
        </button>
      </div>
    </div>

    <div id="teacher-detail-scroll-box" class="p-5 space-y-5 max-h-[75vh] overflow-y-auto">
      
      <!-- 교사 피드백 및 상태 변경 액션 박스 -->
      <div class="bg-orange-50/70 border-2 border-orange-200 rounded-2xl p-4 space-y-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <label for="teacher-feedback-input" class="text-xs font-extrabold text-slate-900 flex items-center gap-1.5">
            <span>💬</span>
            <span>교사 피드백 코멘트 &amp; 수정 요청 / 전시 승인</span>
          </label>
          <button
            type="button"
            id="btn-teacher-ai-feedback"
            onclick="requestTeacherAiFeedback('${safeStudentId}')"
            ${state.aiQuotaExhausted ? 'disabled' : ''}
            class="px-3 py-1.5 rounded-xl text-xs font-extrabold transition flex items-center gap-1.5 shadow-sm ${
              state.aiQuotaExhausted
                ? 'bg-slate-300 text-slate-600 cursor-not-allowed'
                : 'bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-700 hover:to-indigo-700 text-white'
            }"
          >
            <span>🤖</span>
            <span id="btn-teacher-ai-feedback-label">${
              state.aiQuotaExhausted ? '더 이상 AI 피드백을 받을 수 없습니다.' : 'AI 피드백 추가하기'
            }</span>
          </button>
        </div>

        <textarea
          id="teacher-feedback-input"
          rows="3"
          oninput="markTeacherDetailDirty('${safeStudentId}')"
          placeholder="학생에게 전달할 구체적인 수정 요청 피드백이나 칭찬 코멘트를 입력하세요..."
          class="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 focus:border-orange-500 outline-none text-xs sm:text-sm bg-white"
        >${escapeHtml(student.teacherFeedback || '')}</textarea>

        <div class="grid grid-cols-2 gap-2.5">
          <button
            type="button"
            onclick="sendRevisionRequest('${safeStudentId}')"
            class="py-2.5 px-3 rounded-xl bg-orange-600 hover:bg-orange-700 text-white font-extrabold text-xs shadow-sm transition flex items-center justify-center gap-1.5"
          >
            <span>🔄</span>
            <span>수정 요청 보내기</span>
          </button>

          <button
            type="button"
            onclick="approveStudentExpo('${safeStudentId}')"
            class="py-2.5 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-xs shadow-sm transition flex items-center justify-center gap-1.5"
          >
            <span>✅</span>
            <span>전시 승인</span>
          </button>
        </div>
      </div>

      <!-- 학생이 입력한 7단계 항목 상세 확인 및 즉시 수정 -->
      <div class="space-y-3 bg-slate-50/70 p-4 rounded-2xl border border-slate-200">
        <div class="flex items-center justify-between gap-2">
          <h4 class="text-xs font-extrabold text-slate-700 uppercase tracking-wider flex items-center gap-1.5">
            <span>✏️</span>
            <span>학생 입력 7단계 상세 확인 및 수정</span>
          </h4>
          <button
            type="button"
            onclick="saveTeacherInlineEdits('${safeStudentId}', false)"
            class="px-3 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-extrabold shadow-sm transition flex items-center gap-1"
          >
            <span>💾</span>
            <span>수정 내용 저장</span>
          </button>
        </div>

        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          <div class="bg-white p-2.5 rounded-xl border border-slate-200 text-xs space-y-1">
            <label class="block font-bold text-slate-700">학생 이름</label>
            <input
              id="td-edit-student-name"
              type="text"
              oninput="markTeacherDetailDirty('${safeStudentId}')"
              value="${escapeHtml(student.studentName || '')}"
              class="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 focus:border-blue-500 outline-none text-xs font-bold text-slate-900"
            />
          </div>
          <div class="bg-white p-2.5 rounded-xl border border-slate-200 text-xs space-y-1">
            <label class="block font-bold text-slate-700">1-1. 출품 로봇 이름</label>
            <input
              id="td-edit-robot-name"
              type="text"
              oninput="markTeacherDetailDirty('${safeStudentId}')"
              value="${escapeHtml(inp.robotName || '')}"
              class="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 focus:border-blue-500 outline-none text-xs font-bold text-blue-700"
            />
          </div>
        </div>

        <div class="bg-white p-3 rounded-xl border border-slate-200 text-xs space-y-1.5">
          <div class="flex justify-between font-bold text-slate-800">
            <label for="td-edit-appearance">1-2. 로봇 외형 특징</label>
            <span class="${(inp.appearance || '').length >= 15 ? 'text-emerald-600' : 'text-orange-600'}">${(inp.appearance || '').length}자</span>
          </div>
          <textarea
            id="td-edit-appearance"
            rows="2"
            oninput="markTeacherDetailDirty('${safeStudentId}')"
            class="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 focus:border-blue-500 outline-none text-xs text-slate-700 leading-relaxed"
          >${escapeHtml(inp.appearance || '')}</textarea>
        </div>

        <div class="bg-white p-3 rounded-xl border border-slate-200 text-xs space-y-1.5">
          <div class="flex justify-between font-bold text-slate-800">
            <label for="td-edit-purpose">2. 제작 목적 (미래 사회 문제)</label>
            <span class="${(inp.purpose || '').length >= 15 ? 'text-emerald-600' : 'text-orange-600'}">${(inp.purpose || '').length}자</span>
          </div>
          <textarea
            id="td-edit-purpose"
            rows="2"
            oninput="markTeacherDetailDirty('${safeStudentId}')"
            class="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 focus:border-blue-500 outline-none text-xs text-slate-700 leading-relaxed"
          >${escapeHtml(inp.purpose || '')}</textarea>
        </div>

        <div class="bg-white p-3 rounded-xl border border-slate-200 text-xs space-y-1.5">
          <div class="flex justify-between font-bold text-slate-800">
            <label for="td-edit-main-function">3. 주요 기능 (작동 모습과 구조)</label>
            <span class="${(inp.mainFunction || '').length >= 50 ? 'text-emerald-600' : 'text-orange-600'}">${(inp.mainFunction || '').length}자</span>
          </div>
          <textarea
            id="td-edit-main-function"
            rows="2"
            oninput="markTeacherDetailDirty('${safeStudentId}')"
            class="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 focus:border-blue-500 outline-none text-xs text-slate-700 leading-relaxed"
          >${escapeHtml(inp.mainFunction || '')}</textarea>
        </div>

        <div class="bg-indigo-50/60 p-3 rounded-xl border border-indigo-200 text-xs space-y-2">
          <div class="font-bold text-indigo-950">4. 탑재 감지 장치 (센서 3단계)</div>
          <div>
            <label for="td-edit-sensor-name" class="block text-[11px] font-bold text-slate-700 mb-0.5">4-1. 센서명</label>
            <input
              id="td-edit-sensor-name"
              type="text"
              oninput="markTeacherDetailDirty('${safeStudentId}')"
              value="${escapeHtml(inp.sensorName || '')}"
              class="w-full px-2.5 py-1.5 rounded-lg border border-indigo-200 bg-white focus:border-indigo-500 outline-none text-xs text-slate-800"
            />
          </div>
          <div>
            <label for="td-edit-sensor-target" class="block text-[11px] font-bold text-slate-700 mb-0.5">4-2. 세부 감지 대상 (${(inp.sensorTarget || '').length}자)</label>
            <input
              id="td-edit-sensor-target"
              type="text"
              oninput="markTeacherDetailDirty('${safeStudentId}')"
              value="${escapeHtml(inp.sensorTarget || '')}"
              class="w-full px-2.5 py-1.5 rounded-lg border border-indigo-200 bg-white focus:border-indigo-500 outline-none text-xs text-slate-800"
            />
          </div>
          <div>
            <label for="td-edit-sensor-action" class="block text-[11px] font-bold text-slate-700 mb-0.5">4-3. 감지 후 로봇의 행동 (${(inp.sensorAction || '').length}자)</label>
            <input
              id="td-edit-sensor-action"
              type="text"
              oninput="markTeacherDetailDirty('${safeStudentId}')"
              value="${escapeHtml(inp.sensorAction || '')}"
              class="w-full px-2.5 py-1.5 rounded-lg border border-indigo-200 bg-white focus:border-indigo-500 outline-none text-xs text-slate-800"
            />
          </div>
        </div>

        <div class="bg-white p-3 rounded-xl border border-slate-200 text-xs space-y-1.5">
          <div class="flex justify-between font-bold text-slate-800">
            <label for="td-edit-science-tech">5. 적용된 과학 기술 (융합 기술)</label>
            <span class="${(inp.scienceTech || '').length >= 50 ? 'text-emerald-600' : 'text-orange-600'}">${(inp.scienceTech || '').length}자</span>
          </div>
          <textarea
            id="td-edit-science-tech"
            rows="2"
            oninput="markTeacherDetailDirty('${safeStudentId}')"
            class="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 focus:border-blue-500 outline-none text-xs text-slate-700 leading-relaxed"
          >${escapeHtml(inp.scienceTech || '')}</textarea>
        </div>

        <div class="bg-white p-3 rounded-xl border border-slate-200 text-xs space-y-1.5">
          <div class="flex justify-between font-bold text-slate-800">
            <label for="td-edit-core-values">6. 추구하는 가치 (해시태그)</label>
            <span class="${valueTags.length >= 2 ? 'text-emerald-600' : 'text-orange-600'}">${valueTags.length}개 단어</span>
          </div>
          <input
            id="td-edit-core-values"
            type="text"
            oninput="markTeacherDetailDirty('${safeStudentId}')"
            value="${escapeHtml(formatCoreValuesString(inp.coreValues) || '')}"
            class="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 focus:border-blue-500 outline-none text-xs font-bold text-indigo-700"
          />
        </div>

        <div class="bg-white p-3 rounded-xl border border-slate-200 text-xs space-y-1.5">
          <label for="td-edit-video-style" class="block font-bold text-slate-800">7. 선택한 영상 스타일</label>
          <input
            id="td-edit-video-style"
            type="text"
            oninput="markTeacherDetailDirty('${safeStudentId}')"
            value="${escapeHtml(inp.videoStyle || '')}"
            class="w-full px-2.5 py-1.5 rounded-lg border border-slate-300 focus:border-blue-500 outline-none text-xs font-semibold text-blue-700"
          />
        </div>

        <button
          type="button"
          onclick="saveTeacherInlineEdits('${safeStudentId}', false)"
          class="w-full py-2.5 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-extrabold text-xs shadow-sm transition flex items-center justify-center gap-1.5"
        >
          <span>💾</span>
          <span>수정한 내용 저장 및 프롬프트·기획서 자동 갱신</span>
        </button>
      </div>

      <!-- 변환된 AI 영상 프롬프트 확인 -->
      <div class="space-y-1.5">
        <div class="flex items-center justify-between">
          <h4 class="text-xs font-extrabold text-slate-500 uppercase tracking-wider">🎬 변환된 AI 영상 프롬프트</h4>
          <button type="button" onclick="copyVideoPrompt('${escapeJsString(promptText)}')" class="text-xs font-bold text-indigo-600 hover:underline">📋 복사</button>
        </div>
        <div class="bg-slate-900 text-slate-100 p-3.5 rounded-xl text-xs leading-relaxed">
          ${escapeHtml(promptText)}
        </div>
      </div>

      <!-- 변환된 개조식 기획서 확인 -->
      <div class="space-y-1.5">
        <div class="flex items-center justify-between">
          <h4 class="text-xs font-extrabold text-slate-500 uppercase tracking-wider">📋 박람회 개조식 기획서</h4>
          <button
            type="button"
            onclick="openBoothDetailModal('${safeStudentId}')"
            class="text-xs font-bold text-blue-600 hover:underline"
          >
            🏛️ 부스 화면으로 열기 →
          </button>
        </div>
        ${renderSpecSheetHtml(student.specSheet || buildSpecSheetFromInputs(inp))}
      </div>

    </div>
  `;

  if (isSameRenderedStudent) {
    const newScrollBox = document.getElementById('teacher-detail-scroll-box');
    if (newScrollBox) {
      newScrollBox.scrollTop = savedScrollTop;
    }
    if (typeof savedWindowScrollY === 'number' && Math.abs(window.scrollY - savedWindowScrollY) > 5) {
      window.scrollTo({ top: savedWindowScrollY, behavior: 'instant' });
    }
  }
}

function saveTeacherInlineEdits(studentId, silent = false) {
  const student = findStudentById(studentId);
  if (!student) return false;

  const nameEl = document.getElementById('td-edit-student-name');
  if (!nameEl) return false;

  const newStudentName = (nameEl.value || '').trim();
  if (!newStudentName) {
    if (!silent) showToast('학생 이름을 입력해 주세요.', 'warning');
    return false;
  }

  const prevScrollBox = document.getElementById('teacher-detail-scroll-box');
  const savedDetailScrollTop = prevScrollBox ? prevScrollBox.scrollTop : 0;
  const savedWindowScrollY = window.scrollY;

  const updatedInputs = {
    robotName: (document.getElementById('td-edit-robot-name')?.value || '').trim(),
    appearance: (document.getElementById('td-edit-appearance')?.value || '').trim(),
    purpose: (document.getElementById('td-edit-purpose')?.value || '').trim(),
    mainFunction: (document.getElementById('td-edit-main-function')?.value || '').trim(),
    sensorName: (document.getElementById('td-edit-sensor-name')?.value || '').trim(),
    sensorTarget: (document.getElementById('td-edit-sensor-target')?.value || '').trim(),
    sensorAction: (document.getElementById('td-edit-sensor-action')?.value || '').trim(),
    scienceTech: (document.getElementById('td-edit-science-tech')?.value || '').trim(),
    coreValues: formatCoreValuesString((document.getElementById('td-edit-core-values')?.value || '').trim()),
    videoStyle: (document.getElementById('td-edit-video-style')?.value || '').trim(),
    customVideoPrompt: student.inputs?.customVideoPrompt || '',
    aiFeedback: student.inputs?.aiFeedback || null,
    boothComments: Array.isArray(student.inputs?.boothComments) ? student.inputs.boothComments : [],
    deletedCommentIds: Array.isArray(student.inputs?.deletedCommentIds) ? student.inputs.deletedCommentIds : [],
  };

  student.studentName = newStudentName;
  student.inputs = updatedInputs;
  student.videoPrompt = (updatedInputs.customVideoPrompt || '').trim() || buildPromptFromInputs(updatedInputs);
  student.specSheet = buildSpecSheetFromInputs(updatedInputs);
  student.updatedAt = new Date().toISOString();

  if (Array.isArray(student.history) && student.history.length > 0) {
    const latest = student.history[student.history.length - 1];
    latest.inputs = JSON.parse(JSON.stringify(updatedInputs));
    latest.videoPrompt = student.videoPrompt;
    latest.specSheet = JSON.parse(JSON.stringify(student.specSheet));
  }

  state.teacherDetailDirty = false;

  if (!silent) {
    saveStudentsToLocalStorage();
    syncStudentToCloud(student);
    refreshAllViews(state.currentStudentId === student.studentId);
    renderTeacherDetailPanel(true);
    const newScrollBox = document.getElementById('teacher-detail-scroll-box');
    if (newScrollBox) newScrollBox.scrollTop = savedDetailScrollTop;
    if (Math.abs(window.scrollY - savedWindowScrollY) > 5) {
      window.scrollTo({ top: savedWindowScrollY, behavior: 'instant' });
    }
    showToast(`✏️ ${student.studentName} 학생의 로봇 기획서 수정 사항이 저장되었습니다.`, 'success');
  }
  return true;
}

function insertTeacherFeedbackChip(text) {
  const el = document.getElementById('teacher-feedback-input');
  if (!el) return;
  el.value = el.value.trim() ? `${el.value.trim()} ${text}` : text;
  if (state.selectedTeacherStudentId) {
    markTeacherDetailDirty(state.selectedTeacherStudentId);
  }
  el.focus();
}

function updateTeacherAiFeedbackButtonState() {
  const btn = document.getElementById('btn-teacher-ai-feedback');
  const labelEl = document.getElementById('btn-teacher-ai-feedback-label');
  if (!btn) return;

  if (state.aiQuotaExhausted) {
    btn.disabled = true;
    btn.className =
      'px-3 py-1.5 rounded-xl text-xs font-extrabold transition flex items-center gap-1.5 shadow-sm bg-slate-300 text-slate-600 cursor-not-allowed';
    if (labelEl) labelEl.textContent = '더 이상 AI 피드백을 받을 수 없습니다.';
    return;
  }

  btn.disabled = Boolean(state.isRequestingAiFeedback);
  btn.className =
    'px-3 py-1.5 rounded-xl text-xs font-extrabold transition flex items-center gap-1.5 shadow-sm bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-700 hover:to-indigo-700 text-white';
  if (labelEl) {
    labelEl.textContent = state.isRequestingAiFeedback ? 'AI 피드백 생성 중...' : 'AI 피드백 추가하기';
  }
}

async function requestTeacherAiFeedback(studentId) {
  if (state.aiQuotaExhausted) {
    terminateAllAiFeedbackFeatures();
    return;
  }

  const student = findStudentById(studentId || state.selectedTeacherStudentId);
  if (!student) return;

  if (state.isRequestingAiFeedback) return;
  state.isRequestingAiFeedback = true;
  updateTeacherAiFeedbackButtonState();

  try {
    // 현재 우측 상세 패널에 입력된 최신 값 우선 참조
    const currentInputs = {
      robotName: (document.getElementById('td-edit-robot-name')?.value ?? student.inputs?.robotName ?? '').trim(),
      appearance: (document.getElementById('td-edit-appearance')?.value ?? student.inputs?.appearance ?? '').trim(),
      purpose: (document.getElementById('td-edit-purpose')?.value ?? student.inputs?.purpose ?? '').trim(),
      mainFunction: (document.getElementById('td-edit-main-function')?.value ?? student.inputs?.mainFunction ?? '').trim(),
      sensorName: (document.getElementById('td-edit-sensor-name')?.value ?? student.inputs?.sensorName ?? '').trim(),
      sensorTarget: (document.getElementById('td-edit-sensor-target')?.value ?? student.inputs?.sensorTarget ?? '').trim(),
      sensorAction: (document.getElementById('td-edit-sensor-action')?.value ?? student.inputs?.sensorAction ?? '').trim(),
      scienceTech: (document.getElementById('td-edit-science-tech')?.value ?? student.inputs?.scienceTech ?? '').trim(),
      coreValues: (document.getElementById('td-edit-core-values')?.value ?? student.inputs?.coreValues ?? '').trim(),
      videoStyle: (document.getElementById('td-edit-video-style')?.value ?? student.inputs?.videoStyle ?? '').trim(),
    };

    const response = await fetch('/.netlify/functions/ai-feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'teacher',
        studentId: student.studentId,
        studentName: student.studentName,
        inputs: currentInputs,
      }),
    });

    const data = await response.json().catch(() => ({}));

    if (data && data.quotaExhausted) {
      terminateAllAiFeedbackFeatures();
      return;
    }

    if (!response.ok || !data || !data.ok || !data.teacherFeedback) {
      throw new Error(data?.error || 'AI 피드백 생성에 실패했습니다.');
    }

    // 초등학생이 이해할 수 있는 5줄 이하 피드백을 수정 요청 입력칸에 바로 추가
    const lines = String(data.teacherFeedback)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 5);
    const feedbackText = lines.join('\n');

    const feedbackInput = document.getElementById('teacher-feedback-input');
    if (feedbackInput) {
      feedbackInput.value = feedbackText;
      markTeacherDetailDirty(student.studentId);
      feedbackInput.focus();
    }

    if (data.quotaExhausted) {
      terminateAllAiFeedbackFeatures();
      return;
    }

    showToast(`🤖 ${student.studentName} 학생 맞춤 AI 피드백(5줄 이하)이 수정 요청 칸에 추가되었습니다!`, 'success');
  } catch (err) {
    showToast(err.message || 'AI 피드백 생성 중 오류가 발생했습니다.', 'error');
  } finally {
    state.isRequestingAiFeedback = false;
    updateTeacherAiFeedbackButtonState();
  }
}

function sendRevisionRequest(studentId) {
  const student = findStudentById(studentId);
  if (!student) return;

  const feedbackInput = document.getElementById('teacher-feedback-input');
  const comment = (feedbackInput?.value || '').trim();
  if (!comment) {
    showToast('학생에게 전달할 수정 요청 피드백 코멘트를 입력해 주세요!', 'warning');
    feedbackInput?.focus();
    return;
  }

  try {
    saveTeacherInlineEdits(studentId, true);
  } catch (err) {
    console.warn('인라인 수정 저장 생략:', err);
  }

  student.status = 'revision';
  student.teacherFeedback = comment;
  student.feedbackAt = new Date().toISOString();
  student.updatedAt = new Date().toISOString();

  if (Array.isArray(student.history) && student.history.length > 0) {
    student.history[student.history.length - 1].teacherFeedbackAfter = comment;
  }

  state.teacherDetailDirty = false;
  saveStudentsToLocalStorage();
  syncStudentToCloud(student);
  refreshAllViews(state.currentStudentId === student.studentId);
  renderTeacherDetailPanel(true);

  showToast(`🔄 ${student.studentName} 학생에게 수정 요청 피드백을 발송했습니다!`, 'success');
}

function approveStudentExpo(studentId) {
  const student = findStudentById(studentId);
  if (!student) return;

  const feedbackInput = document.getElementById('teacher-feedback-input');
  const comment = (feedbackInput?.value || '').trim();

  try {
    saveTeacherInlineEdits(studentId, true);
  } catch (err) {
    console.warn('인라인 수정 저장 생략:', err);
  }

  student.status = 'approved';
  if (comment) {
    student.teacherFeedback = comment;
    student.feedbackAt = new Date().toISOString();
  }
  student.videoPrompt = buildPromptFromInputs(student.inputs || {});
  student.specSheet = buildSpecSheetFromInputs(student.inputs || {});
  if (!student.currentVersion || student.currentVersion < 1) {
    student.currentVersion = 1;
  }
  student.updatedAt = new Date().toISOString();

  state.teacherDetailDirty = false;
  saveStudentsToLocalStorage();
  syncStudentToCloud(student);
  refreshAllViews(state.currentStudentId === student.studentId);
  renderTeacherDetailPanel(true);

  showToast(`✅ ${student.studentName} 학생의 로봇 기획서를 [전시승인] 처리했습니다!`, 'success');
}

// ============================================================================
// 9-2. 교사 관리자: 학생 로봇 데이터 직접 수정 및 삭제 기능
// ============================================================================
function openAdminEditStudentModal(studentId) {
  const student = findStudentById(studentId);
  if (!student) return;

  const inp = student.inputs || {};
  setInputValue('admin-edit-target-id', student.studentId);
  setInputValue('admin-edit-student-name', student.studentName || '');
  setInputValue('admin-edit-robot-name', inp.robotName || '');
  setInputValue('admin-edit-status', student.status || 'submitted');
  setInputValue('admin-edit-appearance', inp.appearance || '');
  setInputValue('admin-edit-purpose', inp.purpose || '');
  setInputValue('admin-edit-main-function', inp.mainFunction || '');
  setInputValue('admin-edit-sensor-name', inp.sensorName || '');
  setInputValue('admin-edit-sensor-target', inp.sensorTarget || '');
  setInputValue('admin-edit-sensor-action', inp.sensorAction || '');
  setInputValue('admin-edit-science-tech', inp.scienceTech || '');
  setInputValue('admin-edit-core-values', inp.coreValues || '');
  setInputValue('admin-edit-video-style', inp.videoStyle || '');

  document.getElementById('admin-edit-student-modal')?.classList.remove('hidden');
}

function closeAdminEditStudentModal() {
  document.getElementById('admin-edit-student-modal')?.classList.add('hidden');
}

function saveAdminEditedStudent(event) {
  if (event) event.preventDefault();

  const targetId = (document.getElementById('admin-edit-target-id')?.value || '').trim();
  const student = findStudentById(targetId);
  if (!student) return;

  const newName = (document.getElementById('admin-edit-student-name')?.value || '').trim();
  const newStatus = (document.getElementById('admin-edit-status')?.value || 'submitted').trim();

  const updatedInputs = {
    robotName: (document.getElementById('admin-edit-robot-name')?.value || '').trim(),
    appearance: (document.getElementById('admin-edit-appearance')?.value || '').trim(),
    purpose: (document.getElementById('admin-edit-purpose')?.value || '').trim(),
    mainFunction: (document.getElementById('admin-edit-main-function')?.value || '').trim(),
    sensorName: (document.getElementById('admin-edit-sensor-name')?.value || '').trim(),
    sensorTarget: (document.getElementById('admin-edit-sensor-target')?.value || '').trim(),
    sensorAction: (document.getElementById('admin-edit-sensor-action')?.value || '').trim(),
    scienceTech: (document.getElementById('admin-edit-science-tech')?.value || '').trim(),
    coreValues: formatCoreValuesString(document.getElementById('admin-edit-core-values')?.value || ''),
    videoStyle: (document.getElementById('admin-edit-video-style')?.value || '').trim(),
    customVideoPrompt: student.inputs?.customVideoPrompt || '',
    aiFeedback: student.inputs?.aiFeedback || null,
    boothComments: Array.isArray(student.inputs?.boothComments) ? student.inputs.boothComments : [],
    deletedCommentIds: Array.isArray(student.inputs?.deletedCommentIds) ? student.inputs.deletedCommentIds : [],
  };

  if (!newName || !updatedInputs.robotName) {
    showToast('학생 이름과 로봇 이름은 비워둘 수 없습니다.', 'warning');
    return;
  }

  student.studentName = newName;
  student.status = newStatus;
  student.inputs = updatedInputs;
  student.videoPrompt = (updatedInputs.customVideoPrompt || '').trim() || buildPromptFromInputs(updatedInputs);
  student.specSheet = buildSpecSheetFromInputs(updatedInputs);
  student.updatedAt = new Date().toISOString();

  // 최신 제출 버전 이력도 함께 동기화
  if (Array.isArray(student.history) && student.history.length > 0) {
    const lastVer = student.history[student.history.length - 1];
    lastVer.inputs = JSON.parse(JSON.stringify(updatedInputs));
    lastVer.videoPrompt = student.videoPrompt;
    lastVer.specSheet = JSON.parse(JSON.stringify(student.specSheet));
  }

  state.teacherDetailDirty = false;
  saveStudentsToLocalStorage();
  syncStudentToCloud(student);
  closeAdminEditStudentModal();

  // 현재 로그인한 학생이 수정 대상이면 입력창도 즉시 갱신
  refreshAllViews(state.currentStudentId === student.studentId);
  renderTeacherDetailPanel(true);

  if (state.activeBoothStudentId === student.studentId) {
    openBoothDetailModal(student.studentId);
  }

  showToast(`✏️ ${student.studentName} 학생의 로봇 기획서가 수정되었습니다!`, 'success');
}

function deleteStudentFromEditModal() {
  const targetId = (document.getElementById('admin-edit-target-id')?.value || '').trim();
  if (!targetId) return;
  closeAdminEditStudentModal();
  deleteStudentByAdmin(targetId);
}

async function deleteStudentByAdmin(studentId) {
  const student = findStudentById(studentId);
  if (!student) return;

  const robotLabel = student.inputs?.robotName || '미입력 로봇';
  const confirmed = confirm(
    `정말로 '${student.studentName}' 학생이 제출한 '${robotLabel}' 로봇 데이터를 삭제하시겠습니까?\n\n삭제하면 학생 목록과 박람회 전시관 부스에서 모두 삭제됩니다.`
  );
  if (!confirmed) return;

  const deletedId = String(student.studentId || '').trim();
  const deletedName = String(student.studentName || '').trim();

  // 삭제 시점 기준 Tombstone 기록: 삭제 이전에 생성된 데이터가 다른 기기나 지연 폴링으로 다시 복구되는 현상 원천 차단
  // (삭제 이후 학생이 새로 로그인하여 새로 작성하는 데이터는 updatedAt이 더 최신이므로 정상 기록됨)
  const tombstoneTime = Date.now() + 5000;
  if (!state.deletedMap) state.deletedMap = {};
  if (deletedId) state.deletedMap[deletedId] = tombstoneTime;
  if (deletedName) state.deletedMap[deletedName] = tombstoneTime;
  saveDeletedMapToStorage();

  state.students = state.students.filter((s) => {
    const sId = String(s.studentId || '').trim();
    const sName = String(s.studentName || '').trim();
    return sId !== deletedId && sId !== deletedName && sName !== deletedId && sName !== deletedName;
  });

  if (state.currentStudentId === deletedId || state.currentStudentId === deletedName) {
    if (autoSaveTimer) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = null;
    }
    state.currentStudentId = null;
    localStorage.removeItem(STORAGE_KEYS.CURRENT_STUDENT);
  }

  if (state.selectedTeacherStudentId === deletedId || state.selectedTeacherStudentId === deletedName) {
    state.selectedTeacherStudentId = state.students[0]?.studentId || null;
    state.teacherDetailDirty = false;
  }

  if (state.activeBoothStudentId === deletedId || state.activeBoothStudentId === deletedName) {
    closeBoothDetailModal();
  }

  saveStudentsToLocalStorage();
  refreshAllViews(true);
  renderTeacherDetailPanel(true);
  showToast(`🗑️ '${deletedName}' 학생의 로봇 데이터가 삭제되었습니다.`, 'info');

  await Promise.all([
    deleteStudentFromCloud(deletedId, deletedName),
    syncDeletedMapToCloudGuard(deletedId, null),
  ]);
}

async function deleteStudentFromCloud(studentId, studentName = '') {
  if (!studentId) return;
  state.isSyncing = true;
  try {
    updateSyncStatusHeader('개별 행 삭제 동기화 중...');

    // Supabase 개별 행(Row) 삭제 (전체 테이블 삭제 절대 없음)
    if (isSupabaseConfigured() && supabaseClient) {
      try {
        await supabaseClient
          .from(SUPABASE_TABLE)
          .delete()
          .eq('student_id', studentId);
        if (studentName && studentName !== studentId) {
          await supabaseClient
            .from(SUPABASE_TABLE)
            .delete()
            .eq('student_name', studentName);
        }
      } catch (sbErr) {
        console.warn('Supabase 개별 학생 행 삭제 실패:', sbErr);
      }
    }

    state.lastSyncedAt = new Date().toISOString();
  } catch (err) {
    console.warn('클라우드 학생 삭제 통신 생략:', err);
  } finally {
    state.isSyncing = false;
    updateSyncStatusHeader();
  }
}

const deleteStudentFromGas = deleteStudentFromCloud;

// ============================================================================
// 10. [🕒 수정 이력 보기] (버전 1, 버전 2, 버전 3... 변화 과정 비교 모달)
// ============================================================================
function openHistoryCompareModal(studentId) {
  const student = findStudentById(studentId);
  if (!student) return;

  const modal = document.getElementById('history-compare-modal');
  const titleEl = document.getElementById('history-modal-title');
  const subEl = document.getElementById('history-modal-subtitle');
  const bodyEl = document.getElementById('history-modal-body');
  if (!modal || !bodyEl) return;

  const history = Array.isArray(student.history) ? student.history : [];
  if (titleEl) {
    titleEl.textContent = `🕒 ${student.studentName} 학생의 작성 내용 수정 이력 (총 ${history.length}개 버전)`;
  }
  if (subEl) {
    subEl.textContent = '학생이 수정해서 다시 제출할 때마다 기존 데이터가 덮어씌워지지 않고 버전별로 누적 저장됩니다.';
  }

  if (history.length === 0) {
    bodyEl.innerHTML = `
      <div class="bg-slate-50 rounded-2xl p-10 text-center border border-slate-200">
        <div class="text-3xl mb-2">📝</div>
        <div class="text-sm font-extrabold text-slate-800">아직 제출된 버전 이력이 없습니다 (현재 작성중)</div>
        <p class="text-xs text-slate-500 mt-1">[탭 1: 로봇 설계실]에서 제출 버튼을 누르면 버전 1(최초 제출)부터 누적 기록됩니다.</p>
      </div>
    `;
    modal.classList.remove('hidden');
    return;
  }

  const leftIdx = Math.max(0, history.length - 2);
  const rightIdx = history.length - 1;

  bodyEl.innerHTML = `
    ${history.length >= 2 ? `
      <div class="bg-indigo-50/70 border border-indigo-200 rounded-2xl p-4 space-y-4">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div class="text-xs sm:text-sm font-extrabold text-indigo-950 flex items-center gap-2">
            <span>🔍</span>
            <span>버전 간 작성 내용 변화 비교 (Before ➔ After)</span>
          </div>
          <div class="flex items-center gap-2 text-xs">
            <select id="hist-select-left" onchange="updateHistoryComparisonView('${escapeHtml(student.studentId)}')" class="px-3 py-1.5 rounded-xl border border-indigo-300 bg-white font-bold text-slate-800">
              ${history.map((h, i) => `<option value="${i}" ${i === leftIdx ? 'selected' : ''}>${escapeHtml(h.label || `버전 ${h.version}`)}</option>`).join('')}
            </select>
            <span class="font-extrabold text-indigo-600">➔</span>
            <select id="hist-select-right" onchange="updateHistoryComparisonView('${escapeHtml(student.studentId)}')" class="px-3 py-1.5 rounded-xl border border-indigo-300 bg-white font-bold text-indigo-700">
              ${history.map((h, i) => `<option value="${i}" ${i === rightIdx ? 'selected' : ''}>${escapeHtml(h.label || `버전 ${h.version}`)}</option>`).join('')}
            </select>
          </div>
        </div>

        <div id="history-diff-container">
          ${renderTwoVersionDiffHtml(history[leftIdx], history[rightIdx])}
        </div>
      </div>
    ` : ''}

    <div class="space-y-4">
      <h4 class="text-sm font-extrabold text-slate-900 flex items-center gap-2">
        <span>📚</span>
        <span>전체 누적 제출 버전 타임라인 (${history.length}회)</span>
      </h4>

      <div class="grid grid-cols-1 md:grid-cols-${Math.min(history.length, 3)} gap-4">
        ${history.map((ver) => renderSingleVersionCardHtml(ver)).join('')}
      </div>
    </div>
  `;

  modal.classList.remove('hidden');
}

function updateHistoryComparisonView(studentId) {
  const student = findStudentById(studentId);
  if (!student || !Array.isArray(student.history)) return;

  const leftIdx = Number(document.getElementById('hist-select-left')?.value || 0);
  const rightIdx = Number(document.getElementById('hist-select-right')?.value || 0);
  const container = document.getElementById('history-diff-container');
  if (container && student.history[leftIdx] && student.history[rightIdx]) {
    container.innerHTML = renderTwoVersionDiffHtml(student.history[leftIdx], student.history[rightIdx]);
  }
}

function renderTwoVersionDiffHtml(oldVer, newVer) {
  const fields = [
    { key: 'robotName', label: '1-1. 로봇 이름' },
    { key: 'appearance', label: '1-2. 외형 특징' },
    { key: 'purpose', label: '2. 제작 목적' },
    { key: 'mainFunction', label: '3. 주요 기능' },
    { key: 'sensorName', label: '4-1. 탑재 센서' },
    { key: 'sensorTarget', label: '4-2. 세부 감지 대상' },
    { key: 'sensorAction', label: '4-3. 감지 정보 활용' },
    { key: 'scienceTech', label: '5. 적용 과학 기술' },
    { key: 'coreValues', label: '6. 추구하는 가치' },
    { key: 'videoStyle', label: '7. 영상 스타일' },
  ];

  const rowsHtml = fields.map((f) => {
    const valOld = (oldVer.inputs?.[f.key] || '').trim();
    const valNew = (newVer.inputs?.[f.key] || '').trim();
    const isChanged = valOld !== valNew;
    const charDiff = valNew.length - valOld.length;
    const diffBadge = isChanged
      ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-extrabold ${charDiff >= 0 ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}">
           ✨ 수정됨 (${charDiff >= 0 ? `+${charDiff}자 구체화` : `${charDiff}자`})
         </span>`
      : `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-500">동일</span>`;

    return `
      <div class="bg-white rounded-xl p-3.5 border ${isChanged ? 'border-indigo-300 shadow-sm' : 'border-slate-200'} space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-xs font-extrabold text-slate-800">${f.label}</span>
          ${diffBadge}
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          <div class="p-2.5 rounded-lg bg-slate-50 border border-slate-200 text-slate-600">
            <div class="text-[10px] font-bold text-slate-400 mb-1">${escapeHtml(oldVer.label)} (${valOld.length}자)</div>
            <div>${escapeHtml(valOld || '-')}</div>
          </div>
          <div class="p-2.5 rounded-lg ${isChanged ? 'bg-emerald-50/70 border border-emerald-300 text-slate-900 font-medium' : 'bg-slate-50 border border-slate-200 text-slate-600'}">
            <div class="text-[10px] font-bold ${isChanged ? 'text-emerald-700' : 'text-slate-400'} mb-1">${escapeHtml(newVer.label)} (${valNew.length}자)</div>
            <div>${escapeHtml(valNew || '-')}</div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  return `<div class="space-y-2.5">${rowsHtml}</div>`;
}

function renderSingleVersionCardHtml(ver) {
  const inp = ver.inputs || {};
  return `
    <div class="bg-slate-50 rounded-2xl p-4 border border-slate-200 space-y-3 flex flex-col justify-between">
      <div class="space-y-2.5">
        <div class="flex items-center justify-between border-b border-slate-200 pb-2.5">
          <span class="px-2.5 py-1 rounded-lg bg-slate-900 text-white text-xs font-extrabold">
            ${escapeHtml(ver.label || `버전 ${ver.version}`)}
          </span>
          <span class="text-[11px] text-slate-500 font-medium">
            🕒 ${formatDateTime(ver.submittedAt)}
          </span>
        </div>

        ${ver.teacherFeedbackBefore ? `
          <div class="bg-orange-50 border border-orange-200 rounded-xl p-2.5 text-[11px] text-orange-900">
            <strong>💡 반영한 교사 수정 요청:</strong> “${escapeHtml(ver.teacherFeedbackBefore)}”
          </div>
        ` : ''}

        <div class="space-y-1.5 text-xs text-slate-700">
          <div><strong class="text-slate-900">🤖 로봇명:</strong> ${escapeHtml(inp.robotName || '-')}</div>
          <div><strong class="text-slate-900">🎨 외형:</strong> ${escapeHtml(inp.appearance || '-')}</div>
          <div><strong class="text-slate-900">🎯 목적:</strong> ${escapeHtml(inp.purpose || '-')}</div>
          <div><strong class="text-slate-900">⚙️ 기능:</strong> ${escapeHtml(inp.mainFunction || '-')}</div>
          <div><strong class="text-slate-900">📡 센서:</strong> ${escapeHtml(inp.sensorName || '-')} ➔ ${escapeHtml(inp.sensorTarget || '-')} ➔ ${escapeHtml(inp.sensorAction || '-')}</div>
          <div><strong class="text-slate-900">🔬 과학기술:</strong> ${escapeHtml(inp.scienceTech || '-')}</div>
          <div><strong class="text-slate-900">💎 추구가치:</strong> ${escapeHtml(inp.coreValues || '-')}</div>
          <div><strong class="text-slate-900">🎬 영상스타일:</strong> ${escapeHtml(inp.videoStyle || '-')}</div>
        </div>
      </div>

      <div class="pt-2 border-t border-slate-200">
        <div class="text-[11px] font-bold text-slate-500 mb-1">🎬 당시 생성된 AI 영상 프롬프트:</div>
        <div class="bg-white p-2.5 rounded-xl border border-slate-200 text-[11px] text-slate-600 leading-relaxed">
          ${escapeHtml(ver.videoPrompt || '-')}
        </div>
      </div>
    </div>
  `;
}

function closeHistoryCompareModal() {
  document.getElementById('history-compare-modal')?.classList.add('hidden');
}

// ============================================================================
// 11. Supabase 실시간 DB 설정 모달 (교사 관리자 전용 · 자동 마스킹 & 복사 불가 보호)
// ============================================================================
function maskSecretInput(inputEl) {
  if (!inputEl) return;
  inputEl.type = 'password';
  inputEl.value = MASKED_SECRET_PLACEHOLDER;
  inputEl.dataset.masked = 'true';
  // 복사·잘라내기·드래그·우클릭 원천 차단
  const blockEvent = (e) => {
    e.preventDefault();
    return false;
  };
  inputEl.oncopy = blockEvent;
  inputEl.oncut = blockEvent;
  inputEl.ondragstart = blockEvent;
  inputEl.onselectstart = blockEvent;
  inputEl.oncontextmenu = blockEvent;
}

function handleSecretInputFocus(inputEl) {
  if (!inputEl) return;
  // 입력할 때만 평문 타이핑이 가능하도록 마스킹 플레이스홀더를 비우고 text 모드로 전환 (기존 키는 절대 노출되지 않음)
  if (inputEl.dataset.masked === 'true' || inputEl.value === MASKED_SECRET_PLACEHOLDER) {
    inputEl.value = '';
    inputEl.dataset.masked = 'false';
  }
  inputEl.type = 'text';
}

function handleSecretInputBlur(inputEl) {
  if (!inputEl) return;
  const val = (inputEl.value || '').trim();
  if (!val || val === MASKED_SECRET_PLACEHOLDER) {
    maskSecretInput(inputEl);
  } else {
    // 새로 입력한 값이 있더라도 포커스를 벗어나면 즉시 마스킹 처리
    inputEl.type = 'password';
    inputEl.dataset.masked = 'false';
  }
}

function toggleSupabaseSetupGuide(forceClose = false) {
  const bodyEl = document.getElementById('supabase-setup-guide-body');
  const btnEl = document.getElementById('btn-toggle-supabase-guide');
  if (!bodyEl || !btnEl) return;

  const shouldHide = forceClose ? true : !bodyEl.classList.contains('hidden');
  bodyEl.classList.toggle('hidden', shouldHide);
  btnEl.textContent = shouldHide ? '내용 확인' : '내용 닫기';
}

function openGasConfigModal() {
  const modal = document.getElementById('gas-config-modal');
  if (!modal) return;

  toggleSupabaseSetupGuide(true);

  const sbUrlInput = document.getElementById('supabase-url-input');
  const sbKeyInput = document.getElementById('supabase-key-input');
  const badgeEl = document.getElementById('supabase-badge-status');
  const msgEl = document.getElementById('gas-config-status-msg');

  // 실제 Project URL과 API Key는 입력창에 평문으로 넣지 않고 마스킹 처리 (복사 불가)
  maskSecretInput(sbUrlInput);
  maskSecretInput(sbKeyInput);

  if (badgeEl) {
    if (isSupabaseConfigured()) {
      badgeEl.textContent = '⚡ 실시간 연결됨';
      badgeEl.className = 'px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-emerald-100 text-emerald-800';
    } else {
      badgeEl.textContent = '미설정';
      badgeEl.className = 'px-2.5 py-0.5 rounded-full text-[11px] font-bold bg-slate-200 text-slate-700';
    }
  }

  if (msgEl) {
    if (isSupabaseConfigured()) {
      msgEl.textContent = '🔒 보안 보호 작동 중: 등록된 Project URL과 API Key는 자동 마스킹 및 복사 방지 처리되어 있습니다.';
    } else {
      msgEl.textContent = '💡 Supabase Project URL과 Anon Key를 입력하면 실시간 동기화 및 MP4 영상 파일 공유가 즉시 활성화됩니다.';
    }
  }
  modal.classList.remove('hidden');
}

function closeGasConfigModal() {
  const sbUrlInput = document.getElementById('supabase-url-input');
  const sbKeyInput = document.getElementById('supabase-key-input');
  maskSecretInput(sbUrlInput);
  maskSecretInput(sbKeyInput);
  document.getElementById('gas-config-modal')?.classList.add('hidden');
}

async function saveCloudConfig() {
  const sbUrlInput = document.getElementById('supabase-url-input');
  const sbKeyInput = document.getElementById('supabase-key-input');

  const rawUrlVal = (sbUrlInput?.value || '').trim();
  const rawKeyVal = (sbKeyInput?.value || '').trim();

  const isUrlMasked = !rawUrlVal || sbUrlInput?.dataset.masked === 'true' || rawUrlVal === MASKED_SECRET_PLACEHOLDER;
  const isKeyMasked = !rawKeyVal || sbKeyInput?.dataset.masked === 'true' || rawKeyVal === MASKED_SECRET_PLACEHOLDER;

  const sbUrl = isUrlMasked ? (state.supabaseUrl || DEFAULT_SUPABASE_URL) : rawUrlVal;
  const sbKey = isKeyMasked ? (state.supabaseAnonKey || DEFAULT_SUPABASE_ANON_KEY) : rawKeyVal;

  if (sbUrl && !sbUrl.startsWith('https://')) {
    showToast('올바른 Supabase Project URL(https://xxxx.supabase.co)을 입력해 주세요.', 'warning');
    return;
  }

  state.supabaseUrl = sbUrl;
  state.supabaseAnonKey = sbKey;

  localStorage.setItem(STORAGE_KEYS.SUPABASE_URL, sbUrl);
  localStorage.setItem(STORAGE_KEYS.SUPABASE_ANON_KEY, sbKey);

  // 저장 즉시 다시 마스킹 처리
  maskSecretInput(sbUrlInput);
  maskSecretInput(sbKeyInput);

  initSupabaseClient();
  updateSyncStatusHeader();

  const msgEl = document.getElementById('gas-config-status-msg');
  if (isSupabaseConfigured()) {
    showToast('⚡ Supabase 실시간 DB 및 영상 Storage 설정이 저장되었습니다!', 'success');
    if (msgEl) {
      msgEl.textContent = '🔒 설정이 안전하게 저장되고 마스킹 처리되었습니다.';
    }
    await pullFromCloudNow(false);
  } else {
    showToast('💾 로컬 스토리지 모드로 저장되었습니다.', 'info');
  }
}

function saveGasUrlConfig() {
  return saveCloudConfig();
}

async function testCloudConnection() {
  await saveCloudConfig();
  const msgEl = document.getElementById('gas-config-status-msg');

  if (isSupabaseConfigured() && supabaseClient) {
    try {
      const { data, error } = await supabaseClient
        .from(SUPABASE_TABLE)
        .select('student_id')
        .limit(1);

      if (error) {
        if (msgEl) {
          msgEl.textContent = `❌ Supabase 테이블 조회 오류 (${error.message}). 아래 [📋 Supabase 초기 설정 SQL 복사하기] 버튼을 눌러 SQL Editor에서 실행해 주세요!`;
        }
        showToast('Supabase 테이블(robot_expo_students)이 아직 생성되지 않았거나 권한 설정이 필요합니다.', 'warning');
        return;
      }

      if (msgEl) {
        msgEl.textContent = `✅ Supabase 연결 성공! robot_expo_students 테이블(${data?.length || 0}개 이상 확인) 및 실시간 채널과 정상 통신 중입니다.`;
      }
      showToast('✅ Supabase 실시간 DB 연결 테스트 성공!', 'success');
      return;
    } catch (err) {
      if (msgEl) {
        msgEl.textContent = `❌ Supabase 연결 실패: ${err.message || err}`;
      }
      return;
    }
  }
}

const testGasConnection = testCloudConnection;

const SUPABASE_SETUP_SQL = `-- [2050 로봇 박람회] Supabase 테이블 및 영상 Storage 초기 설정 SQL
create table if not exists public.robot_expo_students (
  student_id text primary key,
  student_name text not null,
  status text not null default 'drafting',
  current_version integer not null default 0,
  teacher_feedback text default '',
  feedback_at text default '',
  updated_at text not null default '',
  inputs jsonb not null default '{}'::jsonb,
  video_prompt text default '',
  spec_sheet jsonb not null default '{}'::jsonb,
  video jsonb not null default '{"type":"none","url":"","fileName":""}'::jsonb,
  history jsonb not null default '[]'::jsonb,
  likes integer not null default 0,
  comments jsonb not null default '[]'::jsonb
);

alter table public.robot_expo_students enable row level security;

drop policy if exists "robot_expo_students_select_all" on public.robot_expo_students;
create policy "robot_expo_students_select_all" on public.robot_expo_students for select to anon, authenticated using (true);

drop policy if exists "robot_expo_students_insert_all" on public.robot_expo_students;
create policy "robot_expo_students_insert_all" on public.robot_expo_students for insert to anon, authenticated with check (true);

drop policy if exists "robot_expo_students_update_all" on public.robot_expo_students;
create policy "robot_expo_students_update_all" on public.robot_expo_students for update to anon, authenticated using (true) with check (true);

drop policy if exists "robot_expo_students_delete_all" on public.robot_expo_students;
create policy "robot_expo_students_delete_all" on public.robot_expo_students for delete to anon, authenticated using (true);

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'robot_expo_students'
  ) then
    alter publication supabase_realtime add table public.robot_expo_students;
  end if;
end $$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('robot-videos', 'robot-videos', true, 52428800, array['video/mp4', 'video/webm', 'video/quicktime'])
on conflict (id) do update set public = true, file_size_limit = 52428800;

drop policy if exists "robot_videos_public_read" on storage.objects;
create policy "robot_videos_public_read" on storage.objects for select to anon, authenticated using (bucket_id = 'robot-videos');

drop policy if exists "robot_videos_public_insert" on storage.objects;
create policy "robot_videos_public_insert" on storage.objects for insert to anon, authenticated with check (bucket_id = 'robot-videos');

drop policy if exists "robot_videos_public_update" on storage.objects;
create policy "robot_videos_public_update" on storage.objects for update to anon, authenticated using (bucket_id = 'robot-videos') with check (bucket_id = 'robot-videos');

drop policy if exists "robot_videos_public_delete" on storage.objects;
create policy "robot_videos_public_delete" on storage.objects for delete to anon, authenticated using (bucket_id = 'robot-videos');`;

async function copySupabaseSetupSql() {
  try {
    await navigator.clipboard.writeText(SUPABASE_SETUP_SQL);
    showToast('📋 Supabase 초기 설정 SQL이 복사되었습니다! Supabase SQL Editor에 붙여넣고 Run을 눌러주세요.', 'success');
  } catch {
    showToast('프로젝트 폴더 내 supabase_setup.sql 파일을 열어 복사해 주세요.', 'info');
  }
}

// ============================================================================
// 12. 유틸리티 함수
// ============================================================================
function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeJsString(str) {
  if (!str) return '';
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, ' ');
}

function formatDateTime(isoStr) {
  if (!isoStr) return '-';
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return isoStr;
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${month}월 ${day}일 ${hours}:${minutes}`;
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const colorMap = {
    success: 'bg-slate-900 text-white border-emerald-500',
    warning: 'bg-amber-600 text-white border-amber-400',
    error: 'bg-rose-600 text-white border-rose-400',
    info: 'bg-slate-800 text-white border-blue-400',
  };

  const toast = document.createElement('div');
  toast.className = `pointer-events-auto px-4 py-3 rounded-2xl shadow-xl border-l-4 text-xs sm:text-sm font-bold flex items-center gap-2 transition-all duration-300 ${colorMap[type] || colorMap.info}`;
  toast.innerHTML = `<span>${escapeHtml(message)}</span>`;

  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
    setTimeout(() => toast.remove(), 250);
  }, 3200);
}
