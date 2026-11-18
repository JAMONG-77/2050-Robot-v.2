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
  SUPABASE_URL: 'robot_expo_2050_supabase_url_v3',
  SUPABASE_ANON_KEY: 'robot_expo_2050_supabase_key_v3',
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
const DEFAULT_SUPABASE_URL = 'https://yjjsjththyqmotencrvq.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlqanNqdGh0aHlxbW90ZW5jcnZxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ5NzQ3MDAsImV4cCI6MjExMDU1MDcwMH0.htPOHRj4nKyIy6sCdh8sXrPJR_jh5A3M4JvsdCQ1fZ8';
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
  // 기존 Supabase에서 백업된 학생 22명 및 응원 댓글 156개 데이터 보존 (영상 제외)
  const preserved = [{"studentId":"김지아","studentName":"김지아","status":"drafting","inputs":{"robotName":"","appearance":"","purpose":"","mainFunction":"","sensorName":"","sensorTarget":"","sensorAction":"","scienceTech":"","coreValues":"","videoStyle":"","customVideoPrompt":"","aiFeedback":null,"boothComments":[],"deletedCommentIds":[]},"videoPrompt":"","specSheet":{},"teacherFeedback":"","feedbackAt":"","video":{"type":"none","url":"","title":"","thumbnail":""},"likes":0,"currentVersion":0,"history":[],"updatedAt":"2026-11-16T23:44:44.634Z"},{"studentId":"김서은","studentName":"김서은","status":"drafting","inputs":{"robotName":"","appearance":"","purpose":"","mainFunction":"","sensorName":"","sensorTarget":"","sensorAction":"","scienceTech":"","coreValues":"","videoStyle":"","customVideoPrompt":"","aiFeedback":null,"boothComments":[],"deletedCommentIds":[]},"videoPrompt":"","specSheet":{},"teacherFeedback":"","feedbackAt":"","video":{"type":"none","url":"","title":"","thumbnail":""},"likes":0,"currentVersion":0,"history":[],"updatedAt":"2026-11-17T00:00:49.013Z"},{"studentId":"김지안","studentName":"김지안","status":"approved","inputs":{"robotName":"Cozy-bot1","appearance":"기분 좋을 때는 은은한 빛, 쉬는 시간에는 빛이 꺼짐,따뜻한 목소리껴안아도 딱딱하지 않게, 안쪽은 기계지만 겉은 쿠션 같은 느낌팔은 짧은 곰돌이 인형 팔 같이, 손은 손바닥 모양 정도로 단순함,몸을 감싸는 부분은 부드러운 패브릭 재질(인형 느낌)","purpose":"맞벌이 때문에 부모님이 없는집에서 로봇이 아기를 돌봄","mainFunction":"몸안에 있는 센서로 먼지가 있거나 공기가 안 좋을때 부모에게 가습기등을 틀어야한다고 연락을 함,몸 중간에 있는 화면으로 아이에게 교육함.","sensorName":"공기 질 센서,카메라 센서","sensorTarget":"미세먼지나 공기 질, 아이의 표정과 감정,","sensorAction":"미세먼지나 공기가 안좋다고 느낄때 부모에게 가습기등을 틀어야 한다고 연락을 함,카메라로 아이를 찍어서 지금 기분과 감정이 어떤지 분석해서 그에 맞게 분유를 먹이거나 놀아줌","scienceTech":"얼굴 표정·목소리 톤을 인공지능으로 분석해서 부모와 아이의 감정을 읽고, 맞춤 위로·응원 메시지를 제공하는 기술,집의 조명·에어컨·가습기와 연결해서 온도·습도·공기 상태를 자동 조절해 “아이 키우기 좋은 집안 환경”을 만드는 기술,아이가 책·장난감을 들고 오면 자동으로 관련 동화 읽기, 영어 단어 놀이 등 교육 콘텐츠를 실행하는 기술.","coreValues":"#생명존중 #지속가능성 #따뜻한돌봄","videoStyle":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)","customVideoPrompt":"[AI 영상 제작] 따뜻한 햇살과 미래형 스마트 가전이 어우러진 2050년 미래 가정 실내 공간에서, 기분 좋을 때는 은은한 빛, 쉬는 시간에는 빛이 꺼짐,따뜻한 목소리껴안아도 딱딱하지 않게, 안쪽은 기계지만 겉은 쿠션 같은 느낌팔은 짧은 곰돌이 인형 팔 같이,곰돌이 인형모양 생김새, 손은 손바닥 모양 정도로 단순함,몸을 감싸는 부분은 부드러운 패브릭 재질 외형을 갖춘 로봇 'Cozy-bot1'이 화면 중앙에 등장해서 2~3살 정도 되보이는 아이를 케어하고 놀아주며 생동감 있게 움직이는 영상. 장착된 공기 질 센서,카메라 센서에 푸른 스캔 라이트가 켜지며(미세먼지나 공기 질, 아이의 표정과 감정,) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 사람 곁으로 부드럽게 다가가 친근한 제스처와 따뜻한 라이트로 다정하게 교감하며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상.","aiFeedback":null,"boothComments":[{"v":2,"id":"c_1794788838051_e84dw","text":"부모님이 없어도 아이들이 안심하며 놀 것 같아","author":"진연우","createdAt":"2026-11-16T00:27:18.051Z","viewerToken":"vt_1794788838051_mpwskv0k","authorStudentId":"진연우"},{"v":2,"id":"c_1794796203501_lia41","text":"👶🐻👶🐻👶🐻👶🐻👶🐻👶🐻👶🐻👶🐻👶🐻👶🐻👶🐻👶🐻👶","author":"신연호","createdAt":"2026-11-16T02:30:03.503Z","viewerToken":"vt_1794788851253_3o74q6xc","authorStudentId":"신연호"},{"v":2,"id":"c_1794796209378_pknv9","text":"아기들이 엄청 좋아할것 같아 엄청 따뜻한 느낌이들어","author":"김지아","createdAt":"2026-11-16T02:30:09.378Z","updatedAt":"2026-11-16T02:30:28.484Z","viewerToken":"vt_1794796098329_ixf8fbb4","authorStudentId":"김지아"},{"v":2,"id":"c_1794796263860_ve3sa","text":"친절해서 아이들과 잘 어울려 놀것같아","author":"신다빈","createdAt":"2026-11-16T02:31:03.861Z","viewerToken":"vt_1794796192899_42ggb0j9","authorStudentId":"신다빈"},{"v":2,"id":"c_1794796742034_mds3z","text":"아이들이 좋아할 것 같아 포근한 곰인형이랑 잘 놀 것 같아","author":"장서윤","createdAt":"2026-11-16T02:39:02.034Z","viewerToken":"vt_1794796665307_ra6syqil","authorStudentId":"장서윤"},{"v":2,"id":"c_1794799265772_pf954","text":"집에 있으면 엄청 좋을것 같다! 만들어지면 하나 사봐도 좋겠는데?","author":"박성민","createdAt":"2026-11-16T03:21:05.775Z","viewerToken":"vt_1794797170972_uk8wojcz","authorStudentId":"박성민"},{"v":2,"id":"c_1794799392021_zux8k","text":"반려로봇으로 키워도 될것 같다ㅏㅏㅏ 카와이♡♡","author":"이수아","createdAt":"2026-11-16T03:23:12.021Z","viewerToken":"vt_1794799212191_bqc4jkhg","authorStudentId":"이수아"},{"v":2,"id":"c_1794799422134_kky9i","text":"애기들이 좋아할거같고 부드러워 보인다","author":"진예원","createdAt":"2026-11-16T03:23:42.134Z","viewerToken":"vt_1794796813857_o43fsiny","authorStudentId":"진예원"},{"v":2,"id":"c_1794873241422_1qire","text":"우와와와와와와와와와와와와와어ㅏ어ㅓㅏ아아아 너무 멋진걸?","author":"김민재","createdAt":"2026-11-16T23:54:01.423Z","updatedAt":"2026-11-16T23:54:32.113Z","viewerToken":"vt_1794796308439_8yzbw3eg","authorStudentId":"김민재"},{"v":2,"id":"c_1794873529664_z2ib6","text":"너무 귀여워!! 나중에 유용하게 쓰일 것 같아!!","author":"공인경","createdAt":"2026-11-16T23:58:49.664Z","viewerToken":"vt_1794799986519_qjpt3033","authorStudentId":"공인경"},{"v":2,"id":"c_1794873545276_4c7h5","text":"이야..................","author":"김승윤","createdAt":"2026-11-16T23:59:05.277Z","viewerToken":"vt_1794796086113_pfa1lkx5","authorStudentId":"김승윤"},{"v":2,"id":"c_1794873685944_uqtit","text":"Amazing and amazing,","author":"이석준","createdAt":"2026-11-17T00:01:25.944Z","viewerToken":"vt_1794799215240_tjkhcvj5","authorStudentId":"이석준"},{"v":2,"id":"c_1794873867155_t4zl2","text":"와멋z다 5 이것은 멋져 와ㅏㅏㅏㅏㅏㅏㅏ","author":"이원준","createdAt":"2026-11-17T00:04:27.155Z","viewerToken":"vt_1794873057588_6rghf8uo","authorStudentId":"이원준"}],"deletedCommentIds":["c_1794873314673_806nj"]},"videoPrompt":"[AI 영상 제작] 따뜻한 햇살과 미래형 스마트 가전이 어우러진 2050년 미래 가정 실내 공간에서, 기분 좋을 때는 은은한 빛, 쉬는 시간에는 빛이 꺼짐,따뜻한 목소리껴안아도 딱딱하지 않게, 안쪽은 기계지만 겉은 쿠션 같은 느낌팔은 짧은 곰돌이 인형 팔 같이,곰돌이 인형모양 생김새, 손은 손바닥 모양 정도로 단순함,몸을 감싸는 부분은 부드러운 패브릭 재질 외형을 갖춘 로봇 'Cozy-bot1'이 화면 중앙에 등장해서 2~3살 정도 되보이는 아이를 케어하고 놀아주며 생동감 있게 움직이는 영상. 장착된 공기 질 센서,카메라 센서에 푸른 스캔 라이트가 켜지며(미세먼지나 공기 질, 아이의 표정과 감정,) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 사람 곁으로 부드럽게 다가가 친근한 제스처와 따뜻한 라이트로 다정하게 교감하며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상.","specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"맞벌이 때문에 부모님이 없는집에서 로봇이 아기를 돌봄"},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#생명존중 #지속가능성 #따뜻한돌봄"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"얼굴 표정·목소리 톤을 인공지능으로 분석해서 부모와 아이의 감정을 읽고, 맞춤 위로·응원 메시지를 제공하는 기술,집의 조명·에어컨·가습기와 연결해서 온도·습도·공기 상태를 자동 조절해 “아이 키우기 좋은 집안 환경”을 만드는 기술,아이가 책·장난감을 들고 오면 자동으로 관련 동화 읽기, 영어 단어 놀이 등 교육 콘텐츠를 실행하는 기술."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"몸안에 있는 센서로 먼지가 있거나 공기가 안 좋을때 부모에게 가습기등을 틀어야한다고 연락을 함,몸 중간에 있는 화면으로 아이에게 교육함."},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"공기 질 센서,카메라 센서","sensorAction":"미세먼지나 공기가 안좋다고 느낄때 부모에게 가습기등을 틀어야 한다고 연락을 함,카메라로 아이를 찍어서 지금 기분과 감정이 어떤지 분석해서 그에 맞게 분유를 먹이거나 놀아줌","sensorTarget":"미세먼지나 공기 질, 아이의 표정과 감정,"},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"Cozy-bot1","appearance":"기분 좋을 때는 은은한 빛, 쉬는 시간에는 빛이 꺼짐,따뜻한 목소리껴안아도 딱딱하지 않게, 안쪽은 기계지만 겉은 쿠션 같은 느낌팔은 짧은 곰돌이 인형 팔 같이, 손은 손바닥 모양 정도로 단순함,몸을 감싸는 부분은 부드러운 패브릭 재질(인형 느낌)"}},"teacherFeedback":"","feedbackAt":"","video":{"type":"none","url":"","title":"","thumbnail":""},"likes":13,"currentVersion":2,"history":[{"label":"버전 1 (최초 제출)","inputs":{"purpose":"맞벌이 때문에 부모님이 없는집에서 로봇이 아기를 돌봄","robotName":"Cozy-bot1","aiFeedback":null,"appearance":"기분 좋을 때는 은은한 빛, 쉬는 시간에는 빛이 꺼짐,따뜻한 목소리. 껴안아도 딱딱하지 않게, 안쪽은 기계지만 겉은 쿠션 같은 느낌. 팔은 짧은 곰돌이 인형 팔 같이, 손은 손바닥 모양 정도로 단순함,몸을 감싸는 부분은 부드러운 패브릭 재질(인형 느낌)","coreValues":"#생명존중 #지속가능성 #따뜻한돌봄","sensorName":"공기 질 센서, 카메라 센서","videoStyle":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)","scienceTech":"얼굴 표정·목소리 톤을 인공지능으로 분석해서 부모와 아이의 감정을 읽고, 맞춤 위로·응원 메시지를 제공하는 기술,집의 조명·에어컨·가습기와 연결해서 온도·습도·공기 상태를 자동 조절해 “아이 키우기 좋은 집안 환경”을 만드는 기술,아이가 책·장난감을 들고 오면 자동으로 관련 동화 읽기, 영어 단어 놀이 등 교육 콘텐츠를 실행하는 기술.","mainFunction":"몸안에 있는 센서로 먼지가 있거나 공기가 안 좋을때 부모에게 가습기 등을 틀어야한다고 연락을 함, 몸 중간에 있는 화면으로 아이에게 교육함.","sensorAction":"미세먼지나 공기가 안좋다고 느낄 때 부모에게 가습기 등을 틀어야 한다고 연락을 함,카메라로 아이를 찍어서 지금 기분과 감정이 어떤지 분석해서 그에 맞게 분유를 먹이거나 놀아줌","sensorTarget":"미세먼지나 공기 질, 아이의 표정과 감정","boothComments":[{"v":2,"id":"c_1794788838051_e84dw","text":"부모님이 없어도 아이들이 안심하며 놀 것 같아","author":"진연우","createdAt":"2026-11-16T00:27:18.051Z","viewerToken":"vt_1794788838051_mpwskv0k","authorStudentId":"진연우"}],"customVideoPrompt":"","deletedCommentIds":[]},"version":1,"specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"맞벌이 때문에 부모님이 없는집에서 로봇이 아기를 돌봄"},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#생명존중 #지속가능성 #따뜻한돌봄"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"얼굴 표정·목소리 톤을 인공지능으로 분석해서 부모와 아이의 감정을 읽고, 맞춤 위로·응원 메시지를 제공하는 기술,집의 조명·에어컨·가습기와 연결해서 온도·습도·공기 상태를 자동 조절해 “아이 키우기 좋은 집안 환경”을 만드는 기술,아이가 책·장난감을 들고 오면 자동으로 관련 동화 읽기, 영어 단어 놀이 등 교육 콘텐츠를 실행하는 기술."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"몸안에 있는 센서로 먼지가 있거나 공기가 안 좋을때 부모에게 가습기 등을 틀어야한다고 연락을 함, 몸 중간에 있는 화면으로 아이에게 교육함."},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"공기 질 센서, 카메라 센서","sensorAction":"미세먼지나 공기가 안좋다고 느낄 때 부모에게 가습기 등을 틀어야 한다고 연락을 함,카메라로 아이를 찍어서 지금 기분과 감정이 어떤지 분석해서 그에 맞게 분유를 먹이거나 놀아줌","sensorTarget":"미세먼지나 공기 질, 아이의 표정과 감정"},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"Cozy-bot1","appearance":"기분 좋을 때는 은은한 빛, 쉬는 시간에는 빛이 꺼짐,따뜻한 목소리. 껴안아도 딱딱하지 않게, 안쪽은 기계지만 겉은 쿠션 같은 느낌. 팔은 짧은 곰돌이 인형 팔 같이, 손은 손바닥 모양 정도로 단순함,몸을 감싸는 부분은 부드러운 패브릭 재질(인형 느낌)"}},"submittedAt":"2026-11-16T00:17:33.683Z","videoPrompt":"[AI 영상 제작] 따뜻한 햇살과 미래형 스마트 가전이 어우러진 2050년 미래 가정 실내 공간에서, 기분 좋을 때는 은은한 빛, 쉬는 시간에는 빛이 꺼짐,따뜻한 목소리, 껴안아도 딱딱하지 않게, 안쪽은 기계지만 겉은 쿠션 같은 느낌, 팔은 짧은 곰돌이 인형 팔 같이, 손은 손바닥 모양 정도로 단순함,몸을 감싸는 부분은 부드러운 패브릭 재질 외형을 갖춘 로봇 'Cozy-bot1'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 공기 질 센서, 카메라 센서에 푸른 스캔 라이트가 켜지며(미세먼지나 공기 질, 아이의 표정과 감정) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 사람 곁으로 부드럽게 다가가 친근한 제스처와 따뜻한 라이트로 다정하게 교감하며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상.","teacherFeedbackBefore":""},{"label":"버전 2 (1차 수정)","inputs":{"purpose":"맞벌이 때문에 부모님이 없는집에서 로봇이 아기를 돌봄","robotName":"Cozy-bot1","aiFeedback":null,"appearance":"기분 좋을 때는 은은한 빛, 쉬는 시간에는 빛이 꺼짐,따뜻한 목소리껴안아도 딱딱하지 않게, 안쪽은 기계지만 겉은 쿠션 같은 느낌팔은 짧은 곰돌이 인형 팔 같이, 손은 손바닥 모양 정도로 단순함,몸을 감싸는 부분은 부드러운 패브릭 재질(인형 느낌)","coreValues":"#생명존중 #지속가능성 #따뜻한돌봄","sensorName":"공기 질 센서,카메라 센서","videoStyle":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)","scienceTech":"얼굴 표정·목소리 톤을 인공지능으로 분석해서 부모와 아이의 감정을 읽고, 맞춤 위로·응원 메시지를 제공하는 기술,집의 조명·에어컨·가습기와 연결해서 온도·습도·공기 상태를 자동 조절해 “아이 키우기 좋은 집안 환경”을 만드는 기술,아이가 책·장난감을 들고 오면 자동으로 관련 동화 읽기, 영어 단어 놀이 등 교육 콘텐츠를 실행하는 기술.","mainFunction":"몸안에 있는 센서로 먼지가 있거나 공기가 안 좋을때 부모에게 가습기등을 틀어야한다고 연락을 함,몸 중간에 있는 화면으로 아이에게 교육함.","sensorAction":"미세먼지나 공기가 안좋다고 느낄때 부모에게 가습기등을 틀어야 한다고 연락을 함,카메라로 아이를 찍어서 지금 기분과 감정이 어떤지 분석해서 그에 맞게 분유를 먹이거나 놀아줌","sensorTarget":"미세먼지나 공기 질, 아이의 표정과 감정,","boothComments":[{"v":2,"id":"c_1794788838051_e84dw","text":"부모님이 없어도 아이들이 안심하며 놀 것 같아","author":"진연우","createdAt":"2026-11-16T00:27:18.051Z","viewerToken":"vt_1794788838051_mpwskv0k","authorStudentId":"진연우"}],"customVideoPrompt":"[AI 영상 제작] 따뜻한 햇살과 미래형 스마트 가전이 어우러진 2050년 미래 가정 실내 공간에서, 기분 좋을 때는 은은한 빛, 쉬는 시간에는 빛이 꺼짐,따뜻한 목소리껴안아도 딱딱하지 않게, 안쪽은 기계지만 겉은 쿠션 같은 느낌팔은 짧은 곰돌이 인형 팔 같이,곰돌이 인형모양 생김새, 손은 손바닥 모양 정도로 단순함,몸을 감싸는 부분은 부드러운 패브릭 재질 외형을 갖춘 로봇 'Cozy-bot1'이 화면 중앙에 등장해서 2~3살 정도 되보이는 아이를 케어하고 놀아주며 생동감 있게 움직이는 영상. 장착된 공기 질 센서,카메라 센서에 푸른 스캔 라이트가 켜지며(미세먼지나 공기 질, 아이의 표정과 감정,) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 사람 곁으로 부드럽게 다가가 친근한 제스처와 따뜻한 라이트로 다정하게 교감하며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상.","deletedCommentIds":[]},"version":2,"specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"맞벌이 때문에 부모님이 없는집에서 로봇이 아기를 돌봄"},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#생명존중 #지속가능성 #따뜻한돌봄"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"얼굴 표정·목소리 톤을 인공지능으로 분석해서 부모와 아이의 감정을 읽고, 맞춤 위로·응원 메시지를 제공하는 기술,집의 조명·에어컨·가습기와 연결해서 온도·습도·공기 상태를 자동 조절해 “아이 키우기 좋은 집안 환경”을 만드는 기술,아이가 책·장난감을 들고 오면 자동으로 관련 동화 읽기, 영어 단어 놀이 등 교육 콘텐츠를 실행하는 기술."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"몸안에 있는 센서로 먼지가 있거나 공기가 안 좋을때 부모에게 가습기등을 틀어야한다고 연락을 함,몸 중간에 있는 화면으로 아이에게 교육함."},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"공기 질 센서,카메라 센서","sensorAction":"미세먼지나 공기가 안좋다고 느낄때 부모에게 가습기등을 틀어야 한다고 연락을 함,카메라로 아이를 찍어서 지금 기분과 감정이 어떤지 분석해서 그에 맞게 분유를 먹이거나 놀아줌","sensorTarget":"미세먼지나 공기 질, 아이의 표정과 감정,"},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"Cozy-bot1","appearance":"기분 좋을 때는 은은한 빛, 쉬는 시간에는 빛이 꺼짐,따뜻한 목소리껴안아도 딱딱하지 않게, 안쪽은 기계지만 겉은 쿠션 같은 느낌팔은 짧은 곰돌이 인형 팔 같이, 손은 손바닥 모양 정도로 단순함,몸을 감싸는 부분은 부드러운 패브릭 재질(인형 느낌)"}},"submittedAt":"2026-11-16T00:30:41.644Z","videoPrompt":"[AI 영상 제작] 따뜻한 햇살과 미래형 스마트 가전이 어우러진 2050년 미래 가정 실내 공간에서, 기분 좋을 때는 은은한 빛, 쉬는 시간에는 빛이 꺼짐,따뜻한 목소리껴안아도 딱딱하지 않게, 안쪽은 기계지만 겉은 쿠션 같은 느낌팔은 짧은 곰돌이 인형 팔 같이,곰돌이 인형모양 생김새, 손은 손바닥 모양 정도로 단순함,몸을 감싸는 부분은 부드러운 패브릭 재질 외형을 갖춘 로봇 'Cozy-bot1'이 화면 중앙에 등장해서 2~3살 정도 되보이는 아이를 케어하고 놀아주며 생동감 있게 움직이는 영상. 장착된 공기 질 센서,카메라 센서에 푸른 스캔 라이트가 켜지며(미세먼지나 공기 질, 아이의 표정과 감정,) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 사람 곁으로 부드럽게 다가가 친근한 제스처와 따뜻한 라이트로 다정하게 교감하며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상.","teacherFeedbackBefore":""}],"updatedAt":"2026-11-17T00:04:27.155Z"},{"studentId":"김민재","studentName":"김민재","status":"approved","inputs":{"robotName":"Silver Guardian X-777","appearance":"둥근머리에 네모난 몸통, 그리고 튼튼한 다리 두껍고 길며, 팔은 얇고 관절이 360°돌아가 유연성이 뛰어남. 키는 190cm, 몸무게는 30kg, 이 가볍고 큰 키로 뛰어난 달리기 빠르기를 보여줌. 얼굴이 달려있는 인간형 ai로봇임.","purpose":"미래에 고령화와 저출산 문제로 인해서 요양원에 노인들은 많아지고 그 노인들을 돌보는 청년들이 없어져 요양원이 문을 닫는 현상이 일어남.","mainFunction":"열 감지센서로 사람의 온도를 보고, 사람의 평균 온도를 넘자마자 의사에게 알림. 카메라 센서로 사람의 움직임을 보아 위험하다면 바로 튼튼한 다리를 이용해 사람을 구해줌","sensorName":"카메라 센서, 심박 센서, 움직임 센서","sensorTarget":"사람의 모습, 사람의 심박수, 사람이 어떻게 움직이는지 정밀하게 감지한다.","sensorAction":"노인들의 얼굴을  확인하여 그 노인이 매일 먹는 약을 그 노인에게 줌. 사람의 심박수를 감지해서 심박수가 적게 뜨면 바로 의사를 부른다. 사람의 움직임울 감지해서 위험한 곳에 가면 바로 그 앞길을 막는다.","scienceTech":"음성 인식으로 노인이 하는 말을 다 알아들어 노인들이 시키는 대로 함. 무선 충전으로 누가 충전 하지 않아도 자기가 직접 가서 충전하고 줄이 없어서 누가 걸려 넘어지는 일도 없음.","coreValues":"#생명존중 #따뜻한돌봄","videoStyle":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)","customVideoPrompt":"[AI 영상 제작] 따뜻한 햇살과 미래형 스마트 가전이 어우러진 2050년 미래 요양원 실내 공간에서, 둥근머리에 네모난 몸통, 그리고 튼튼한 다리 두껍고 길며, 팔은 얇고 관절이 360°돌아가 유연성이 뛰어남, 키는 190cm, 몸무게는 30kg, 이 가볍고 큰 키로 뛰어난 달리기 빠르기를 보여줌, 얼굴이 달려있는 인간형 ai로봇임 외형을 갖춘 로봇 'Silver Guardian X-777'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 카메라 센서, 심박 센서, 움직임 센서에 푸른 스캔 라이트가 켜지며(사람의 모습, 사람의 심박수, 사람이 어떻게 움직이는지 정밀하게) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, \"스캔을 완료했습니다\"를 한국어로 말하고, 로봇이 80세로 추정되는 나이를 가진 노인 곁으로 부드럽게 다가가 친근한 제스처와 따뜻한 라이트로 다정하게 교감하며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상. 다리는 두개야 두개.","aiFeedback":null,"boothComments":[{"v":2,"id":"c_1794873177321_z6ivu","text":"오오오오오오오오오오오오오오오 아이디어가 좋아","author":"장서윤","createdAt":"2026-11-16T23:52:57.321Z","updatedAt":"2026-11-17T00:06:26.848Z","viewerToken":"vt_1794796665307_ra6syqil","authorStudentId":"장서윤"},{"v":2,"id":"c_1794873363405_ewlsw","text":"역쉬 김민재크~~~~~~~~~~~~~b","author":"신연호","createdAt":"2026-11-16T23:56:03.405Z","viewerToken":"vt_1794788851253_3o74q6xc","authorStudentId":"신연호"},{"v":2,"id":"c_1794873792723_czv89","text":"너무 신기해.너무 신기해.너무 신기해.","author":"김규혁","createdAt":"2026-11-17T00:03:12.723Z","viewerToken":"vt_1794796116808_09f96gop","authorStudentId":"김규혁"},{"v":2,"id":"c_1794873927325_wbwsd","text":"좋은 아이디어 인것 같아.👴👵🧓","author":"진연우","createdAt":"2026-11-17T00:05:27.325Z","viewerToken":"vt_1794788838051_mpwskv0k","authorStudentId":"진연우"},{"v":2,"id":"c_1794874027811_3j12f","text":"으아ㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏ!","author":"김승윤","createdAt":"2026-11-17T00:07:07.812Z","viewerToken":"vt_1794796086113_pfa1lkx5","authorStudentId":"김승윤"},{"v":2,"id":"c_1794874107746_tc3v6","text":"오 브로 이것은 엄청난 로봇이다 브로 브로👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍","author":"이원준","createdAt":"2026-11-17T00:08:27.746Z","viewerToken":"vt_1794873057588_6rghf8uo","authorStudentId":"이원준"},{"v":2,"id":"c_1794874134591_jnj4j","text":"우와ㅏ360도 돌아간다니 신기해!! 근데 이렇게 하면 고령화가 더 늘어날수 있지 않을까..?💦","author":"김지아","createdAt":"2026-11-17T00:08:54.591Z","viewerToken":"vt_1794796098329_ixf8fbb4","authorStudentId":"김지아"}],"deletedCommentIds":["c_1794873415639_gy3kg","c_1794873706088_yaymy","c_1794873745368_5wzob"]},"videoPrompt":"[AI 영상 제작] 따뜻한 햇살과 미래형 스마트 가전이 어우러진 2050년 미래 요양원 실내 공간에서, 둥근머리에 네모난 몸통, 그리고 튼튼한 다리 두껍고 길며, 팔은 얇고 관절이 360°돌아가 유연성이 뛰어남, 키는 190cm, 몸무게는 30kg, 이 가볍고 큰 키로 뛰어난 달리기 빠르기를 보여줌, 얼굴이 달려있는 인간형 ai로봇임 외형을 갖춘 로봇 'Silver Guardian X-777'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 카메라 센서, 심박 센서, 움직임 센서에 푸른 스캔 라이트가 켜지며(사람의 모습, 사람의 심박수, 사람이 어떻게 움직이는지 정밀하게) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, \"스캔을 완료했습니다\"를 한국어로 말하고, 로봇이 80세로 추정되는 나이를 가진 노인 곁으로 부드럽게 다가가 친근한 제스처와 따뜻한 라이트로 다정하게 교감하며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상. 다리는 두개야 두개.","specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"미래에 고령화와 저출산 문제로 인해서 요양원에 노인들은 많아지고 그 노인들을 돌보는 청년들이 없어져 요양원이 문을 닫는 현상이 일어남."},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#생명존중 #따뜻한돌봄"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"음성 인식으로 노인이 하는 말을 다 알아들어 노인들이 시키는 대로 함. 무선 충전으로 누가 충전 하지 않아도 자기가 직접 가서 충전하고 줄이 없어서 누가 걸려 넘어지는 일도 없음."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"열 감지센서로 사람의 온도를 보고, 사람의 평균 온도를 넘자마자 의사에게 알림. 카메라 센서로 사람의 움직임을 보아 위험하다면 바로 튼튼한 다리를 이용해 사람을 구해줌"},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"카메라 센서, 심박 센서, 움직임 센서","sensorAction":"노인들의 얼굴을  확인하여 그 노인이 매일 먹는 약을 그 노인에게 줌. 사람의 심박수를 감지해서 심박수가 적게 뜨면 바로 의사를 부른다. 사람의 움직임울 감지해서 위험한 곳에 가면 바로 그 앞길을 막는다.","sensorTarget":"사람의 모습, 사람의 심박수, 사람이 어떻게 움직이는지 정밀하게 감지한다."},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"Silver Guardian X-777","appearance":"둥근머리에 네모난 몸통, 그리고 튼튼한 다리 두껍고 길며, 팔은 얇고 관절이 360°돌아가 유연성이 뛰어남. 키는 190cm, 몸무게는 30kg, 이 가볍고 큰 키로 뛰어난 달리기 빠르기를 보여줌. 얼굴이 달려있는 인간형 ai로봇임."}},"teacherFeedback":"영상 프롬프트를 수정해주세요.\n1. 로봇이 사용되는 장소에 대한 설명\n2. 로봇이 다루는 사람(노인) 설정\n3. 로봇의 구체적인 행동","feedbackAt":"2026-11-16T03:36:16.144Z","video":{"type":"none","url":"","title":"","thumbnail":""},"likes":7,"currentVersion":7,"history":[{"label":"버전 6 (5차 수정)","inputs":{"purpose":"미래에 고령화와 저출산 문제로 인해서 요양원에 노인들은 많아지고 그 노인들을 돌보는 청년들이 없어져 요양원이 문을 닫는 현상이 일어남.","robotName":"Silver Guardian X-777","aiFeedback":null,"appearance":"둥근머리에 네모난 몸통, 그리고 튼튼한 다리 두껍고 길며, 팔은 얇고 관절이 360°돌아가 유연성이 뛰어남. 키는 190cm, 몸무게는 30kg, 이 가볍고 큰 키로 뛰어난 달리기 빠르기를 보여줌. 얼굴이 달려있는 인간형 ai로봇임.","coreValues":"#생명존중 #따뜻한돌봄","sensorName":"카메라 센서, 심박 센서, 움직임 센서","videoStyle":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)","scienceTech":"음성 인식으로 노인이 하는 말을 다 알아들어 노인들이 시키는 대로 함. 무선 충전으로 누가 충전 하지 않아도 자기가 직접 가서 충전하고 줄이 없어서 누가 걸려 넘어지는 일도 없음.","mainFunction":"열 감지센서로 사람의 온도를 보고, 사람의 평균 온도를 넘자마자 의사에게 알림. 카메라 센서로 사람의 움직임을 보아 위험하다면 바로 튼튼한 다리를 이용해 사람을 구해줌","sensorAction":"노인들의 얼굴을  확인하여 그 노인이 매일 먹는 약을 그 노인에게 줌. 사람의 심박수를 감지해서 심박수가 적게 뜨면 바로 의사를 부른다. 사람의 움직임울 감지해서 위험한 곳에 가면 바로 그 앞길을 막는다.","sensorTarget":"사람의 모습, 사람의 심박수, 사람이 어떻게 움직이는지 정밀하게 감지한다.","boothComments":[],"customVideoPrompt":"[AI 영상 제작] 따뜻한 햇살과 미래형 스마트 가전이 어우러진 2050년 미래 요양원 실내 공간에서, 둥근머리에 네모난 몸통, 그리고 튼튼한 다리 두껍고 길며, 팔은 얇고 관절이 360°돌아가 유연성이 뛰어남, 키는 190cm, 몸무게는 30kg, 이 가볍고 큰 키로 뛰어난 달리기 빠르기를 보여줌, 얼굴이 달려있는 인간형 ai로봇임 외형을 갖춘 로봇 'Silver Guardian X-777'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 카메라 센서, 심박 센서, 움직임 센서에 푸른 스캔 라이트가 켜지며(사람의 모습, 사람의 심박수, 사람이 어떻게 움직이는지 정밀하게) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, \"스캔을 완료했습니다\"를 한국어로 말하고, 로봇이 80세로 추정되는 나이를 가진 노인 곁으로 부드럽게 다가가 친근한 제스처와 따뜻한 라이트로 다정하게 교감하며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상.","deletedCommentIds":[]},"version":6,"specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"미래에 고령화와 저출산 문제로 인해서 요양원에 노인들은 많아지고 그 노인들을 돌보는 청년들이 없어져 요양원이 문을 닫는 현상이 일어남."},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#생명존중 #따뜻한돌봄"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"음성 인식으로 노인이 하는 말을 다 알아들어 노인들이 시키는 대로 함. 무선 충전으로 누가 충전 하지 않아도 자기가 직접 가서 충전하고 줄이 없어서 누가 걸려 넘어지는 일도 없음."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"열 감지센서로 사람의 온도를 보고, 사람의 평균 온도를 넘자마자 의사에게 알림. 카메라 센서로 사람의 움직임을 보아 위험하다면 바로 튼튼한 다리를 이용해 사람을 구해줌"},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"카메라 센서, 심박 센서, 움직임 센서","sensorAction":"노인들의 얼굴을  확인하여 그 노인이 매일 먹는 약을 그 노인에게 줌. 사람의 심박수를 감지해서 심박수가 적게 뜨면 바로 의사를 부른다. 사람의 움직임울 감지해서 위험한 곳에 가면 바로 그 앞길을 막는다.","sensorTarget":"사람의 모습, 사람의 심박수, 사람이 어떻게 움직이는지 정밀하게 감지한다."},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"Silver Guardian X-777","appearance":"둥근머리에 네모난 몸통, 그리고 튼튼한 다리 두껍고 길며, 팔은 얇고 관절이 360°돌아가 유연성이 뛰어남. 키는 190cm, 몸무게는 30kg, 이 가볍고 큰 키로 뛰어난 달리기 빠르기를 보여줌. 얼굴이 달려있는 인간형 ai로봇임."}},"submittedAt":"2026-11-16T02:43:42.909Z","videoPrompt":"[AI 영상 제작] 따뜻한 햇살과 미래형 스마트 가전이 어우러진 2050년 미래 요양원 실내 공간에서, 둥근머리에 네모난 몸통, 그리고 튼튼한 다리 두껍고 길며, 팔은 얇고 관절이 360°돌아가 유연성이 뛰어남, 키는 190cm, 몸무게는 30kg, 이 가볍고 큰 키로 뛰어난 달리기 빠르기를 보여줌, 얼굴이 달려있는 인간형 ai로봇임 외형을 갖춘 로봇 'Silver Guardian X-777'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 카메라 센서, 심박 센서, 움직임 센서에 푸른 스캔 라이트가 켜지며(사람의 모습, 사람의 심박수, 사람이 어떻게 움직이는지 정밀하게) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, \"스캔을 완료했습니다\"를 한국어로 말하고, 로봇이 80세로 추정되는 나이를 가진 노인 곁으로 부드럽게 다가가 친근한 제스처와 따뜻한 라이트로 다정하게 교감하며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상.","teacherFeedbackBefore":"영상 프롬프트를 수정해주세요.\n1. 로봇이 사용되는 장소에 대한 설명\n2. 로봇이 다루는 사람(노인) 설정\n3. 로봇의 구체적인 행동"},{"label":"버전 7 (6차 수정)","inputs":{"purpose":"미래에 고령화와 저출산 문제로 인해서 요양원에 노인들은 많아지고 그 노인들을 돌보는 청년들이 없어져 요양원이 문을 닫는 현상이 일어남.","robotName":"Silver Guardian X-777","aiFeedback":null,"appearance":"둥근머리에 네모난 몸통, 그리고 튼튼한 다리 두껍고 길며, 팔은 얇고 관절이 360°돌아가 유연성이 뛰어남. 키는 190cm, 몸무게는 30kg, 이 가볍고 큰 키로 뛰어난 달리기 빠르기를 보여줌. 얼굴이 달려있는 인간형 ai로봇임.","coreValues":"#생명존중 #따뜻한돌봄","sensorName":"카메라 센서, 심박 센서, 움직임 센서","videoStyle":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)","scienceTech":"음성 인식으로 노인이 하는 말을 다 알아들어 노인들이 시키는 대로 함. 무선 충전으로 누가 충전 하지 않아도 자기가 직접 가서 충전하고 줄이 없어서 누가 걸려 넘어지는 일도 없음.","mainFunction":"열 감지센서로 사람의 온도를 보고, 사람의 평균 온도를 넘자마자 의사에게 알림. 카메라 센서로 사람의 움직임을 보아 위험하다면 바로 튼튼한 다리를 이용해 사람을 구해줌","sensorAction":"노인들의 얼굴을  확인하여 그 노인이 매일 먹는 약을 그 노인에게 줌. 사람의 심박수를 감지해서 심박수가 적게 뜨면 바로 의사를 부른다. 사람의 움직임울 감지해서 위험한 곳에 가면 바로 그 앞길을 막는다.","sensorTarget":"사람의 모습, 사람의 심박수, 사람이 어떻게 움직이는지 정밀하게 감지한다.","boothComments":[],"customVideoPrompt":"[AI 영상 제작] 따뜻한 햇살과 미래형 스마트 가전이 어우러진 2050년 미래 요양원 실내 공간에서, 둥근머리에 네모난 몸통, 그리고 튼튼한 다리 두껍고 길며, 팔은 얇고 관절이 360°돌아가 유연성이 뛰어남, 키는 190cm, 몸무게는 30kg, 이 가볍고 큰 키로 뛰어난 달리기 빠르기를 보여줌, 얼굴이 달려있는 인간형 ai로봇임 외형을 갖춘 로봇 'Silver Guardian X-777'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 카메라 센서, 심박 센서, 움직임 센서에 푸른 스캔 라이트가 켜지며(사람의 모습, 사람의 심박수, 사람이 어떻게 움직이는지 정밀하게) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, \"스캔을 완료했습니다\"를 한국어로 말하고, 로봇이 80세로 추정되는 나이를 가진 노인 곁으로 부드럽게 다가가 친근한 제스처와 따뜻한 라이트로 다정하게 교감하며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상. 다리는 두개야 두개.","deletedCommentIds":[]},"version":7,"specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"미래에 고령화와 저출산 문제로 인해서 요양원에 노인들은 많아지고 그 노인들을 돌보는 청년들이 없어져 요양원이 문을 닫는 현상이 일어남."},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#생명존중 #따뜻한돌봄"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"음성 인식으로 노인이 하는 말을 다 알아들어 노인들이 시키는 대로 함. 무선 충전으로 누가 충전 하지 않아도 자기가 직접 가서 충전하고 줄이 없어서 누가 걸려 넘어지는 일도 없음."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"열 감지센서로 사람의 온도를 보고, 사람의 평균 온도를 넘자마자 의사에게 알림. 카메라 센서로 사람의 움직임을 보아 위험하다면 바로 튼튼한 다리를 이용해 사람을 구해줌"},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"카메라 센서, 심박 센서, 움직임 센서","sensorAction":"노인들의 얼굴을  확인하여 그 노인이 매일 먹는 약을 그 노인에게 줌. 사람의 심박수를 감지해서 심박수가 적게 뜨면 바로 의사를 부른다. 사람의 움직임울 감지해서 위험한 곳에 가면 바로 그 앞길을 막는다.","sensorTarget":"사람의 모습, 사람의 심박수, 사람이 어떻게 움직이는지 정밀하게 감지한다."},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"Silver Guardian X-777","appearance":"둥근머리에 네모난 몸통, 그리고 튼튼한 다리 두껍고 길며, 팔은 얇고 관절이 360°돌아가 유연성이 뛰어남. 키는 190cm, 몸무게는 30kg, 이 가볍고 큰 키로 뛰어난 달리기 빠르기를 보여줌. 얼굴이 달려있는 인간형 ai로봇임."}},"submittedAt":"2026-11-16T03:08:56.504Z","videoPrompt":"[AI 영상 제작] 따뜻한 햇살과 미래형 스마트 가전이 어우러진 2050년 미래 요양원 실내 공간에서, 둥근머리에 네모난 몸통, 그리고 튼튼한 다리 두껍고 길며, 팔은 얇고 관절이 360°돌아가 유연성이 뛰어남, 키는 190cm, 몸무게는 30kg, 이 가볍고 큰 키로 뛰어난 달리기 빠르기를 보여줌, 얼굴이 달려있는 인간형 ai로봇임 외형을 갖춘 로봇 'Silver Guardian X-777'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 카메라 센서, 심박 센서, 움직임 센서에 푸른 스캔 라이트가 켜지며(사람의 모습, 사람의 심박수, 사람이 어떻게 움직이는지 정밀하게) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, \"스캔을 완료했습니다\"를 한국어로 말하고, 로봇이 80세로 추정되는 나이를 가진 노인 곁으로 부드럽게 다가가 친근한 제스처와 따뜻한 라이트로 다정하게 교감하며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상. 다리는 두개야 두개.","teacherFeedbackBefore":"영상 프롬프트를 수정해주세요.\n1. 로봇이 사용되는 장소에 대한 설명\n2. 로봇이 다루는 사람(노인) 설정\n3. 로봇의 구체적인 행동"}],"updatedAt":"2026-11-17T00:08:54.591Z"},{"studentId":"김재용","studentName":"김재용","status":"approved","inputs":{"robotName":"포레스트엑스","appearance":"크기는 작은 강아지 정도 생김새는 다람쥐이며  카메라 눈 2개 위에는 긴 안테나 1개 짧은 다리4개 등에는 태양광 패널이 있다.","purpose":"불씨나 연기를 발견해서 사람과 소방서에 바로 알려주어 화재에 의한 피해를 줄인다.","mainFunction":"불씨가 작을 때는 젤 형 소화제와 같이 화재가 진압되는 소화액으로 동물에게는 피해와 해롭게 되지 안되도록 불이 난 곳을 뿌린다 팔 부분에서 소화액이 나온다.","sensorName":"온도 센서,습도 센서,소리센서,가스센서","sensorTarget":"동물의 움직임을 보고 전방 20m내에 있는 불을 확인한다.","sensorAction":"동물들을 화재난 곳으로 부터 멀리하고 소방서 등에 알린다.","scienceTech":"인공지능(AI)사물 인식 기능으로 불과 동물을 구분한다. 등에있는 패널로 에너지를 아낀다.","coreValues":"#생태계보존 #지속가능성 #안전한사회","videoStyle":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)","customVideoPrompt":"[AI 영상 제작] 연기와 불길이 많으면은 안되고 긴박한 미래 산림·도심 재난 구조 현장에서, 크기는 작은 강아지 정도 생김새는 무조건 다람쥐이며 카메라 눈 2개 위에는 긴 안테나 1개 짧은 다리4개 등에는 태양광 패널이 있다 외형을 갖춘 로봇 '포레스트엑스'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 온도 센서,습도 센서,소리센서,에 푸른 스캔 라이트가 켜지며(동물의 움직임을 보고 전방 20m내에 있는 불을 확인한다)이때 동물은 있어야 하며 대피하고 있어야 한다. 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 주변 생물과 장애물을 민첩하게 방향을 틀어 자연스럽게 재빨리 회피 이동하며, 강력한 소화 분사 장치를 가동 했을 때 불길이 바로 완전히 꺼져야한다.  안전 통로를 확보하며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상.","aiFeedback":{"date":"2026-11-16","count":1,"step1":"귀여운 다람쥐 모양에 태양광 패널까지 정말 멋진 아이디어예요! 다만 이 로봇이 험한 산속을 잘 달릴 수 있도록 다리의 관절이 어떻게 움직이는지 모터 구조를 조금 더 자세히 적어주면 완벽할 거예요.","step2":"산불을 미리 막아서 소중한 동물과 자연을 지키려는 마음이 참 따뜻해요! 불을 끄는 것뿐만 아니라 건조한 날씨를 미리 예측해서 산불을 예방하는 목적을 더해보면 더욱 멋진 로봇이 될 거예요.","step3":"친환경 소화액으로 동물을 보호하며 불을 끄는 기능이 아주 훌륭해요! 소화액을 멀리까지 뿜어내기 위해 어떤 펌프 장치나 기계 팔 구조를 사용하는지 적어보면 훨씬 더 실감 나는 로봇이 될 거예요.","step4":"온도와 연기를 감지하는 센서 작동 순서를 아주 잘 적어주었어요! 여기에 연기 냄새를 맡는 가스 센서를 추가하고, 위험을 감지하면 소방서로 위치 정보를 보내는 무선 통신 행동을 적어보세요.","step5":"인공지능으로 불과 동물을 구분하고 태양광 에너지를 쓰는 점이 정말 훌륭해요! 여기에 햇빛이 없을 때를 대비해 에너지를 저장하는 친환경 배터리 기술이나 가벼운 신소재를 함께 적어주면 과학적으로 더 완벽해져요.","updatedAt":"2026-11-16T02:31:37.325Z"},"boothComments":[{"v":2,"id":"c_1794799332323_3twdr","text":"로봇이 동물들과 자연을 지키는 것이 멋져! 아이디어가 좋아!","author":"장서윤","createdAt":"2026-11-16T03:22:12.324Z","viewerToken":"vt_1794796665307_ra6syqil","authorStudentId":"장서윤"},{"v":2,"id":"c_1794873207800_wxe9j","text":"불울 끄고 야생동물들을 지켜주는 로봇이라니 멋지다","author":"박성민","createdAt":"2026-11-16T23:53:27.800Z","viewerToken":"vt_1794797170972_uk8wojcz","authorStudentId":"박성민"},{"v":2,"id":"c_1794873836502_ur8dl","text":"우와ㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏ","author":"김승윤","createdAt":"2026-11-17T00:03:56.502Z","viewerToken":"vt_1794796086113_pfa1lkx5","authorStudentId":"김승윤"},{"v":2,"id":"c_1794874180753_w4yei","text":"산불로 인해 피해보는 동물들이 줄어들 것 같아","author":"진연우","createdAt":"2026-11-17T00:09:40.753Z","viewerToken":"vt_1794788838051_mpwskv0k","authorStudentId":"진연우"}],"deletedCommentIds":[]},"videoPrompt":"[AI 영상 제작] 연기와 불길이 많으면은 안되고 긴박한 미래 산림·도심 재난 구조 현장에서, 크기는 작은 강아지 정도 생김새는 무조건 다람쥐이며 카메라 눈 2개 위에는 긴 안테나 1개 짧은 다리4개 등에는 태양광 패널이 있다 외형을 갖춘 로봇 '포레스트엑스'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 온도 센서,습도 센서,소리센서,에 푸른 스캔 라이트가 켜지며(동물의 움직임을 보고 전방 20m내에 있는 불을 확인한다)이때 동물은 있어야 하며 대피하고 있어야 한다. 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 주변 생물과 장애물을 민첩하게 방향을 틀어 자연스럽게 재빨리 회피 이동하며, 강력한 소화 분사 장치를 가동 했을 때 불길이 바로 완전히 꺼져야한다.  안전 통로를 확보하며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상.","specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"불씨나 연기를 발견해서 사람과 소방서에 바로 알려주어 화재에 의한 피해를 줄인다."},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#생태계보존 #지속가능성 #안전한사회"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"인공지능(AI)사물 인식 기능으로 불과 동물을 구분한다. 등에있는 패널로 에너지를 아낀다."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"불씨가 작을 때는 젤 형 소화제와 같이 화재가 진압되는 소화액으로 동물에게는 피해와 해롭게 되지 안되도록 불이 난 곳을 뿌린다 팔 부분에서 소화액이 나온다."},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"온도 센서,습도 센서,소리센서,가스센서","sensorAction":"동물들을 화재난 곳으로 부터 멀리하고 소방서 등에 알린다.","sensorTarget":"동물의 움직임을 보고 전방 20m내에 있는 불을 확인한다."},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"포레스트엑스","appearance":"크기는 작은 강아지 정도 생김새는 다람쥐이며  카메라 눈 2개 위에는 긴 안테나 1개 짧은 다리4개 등에는 태양광 패널이 있다."}},"teacherFeedback":"","feedbackAt":"","video":{"type":"none","url":"","title":"","thumbnail":""},"likes":4,"currentVersion":2,"history":[{"label":"버전 1 (최초 제출)","inputs":{"purpose":"불씨나 연기를 발견해서 사람과 소방서에 바로 알려주어 화재에 의한 피해를 줄인다.","robotName":"포레스트엑스","aiFeedback":{"date":"2026-11-16","count":1,"step1":"귀여운 다람쥐 모양에 태양광 패널까지 정말 멋진 아이디어예요! 다만 이 로봇이 험한 산속을 잘 달릴 수 있도록 다리의 관절이 어떻게 움직이는지 모터 구조를 조금 더 자세히 적어주면 완벽할 거예요.","step2":"산불을 미리 막아서 소중한 동물과 자연을 지키려는 마음이 참 따뜻해요! 불을 끄는 것뿐만 아니라 건조한 날씨를 미리 예측해서 산불을 예방하는 목적을 더해보면 더욱 멋진 로봇이 될 거예요.","step3":"친환경 소화액으로 동물을 보호하며 불을 끄는 기능이 아주 훌륭해요! 소화액을 멀리까지 뿜어내기 위해 어떤 펌프 장치나 기계 팔 구조를 사용하는지 적어보면 훨씬 더 실감 나는 로봇이 될 거예요.","step4":"온도와 연기를 감지하는 센서 작동 순서를 아주 잘 적어주었어요! 여기에 연기 냄새를 맡는 가스 센서를 추가하고, 위험을 감지하면 소방서로 위치 정보를 보내는 무선 통신 행동을 적어보세요.","step5":"인공지능으로 불과 동물을 구분하고 태양광 에너지를 쓰는 점이 정말 훌륭해요! 여기에 햇빛이 없을 때를 대비해 에너지를 저장하는 친환경 배터리 기술이나 가벼운 신소재를 함께 적어주면 과학적으로 더 완벽해져요.","updatedAt":"2026-11-16T02:31:37.325Z"},"appearance":"크기는 작은 강아지 정도 생김새는 다람쥐이며  카메라 눈 2개 위에는 긴 안테나 1개와 짧은 다리 4개가 있다. 등에는 태양광 패널이 있다.","coreValues":"#생태계보존 #지속가능성 #안전한사회","sensorName":"온도 센서,습도 센서,소리센서,가스센서","videoStyle":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)","scienceTech":"인공지능(AI)사물 인식 기능으로 불과 동물을 구분한다. 등에있는 패널로 에너지를 아낀다.","mainFunction":"불씨가 작을 때는 젤 형 소화제와 같이 화재가 진압되는 소화액으로 동물에게는 피해와 해롭게 되지 안되도록 불이 난 곳을 뿌린다. 팔 부분에서 소화액이 나온다.","sensorAction":"동물들을 화재난 곳으로 부터 멀리하고 소방서 등에 알린다.","sensorTarget":"동물의 움직임을 보고 전방 20m내에 있는 불을 확인한다.","boothComments":[],"customVideoPrompt":"","deletedCommentIds":[]},"version":1,"specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"불씨나 연기를 발견해서 사람과 소방서에 바로 알려주어 화재에 의한 피해를 줄인다."},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#생태계보존 #지속가능성 #안전한사회"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"인공지능(AI)사물 인식 기능으로 불과 동물을 구분한다. 등에있는 패널로 에너지를 아낀다."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"불씨가 작을 때는 젤 형 소화제와 같이 화재가 진압되는 소화액으로 동물에게는 피해와 해롭게 되지 안되도록 불이 난 곳을 뿌린다. 팔 부분에서 소화액이 나온다."},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"온도 센서,습도 센서,소리센서,가스센서","sensorAction":"동물들을 화재난 곳으로 부터 멀리하고 소방서 등에 알린다.","sensorTarget":"동물의 움직임을 보고 전방 20m내에 있는 불을 확인한다."},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"포레스트엑스","appearance":"크기는 작은 강아지 정도 생김새는 다람쥐이며  카메라 눈 2개 위에는 긴 안테나 1개와 짧은 다리 4개가 있다. 등에는 태양광 패널이 있다."}},"submittedAt":"2026-11-16T02:38:10.880Z","videoPrompt":"[AI 영상 제작] 연기와 불길이 피어오르는 긴박한 미래 산림·도심 재난 구조 현장에서, 크기는 작은 강아지 정도 생김새는 다람쥐이며 카메라 눈 2개 위에는 긴 안테나 1개와 짧은 다리 4개가 있다, 등에는 태양광 패널이 있다 외형을 갖춘 로봇 '포레스트엑스'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 온도 센서,습도 센서,소리센서,가스센서에 푸른 스캔 라이트가 켜지며(동물의 움직임을 보고 전방 20m내에 있는 불을 확인한다) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 주변 생물과 장애물을 민첩하게 방향을 틀어 안전하게 회피 이동하며, 강력한 소화 분사 장치를 가동해 불길을 진압하고 안전 통로를 확보하며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상.","teacherFeedbackBefore":""},{"label":"버전 2 (1차 수정)","inputs":{"purpose":"불씨나 연기를 발견해서 사람과 소방서에 바로 알려주어 화재에 의한 피해를 줄인다.","robotName":"포레스트엑스","aiFeedback":{"date":"2026-11-16","count":1,"step1":"귀여운 다람쥐 모양에 태양광 패널까지 정말 멋진 아이디어예요! 다만 이 로봇이 험한 산속을 잘 달릴 수 있도록 다리의 관절이 어떻게 움직이는지 모터 구조를 조금 더 자세히 적어주면 완벽할 거예요.","step2":"산불을 미리 막아서 소중한 동물과 자연을 지키려는 마음이 참 따뜻해요! 불을 끄는 것뿐만 아니라 건조한 날씨를 미리 예측해서 산불을 예방하는 목적을 더해보면 더욱 멋진 로봇이 될 거예요.","step3":"친환경 소화액으로 동물을 보호하며 불을 끄는 기능이 아주 훌륭해요! 소화액을 멀리까지 뿜어내기 위해 어떤 펌프 장치나 기계 팔 구조를 사용하는지 적어보면 훨씬 더 실감 나는 로봇이 될 거예요.","step4":"온도와 연기를 감지하는 센서 작동 순서를 아주 잘 적어주었어요! 여기에 연기 냄새를 맡는 가스 센서를 추가하고, 위험을 감지하면 소방서로 위치 정보를 보내는 무선 통신 행동을 적어보세요.","step5":"인공지능으로 불과 동물을 구분하고 태양광 에너지를 쓰는 점이 정말 훌륭해요! 여기에 햇빛이 없을 때를 대비해 에너지를 저장하는 친환경 배터리 기술이나 가벼운 신소재를 함께 적어주면 과학적으로 더 완벽해져요.","updatedAt":"2026-11-16T02:31:37.325Z"},"appearance":"크기는 작은 강아지 정도 생김새는 다람쥐이며  카메라 눈 2개 위에는 긴 안테나 1개 짧은 다리4개 등에는 태양광 패널이 있다.","coreValues":"#생태계보존 #지속가능성 #안전한사회","sensorName":"온도 센서,습도 센서,소리센서,가스센서","videoStyle":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)","scienceTech":"인공지능(AI)사물 인식 기능으로 불과 동물을 구분한다. 등에있는 패널로 에너지를 아낀다.","mainFunction":"불씨가 작을 때는 젤 형 소화제와 같이 화재가 진압되는 소화액으로 동물에게는 피해와 해롭게 되지 안되도록 불이 난 곳을 뿌린다 팔 부분에서 소화액이 나온다.","sensorAction":"동물들을 화재난 곳으로 부터 멀리하고 소방서 등에 알린다.","sensorTarget":"동물의 움직임을 보고 전방 20m내에 있는 불을 확인한다.","boothComments":[],"customVideoPrompt":"[AI 영상 제작] 연기와 불길이 많으면은 안되고 긴박한 미래 산림·도심 재난 구조 현장에서, 크기는 작은 강아지 정도 생김새는 무조건 다람쥐이며 카메라 눈 2개 위에는 긴 안테나 1개 짧은 다리4개 등에는 태양광 패널이 있다 외형을 갖춘 로봇 '포레스트엑스'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 온도 센서,습도 센서,소리센서,에 푸른 스캔 라이트가 켜지며(동물의 움직임을 보고 전방 20m내에 있는 불을 확인한다)이때 동물은 있어야 하며 대피하고 있어야 한다. 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 주변 생물과 장애물을 민첩하게 방향을 틀어 자연스럽게 재빨리 회피 이동하며, 강력한 소화 분사 장치를 가동 했을 때 불길이 바로 완전히 꺼져야한다.  안전 통로를 확보하며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상.","deletedCommentIds":[]},"version":2,"specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"불씨나 연기를 발견해서 사람과 소방서에 바로 알려주어 화재에 의한 피해를 줄인다."},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#생태계보존 #지속가능성 #안전한사회"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"인공지능(AI)사물 인식 기능으로 불과 동물을 구분한다. 등에있는 패널로 에너지를 아낀다."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"불씨가 작을 때는 젤 형 소화제와 같이 화재가 진압되는 소화액으로 동물에게는 피해와 해롭게 되지 안되도록 불이 난 곳을 뿌린다 팔 부분에서 소화액이 나온다."},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"온도 센서,습도 센서,소리센서,가스센서","sensorAction":"동물들을 화재난 곳으로 부터 멀리하고 소방서 등에 알린다.","sensorTarget":"동물의 움직임을 보고 전방 20m내에 있는 불을 확인한다."},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"포레스트엑스","appearance":"크기는 작은 강아지 정도 생김새는 다람쥐이며  카메라 눈 2개 위에는 긴 안테나 1개 짧은 다리4개 등에는 태양광 패널이 있다."}},"submittedAt":"2026-11-16T03:06:08.859Z","videoPrompt":"[AI 영상 제작] 연기와 불길이 많으면은 안되고 긴박한 미래 산림·도심 재난 구조 현장에서, 크기는 작은 강아지 정도 생김새는 무조건 다람쥐이며 카메라 눈 2개 위에는 긴 안테나 1개 짧은 다리4개 등에는 태양광 패널이 있다 외형을 갖춘 로봇 '포레스트엑스'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 온도 센서,습도 센서,소리센서,에 푸른 스캔 라이트가 켜지며(동물의 움직임을 보고 전방 20m내에 있는 불을 확인한다)이때 동물은 있어야 하며 대피하고 있어야 한다. 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 주변 생물과 장애물을 민첩하게 방향을 틀어 자연스럽게 재빨리 회피 이동하며, 강력한 소화 분사 장치를 가동 했을 때 불길이 바로 완전히 꺼져야한다.  안전 통로를 확보하며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상.","teacherFeedbackBefore":""}],"updatedAt":"2026-11-17T00:09:40.753Z"},{"studentId":"이원준","studentName":"이원준","status":"approved","inputs":{"robotName":"ZAE-tidy","appearance":"바다속에 가야되니까 프로펠러2개 타원형인데 납작한 몸통 몸통의재질은 탄소섬유(카본)+알류미늄 팔은 몸통안에있다가 쓰레기가 발견돼면나오는구조 팔은2개 잡는방법은 집게모양 센서는 초음파 +카매라 카매라는 쓰래기또는철을 감지함 그리고 뒤에는 쓰레기를 담을수 있는 큰통 바다를 정화할수있는 필터 제트스키처럼 물을 빨아 드리면 필터미새플라스틱등 안좋은것을 정화하고 다시 물을 뒷부분구멍으로 내보는 기능 맨뒤에3cm구멍을내고 냉추진기능을 넣는다.","purpose":"바다 또는 해안가에 있는쓰레기를 치우기 위해또는환경을 지키기 위해","mainFunction":"쓰레기를 집게로 집어 치우고 몸통 맨 밎에 비스듬이 구멍을 내서 필터로 오염된 바닷물을 정화한다 팔과 집게는 링크 구조이다.\nㅔ","sensorName":"원주형 초음파 센서","sensorTarget":"앞에 있는 벽 또는 생물 또는 쓰레기","sensorAction":"앞에 생물이 있으면 피해간다 또 벽이 있어도 피해간다","scienceTech":"배터리가 없으면 바다위로 올라가서 태양광패널을 펼친다 펼처서 배터리를 충전한다 만약의 깊은곳에 있으면 프로펠러말고 냉추진가스를 내뿜어 지상으로 빠르게 올라간다 배터리는 압전소자구조이다.","coreValues":"#환경보존#생명존중 #균형","videoStyle":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)","customVideoPrompt":"[AI 영상 제작] 햇빛이 투명하게 투과되는 2050년 푸른 바닷속 수중 생태계와 해안가에서, 프로펠러2개 타원형인데 납작한 몸통 몸통의재질은 탄소섬유+알류미늄 팔은 몸통안에있다가 쓰레기가 발견돼면나오는구조 팔은2개이고 팔은 위에서 나옴 잡는방법은 집게모양 센서는 초음파 +카매라 카매라는 쓰래기또는철을 감지함 그리고 뒤에는 쓰레기를 담을수 있는 큰통과 바다를 정화할수있는 필터 제트스키처럼 물을 빨아 드리면 필터미새플라스틱등 안좋은것을 정화하고 다시 물을 뒷부분구멍으로 내보는 기능 맨뒤에3cm구멍을낸다 넣는다 외형을 갖춘 로봇 'ZAE-tidy'이 화면 중앙에 등장해 생동감 있게 프로펠러로 움직이는 영상. 장착된 원주형 초음파 센서에 푸른 스캔 라이트가 켜지며 쓰레기 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 앞에있는 쓰레기를 집어 올리고 수거 장치를 작동시키며, 몸체의 있는 팔을꺼내 쓰레기를 집어 큰통에 넣는 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상.","aiFeedback":{"date":"2026-11-16","count":3,"step1":"로봇의 이름과 외형 설명이 아주 구체적이라 멋져요! 몸통 재질로 가벼운 탄소섬유를 선택한 점이 훌륭한데, 바닷물 속에서 부력을 어떻게 조절할지 생각해보면 더 완벽해질 거예요.","step2":"환경을 지키려는 마음이 참 따뜻하네요! 단순히 쓰레기를 치우는 것을 넘어, 미세 플라스틱을 걸러내어 해양 생태계를 보호한다는 구체적인 목표를 추가하면 더 멋진 발명품이 될 거예요.","step3":"링크 구조의 팔은 튼튼해서 쓰레기를 잡기 딱 좋겠어요! 쓰레기를 담은 뒤 물속에서 무거워질 텐데, 무게 중심을 잡아주는 밸런스 장치를 추가하면 더 안정적으로 움직일 수 있을 거예요.","step4":"생물과 벽을 피하는 똑똑한 센서 설정이에요! 여기에 '쓰레기 감지 시 집게가 자동으로 작동'하도록 센서와 팔의 동작을 연결하는 단계를 더 자세히 적어보세요.","step5":"태양광 충전과 압전소자를 활용한 아이디어가 정말 기발해요! 냉추진 가스 대신 해수 온도 차이를 이용한 발전 기술을 더해보면 훨씬 더 친환경적인 미래 로봇이 될 거예요.","updatedAt":"2026-11-16T02:28:50.805Z"},"boothComments":[{"v":2,"id":"c_1794873156723_rjd4t","text":"우와! 너무 잘했어 대단해!!!!!!","author":"김승윤","createdAt":"2026-11-16T23:52:36.723Z","viewerToken":"vt_1794796086113_pfa1lkx5","authorStudentId":"김승윤"},{"v":2,"id":"c_1794873618617_lvwt9","text":"저런 로봇은 해양 생태계가 좋아 질 것같아","author":"진연우","createdAt":"2026-11-17T00:00:18.617Z","viewerToken":"vt_1794788838051_mpwskv0k","authorStudentId":"진연우"},{"v":2,"id":"c_1794874117178_ofed0","text":"이야우 정말 머싯다😀😀😀😀😀!","author":"이석준","createdAt":"2026-11-17T00:08:37.179Z","viewerToken":"vt_1794799215240_tjkhcvj5","authorStudentId":"이석준"},{"v":2,"id":"c_1794874278991_bdhu9","text":"바다쓰레기를 수거하는 로봇이라니 참 좋은 아이디어다!!","author":"장서윤","createdAt":"2026-11-17T00:11:18.991Z","viewerToken":"vt_1794796665307_ra6syqil","authorStudentId":"장서윤"}],"deletedCommentIds":[]},"videoPrompt":"[AI 영상 제작] 햇빛이 투명하게 투과되는 2050년 푸른 바닷속 수중 생태계와 해안가에서, 프로펠러2개 타원형인데 납작한 몸통 몸통의재질은 탄소섬유+알류미늄 팔은 몸통안에있다가 쓰레기가 발견돼면나오는구조 팔은2개이고 팔은 위에서 나옴 잡는방법은 집게모양 센서는 초음파 +카매라 카매라는 쓰래기또는철을 감지함 그리고 뒤에는 쓰레기를 담을수 있는 큰통과 바다를 정화할수있는 필터 제트스키처럼 물을 빨아 드리면 필터미새플라스틱등 안좋은것을 정화하고 다시 물을 뒷부분구멍으로 내보는 기능 맨뒤에3cm구멍을낸다 넣는다 외형을 갖춘 로봇 'ZAE-tidy'이 화면 중앙에 등장해 생동감 있게 프로펠러로 움직이는 영상. 장착된 원주형 초음파 센서에 푸른 스캔 라이트가 켜지며 쓰레기 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 앞에있는 쓰레기를 집어 올리고 수거 장치를 작동시키며, 몸체의 있는 팔을꺼내 쓰레기를 집어 큰통에 넣는 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상.","specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"바다 또는 해안가에 있는쓰레기를 치우기 위해또는환경을 지키기 위해"},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#환경보존#생명존중 #균형"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"배터리가 없으면 바다위로 올라가서 태양광패널을 펼친다 펼처서 배터리를 충전한다 만약의 깊은곳에 있으면 프로펠러말고 냉추진가스를 내뿜어 지상으로 빠르게 올라간다 배터리는 압전소자구조이다."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"쓰레기를 집게로 집어 치우고 몸통 맨 밎에 비스듬이 구멍을 내서 필터로 오염된 바닷물을 정화한다 팔과 집게는 링크 구조이다.\nㅔ"},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"원주형 초음파 센서","sensorAction":"앞에 생물이 있으면 피해간다 또 벽이 있어도 피해간다","sensorTarget":"앞에 있는 벽 또는 생물 또는 쓰레기"},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"ZAE-tidy","appearance":"바다속에 가야되니까 프로펠러2개 타원형인데 납작한 몸통 몸통의재질은 탄소섬유(카본)+알류미늄 팔은 몸통안에있다가 쓰레기가 발견돼면나오는구조 팔은2개 잡는방법은 집게모양 센서는 초음파 +카매라 카매라는 쓰래기또는철을 감지함 그리고 뒤에는 쓰레기를 담을수 있는 큰통 바다를 정화할수있는 필터 제트스키처럼 물을 빨아 드리면 필터미새플라스틱등 안좋은것을 정화하고 다시 물을 뒷부분구멍으로 내보는 기능 맨뒤에3cm구멍을내고 냉추진기능을 넣는다."}},"teacherFeedback":"","feedbackAt":"","video":{"type":"none","url":"","title":"","thumbnail":""},"likes":4,"currentVersion":5,"history":[{"label":"버전 4 (3차 수정)","inputs":{"purpose":"바다 또는 해안가에 있는쓰레기를 치우기 위해또는환경을 지키기 위해","robotName":"ZAE-tidy","aiFeedback":{"date":"2026-11-16","count":3,"step1":"로봇의 이름과 외형 설명이 아주 구체적이라 멋져요! 몸통 재질로 가벼운 탄소섬유를 선택한 점이 훌륭한데, 바닷물 속에서 부력을 어떻게 조절할지 생각해보면 더 완벽해질 거예요.","step2":"환경을 지키려는 마음이 참 따뜻하네요! 단순히 쓰레기를 치우는 것을 넘어, 미세 플라스틱을 걸러내어 해양 생태계를 보호한다는 구체적인 목표를 추가하면 더 멋진 발명품이 될 거예요.","step3":"링크 구조의 팔은 튼튼해서 쓰레기를 잡기 딱 좋겠어요! 쓰레기를 담은 뒤 물속에서 무거워질 텐데, 무게 중심을 잡아주는 밸런스 장치를 추가하면 더 안정적으로 움직일 수 있을 거예요.","step4":"생물과 벽을 피하는 똑똑한 센서 설정이에요! 여기에 '쓰레기 감지 시 집게가 자동으로 작동'하도록 센서와 팔의 동작을 연결하는 단계를 더 자세히 적어보세요.","step5":"태양광 충전과 압전소자를 활용한 아이디어가 정말 기발해요! 냉추진 가스 대신 해수 온도 차이를 이용한 발전 기술을 더해보면 훨씬 더 친환경적인 미래 로봇이 될 거예요.","updatedAt":"2026-11-16T02:28:50.805Z"},"appearance":"바다속에 가야되니까 프로펠러2개 타원형인데 납작한 몸통 몸통의재질은 탄소섬유(카본)+알류미늄 팔은 몸통안에있다가 쓰레기가 발견돼면나오는구조 팔은2개 잡는방법은 집게모양 센서는 초음파 +카매라 카매라는 쓰래기또는철을 감지함 그리고 뒤에는 쓰레기를 담을수 있는 큰통 바다를 정화할수있는 필터 제트스키처럼 물을 빨아 드리면 필터미새플라스틱등 안좋은것을 정화하고 다시 물을 뒷부분구멍으로 내보는 기능 맨뒤에3cm구멍을내고 냉추진기능을 넣는다.","coreValues":"#환경보존#생명존중 #균형","sensorName":"원주형 초음파 센서","videoStyle":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)","scienceTech":"배터리가 없으면 바다위로 올라가서 태양광패널을 펼친다 펼처서 배터리를 충전한다 만약의 깊은곳에 있으면 프로펠러말고 냉추진가스를 내뿜어 지상으로 빠르게 올라간다 배터리는 압전소자구조이다.","mainFunction":"쓰레기를 집게로 집어 치우고 몸통 맨 밎에 비스듬이 구멍을 내서 필터로 오염된 바닷물을 정화한다 팔과 집게는 링크 구조이다.\nㅔ","sensorAction":"앞에 생물이 있으면 피해간다 또 벽이 있어도 피해간다","sensorTarget":"앞에 있는 벽 또는 생물 또는 쓰레기","boothComments":[],"customVideoPrompt":"[AI 영상 제작] 햇빛이 투명하게 투과되는 2050년 푸른 바닷속 수중 생태계와 해안가에서, 프로펠러2개 타원형인데 납작한 몸통 몸통의재질은 탄소섬유+알류미늄 팔은 몸통안에있다가 쓰레기가 발견돼면나오는구조 팔은2개이고 팔은 위에서 나옴 잡는방법은 집게모양 센서는 초음파 +카매라 카매라는 쓰래기또는철을 감지함 그리고 뒤에는 쓰레기를 담을수 있는 큰통과 바다를 정화할수있는 필터 제트스키처럼 물을 빨아 드리면 필터미새플라스틱등 안좋은것을 정화하고 다시 물을 뒷부분구멍으로 내보는 기능 맨뒤에3cm구멍을낸다 넣는다 외형을 갖춘 로봇 'ZAE-tidy'이 화면 중앙에 등장해 생동감 있게 프로펠러로 움직이는 영상. 장착된 원주형 초음파 센서에 푸른 스캔 라이트가 켜지며(앞에 있는 벽 또는 생물 또는 쓰레기) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 앞에있는 쓰레기를 집어 올리고 수거 장치를 작동시키며, 몸체의 있는 팔을꺼내 쓰레기를 집어 큰통에 넣는연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상.","deletedCommentIds":[]},"version":4,"specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"바다 또는 해안가에 있는쓰레기를 치우기 위해또는환경을 지키기 위해"},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#환경보존#생명존중 #균형"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"배터리가 없으면 바다위로 올라가서 태양광패널을 펼친다 펼처서 배터리를 충전한다 만약의 깊은곳에 있으면 프로펠러말고 냉추진가스를 내뿜어 지상으로 빠르게 올라간다 배터리는 압전소자구조이다."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"쓰레기를 집게로 집어 치우고 몸통 맨 밎에 비스듬이 구멍을 내서 필터로 오염된 바닷물을 정화한다 팔과 집게는 링크 구조이다.\nㅔ"},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"원주형 초음파 센서","sensorAction":"앞에 생물이 있으면 피해간다 또 벽이 있어도 피해간다","sensorTarget":"앞에 있는 벽 또는 생물 또는 쓰레기"},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"ZAE-tidy","appearance":"바다속에 가야되니까 프로펠러2개 타원형인데 납작한 몸통 몸통의재질은 탄소섬유(카본)+알류미늄 팔은 몸통안에있다가 쓰레기가 발견돼면나오는구조 팔은2개 잡는방법은 집게모양 센서는 초음파 +카매라 카매라는 쓰래기또는철을 감지함 그리고 뒤에는 쓰레기를 담을수 있는 큰통 바다를 정화할수있는 필터 제트스키처럼 물을 빨아 드리면 필터미새플라스틱등 안좋은것을 정화하고 다시 물을 뒷부분구멍으로 내보는 기능 맨뒤에3cm구멍을내고 냉추진기능을 넣는다."}},"submittedAt":"2026-11-16T03:09:23.989Z","videoPrompt":"[AI 영상 제작] 햇빛이 투명하게 투과되는 2050년 푸른 바닷속 수중 생태계와 해안가에서, 프로펠러2개 타원형인데 납작한 몸통 몸통의재질은 탄소섬유+알류미늄 팔은 몸통안에있다가 쓰레기가 발견돼면나오는구조 팔은2개이고 팔은 위에서 나옴 잡는방법은 집게모양 센서는 초음파 +카매라 카매라는 쓰래기또는철을 감지함 그리고 뒤에는 쓰레기를 담을수 있는 큰통과 바다를 정화할수있는 필터 제트스키처럼 물을 빨아 드리면 필터미새플라스틱등 안좋은것을 정화하고 다시 물을 뒷부분구멍으로 내보는 기능 맨뒤에3cm구멍을낸다 넣는다 외형을 갖춘 로봇 'ZAE-tidy'이 화면 중앙에 등장해 생동감 있게 프로펠러로 움직이는 영상. 장착된 원주형 초음파 센서에 푸른 스캔 라이트가 켜지며(앞에 있는 벽 또는 생물 또는 쓰레기) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 앞에있는 쓰레기를 집어 올리고 수거 장치를 작동시키며, 몸체의 있는 팔을꺼내 쓰레기를 집어 큰통에 넣는연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상.","teacherFeedbackBefore":""},{"label":"버전 5 (4차 수정)","inputs":{"purpose":"바다 또는 해안가에 있는쓰레기를 치우기 위해또는환경을 지키기 위해","robotName":"ZAE-tidy","aiFeedback":{"date":"2026-11-16","count":3,"step1":"로봇의 이름과 외형 설명이 아주 구체적이라 멋져요! 몸통 재질로 가벼운 탄소섬유를 선택한 점이 훌륭한데, 바닷물 속에서 부력을 어떻게 조절할지 생각해보면 더 완벽해질 거예요.","step2":"환경을 지키려는 마음이 참 따뜻하네요! 단순히 쓰레기를 치우는 것을 넘어, 미세 플라스틱을 걸러내어 해양 생태계를 보호한다는 구체적인 목표를 추가하면 더 멋진 발명품이 될 거예요.","step3":"링크 구조의 팔은 튼튼해서 쓰레기를 잡기 딱 좋겠어요! 쓰레기를 담은 뒤 물속에서 무거워질 텐데, 무게 중심을 잡아주는 밸런스 장치를 추가하면 더 안정적으로 움직일 수 있을 거예요.","step4":"생물과 벽을 피하는 똑똑한 센서 설정이에요! 여기에 '쓰레기 감지 시 집게가 자동으로 작동'하도록 센서와 팔의 동작을 연결하는 단계를 더 자세히 적어보세요.","step5":"태양광 충전과 압전소자를 활용한 아이디어가 정말 기발해요! 냉추진 가스 대신 해수 온도 차이를 이용한 발전 기술을 더해보면 훨씬 더 친환경적인 미래 로봇이 될 거예요.","updatedAt":"2026-11-16T02:28:50.805Z"},"appearance":"바다속에 가야되니까 프로펠러2개 타원형인데 납작한 몸통 몸통의재질은 탄소섬유(카본)+알류미늄 팔은 몸통안에있다가 쓰레기가 발견돼면나오는구조 팔은2개 잡는방법은 집게모양 센서는 초음파 +카매라 카매라는 쓰래기또는철을 감지함 그리고 뒤에는 쓰레기를 담을수 있는 큰통 바다를 정화할수있는 필터 제트스키처럼 물을 빨아 드리면 필터미새플라스틱등 안좋은것을 정화하고 다시 물을 뒷부분구멍으로 내보는 기능 맨뒤에3cm구멍을내고 냉추진기능을 넣는다.","coreValues":"#환경보존#생명존중 #균형","sensorName":"원주형 초음파 센서","videoStyle":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)","scienceTech":"배터리가 없으면 바다위로 올라가서 태양광패널을 펼친다 펼처서 배터리를 충전한다 만약의 깊은곳에 있으면 프로펠러말고 냉추진가스를 내뿜어 지상으로 빠르게 올라간다 배터리는 압전소자구조이다.","mainFunction":"쓰레기를 집게로 집어 치우고 몸통 맨 밎에 비스듬이 구멍을 내서 필터로 오염된 바닷물을 정화한다 팔과 집게는 링크 구조이다.\nㅔ","sensorAction":"앞에 생물이 있으면 피해간다 또 벽이 있어도 피해간다","sensorTarget":"앞에 있는 벽 또는 생물 또는 쓰레기","boothComments":[],"customVideoPrompt":"[AI 영상 제작] 햇빛이 투명하게 투과되는 2050년 푸른 바닷속 수중 생태계와 해안가에서, 프로펠러2개 타원형인데 납작한 몸통 몸통의재질은 탄소섬유+알류미늄 팔은 몸통안에있다가 쓰레기가 발견돼면나오는구조 팔은2개이고 팔은 위에서 나옴 잡는방법은 집게모양 센서는 초음파 +카매라 카매라는 쓰래기또는철을 감지함 그리고 뒤에는 쓰레기를 담을수 있는 큰통과 바다를 정화할수있는 필터 제트스키처럼 물을 빨아 드리면 필터미새플라스틱등 안좋은것을 정화하고 다시 물을 뒷부분구멍으로 내보는 기능 맨뒤에3cm구멍을낸다 넣는다 외형을 갖춘 로봇 'ZAE-tidy'이 화면 중앙에 등장해 생동감 있게 프로펠러로 움직이는 영상. 장착된 원주형 초음파 센서에 푸른 스캔 라이트가 켜지며 쓰레기 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 앞에있는 쓰레기를 집어 올리고 수거 장치를 작동시키며, 몸체의 있는 팔을꺼내 쓰레기를 집어 큰통에 넣는 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상.","deletedCommentIds":[]},"version":5,"specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"바다 또는 해안가에 있는쓰레기를 치우기 위해또는환경을 지키기 위해"},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#환경보존#생명존중 #균형"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"배터리가 없으면 바다위로 올라가서 태양광패널을 펼친다 펼처서 배터리를 충전한다 만약의 깊은곳에 있으면 프로펠러말고 냉추진가스를 내뿜어 지상으로 빠르게 올라간다 배터리는 압전소자구조이다."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"쓰레기를 집게로 집어 치우고 몸통 맨 밎에 비스듬이 구멍을 내서 필터로 오염된 바닷물을 정화한다 팔과 집게는 링크 구조이다.\nㅔ"},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"원주형 초음파 센서","sensorAction":"앞에 생물이 있으면 피해간다 또 벽이 있어도 피해간다","sensorTarget":"앞에 있는 벽 또는 생물 또는 쓰레기"},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"ZAE-tidy","appearance":"바다속에 가야되니까 프로펠러2개 타원형인데 납작한 몸통 몸통의재질은 탄소섬유(카본)+알류미늄 팔은 몸통안에있다가 쓰레기가 발견돼면나오는구조 팔은2개 잡는방법은 집게모양 센서는 초음파 +카매라 카매라는 쓰래기또는철을 감지함 그리고 뒤에는 쓰레기를 담을수 있는 큰통 바다를 정화할수있는 필터 제트스키처럼 물을 빨아 드리면 필터미새플라스틱등 안좋은것을 정화하고 다시 물을 뒷부분구멍으로 내보는 기능 맨뒤에3cm구멍을내고 냉추진기능을 넣는다."}},"submittedAt":"2026-11-16T03:28:55.773Z","videoPrompt":"[AI 영상 제작] 햇빛이 투명하게 투과되는 2050년 푸른 바닷속 수중 생태계와 해안가에서, 프로펠러2개 타원형인데 납작한 몸통 몸통의재질은 탄소섬유+알류미늄 팔은 몸통안에있다가 쓰레기가 발견돼면나오는구조 팔은2개이고 팔은 위에서 나옴 잡는방법은 집게모양 센서는 초음파 +카매라 카매라는 쓰래기또는철을 감지함 그리고 뒤에는 쓰레기를 담을수 있는 큰통과 바다를 정화할수있는 필터 제트스키처럼 물을 빨아 드리면 필터미새플라스틱등 안좋은것을 정화하고 다시 물을 뒷부분구멍으로 내보는 기능 맨뒤에3cm구멍을낸다 넣는다 외형을 갖춘 로봇 'ZAE-tidy'이 화면 중앙에 등장해 생동감 있게 프로펠러로 움직이는 영상. 장착된 원주형 초음파 센서에 푸른 스캔 라이트가 켜지며 쓰레기 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 앞에있는 쓰레기를 집어 올리고 수거 장치를 작동시키며, 몸체의 있는 팔을꺼내 쓰레기를 집어 큰통에 넣는 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상.","teacherFeedbackBefore":""}],"updatedAt":"2026-11-17T00:11:18.991Z"},{"studentId":"박성민","studentName":"박성민","status":"approved","inputs":{"robotName":"역해킹 로봇","appearance":"휴머노이드 몸체에 오른팔에 미니 컴퓨터가 접혀있다.몸체는 티탄 합금,합성섬유,탄소나노튜브,다이아몬드로 만들어져서 절대 끊어지고 부서지지 않으면서 활동 젤로 만들어져서 더욱 튼튼해지고 부식되지않고 열을 잘 견디고 형상기억합금으로도 코팅되어서 부서지거나 금이가도 복구가 된다,즉 범인이 피해를 가해도 몸체가 스스로 자가복구가 된다.테플론으로 코팅이 되어서 상처가 안나고 설계가 되어서 쉽게 고장나지 않고 자가 변환 기술로 비행기,잠수함등 여러 형태로 변환될수있다.몸체가 접혀고 줄어들고 늘어나는등 여러가지의 변환으로 비행기,잠수함으로 몸체 모양이 변환된다.또 폴리아세틸렌으로 만들어져서 연로가 없이도 햇빛만으로 움직일수있고 스텔스기술로 레이더를 피할수 있다.이기술로 범인의 레이더를 피할수도 있다.메타 머티리얼로 몸체를 바꾸어 빛을 굴절시켜서 투명하게 바꾸어서 은밀하게 접근할수가 있다.쉽게 미끄러지지않도록 생물 신소재 접착체를 첨가해서 미끄러운 공간에서도 범인을 쉽게 쫒을수 있다.","purpose":"AI기술이 매우 발전해서 해킹이 빈번한 시대에서 해킹을 막고 경찰과 같이 체포하고 구속하는 로봇,경찰들과 함께 범인을 찾고 구속,체포를 한다.데이터 복구 기술로 추적에 더 쉽게 도움을 준다.개인이나 기업에서 보안을 위해 사용될수있어서 디지털 보안관 역할을 한다.","mainFunction":"신고를 받고 신고자의 정보를 다운받아서 역으로 기록을 추적하고 상황등을 파악해서 해킹 방법을 예상해서 감시망을 줄이고 범인을 찾아서 경찰에게 연락하여 정보,위치를 알려주거나 경찰과 함께 협동하여서 범인을 구속하고 체포한다.체포를 위해 비행,잠수를 하는데 방수가 되는 디스프로슘과 네오디뮴을 사용한 BLDC모터를 사용해 빠르고 정확하게 쫒아가기도 한다.범인의 현재거리를 분석하고 계산해서 액추에이터로 더욱 빠르거나 힘을 강화시킨다.","sensorName":"음성인식 모듈->신고자 정보 다운로드->기록을 역추적","sensorTarget":"신고를 보내면 신고전파를 잡아서 신고자의 신고를 감지한다.","sensorAction":"신고자의 기록을 다운로드 받아서 방법 예상,역해킹등으로 범인의위치,범인을 알아내서 경찰에게 알리거나 합동하여서 체포한다.적이 사용한 해킹 도구의 GPS위치를 추적해서 위치 찾는데 도움을 준다.공범의 경우 네트워크 패킷으로 연락을 막는다.네트워크 패킷 분석센서도 사용한다.","scienceTech":"신고자의 정보를 이용해서 크래커를 찾아내서 경찰에게 정보를 알려주거나 합동해서 잡는다.신고를 받으면 미니 컴퓨터와 가상의 카보드를 꺼내서 기록으로역추적을 한다.데이터를 들어가서 범인이 더 피해를 주지못하도록 암호를 걸어서 피해를  줄이고 빅테이터를 사용하여 범인의 모든 정보를 알아내서 경찰에게 전달하거나 협동을 해서 체포를 한다.","coreValues":"#범죄 #예방#사생활 #보호","videoStyle":"정밀 메카닉 공학 시뮬레이션 스타일 (로봇 관절 구조와 내부 기계 작동 클로즈업)","customVideoPrompt":"[AI Video Production] In 2050, a scene of a long building receiving a report in the center of a dense city; the humanoid body has a mini computer folded in the right arm. The body is made of titanium alloy, synthetic fibers, carbon nanotubes, and diamonds, making it completely unbreakable and indestructible, while being reinforced with an active gel for enhanced durability, corrosion resistance, and heat resistance, and coated with shape-memory alloy so that it can be repaired even if broken or cracked. In other words, the body self-reduces even if the perpetrator causes damage. Coated with Teflon to prevent scratches, it is designed to be durable, and with self-transformation technology, it can change into various forms such as an airplane or a submarine A video of a humanoid 'reverse hacking robot' appearing at the center of the screen and moving dynamically. The installed voice recognition module, caller information download, and record tracing are vividly demonstrated through a sequence of scenes: a blue scan light turns on upon receiving a report (the system detects the report signal to identify the caller), a close-up scan of the surroundings using 3D holographic wavelengths, and the robot downloading the caller’s records to predict methods, reverse-hack, identify the suspect, notify the police, or work with them to apprehend the criminal, carrying out its mission in continuous operation. A precision mechanical engineering simulation-style video featuring camera tracking that seamlessly transitions from wide shots to close-ups of mechanical joints, enhanced with three-dimensional lighting.","aiFeedback":{"date":"2026-11-16","count":2,"step1":"성민이의 로봇은 정말 튼튼해 보여요! 다만 너무 많은 신소재를 나열하기보다, '형상기억합금'처럼 로봇이 스스로 고쳐지는 원리를 중심으로 설명하면 더 멋질 것 같아요.","step2":"AI 해킹을 막겠다는 목적이 아주 훌륭해요. 단순히 경찰을 돕는 것을 넘어, '사이버 범죄 예방을 위한 디지털 보안관'이라는 구체적인 역할을 강조해 보면 어떨까요?","step3":"모터 종류까지 아주 자세히 알고 있네요! 범인을 잡을 때 필요한 관절의 유연함이나 힘을 조절하는 '액추에이터'의 움직임도 함께 설명하면 로봇의 동작이 더 생생하게 느껴질 거예요.","step4":"센서 단계가 잘 정리되었어요. 음성인식 외에도 범인의 디지털 흔적을 찾는 '네트워크 패킷 분석 센서'라는 이름을 추가하면 훨씬 전문적인 로봇이 될 것 같아요.","step5":"정보를 활용하는 기술은 좋지만, 여기에는 '데이터 암호화'나 '빅데이터 분석' 같은 기술 용어를 넣어보세요. 과학 기술을 로봇의 어떤 행동에 적용할지 한 번 더 연결해 주면 완벽해요!","updatedAt":"2026-11-16T03:32:09.824Z"},"boothComments":[{"v":2,"id":"c_1794873528599_k02ve","text":"요즘엔 해킹이 사회적으로 문제인데 이런 로봇이 있으면 좋을 것같아","author":"진연우","createdAt":"2026-11-16T23:58:48.599Z","viewerToken":"vt_1794788838051_mpwskv0k","authorStudentId":"진연우"},{"v":2,"id":"c_1794873804623_qtfit","text":"키야ㅑㅑㅑㅑㅑㅑㅑㅑㅑㅑㅑㅑㅑㅑㅑㅑㅑ!","author":"김승윤","createdAt":"2026-11-17T00:03:24.623Z","viewerToken":"vt_1794796086113_pfa1lkx5","authorStudentId":"김승윤"},{"v":2,"id":"c_1794874065813_9j98n","text":"해킹을 막는 로봇이라니! 좋은 아이디어다!","author":"장서윤","createdAt":"2026-11-17T00:07:45.813Z","viewerToken":"vt_1794796665307_ra6syqil","authorStudentId":"장서윤"},{"v":2,"id":"c_1794874197406_kb1e5","text":"와우 정말 멋있다 와우우우우우우!!!!","author":"이석준","createdAt":"2026-11-17T00:09:57.406Z","viewerToken":"vt_1794799215240_tjkhcvj5","authorStudentId":"이석준"},{"v":2,"id":"c_1794874295326_vm6pu","text":"우와ㅏ 역해킹이라니!! 해킹한 사람들의 위치를 찾아내서 체포하다니 아이디어 짱짱이닷💡","author":"김지아","createdAt":"2026-11-17T00:11:35.326Z","viewerToken":"vt_1794796098329_ixf8fbb4","authorStudentId":"김지아"}],"deletedCommentIds":[]},"videoPrompt":"[AI Video Production] In 2050, a scene of a long building receiving a report in the center of a dense city; the humanoid body has a mini computer folded in the right arm. The body is made of titanium alloy, synthetic fibers, carbon nanotubes, and diamonds, making it completely unbreakable and indestructible, while being reinforced with an active gel for enhanced durability, corrosion resistance, and heat resistance, and coated with shape-memory alloy so that it can be repaired even if broken or cracked. In other words, the body self-reduces even if the perpetrator causes damage. Coated with Teflon to prevent scratches, it is designed to be durable, and with self-transformation technology, it can change into various forms such as an airplane or a submarine A video of a humanoid 'reverse hacking robot' appearing at the center of the screen and moving dynamically. The installed voice recognition module, caller information download, and record tracing are vividly demonstrated through a sequence of scenes: a blue scan light turns on upon receiving a report (the system detects the report signal to identify the caller), a close-up scan of the surroundings using 3D holographic wavelengths, and the robot downloading the caller’s records to predict methods, reverse-hack, identify the suspect, notify the police, or work with them to apprehend the criminal, carrying out its mission in continuous operation. A precision mechanical engineering simulation-style video featuring camera tracking that seamlessly transitions from wide shots to close-ups of mechanical joints, enhanced with three-dimensional lighting.","specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"AI기술이 매우 발전해서 해킹이 빈번한 시대에서 해킹을 막고 경찰과 같이 체포하고 구속하는 로봇,경찰들과 함께 범인을 찾고 구속,체포를 한다.데이터 복구 기술로 추적에 더 쉽게 도움을 준다.개인이나 기업에서 보안을 위해 사용될수있어서 디지털 보안관 역할을 한다."},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#범죄 #예방#사생활 #보호"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"정밀 메카닉 공학 시뮬레이션 스타일 (로봇 관절 구조와 내부 기계 작동 클로즈업)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"신고자의 정보를 이용해서 크래커를 찾아내서 경찰에게 정보를 알려주거나 합동해서 잡는다.신고를 받으면 미니 컴퓨터와 가상의 카보드를 꺼내서 기록으로역추적을 한다.데이터를 들어가서 범인이 더 피해를 주지못하도록 암호를 걸어서 피해를  줄이고 빅테이터를 사용하여 범인의 모든 정보를 알아내서 경찰에게 전달하거나 협동을 해서 체포를 한다."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"신고를 받고 신고자의 정보를 다운받아서 역으로 기록을 추적하고 상황등을 파악해서 해킹 방법을 예상해서 감시망을 줄이고 범인을 찾아서 경찰에게 연락하여 정보,위치를 알려주거나 경찰과 함께 협동하여서 범인을 구속하고 체포한다.체포를 위해 비행,잠수를 하는데 방수가 되는 디스프로슘과 네오디뮴을 사용한 BLDC모터를 사용해 빠르고 정확하게 쫒아가기도 한다.범인의 현재거리를 분석하고 계산해서 액추에이터로 더욱 빠르거나 힘을 강화시킨다."},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"음성인식 모듈->신고자 정보 다운로드->기록을 역추적","sensorAction":"신고자의 기록을 다운로드 받아서 방법 예상,역해킹등으로 범인의위치,범인을 알아내서 경찰에게 알리거나 합동하여서 체포한다.적이 사용한 해킹 도구의 GPS위치를 추적해서 위치 찾는데 도움을 준다.공범의 경우 네트워크 패킷으로 연락을 막는다.네트워크 패킷 분석센서도 사용한다.","sensorTarget":"신고를 보내면 신고전파를 잡아서 신고자의 신고를 감지한다."},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"역해킹 로봇","appearance":"휴머노이드 몸체에 오른팔에 미니 컴퓨터가 접혀있다.몸체는 티탄 합금,합성섬유,탄소나노튜브,다이아몬드로 만들어져서 절대 끊어지고 부서지지 않으면서 활동 젤로 만들어져서 더욱 튼튼해지고 부식되지않고 열을 잘 견디고 형상기억합금으로도 코팅되어서 부서지거나 금이가도 복구가 된다,즉 범인이 피해를 가해도 몸체가 스스로 자가복구가 된다.테플론으로 코팅이 되어서 상처가 안나고 설계가 되어서 쉽게 고장나지 않고 자가 변환 기술로 비행기,잠수함등 여러 형태로 변환될수있다.몸체가 접혀고 줄어들고 늘어나는등 여러가지의 변환으로 비행기,잠수함으로 몸체 모양이 변환된다.또 폴리아세틸렌으로 만들어져서 연로가 없이도 햇빛만으로 움직일수있고 스텔스기술로 레이더를 피할수 있다.이기술로 범인의 레이더를 피할수도 있다.메타 머티리얼로 몸체를 바꾸어 빛을 굴절시켜서 투명하게 바꾸어서 은밀하게 접근할수가 있다.쉽게 미끄러지지않도록 생물 신소재 접착체를 첨가해서 미끄러운 공간에서도 범인을 쉽게 쫒을수 있다."}},"teacherFeedback":"","feedbackAt":"","video":{"type":"none","url":"","title":"","thumbnail":""},"likes":5,"currentVersion":9,"history":[{"label":"버전 8 (7차 수정)","inputs":{"purpose":"AI기술이 매우 발전해서 해킹이 빈번한 시대에서 해킹을 막고 경찰과 같이 체포하고 구속하는 로봇,경찰들과 함께 범인을 찾고 구속,체포를 한다.데이터 복구 기술로 추적에 더 쉽게 도움을 준다.","robotName":"역해킹 로봇","aiFeedback":{"date":"2026-11-16","count":1,"step1":"로봇의 외형이 비행과 잠수까지 가능하다니 정말 멋져요! 몸체가 변신할 때 필요한 관절의 움직임을 돕는 '유연한 신소재'나 변신 원리를 조금 더 구체적으로 적어주면 로봇의 모습이 더 생생해질 거예요.","step2":"해킹을 막는 로봇이라니 정말 든든해요! 단순히 경찰을 돕는 것 외에도, 해킹된 정보를 다시 되돌리는 '데이터 복구 기술'이나 '사이버 보안 시스템' 같은 사회적 목표를 추가해 보면 좋을 것 같아요.","step3":"범인을 잡기 위한 협동 기능이 참 인상적이에요. 로봇이 빠르게 이동할 수 있도록 다리에 어떤 모터를 썼는지, 혹은 비행을 위해 어떤 추진 장치를 사용하는지 기계적 구조를 한 문장 더 넣으면 훨씬 과학적일 거예요.","step4":"신고 전파를 잡는 아이디어가 훌륭해요! 센서에 '위치 추적용 GPS'나 범인의 움직임을 감지하는 '열화상 센서'를 추가해서, 범인을 훨씬 더 정확하고 빠르게 찾아낼 수 있도록 꾸며볼까요?","step5":"정보를 다루는 로봇이니 인공지능의 핵심인 '딥러닝'이나 범인의 위치를 빠르게 계산하는 '양자 컴퓨터' 기술을 언급해 보면 어떨까요? 과학 기술 이름을 더해주면 훨씬 더 똑똑한 로봇 설계도가 될 거예요.","updatedAt":"2026-11-16T00:25:07.481Z"},"appearance":"휴머노이드 몸체에 오른팔에 미니 컴퓨터가 접혀있다.몸체는 티탄 합금,합성섬유,탄소나노튜브,다이아몬드로 만들어져서 절대 끊어지고 부서지지 않으면서 활동 젤로 만들어져서 더욱 튼튼해지고 부식되지않고 열을 잘 견디고 형상기억합금으로도 코팅되어서 부서지거나 금이가도 복구가 된다..테플론으로 코팅이 되어서 상처가 안나고 설계가 되어서 쉽게 고장나지 않고 자가 변환 기술로 비행기,잠수함등 여러 형태로 변환될수있다.또 폴리아세틸렌으로 만들어져서 연로가 없이도 햇빛만으로 움직일수있고 스텔스기술로 레이더를 피할수 있다.메타 머티리얼로 몸체를 바꾸어 빛을 굴절시켜서 투명하게 보이게 만들수가 있다.쉽게 미끄러지지않도록 생물 신소재 접착체를 첨가했다.","coreValues":"#범죄 #예방#사생활 #보호","sensorName":"음성인식 모듈->신고자 정보 다운로드->기록을 역추적","videoStyle":"정밀 메카닉 공학 시뮬레이션 스타일 (로봇 관절 구조와 내부 기계 작동 클로즈업)","scienceTech":"신고자의 정보를 이용해서 크래커를 찾아내서 경찰에게 정보를 알려주거나 합동해서 잡는다.신고를 받으면 미니 컴퓨터와 가상의 카보드를 꺼내서 기록으로역추적을 한다.","mainFunction":"신고를 받고 신고자의 정보를 다운받아서 역으로 기록을 추적하고 상황등을 파악해서 해킹 방법을 예상해서 감시망을 줄이고 범인을 찾아서 경찰에게 연락하여 정보,위치를 알려주거나 경찰과 함께 협동하여서 범인을 구속하고 체포한다.체포를 위해 비행,잠수를 하는데 방수가 되는 디스프로슘과 네오디뮴을 사용한 BLDC모터를 사용해 빠르고 정확하게 쫒아가기도 한다.","sensorAction":"신고자의 기록을 다운로드 받아서 방법 예상,역해킹등으로 범인의위치,범인을 알아내서 경찰에게 알리거나 합동하여서 체포한다.적이 사용한 해킹 도구의 GPS위치를 추적해서 위치 찾는데 도움을 준다.","sensorTarget":"신고를 보내면 신고전파를 잡아서 신고자의 신고를 감지한다.","boothComments":[],"customVideoPrompt":"[AI Video Production] In 2050, a scene where a reverse-hacking robot receives a report in the center of a densely built city, with a humanoid body and a folded mini computer on the right arm. The body is made of titanium alloy, synthetic fibers, carbon nanotubes, and diamonds, making it extremely durable and unbreakable; it is reinforced with an active gel that resists corrosion and heat, and coated with shape-memory alloy so that it can be restored even if broken or cracked. Coated with Teflon to prevent scratches, it is designed to be easy to maintain, and its self-transforming technology allows it to change into various forms such as an airplane or a submarine A video of a humanoid 'reverse hacking robot' appearing at the center of the screen and moving dynamically. The installed voice recognition module, caller information download, and record tracing are vividly demonstrated through a sequence of scenes: a blue scan light turns on upon receiving a report (the system detects the report signal to identify the caller), a close-up scan of the surroundings using 3D holographic wavelengths, and the robot downloading the caller’s records to predict methods, reverse-hack, identify the suspect, notify the police, or work with them to apprehend the criminal, carrying out its mission in continuous operation. A precision mechanical engineering simulation-style video featuring camera tracking that seamlessly transitions from wide shots to close-ups of mechanical joints, enhanced with three-dimensional lighting.","deletedCommentIds":[]},"version":8,"specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"AI기술이 매우 발전해서 해킹이 빈번한 시대에서 해킹을 막고 경찰과 같이 체포하고 구속하는 로봇,경찰들과 함께 범인을 찾고 구속,체포를 한다.데이터 복구 기술로 추적에 더 쉽게 도움을 준다."},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#범죄 #예방#사생활 #보호"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"정밀 메카닉 공학 시뮬레이션 스타일 (로봇 관절 구조와 내부 기계 작동 클로즈업)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"신고자의 정보를 이용해서 크래커를 찾아내서 경찰에게 정보를 알려주거나 합동해서 잡는다.신고를 받으면 미니 컴퓨터와 가상의 카보드를 꺼내서 기록으로역추적을 한다."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"신고를 받고 신고자의 정보를 다운받아서 역으로 기록을 추적하고 상황등을 파악해서 해킹 방법을 예상해서 감시망을 줄이고 범인을 찾아서 경찰에게 연락하여 정보,위치를 알려주거나 경찰과 함께 협동하여서 범인을 구속하고 체포한다.체포를 위해 비행,잠수를 하는데 방수가 되는 디스프로슘과 네오디뮴을 사용한 BLDC모터를 사용해 빠르고 정확하게 쫒아가기도 한다."},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"음성인식 모듈->신고자 정보 다운로드->기록을 역추적","sensorAction":"신고자의 기록을 다운로드 받아서 방법 예상,역해킹등으로 범인의위치,범인을 알아내서 경찰에게 알리거나 합동하여서 체포한다.적이 사용한 해킹 도구의 GPS위치를 추적해서 위치 찾는데 도움을 준다.","sensorTarget":"신고를 보내면 신고전파를 잡아서 신고자의 신고를 감지한다."},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"역해킹 로봇","appearance":"휴머노이드 몸체에 오른팔에 미니 컴퓨터가 접혀있다.몸체는 티탄 합금,합성섬유,탄소나노튜브,다이아몬드로 만들어져서 절대 끊어지고 부서지지 않으면서 활동 젤로 만들어져서 더욱 튼튼해지고 부식되지않고 열을 잘 견디고 형상기억합금으로도 코팅되어서 부서지거나 금이가도 복구가 된다..테플론으로 코팅이 되어서 상처가 안나고 설계가 되어서 쉽게 고장나지 않고 자가 변환 기술로 비행기,잠수함등 여러 형태로 변환될수있다.또 폴리아세틸렌으로 만들어져서 연로가 없이도 햇빛만으로 움직일수있고 스텔스기술로 레이더를 피할수 있다.메타 머티리얼로 몸체를 바꾸어 빛을 굴절시켜서 투명하게 보이게 만들수가 있다.쉽게 미끄러지지않도록 생물 신소재 접착체를 첨가했다."}},"submittedAt":"2026-11-16T03:17:52.008Z","videoPrompt":"[AI Video Production] In 2050, a scene where a reverse-hacking robot receives a report in the center of a densely built city, with a humanoid body and a folded mini computer on the right arm. The body is made of titanium alloy, synthetic fibers, carbon nanotubes, and diamonds, making it extremely durable and unbreakable; it is reinforced with an active gel that resists corrosion and heat, and coated with shape-memory alloy so that it can be restored even if broken or cracked. Coated with Teflon to prevent scratches, it is designed to be easy to maintain, and its self-transforming technology allows it to change into various forms such as an airplane or a submarine A video of a humanoid 'reverse hacking robot' appearing at the center of the screen and moving dynamically. The installed voice recognition module, caller information download, and record tracing are vividly demonstrated through a sequence of scenes: a blue scan light turns on upon receiving a report (the system detects the report signal to identify the caller), a close-up scan of the surroundings using 3D holographic wavelengths, and the robot downloading the caller’s records to predict methods, reverse-hack, identify the suspect, notify the police, or work with them to apprehend the criminal, carrying out its mission in continuous operation. A precision mechanical engineering simulation-style video featuring camera tracking that seamlessly transitions from wide shots to close-ups of mechanical joints, enhanced with three-dimensional lighting.","teacherFeedbackBefore":""},{"label":"버전 9 (8차 수정)","inputs":{"purpose":"AI기술이 매우 발전해서 해킹이 빈번한 시대에서 해킹을 막고 경찰과 같이 체포하고 구속하는 로봇,경찰들과 함께 범인을 찾고 구속,체포를 한다.데이터 복구 기술로 추적에 더 쉽게 도움을 준다.개인이나 기업에서 보안을 위해 사용될수있어서 디지털 보안관 역할을 한다.","robotName":"역해킹 로봇","aiFeedback":{"date":"2026-11-16","count":2,"step1":"성민이의 로봇은 정말 튼튼해 보여요! 다만 너무 많은 신소재를 나열하기보다, '형상기억합금'처럼 로봇이 스스로 고쳐지는 원리를 중심으로 설명하면 더 멋질 것 같아요.","step2":"AI 해킹을 막겠다는 목적이 아주 훌륭해요. 단순히 경찰을 돕는 것을 넘어, '사이버 범죄 예방을 위한 디지털 보안관'이라는 구체적인 역할을 강조해 보면 어떨까요?","step3":"모터 종류까지 아주 자세히 알고 있네요! 범인을 잡을 때 필요한 관절의 유연함이나 힘을 조절하는 '액추에이터'의 움직임도 함께 설명하면 로봇의 동작이 더 생생하게 느껴질 거예요.","step4":"센서 단계가 잘 정리되었어요. 음성인식 외에도 범인의 디지털 흔적을 찾는 '네트워크 패킷 분석 센서'라는 이름을 추가하면 훨씬 전문적인 로봇이 될 것 같아요.","step5":"정보를 활용하는 기술은 좋지만, 여기에는 '데이터 암호화'나 '빅데이터 분석' 같은 기술 용어를 넣어보세요. 과학 기술을 로봇의 어떤 행동에 적용할지 한 번 더 연결해 주면 완벽해요!","updatedAt":"2026-11-16T03:32:09.824Z"},"appearance":"휴머노이드 몸체에 오른팔에 미니 컴퓨터가 접혀있다.몸체는 티탄 합금,합성섬유,탄소나노튜브,다이아몬드로 만들어져서 절대 끊어지고 부서지지 않으면서 활동 젤로 만들어져서 더욱 튼튼해지고 부식되지않고 열을 잘 견디고 형상기억합금으로도 코팅되어서 부서지거나 금이가도 복구가 된다,즉 범인이 피해를 가해도 몸체가 스스로 자가복구가 된다.테플론으로 코팅이 되어서 상처가 안나고 설계가 되어서 쉽게 고장나지 않고 자가 변환 기술로 비행기,잠수함등 여러 형태로 변환될수있다.몸체가 접혀고 줄어들고 늘어나는등 여러가지의 변환으로 비행기,잠수함으로 몸체 모양이 변환된다.또 폴리아세틸렌으로 만들어져서 연로가 없이도 햇빛만으로 움직일수있고 스텔스기술로 레이더를 피할수 있다.이기술로 범인의 레이더를 피할수도 있다.메타 머티리얼로 몸체를 바꾸어 빛을 굴절시켜서 투명하게 바꾸어서 은밀하게 접근할수가 있다.쉽게 미끄러지지않도록 생물 신소재 접착체를 첨가해서 미끄러운 공간에서도 범인을 쉽게 쫒을수 있다.","coreValues":"#범죄 #예방#사생활 #보호","sensorName":"음성인식 모듈->신고자 정보 다운로드->기록을 역추적","videoStyle":"정밀 메카닉 공학 시뮬레이션 스타일 (로봇 관절 구조와 내부 기계 작동 클로즈업)","scienceTech":"신고자의 정보를 이용해서 크래커를 찾아내서 경찰에게 정보를 알려주거나 합동해서 잡는다.신고를 받으면 미니 컴퓨터와 가상의 카보드를 꺼내서 기록으로역추적을 한다.데이터를 들어가서 범인이 더 피해를 주지못하도록 암호를 걸어서 피해를  줄이고 빅테이터를 사용하여 범인의 모든 정보를 알아내서 경찰에게 전달하거나 협동을 해서 체포를 한다.","mainFunction":"신고를 받고 신고자의 정보를 다운받아서 역으로 기록을 추적하고 상황등을 파악해서 해킹 방법을 예상해서 감시망을 줄이고 범인을 찾아서 경찰에게 연락하여 정보,위치를 알려주거나 경찰과 함께 협동하여서 범인을 구속하고 체포한다.체포를 위해 비행,잠수를 하는데 방수가 되는 디스프로슘과 네오디뮴을 사용한 BLDC모터를 사용해 빠르고 정확하게 쫒아가기도 한다.범인의 현재거리를 분석하고 계산해서 액추에이터로 더욱 빠르거나 힘을 강화시킨다.","sensorAction":"신고자의 기록을 다운로드 받아서 방법 예상,역해킹등으로 범인의위치,범인을 알아내서 경찰에게 알리거나 합동하여서 체포한다.적이 사용한 해킹 도구의 GPS위치를 추적해서 위치 찾는데 도움을 준다.공범의 경우 네트워크 패킷으로 연락을 막는다.네트워크 패킷 분석센서도 사용한다.","sensorTarget":"신고를 보내면 신고전파를 잡아서 신고자의 신고를 감지한다.","boothComments":[],"customVideoPrompt":"[AI Video Production] In 2050, a scene of a long building receiving a report in the center of a dense city; the humanoid body has a mini computer folded in the right arm. The body is made of titanium alloy, synthetic fibers, carbon nanotubes, and diamonds, making it completely unbreakable and indestructible, while being reinforced with an active gel for enhanced durability, corrosion resistance, and heat resistance, and coated with shape-memory alloy so that it can be repaired even if broken or cracked. In other words, the body self-reduces even if the perpetrator causes damage. Coated with Teflon to prevent scratches, it is designed to be durable, and with self-transformation technology, it can change into various forms such as an airplane or a submarine A video of a humanoid 'reverse hacking robot' appearing at the center of the screen and moving dynamically. The installed voice recognition module, caller information download, and record tracing are vividly demonstrated through a sequence of scenes: a blue scan light turns on upon receiving a report (the system detects the report signal to identify the caller), a close-up scan of the surroundings using 3D holographic wavelengths, and the robot downloading the caller’s records to predict methods, reverse-hack, identify the suspect, notify the police, or work with them to apprehend the criminal, carrying out its mission in continuous operation. A precision mechanical engineering simulation-style video featuring camera tracking that seamlessly transitions from wide shots to close-ups of mechanical joints, enhanced with three-dimensional lighting.","deletedCommentIds":[]},"version":9,"specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"AI기술이 매우 발전해서 해킹이 빈번한 시대에서 해킹을 막고 경찰과 같이 체포하고 구속하는 로봇,경찰들과 함께 범인을 찾고 구속,체포를 한다.데이터 복구 기술로 추적에 더 쉽게 도움을 준다.개인이나 기업에서 보안을 위해 사용될수있어서 디지털 보안관 역할을 한다."},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#범죄 #예방#사생활 #보호"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"정밀 메카닉 공학 시뮬레이션 스타일 (로봇 관절 구조와 내부 기계 작동 클로즈업)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"신고자의 정보를 이용해서 크래커를 찾아내서 경찰에게 정보를 알려주거나 합동해서 잡는다.신고를 받으면 미니 컴퓨터와 가상의 카보드를 꺼내서 기록으로역추적을 한다.데이터를 들어가서 범인이 더 피해를 주지못하도록 암호를 걸어서 피해를  줄이고 빅테이터를 사용하여 범인의 모든 정보를 알아내서 경찰에게 전달하거나 협동을 해서 체포를 한다."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"신고를 받고 신고자의 정보를 다운받아서 역으로 기록을 추적하고 상황등을 파악해서 해킹 방법을 예상해서 감시망을 줄이고 범인을 찾아서 경찰에게 연락하여 정보,위치를 알려주거나 경찰과 함께 협동하여서 범인을 구속하고 체포한다.체포를 위해 비행,잠수를 하는데 방수가 되는 디스프로슘과 네오디뮴을 사용한 BLDC모터를 사용해 빠르고 정확하게 쫒아가기도 한다.범인의 현재거리를 분석하고 계산해서 액추에이터로 더욱 빠르거나 힘을 강화시킨다."},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"음성인식 모듈->신고자 정보 다운로드->기록을 역추적","sensorAction":"신고자의 기록을 다운로드 받아서 방법 예상,역해킹등으로 범인의위치,범인을 알아내서 경찰에게 알리거나 합동하여서 체포한다.적이 사용한 해킹 도구의 GPS위치를 추적해서 위치 찾는데 도움을 준다.공범의 경우 네트워크 패킷으로 연락을 막는다.네트워크 패킷 분석센서도 사용한다.","sensorTarget":"신고를 보내면 신고전파를 잡아서 신고자의 신고를 감지한다."},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"역해킹 로봇","appearance":"휴머노이드 몸체에 오른팔에 미니 컴퓨터가 접혀있다.몸체는 티탄 합금,합성섬유,탄소나노튜브,다이아몬드로 만들어져서 절대 끊어지고 부서지지 않으면서 활동 젤로 만들어져서 더욱 튼튼해지고 부식되지않고 열을 잘 견디고 형상기억합금으로도 코팅되어서 부서지거나 금이가도 복구가 된다,즉 범인이 피해를 가해도 몸체가 스스로 자가복구가 된다.테플론으로 코팅이 되어서 상처가 안나고 설계가 되어서 쉽게 고장나지 않고 자가 변환 기술로 비행기,잠수함등 여러 형태로 변환될수있다.몸체가 접혀고 줄어들고 늘어나는등 여러가지의 변환으로 비행기,잠수함으로 몸체 모양이 변환된다.또 폴리아세틸렌으로 만들어져서 연로가 없이도 햇빛만으로 움직일수있고 스텔스기술로 레이더를 피할수 있다.이기술로 범인의 레이더를 피할수도 있다.메타 머티리얼로 몸체를 바꾸어 빛을 굴절시켜서 투명하게 바꾸어서 은밀하게 접근할수가 있다.쉽게 미끄러지지않도록 생물 신소재 접착체를 첨가해서 미끄러운 공간에서도 범인을 쉽게 쫒을수 있다."}},"submittedAt":"2026-11-16T03:44:56.841Z","videoPrompt":"[AI Video Production] In 2050, a scene of a long building receiving a report in the center of a dense city; the humanoid body has a mini computer folded in the right arm. The body is made of titanium alloy, synthetic fibers, carbon nanotubes, and diamonds, making it completely unbreakable and indestructible, while being reinforced with an active gel for enhanced durability, corrosion resistance, and heat resistance, and coated with shape-memory alloy so that it can be repaired even if broken or cracked. In other words, the body self-reduces even if the perpetrator causes damage. Coated with Teflon to prevent scratches, it is designed to be durable, and with self-transformation technology, it can change into various forms such as an airplane or a submarine A video of a humanoid 'reverse hacking robot' appearing at the center of the screen and moving dynamically. The installed voice recognition module, caller information download, and record tracing are vividly demonstrated through a sequence of scenes: a blue scan light turns on upon receiving a report (the system detects the report signal to identify the caller), a close-up scan of the surroundings using 3D holographic wavelengths, and the robot downloading the caller’s records to predict methods, reverse-hack, identify the suspect, notify the police, or work with them to apprehend the criminal, carrying out its mission in continuous operation. A precision mechanical engineering simulation-style video featuring camera tracking that seamlessly transitions from wide shots to close-ups of mechanical joints, enhanced with three-dimensional lighting.","teacherFeedbackBefore":""}],"updatedAt":"2026-11-17T00:11:35.326Z"},{"studentId":"신다빈","studentName":"신다빈","status":"approved","inputs":{"robotName":"다빈치봇","appearance":"로봇은 집게팔이 있고, 4족 보행을 하고 몸통에 주워진 쓰레기들이 있는 투명한 통이 있다. 몸통은 직사각형이다.","purpose":"쓰레기가 많이 있는 숲에서 버려진 쓰레기들을 주워 구멍에 넣어 연결된 투명한 통에 쓰레기가 보내지게 한다.","mainFunction":"집게팔로 쓰레기를 집어 구멍으로 넣어 밖으로 쓰레기가 튀어나가지 않도록 통에 보관할수 있게 한다.","sensorName":"카메라 센서, 촉각 센서","sensorTarget":"숲에 버려진 쓰레기들을 감지한다.","sensorAction":"감지된 쓰레기들을 투명한 통과 이어진 구멍에 넣어 처리한다.","scienceTech":"인공지능(AI) 사물인식 기능으로 숲의 쓰레기들을 투명한 통과 이어진 구멍에 넣어 알아서 처리한다.","coreValues":"#생태계보존 #숲에 #쓰레기무단투기금지","videoStyle":"미래 박람회 쇼케이스 디지털 컨셉 아트 스타일 (세련된 조명과 미래지향적 모션그래픽)","customVideoPrompt":"[AI 영상 제작] 푸른 나무와 빛나는 자연이 어우러진 2050년 미래 생태 숲 현장에서, 로봇은 집게팔이 있고, 4족 보행을 하고 몸통에 주워진 쓰레기들이 있는 투명한 통이 있다, 몸통은 직사각형 외형을 갖춘 로봇 '다빈치봇'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 카메라 센서, 촉각 센서에 푸른 스캔 라이트가 켜지며(숲에 버려진 쓰레기들) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 목표물을 집어 올려서 투명한 통에 연결된 구멍에 쓰레기를 넣으면서 수거 장치를 작동시키며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 미래 박람회 쇼케이스 디지털 컨셉 아트 스타일 동영상.","aiFeedback":null,"boothComments":[{"v":2,"id":"c_1794873100307_8mdw1","text":"정말 대단해ㅐㅐㅐㅐㅐㅐㅐㅐㅐㅐㅐㅐㅐㅐㅐㅐㅐㅐㅐㅐ👍👍👍👍👍👍","author":"김지안","createdAt":"2026-11-16T23:51:40.307Z","viewerToken":"vt_1794796070701_4iqa9fd3","authorStudentId":"김지안"},{"v":2,"id":"c_1794873559876_qsgq1","text":"엄청 아이디어가 좋다 그리고 기여워☆","author":"김지아","createdAt":"2026-11-16T23:59:19.876Z","viewerToken":"vt_1794796098329_ixf8fbb4","authorStudentId":"김지아"},{"v":2,"id":"c_1794873703139_kqfng","text":"오~ 정말 좋은 아이디어다!!!!!!","author":"장서윤","createdAt":"2026-11-17T00:01:43.141Z","viewerToken":"vt_1794796665307_ra6syqil","authorStudentId":"장서윤"},{"v":2,"id":"c_1794873707653_z8sp7","text":"쓰레기를 버리려는 아이디어는 정말 좋은거 같애🙊","author":"신다빈","createdAt":"2026-11-17T00:01:47.653Z","viewerToken":"vt_1794796192899_42ggb0j9","authorStudentId":"신다빈"},{"v":2,"id":"c_1794873739989_ywz62","text":"여기 영상중에 가장 오류 없이 잘 만들어진것 같아!!👍👍👍👍👍👍","author":"공인경","createdAt":"2026-11-17T00:02:19.990Z","viewerToken":"vt_1794799986519_qjpt3033","authorStudentId":"공인경"},{"v":2,"id":"c_1794874139333_3ouz8","text":"이랴 !!!! 정말 대단히야ㅑㅑㅑㅑㅑ!","author":"김승윤","createdAt":"2026-11-17T00:08:59.333Z","viewerToken":"vt_1794796086113_pfa1lkx5","authorStudentId":"김승윤"},{"v":2,"id":"c_1794874296982_ndyi0","text":"쓰레기가 들어가는거 약간 쾌감이다ㅏㅏ","author":"이수아","createdAt":"2026-11-17T00:11:36.983Z","updatedAt":"2026-11-17T00:11:51.920Z","viewerToken":"vt_1794799212191_bqc4jkhg","authorStudentId":""}],"deletedCommentIds":["c_1794873647518_2kn2s"]},"videoPrompt":"[AI 영상 제작] 푸른 나무와 빛나는 자연이 어우러진 2050년 미래 생태 숲 현장에서, 로봇은 집게팔이 있고, 4족 보행을 하고 몸통에 주워진 쓰레기들이 있는 투명한 통이 있다, 몸통은 직사각형 외형을 갖춘 로봇 '다빈치봇'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 카메라 센서, 촉각 센서에 푸른 스캔 라이트가 켜지며(숲에 버려진 쓰레기들) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 목표물을 집어 올려서 투명한 통에 연결된 구멍에 쓰레기를 넣으면서 수거 장치를 작동시키며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 미래 박람회 쇼케이스 디지털 컨셉 아트 스타일 동영상.","specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"쓰레기가 많이 있는 숲에서 버려진 쓰레기들을 주워 구멍에 넣어 연결된 투명한 통에 쓰레기가 보내지게 한다."},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#생태계보존 #숲에 #쓰레기무단투기금지"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"미래 박람회 쇼케이스 디지털 컨셉 아트 스타일 (세련된 조명과 미래지향적 모션그래픽)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"인공지능(AI) 사물인식 기능으로 숲의 쓰레기들을 투명한 통과 이어진 구멍에 넣어 알아서 처리한다."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"집게팔로 쓰레기를 집어 구멍으로 넣어 밖으로 쓰레기가 튀어나가지 않도록 통에 보관할수 있게 한다."},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"카메라 센서, 촉각 센서","sensorAction":"감지된 쓰레기들을 투명한 통과 이어진 구멍에 넣어 처리한다.","sensorTarget":"숲에 버려진 쓰레기들을 감지한다."},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"다빈치봇","appearance":"로봇은 집게팔이 있고, 4족 보행을 하고 몸통에 주워진 쓰레기들이 있는 투명한 통이 있다. 몸통은 직사각형이다."}},"teacherFeedback":"새롭게!","feedbackAt":"2026-11-16T03:39:58.555Z","video":{"type":"none","url":"","title":"","thumbnail":""},"likes":7,"currentVersion":4,"history":[{"label":"버전 3 (2차 수정)","inputs":{"purpose":"쓰레기가 많이 있는 숲에서 버려진 쓰레기들을 주워 구멍에 넣어 연결된 투명한 통에 쓰레기가 보내지게 한다.","robotName":"다빈치봇","aiFeedback":null,"appearance":"로봇은 집게팔이 있고, 4족 보행을 하고 몸통에 주워진 쓰레기들이 있는 투명한 통이 있다. 몸통은 직사각형이다.","coreValues":"#생태계보존 #숲에 #쓰레기무단투기금지","sensorName":"카메라 센서, 촉각 센서","videoStyle":"미래 박람회 쇼케이스 디지털 컨셉 아트 스타일 (세련된 조명과 미래지향적 모션그래픽)","scienceTech":"인공지능(AI) 사물인식 기능으로 숲의 쓰레기들을 투명한 통과 이어진 구멍에 넣어 알아서 처리한다.","mainFunction":"집게팔로 쓰레기를 집어 구멍으로 넣어 밖으로 쓰레기가 튀어나가지 않도록 통에 보관할수 있게 한다.","sensorAction":"감지된 쓰레기들을 투명한 통과 이어진 구멍에 넣어 처리한다.","sensorTarget":"숲에 버려진 쓰레기들을 감지한다.","boothComments":[],"customVideoPrompt":"[AI 영상 제작] 푸른 나무와 빛나는 자연이 어우러진 2050년 미래 생태 숲 현장에서, 로봇은 집게팔이 있고, 4족 보행을 하고 몸통에 주워진 쓰레기들이 있는 투명한 통이 있다, 몸통은 직사각형 외형을 갖춘 로봇 '다빈치봇'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 카메라 센서, 촉각 센서에 푸른 스캔 라이트가 켜지며(숲에 버려진 쓰레기들) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 목표물을 집어 올리고 수거 장치를 작동시키며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 미래 박람회 쇼케이스 디지털 컨셉 아트 스타일 동영상.","deletedCommentIds":[]},"version":3,"specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"쓰레기가 많이 있는 숲에서 버려진 쓰레기들을 주워 구멍에 넣어 연결된 투명한 통에 쓰레기가 보내지게 한다."},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#생태계보존 #숲에 #쓰레기무단투기금지"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"미래 박람회 쇼케이스 디지털 컨셉 아트 스타일 (세련된 조명과 미래지향적 모션그래픽)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"인공지능(AI) 사물인식 기능으로 숲의 쓰레기들을 투명한 통과 이어진 구멍에 넣어 알아서 처리한다."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"집게팔로 쓰레기를 집어 구멍으로 넣어 밖으로 쓰레기가 튀어나가지 않도록 통에 보관할수 있게 한다."},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"카메라 센서, 촉각 센서","sensorAction":"감지된 쓰레기들을 투명한 통과 이어진 구멍에 넣어 처리한다.","sensorTarget":"숲에 버려진 쓰레기들을 감지한다."},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"다빈치봇","appearance":"로봇은 집게팔이 있고, 4족 보행을 하고 몸통에 주워진 쓰레기들이 있는 투명한 통이 있다. 몸통은 직사각형이다."}},"submittedAt":"2026-11-16T03:10:47.572Z","videoPrompt":"[AI 영상 제작] 푸른 나무와 빛나는 자연이 어우러진 2050년 미래 생태 숲 현장에서, 로봇은 집게팔이 있고, 4족 보행을 하고 몸통에 주워진 쓰레기들이 있는 투명한 통이 있다, 몸통은 직사각형 외형을 갖춘 로봇 '다빈치봇'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 카메라 센서, 촉각 센서에 푸른 스캔 라이트가 켜지며(숲에 버려진 쓰레기들) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 목표물을 집어 올리고 수거 장치를 작동시키며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 미래 박람회 쇼케이스 디지털 컨셉 아트 스타일 동영상.","teacherFeedbackBefore":"새롭게!"},{"label":"버전 4 (3차 수정)","inputs":{"purpose":"쓰레기가 많이 있는 숲에서 버려진 쓰레기들을 주워 구멍에 넣어 연결된 투명한 통에 쓰레기가 보내지게 한다.","robotName":"다빈치봇","aiFeedback":null,"appearance":"로봇은 집게팔이 있고, 4족 보행을 하고 몸통에 주워진 쓰레기들이 있는 투명한 통이 있다. 몸통은 직사각형이다.","coreValues":"#생태계보존 #숲에 #쓰레기무단투기금지","sensorName":"카메라 센서, 촉각 센서","videoStyle":"미래 박람회 쇼케이스 디지털 컨셉 아트 스타일 (세련된 조명과 미래지향적 모션그래픽)","scienceTech":"인공지능(AI) 사물인식 기능으로 숲의 쓰레기들을 투명한 통과 이어진 구멍에 넣어 알아서 처리한다.","mainFunction":"집게팔로 쓰레기를 집어 구멍으로 넣어 밖으로 쓰레기가 튀어나가지 않도록 통에 보관할수 있게 한다.","sensorAction":"감지된 쓰레기들을 투명한 통과 이어진 구멍에 넣어 처리한다.","sensorTarget":"숲에 버려진 쓰레기들을 감지한다.","boothComments":[],"customVideoPrompt":"[AI 영상 제작] 푸른 나무와 빛나는 자연이 어우러진 2050년 미래 생태 숲 현장에서, 로봇은 집게팔이 있고, 4족 보행을 하고 몸통에 주워진 쓰레기들이 있는 투명한 통이 있다, 몸통은 직사각형 외형을 갖춘 로봇 '다빈치봇'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 카메라 센서, 촉각 센서에 푸른 스캔 라이트가 켜지며(숲에 버려진 쓰레기들) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 목표물을 집어 올려서 투명한 통에 연결된 구멍에 쓰레기를 넣으면서 수거 장치를 작동시키며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 미래 박람회 쇼케이스 디지털 컨셉 아트 스타일 동영상.","deletedCommentIds":[]},"version":4,"specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"쓰레기가 많이 있는 숲에서 버려진 쓰레기들을 주워 구멍에 넣어 연결된 투명한 통에 쓰레기가 보내지게 한다."},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#생태계보존 #숲에 #쓰레기무단투기금지"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"미래 박람회 쇼케이스 디지털 컨셉 아트 스타일 (세련된 조명과 미래지향적 모션그래픽)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"인공지능(AI) 사물인식 기능으로 숲의 쓰레기들을 투명한 통과 이어진 구멍에 넣어 알아서 처리한다."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"집게팔로 쓰레기를 집어 구멍으로 넣어 밖으로 쓰레기가 튀어나가지 않도록 통에 보관할수 있게 한다."},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"카메라 센서, 촉각 센서","sensorAction":"감지된 쓰레기들을 투명한 통과 이어진 구멍에 넣어 처리한다.","sensorTarget":"숲에 버려진 쓰레기들을 감지한다."},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"다빈치봇","appearance":"로봇은 집게팔이 있고, 4족 보행을 하고 몸통에 주워진 쓰레기들이 있는 투명한 통이 있다. 몸통은 직사각형이다."}},"submittedAt":"2026-11-16T03:32:59.649Z","videoPrompt":"[AI 영상 제작] 푸른 나무와 빛나는 자연이 어우러진 2050년 미래 생태 숲 현장에서, 로봇은 집게팔이 있고, 4족 보행을 하고 몸통에 주워진 쓰레기들이 있는 투명한 통이 있다, 몸통은 직사각형 외형을 갖춘 로봇 '다빈치봇'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 카메라 센서, 촉각 센서에 푸른 스캔 라이트가 켜지며(숲에 버려진 쓰레기들) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 목표물을 집어 올려서 투명한 통에 연결된 구멍에 쓰레기를 넣으면서 수거 장치를 작동시키며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 미래 박람회 쇼케이스 디지털 컨셉 아트 스타일 동영상.","teacherFeedbackBefore":"새롭게!"}],"updatedAt":"2026-11-17T00:11:51.921Z"},{"studentId":"김승윤","studentName":"김승윤","status":"approved","inputs":{"robotName":"거거걱 봇 SIU⅛","appearance":"이 로봇은 음식물 처리기, 공기청정기 기능을 2가지 다 담고있다. 바퀴가 있어 어디든지 사람이 필요한 곳에 갈 수 있다. 재질은 가벼운 알루미늄으로 만들어져있고 눈이 거미처럼 많이 달려있어 어디든지 필요한 상황에 보고 갈 수 있다 . 외형은 호날두다","purpose":"미래 사회에는 공기가 오염되어서 공기 정화가 꼭 필요하다.","mainFunction":"갈아버리는 기능, 공기 순환 기능 등 거거걱봇은 음식물 쓰레기 갈기, 공기청정기이다다다다다","sensorName":"미세먼지 센서, 카메라 센서","sensorTarget":"사람의 체온, 미세먼지 감지 등","sensorAction":"미세먼지 감지후, 공기를 깨끗하게 만들어준다","scienceTech":"공기 정화 , 인공지능(AI), 친환경 배터리와, 자율주행, 무선 충전 등등이 탑재 되어있다","coreValues":"#생태계보존 #미래보존","videoStyle":"솔라펑크(Solarpunk) 친환경 미래 3D 스타일 (푸른 자연 생태계와 첨단 과학기술의 조화)","customVideoPrompt":"[AI 영상 제작] 환경은 길거리고, 이 로봇은 음식물 처리기, 공기청정기 기능을 2가지 다 담고있다, 바퀴가 있어 어디든지 사람이 필요한 곳에 갈 수 있다, 재질은 가벼운 알루미늄으로 만들어져있고 눈이 거미처럼 많이 달려있어 어디든지 필요한 상황에 보고 갈 수 있다 외형을 갖춘 로봇 '거거걱 봇 SIU⅛'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 미세먼지 센서, 카메라 센서에 푸른 스캔 라이트가 켜지며(사람의 체온, 미세먼지 감지 등) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 목표물을 집어 올리고 수거 장치를 작동시키며, 몸체의 정화 필터로 오염 물질을 흡입해 걸러낸 뒤 맑고 깨끗한 흐름을 내보내며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 솔라펑크 친환경 미래 3D 스타일 동영상 그리고 외형은 로봇말고 사람스럽게 해줘 그리고 쓰래기를 뱉지마","aiFeedback":{"date":"2026-11-16","count":1,"step1":"거미 눈처럼 많은 센서가 달린 점이 아주 멋져요! 가벼운 알루미늄 대신 충격에 강하고 탄성이 좋은 신소재인 '탄소 섬유'를 사용해 보면 로봇이 더 튼튼해질 거예요.","step2":"공기 정화뿐만 아니라 음식물 쓰레기를 분해해서 에너지로 만드는 '바이오 가스 기술'을 추가하면 미래 환경 문제도 해결하는 멋진 로봇이 될 거예요.","step3":"음식물을 갈 때 필요한 '분쇄 모터'와 공기를 빨아들이는 '팬 구조'를 어떻게 연결할지 구체적으로 고민해 봐요. 공기청정기 필터가 어떻게 움직이는지 설명해 주면 더 완벽하겠어요.","step4":"센서가 단순히 감지만 하는 게 아니라, 위험한 쓰레기를 구분하는 '이미지 인식 카메라' 기능을 넣어보세요. 감지 후에 스스로 충전소로 이동하는 자율주행 알고리즘을 추가하면 훨씬 똑똑해질 거예요.","step5":"훌륭한 기술들이 많아요! 여기서 공기 속의 오염 물질을 붙잡는 '정전기 필터 원리'나 로봇 스스로 에너지를 아끼는 '전력 최적화 알고리즘'을 더 자세히 적어보길 추천해요.","updatedAt":"2026-11-16T00:26:09.920Z"},"boothComments":[{"v":2,"id":"c_1794873298285_wou0r","text":"와와와 정말 거거거거거거거거거거거거걱한데?","author":"김민재","createdAt":"2026-11-16T23:54:58.285Z","viewerToken":"vt_1794796308439_8yzbw3eg","authorStudentId":"김민재"},{"v":2,"id":"c_1794873305498_rvibr","text":"오오오오오오오 쓰레기를 버리는 로봇 아이디어가 좋은데!","author":"장서윤","createdAt":"2026-11-16T23:55:05.498Z","viewerToken":"vt_1794796665307_ra6syqil","authorStudentId":"장서윤"},{"v":2,"id":"c_1794873420876_p79fn","text":"음.... 그 동영상 만들기 설명에 쓰레기가 아니라 쓰래기라고 되어있는.... 의도가 있겠지뭐....","author":"이수아","createdAt":"2026-11-16T23:57:00.876Z","viewerToken":"vt_1794799212191_bqc4jkhg","authorStudentId":""},{"v":2,"id":"c_1794873634701_yptl4","text":"와 너무멋지다 쓰레기를 치우다니 멋지다","author":"이원준","createdAt":"2026-11-17T00:00:34.701Z","viewerToken":"vt_1794873057588_6rghf8uo","authorStudentId":"이원준"},{"v":2,"id":"c_1794873657184_6w5o3","text":"......내 능지 이슈임 ㅅㄱㅅㄱ.","author":"김승윤","createdAt":"2026-11-17T00:00:57.184Z","viewerToken":"vt_1794796086113_pfa1lkx5","authorStudentId":"김승윤"},{"v":2,"id":"c_1794873810287_an13n","text":"오아ㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏ 아이디어가 좋은것같애","author":"김지안","createdAt":"2026-11-17T00:03:30.288Z","viewerToken":"vt_1794796070701_4iqa9fd3","authorStudentId":"김지안"},{"v":2,"id":"c_1794873841286_umt95","text":"와우아우아우아ㅏㅏㅏㅏㅏ 머싯다 !!!","author":"이석준","createdAt":"2026-11-17T00:04:01.286Z","viewerToken":"vt_1794799215240_tjkhcvj5","authorStudentId":"이석준"},{"v":2,"id":"c_1794873935735_f4lzn","text":"우와ㅏ 쓰레기를 먹어주고 공기도 청정해준다니! 정말 아이디어 좋다 ❤️‍🔥","author":"김지아","createdAt":"2026-11-17T00:05:35.735Z","viewerToken":"vt_1794796098329_ixf8fbb4","authorStudentId":"김지아"},{"v":2,"id":"c_1794874291106_pzmun","text":"와 브로. 그것은 완벽함 그 잡채야🤩 이정도면 지구에 있는 모든 쓰레기와 길거리에 있는 모든 쓰레기를 하나하나 따로 힘들게 노동을 하면서 버리지 않아도 많은 쓰레기를 버려서 지구 온난화를 늦출수있겠어🤩🤩🤩 와 진짜, 브로는 천재야 어떻게 로봇을 길거리에 날려서 지구를 킬 생각을 한거지? 브로는 그냥 그 상태로 조금만 연구하면 쓰레기정복은 거뜬하겠는걸","author":"김규혁","createdAt":"2026-11-17T00:11:31.106Z","viewerToken":"vt_1794796116808_09f96gop","authorStudentId":"김규혁"},{"v":2,"id":"c_1794874317341_ockud","text":"아이디어가 진짜 정마아알 넘무 조은거 같퇘!","author":"신다빈","createdAt":"2026-11-17T00:11:57.341Z","viewerToken":"vt_1794796192899_42ggb0j9","authorStudentId":"신다빈"}],"deletedCommentIds":["c_1794873398662_jb9dh"]},"videoPrompt":"[AI 영상 제작] 환경은 길거리고, 이 로봇은 음식물 처리기, 공기청정기 기능을 2가지 다 담고있다, 바퀴가 있어 어디든지 사람이 필요한 곳에 갈 수 있다, 재질은 가벼운 알루미늄으로 만들어져있고 눈이 거미처럼 많이 달려있어 어디든지 필요한 상황에 보고 갈 수 있다 외형을 갖춘 로봇 '거거걱 봇 SIU⅛'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 미세먼지 센서, 카메라 센서에 푸른 스캔 라이트가 켜지며(사람의 체온, 미세먼지 감지 등) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 목표물을 집어 올리고 수거 장치를 작동시키며, 몸체의 정화 필터로 오염 물질을 흡입해 걸러낸 뒤 맑고 깨끗한 흐름을 내보내며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 솔라펑크 친환경 미래 3D 스타일 동영상 그리고 외형은 로봇말고 사람스럽게 해줘 그리고 쓰래기를 뱉지마","specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"미래 사회에는 공기가 오염되어서 공기 정화가 꼭 필요하다."},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#생태계보존 #미래보존"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"솔라펑크(Solarpunk) 친환경 미래 3D 스타일 (푸른 자연 생태계와 첨단 과학기술의 조화)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"공기 정화 , 인공지능(AI), 친환경 배터리와, 자율주행, 무선 충전 등등이 탑재 되어있다"},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"갈아버리는 기능, 공기 순환 기능 등 거거걱봇은 음식물 쓰레기 갈기, 공기청정기이다다다다다"},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"미세먼지 센서, 카메라 센서","sensorAction":"미세먼지 감지후, 공기를 깨끗하게 만들어준다","sensorTarget":"사람의 체온, 미세먼지 감지 등"},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"거거걱 봇 SIU⅛","appearance":"이 로봇은 음식물 처리기, 공기청정기 기능을 2가지 다 담고있다. 바퀴가 있어 어디든지 사람이 필요한 곳에 갈 수 있다. 재질은 가벼운 알루미늄으로 만들어져있고 눈이 거미처럼 많이 달려있어 어디든지 필요한 상황에 보고 갈 수 있다 . 외형은 호날두다"}},"teacherFeedback":"기능과 센서가 연결이 잘 안됨. 다시 생각해보고 내용 수정 필요.","feedbackAt":"2026-11-16T03:29:23.761Z","video":{"type":"none","url":"","title":"","thumbnail":""},"likes":10,"currentVersion":45,"history":[{"label":"버전 44 (43차 수정)","inputs":{"purpose":"미래 사회에는 공기가 오염되어서 공기 정화가 꼭 필요하다.","robotName":"거거걱 봇 SIU⅛","aiFeedback":{"date":"2026-11-16","count":1,"step1":"거미 눈처럼 많은 센서가 달린 점이 아주 멋져요! 가벼운 알루미늄 대신 충격에 강하고 탄성이 좋은 신소재인 '탄소 섬유'를 사용해 보면 로봇이 더 튼튼해질 거예요.","step2":"공기 정화뿐만 아니라 음식물 쓰레기를 분해해서 에너지로 만드는 '바이오 가스 기술'을 추가하면 미래 환경 문제도 해결하는 멋진 로봇이 될 거예요.","step3":"음식물을 갈 때 필요한 '분쇄 모터'와 공기를 빨아들이는 '팬 구조'를 어떻게 연결할지 구체적으로 고민해 봐요. 공기청정기 필터가 어떻게 움직이는지 설명해 주면 더 완벽하겠어요.","step4":"센서가 단순히 감지만 하는 게 아니라, 위험한 쓰레기를 구분하는 '이미지 인식 카메라' 기능을 넣어보세요. 감지 후에 스스로 충전소로 이동하는 자율주행 알고리즘을 추가하면 훨씬 똑똑해질 거예요.","step5":"훌륭한 기술들이 많아요! 여기서 공기 속의 오염 물질을 붙잡는 '정전기 필터 원리'나 로봇 스스로 에너지를 아끼는 '전력 최적화 알고리즘'을 더 자세히 적어보길 추천해요.","updatedAt":"2026-11-16T00:26:09.920Z"},"appearance":"이 로봇은 음식물 처리기, 공기청정기 기능을 2가지 다 담고있다. 바퀴가 있어 어디든지 사람이 필요한 곳에 갈 수 있다. 재질은 가벼운 알루미늄으로 만들어져있고 눈이 거미처럼 많이 달려있어 어디든지 필요한 상황에 보고 갈 수 있다 . 외형은 호날두다","coreValues":"#생태계보존 #미래보존","sensorName":"미세먼지 센서, 카메라 센서","videoStyle":"솔라펑크(Solarpunk) 친환경 미래 3D 스타일 (푸른 자연 생태계와 첨단 과학기술의 조화)","scienceTech":"공기 정화 , 인공지능(AI), 친환경 배터리와, 자율주행, 무선 충전 등등이 탑재 되어있다","mainFunction":"갈아버리는 기능, 공기 순환 기능 등 거거걱봇은 음식물 쓰레기 갈기, 공기청정기이다다다다다","sensorAction":"미세먼지 감지후, 공기를 깨끗하게 만들어준다","sensorTarget":"사람의 체온, 미세먼지 감지 등","boothComments":[],"customVideoPrompt":"[AI 영상 제작] 환경은 길거리고, 이 로봇은 음식물 처리기, 공기청정기 기능을 2가지 다 담고있다, 바퀴가 있어 어디든지 사람이 필요한 곳에 갈 수 있다, 재질은 가벼운 알루미늄으로 만들어져있고 눈이 거미처럼 많이 달려있어 어디든지 필요한 상황에 보고 갈 수 있다 외형을 갖춘 로봇 '거거걱 봇 SIU⅛'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 미세먼지 센서, 카메라 센서에 푸른 스캔 라이트가 켜지며(사람의 체온, 미세먼지 감지 등) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 목표물을 집어 올리고 수거 장치를 작동시키며, 몸체의 정화 필터로 오염 물질을 흡입해 걸러낸 뒤 맑고 깨끗한 흐름을 내보내며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 솔라펑크 친환경 미래 3D 스타일 동영상 그리고 외형은 로봇말고 사람스럽게 해줘 그리고 쓰래기를 뱉지마","deletedCommentIds":[]},"version":44,"specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"미래 사회에는 공기가 오염되어서 공기 정화가 꼭 필요하다."},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#생태계보존 #미래보존"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"솔라펑크(Solarpunk) 친환경 미래 3D 스타일 (푸른 자연 생태계와 첨단 과학기술의 조화)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"공기 정화 , 인공지능(AI), 친환경 배터리와, 자율주행, 무선 충전 등등이 탑재 되어있다"},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"갈아버리는 기능, 공기 순환 기능 등 거거걱봇은 음식물 쓰레기 갈기, 공기청정기이다다다다다"},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"미세먼지 센서, 카메라 센서","sensorAction":"미세먼지 감지후, 공기를 깨끗하게 만들어준다","sensorTarget":"사람의 체온, 미세먼지 감지 등"},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"거거걱 봇 SIU⅛","appearance":"이 로봇은 음식물 처리기, 공기청정기 기능을 2가지 다 담고있다. 바퀴가 있어 어디든지 사람이 필요한 곳에 갈 수 있다. 재질은 가벼운 알루미늄으로 만들어져있고 눈이 거미처럼 많이 달려있어 어디든지 필요한 상황에 보고 갈 수 있다 . 외형은 호날두다"}},"submittedAt":"2026-11-16T03:27:24.240Z","videoPrompt":"[AI 영상 제작] 환경은 길거리고, 이 로봇은 음식물 처리기, 공기청정기 기능을 2가지 다 담고있다, 바퀴가 있어 어디든지 사람이 필요한 곳에 갈 수 있다, 재질은 가벼운 알루미늄으로 만들어져있고 눈이 거미처럼 많이 달려있어 어디든지 필요한 상황에 보고 갈 수 있다 외형을 갖춘 로봇 '거거걱 봇 SIU⅛'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 미세먼지 센서, 카메라 센서에 푸른 스캔 라이트가 켜지며(사람의 체온, 미세먼지 감지 등) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 목표물을 집어 올리고 수거 장치를 작동시키며, 몸체의 정화 필터로 오염 물질을 흡입해 걸러낸 뒤 맑고 깨끗한 흐름을 내보내며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 솔라펑크 친환경 미래 3D 스타일 동영상 그리고 외형은 로봇말고 사람스럽게 해줘 그리고 쓰래기를 뱉지마","teacherFeedbackBefore":"기능과 센서가 연결이 잘 안됨. 다시 생각해보고 내용 수정 필요."},{"label":"버전 45 (44차 수정)","inputs":{"purpose":"미래 사회에는 공기가 오염되어서 공기 정화가 꼭 필요하다.","robotName":"거거걱 봇 SIU⅛","aiFeedback":{"date":"2026-11-16","count":1,"step1":"거미 눈처럼 많은 센서가 달린 점이 아주 멋져요! 가벼운 알루미늄 대신 충격에 강하고 탄성이 좋은 신소재인 '탄소 섬유'를 사용해 보면 로봇이 더 튼튼해질 거예요.","step2":"공기 정화뿐만 아니라 음식물 쓰레기를 분해해서 에너지로 만드는 '바이오 가스 기술'을 추가하면 미래 환경 문제도 해결하는 멋진 로봇이 될 거예요.","step3":"음식물을 갈 때 필요한 '분쇄 모터'와 공기를 빨아들이는 '팬 구조'를 어떻게 연결할지 구체적으로 고민해 봐요. 공기청정기 필터가 어떻게 움직이는지 설명해 주면 더 완벽하겠어요.","step4":"센서가 단순히 감지만 하는 게 아니라, 위험한 쓰레기를 구분하는 '이미지 인식 카메라' 기능을 넣어보세요. 감지 후에 스스로 충전소로 이동하는 자율주행 알고리즘을 추가하면 훨씬 똑똑해질 거예요.","step5":"훌륭한 기술들이 많아요! 여기서 공기 속의 오염 물질을 붙잡는 '정전기 필터 원리'나 로봇 스스로 에너지를 아끼는 '전력 최적화 알고리즘'을 더 자세히 적어보길 추천해요.","updatedAt":"2026-11-16T00:26:09.920Z"},"appearance":"이 로봇은 음식물 처리기, 공기청정기 기능을 2가지 다 담고있다. 바퀴가 있어 어디든지 사람이 필요한 곳에 갈 수 있다. 재질은 가벼운 알루미늄으로 만들어져있고 눈이 거미처럼 많이 달려있어 어디든지 필요한 상황에 보고 갈 수 있다 . 외형은 호날두다","coreValues":"#생태계보존 #미래보존","sensorName":"미세먼지 센서, 카메라 센서","videoStyle":"솔라펑크(Solarpunk) 친환경 미래 3D 스타일 (푸른 자연 생태계와 첨단 과학기술의 조화)","scienceTech":"공기 정화 , 인공지능(AI), 친환경 배터리와, 자율주행, 무선 충전 등등이 탑재 되어있다","mainFunction":"갈아버리는 기능, 공기 순환 기능 등 거거걱봇은 음식물 쓰레기 갈기, 공기청정기이다다다다다","sensorAction":"미세먼지 감지후, 공기를 깨끗하게 만들어준다","sensorTarget":"사람의 체온, 미세먼지 감지 등","boothComments":[],"customVideoPrompt":"[AI 영상 제작] 환경은 길거리고, 이 로봇은 음식물 처리기, 공기청정기 기능을 2가지 다 담고있다, 바퀴가 있어 어디든지 사람이 필요한 곳에 갈 수 있다, 재질은 가벼운 알루미늄으로 만들어져있고 눈이 거미처럼 많이 달려있어 어디든지 필요한 상황에 보고 갈 수 있다 외형을 갖춘 로봇 '거거걱 봇 SIU⅛'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 미세먼지 센서, 카메라 센서에 푸른 스캔 라이트가 켜지며(사람의 체온, 미세먼지 감지 등) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 목표물을 집어 올리고 수거 장치를 작동시키며, 몸체의 정화 필터로 오염 물질을 흡입해 걸러낸 뒤 맑고 깨끗한 흐름을 내보내며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 솔라펑크 친환경 미래 3D 스타일 동영상 그리고 외형은 로봇말고 사람스럽게 해줘 그리고 쓰래기를 뱉지마","deletedCommentIds":[]},"version":45,"specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"미래 사회에는 공기가 오염되어서 공기 정화가 꼭 필요하다."},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#생태계보존 #미래보존"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"솔라펑크(Solarpunk) 친환경 미래 3D 스타일 (푸른 자연 생태계와 첨단 과학기술의 조화)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"공기 정화 , 인공지능(AI), 친환경 배터리와, 자율주행, 무선 충전 등등이 탑재 되어있다"},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"갈아버리는 기능, 공기 순환 기능 등 거거걱봇은 음식물 쓰레기 갈기, 공기청정기이다다다다다"},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"미세먼지 센서, 카메라 센서","sensorAction":"미세먼지 감지후, 공기를 깨끗하게 만들어준다","sensorTarget":"사람의 체온, 미세먼지 감지 등"},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"거거걱 봇 SIU⅛","appearance":"이 로봇은 음식물 처리기, 공기청정기 기능을 2가지 다 담고있다. 바퀴가 있어 어디든지 사람이 필요한 곳에 갈 수 있다. 재질은 가벼운 알루미늄으로 만들어져있고 눈이 거미처럼 많이 달려있어 어디든지 필요한 상황에 보고 갈 수 있다 . 외형은 호날두다"}},"submittedAt":"2026-11-16T03:27:24.500Z","videoPrompt":"[AI 영상 제작] 환경은 길거리고, 이 로봇은 음식물 처리기, 공기청정기 기능을 2가지 다 담고있다, 바퀴가 있어 어디든지 사람이 필요한 곳에 갈 수 있다, 재질은 가벼운 알루미늄으로 만들어져있고 눈이 거미처럼 많이 달려있어 어디든지 필요한 상황에 보고 갈 수 있다 외형을 갖춘 로봇 '거거걱 봇 SIU⅛'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 미세먼지 센서, 카메라 센서에 푸른 스캔 라이트가 켜지며(사람의 체온, 미세먼지 감지 등) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 목표물을 집어 올리고 수거 장치를 작동시키며, 몸체의 정화 필터로 오염 물질을 흡입해 걸러낸 뒤 맑고 깨끗한 흐름을 내보내며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 솔라펑크 친환경 미래 3D 스타일 동영상 그리고 외형은 로봇말고 사람스럽게 해줘 그리고 쓰래기를 뱉지마","teacherFeedbackBefore":"기능과 센서가 연결이 잘 안됨. 다시 생각해보고 내용 수정 필요."}],"updatedAt":"2026-11-17T00:11:57.341Z"},{"studentId":"하정우","studentName":"하정우","status":"approved","inputs":{"robotName":"해양 쓰레기 봇 X👍","appearance":"외형은 몸통은 동그랗고 프로펠러가 4개 정도 달려 있고 다리는 새 다리 처럼 생겼다. 손은 사람처럼 있고 집게 손 모형이다. 눈에 센서가 달려 바다에 있는 쓰레기는손으로 잡고 미세 플라스틱 같은 작은 물체는 입구멍으로 빨아들이고 자기 머리 뚜껑을 열어 쓰레기를 넣어 자동 처리 한다. 그리고 몸에 전체적으로 태양열 패널이 있어 자동 충전 외형의 로봇","purpose":"오염된 바다를 날아다니며 오염 물질을 처리한다.","mainFunction":"입에 있는 구멍으로는 작은 물체를 빨아들이고 집게 손으로 집을수 있는 것은 손으로 잡아 머리 뚜껑을 열어 쓰레기를 자동 처리","sensorName":"해양 오염 물질 센서","sensorTarget":"물속에 있는 오염 물질을 센서로 감지 함","sensorAction":"로봇의 해양 오염 물질 센서가 빛나며 바다 속에 있는 쓰레기를 센서로 감지 함을 스캔한 뒤, 쓰레기를 처리 하고 쓰레기가 많은 곳을 센서로 감지 해 또 쓰레기를 처리 한다","scienceTech":"해양 오염 물질 센서로 쓰레기를 감지 하고 몸에 전체적으로 태양열 패널이 있어 자동 충전 외형의 로봇이다","coreValues":"#생태계 #쓰레기 #처리","videoStyle":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)","customVideoPrompt":"[AI 영상 제작] 햇빛이 투명하게 투과되는 2050년 푸른 날 하늘을 날아 다니며 바다에 있는 쓰레기를 스캔 해 바다로 들어감, 몸통은 동그랗고 프로펠러가 4개 정도 달려 있고 다리는 두개 날아 다니며 바다에 들어가서 손은 집게 모형, 눈에 센서가 달려 바다에 있는 쓰레기는 손으로 잡고 자기 머리 뚜껑을 열어 쓰레기를 넣고 머리 뚜껑을 닫는다 집게 손으로 집을수 있는 것은 손으로 잡아 머리 뚜껑을 열어 쓰레기를 자동 처리 하는 외형을 갖춘 로봇 '해양 쓰레기 봇 X👍'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 해양 오염 물질 센서에 푸른 스캔 라이트가 켜지며(물속에 있는 오염 물질을 센서로 감지 함) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 목표물을 집어 올리고 수거 장치를 작동시키며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상. 쓰레기는 생성 하지 말고 날다가 바다로 들어가 쓰레기를 머리에 넣어","aiFeedback":{"date":"2026-11-16","count":1,"step1":"로봇의 외형이 잘 그려져서 정말 멋져요! 다만, 바다에서 쓰레기를 담을 때 물에 젖지 않도록 로봇 표면에 '연잎 효과'를 이용한 방수 신소재를 씌운다고 설명해 보면 어떨까요? 또한, 다리가 왜 새 모양인지 공학적 이유를 한 문장 더 추가해 보세요.","step2":"바다를 깨끗하게 만드는 목적이 아주 훌륭해요! 단순히 처리하는 것을 넘어, 로봇이 수집한 정보를 바탕으로 바다의 오염 지도를 실시간으로 작성하여 사람들에게 알려주는 역할을 추가하면 사회적으로 더 큰 도움이 될 거예요.","step3":"쓰레기를 빨아들이는 원리를 조금 더 구체적으로 적어볼까요? 로봇 내부에 베르누이 원리를 이용한 진공 흡입 장치가 있다고 설명하면 훨씬 공학적인 설명이 된답니다. 집게 손에는 물건의 무게를 느끼는 압력 센서를 추가해 보세요.","step4":"센서가 빛나는 모습이 상상돼요! 단순히 빛나는 것뿐만 아니라, 오염 물질의 종류를 구별할 수 있도록 '분광 센서'를 사용한다고 적어보세요. 쓰레기를 감지한 뒤에는 GPS 통신을 통해 수거된 위치를 기록하는 행동을 추가하면 완벽해요.","step5":"태양열 패널 기술은 아주 좋아요! 여기에 바다의 파도 에너지를 이용하는 '압전 소자' 기술을 추가해 보면 어떨까요? 그러면 흐린 날에도 바다 위에서 에너지를 만들어 훨씬 오래 활동할 수 있을 거예요.","updatedAt":"2026-11-16T00:25:17.649Z"},"boothComments":[{"v":2,"id":"c_1794873514312_5c3u3","text":"이런쓰레기로봇이 있으면 바다가 깨끗해질거야.","author":"이원준","createdAt":"2026-11-16T23:58:34.312Z","viewerToken":"vt_1794873057588_6rghf8uo","authorStudentId":"이원준"},{"v":2,"id":"c_1794873540089_u68kt","text":"우ㅗ아와와와와와어ㅏ와와와와와어ㅏ오ㅓ와와와ㅏ 이 로봇을 보면서 해양생테계를 지킬수있는 최적화되어있다는걸 느꼈어 정말 대단한데? 정말 칭찬해! 브로는 완벽함의 그 잡체야. 정말 놀라워서 손이 떨리는걸?🤣 나도 이런점을 본받을려고 노력해야겠어.","author":"김민재","createdAt":"2026-11-16T23:59:00.089Z","viewerToken":"vt_1794796308439_8yzbw3eg","authorStudentId":"김민재"},{"v":2,"id":"c_1794873853325_wi2t1","text":"🦀🦾🌊🦀🦾🌊🦀🦾🌊🦀🦾🌊🦀🦾🌊🦀🦾🌊🦀🦾🌊🦀🦾🌊🦀🦾🌊🦀🦾🌊🦀🦾🌊🦀🦾🌊🦀🦾🌊🦀🦾🌊🦀🦾🌊🦀🦾🌊🦀🦾🌊🦀🦾🌊🦀🦾🌊🦀🦾🌊🦀🦾🌊🦀🦾🌊🦀🦾🌊🦀🦾🌊🦀🦾🌊🦀🦾🌊🦀🦾🌊🦀🦾🌊🦀🦾🌊🦀🦾🌊🦀🦾🌊🦀🦾🌊🦀🦾🌊","author":"신연호","createdAt":"2026-11-17T00:04:13.325Z","viewerToken":"vt_1794788851253_3o74q6xc","authorStudentId":"신연호"},{"v":2,"id":"c_1794873878852_rryfb","text":"바다의 쓰레기들이 좀 줄어서 바다를 지킬 수 있을 것 같아! 좋은 아이디어야","author":"장서윤","createdAt":"2026-11-17T00:04:38.852Z","viewerToken":"vt_1794796665307_ra6syqil","authorStudentId":"장서윤"},{"v":2,"id":"c_1794873971667_h1mkk","text":"우와 형제여 이것은 말을 설명할수없는.","author":"김승윤","createdAt":"2026-11-17T00:06:11.667Z","viewerToken":"vt_1794796086113_pfa1lkx5","authorStudentId":"김승윤"},{"v":2,"id":"c_1794873979711_y8ltd","text":"와 브로. 그것은 완벽함 그 잡채야🤩 지구에 있는 모든 쓰레기와 바다에 있는 모든 쓰레기를 하나하나 따로 힘들게 노동을 하면서 버리지 않아도 많은 쓰레기를 버려서 지구 온난화를 늦출수있겠어🤩🤩🤩 와 진짜, 브로는 천재야 어떻게 로봇을 바다에 날려보내서 바다까지 지킬 생각을 한거지? 브로는 그냥 그 상태로 조금만 연구하면 바다정복은 거뜬하겠는걸?!?!","author":"김규혁","createdAt":"2026-11-17T00:06:19.711Z","viewerToken":"vt_1794796116808_09f96gop","authorStudentId":"김규혁"},{"v":2,"id":"c_1794874328786_qsl63","text":"물 안에서 이동하면 물고기가 다칠수 있는데 ㅅ하늘로 이동해서 잡으면 덜 다칠 수 있어","author":"진연우","createdAt":"2026-11-17T00:12:08.786Z","viewerToken":"vt_1794788838051_mpwskv0k","authorStudentId":"진연우"}],"deletedCommentIds":["c_1794873171284_1w3k6","c_1794874262324_lwg19"]},"videoPrompt":"[AI 영상 제작] 햇빛이 투명하게 투과되는 2050년 푸른 날 하늘을 날아 다니며 바다에 있는 쓰레기를 스캔 해 바다로 들어감, 몸통은 동그랗고 프로펠러가 4개 정도 달려 있고 다리는 두개 날아 다니며 바다에 들어가서 손은 집게 모형, 눈에 센서가 달려 바다에 있는 쓰레기는 손으로 잡고 자기 머리 뚜껑을 열어 쓰레기를 넣고 머리 뚜껑을 닫는다 집게 손으로 집을수 있는 것은 손으로 잡아 머리 뚜껑을 열어 쓰레기를 자동 처리 하는 외형을 갖춘 로봇 '해양 쓰레기 봇 X👍'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 해양 오염 물질 센서에 푸른 스캔 라이트가 켜지며(물속에 있는 오염 물질을 센서로 감지 함) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 목표물을 집어 올리고 수거 장치를 작동시키며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상. 쓰레기는 생성 하지 말고 날다가 바다로 들어가 쓰레기를 머리에 넣어","specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"오염된 바다를 날아다니며 오염 물질을 처리한다."},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#생태계 #쓰레기 #처리"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"해양 오염 물질 센서로 쓰레기를 감지 하고 몸에 전체적으로 태양열 패널이 있어 자동 충전 외형의 로봇이다"},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"입에 있는 구멍으로는 작은 물체를 빨아들이고 집게 손으로 집을수 있는 것은 손으로 잡아 머리 뚜껑을 열어 쓰레기를 자동 처리"},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"해양 오염 물질 센서","sensorAction":"로봇의 해양 오염 물질 센서가 빛나며 바다 속에 있는 쓰레기를 센서로 감지 함을 스캔한 뒤, 쓰레기를 처리 하고 쓰레기가 많은 곳을 센서로 감지 해 또 쓰레기를 처리 한다","sensorTarget":"물속에 있는 오염 물질을 센서로 감지 함"},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"해양 쓰레기 봇 X👍","appearance":"외형은 몸통은 동그랗고 프로펠러가 4개 정도 달려 있고 다리는 새 다리 처럼 생겼다. 손은 사람처럼 있고 집게 손 모형이다. 눈에 센서가 달려 바다에 있는 쓰레기는손으로 잡고 미세 플라스틱 같은 작은 물체는 입구멍으로 빨아들이고 자기 머리 뚜껑을 열어 쓰레기를 넣어 자동 처리 한다. 그리고 몸에 전체적으로 태양열 패널이 있어 자동 충전 외형의 로봇"}},"teacherFeedback":"","feedbackAt":"","video":{"type":"none","url":"","title":"","thumbnail":""},"likes":7,"currentVersion":8,"history":[{"label":"버전 7 (6차 수정)","inputs":{"purpose":"오염된 바다를 날아다니며 오염 물질을 처리한다.","robotName":"해양 쓰레기 봇 X👍","aiFeedback":{"date":"2026-11-16","count":1,"step1":"로봇의 외형이 잘 그려져서 정말 멋져요! 다만, 바다에서 쓰레기를 담을 때 물에 젖지 않도록 로봇 표면에 '연잎 효과'를 이용한 방수 신소재를 씌운다고 설명해 보면 어떨까요? 또한, 다리가 왜 새 모양인지 공학적 이유를 한 문장 더 추가해 보세요.","step2":"바다를 깨끗하게 만드는 목적이 아주 훌륭해요! 단순히 처리하는 것을 넘어, 로봇이 수집한 정보를 바탕으로 바다의 오염 지도를 실시간으로 작성하여 사람들에게 알려주는 역할을 추가하면 사회적으로 더 큰 도움이 될 거예요.","step3":"쓰레기를 빨아들이는 원리를 조금 더 구체적으로 적어볼까요? 로봇 내부에 베르누이 원리를 이용한 진공 흡입 장치가 있다고 설명하면 훨씬 공학적인 설명이 된답니다. 집게 손에는 물건의 무게를 느끼는 압력 센서를 추가해 보세요.","step4":"센서가 빛나는 모습이 상상돼요! 단순히 빛나는 것뿐만 아니라, 오염 물질의 종류를 구별할 수 있도록 '분광 센서'를 사용한다고 적어보세요. 쓰레기를 감지한 뒤에는 GPS 통신을 통해 수거된 위치를 기록하는 행동을 추가하면 완벽해요.","step5":"태양열 패널 기술은 아주 좋아요! 여기에 바다의 파도 에너지를 이용하는 '압전 소자' 기술을 추가해 보면 어떨까요? 그러면 흐린 날에도 바다 위에서 에너지를 만들어 훨씬 오래 활동할 수 있을 거예요.","updatedAt":"2026-11-16T00:25:17.649Z"},"appearance":"외형은 몸통은 동그랗고 프로펠러가 4개 정도 달려 있고 다리는 새 다리 처럼 생겼다. 손은 사람처럼 있고 집게 손 모형이다. 눈에 센서가 달려 바다에 있는 쓰레기는손으로 잡고 미세 플라스틱 같은 작은 물체는 입구멍으로 빨아들이고 자기 머리 뚜껑을 열어 쓰레기를 넣어 자동 처리 한다. 그리고 몸에 전체적으로 태양열 패널이 있어 자동 충전 외형의 로봇","coreValues":"#생태계 #쓰레기 #처리","sensorName":"해양 오염 물질 센서","videoStyle":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)","scienceTech":"해양 오염 물질 센서로 쓰레기를 감지 하고 몸에 전체적으로 태양열 패널이 있어 자동 충전 외형의 로봇이다","mainFunction":"입에 있는 구멍으로는 작은 물체를 빨아들이고 집게 손으로 집을수 있는 것은 손으로 잡아 머리 뚜껑을 열어 쓰레기를 자동 처리","sensorAction":"로봇의 해양 오염 물질 센서가 빛나며 바다 속에 있는 쓰레기를 센서로 감지 함을 스캔한 뒤, 쓰레기를 처리 하고 쓰레기가 많은 곳을 센서로 감지 해 또 쓰레기를 처리 한다","sensorTarget":"물속에 있는 오염 물질을 센서로 감지 함","boothComments":[],"customVideoPrompt":"[AI 영상 제작] 햇빛이 투명하게 투과되는 2050년 푸른 날 하늘을 날아 다니며 바다에 있는 쓰레기를 스켄 해 바다로 들어감, 외형은 몸통은 동그랗고 프로펠러가 4개 정도 달려 있고 다리는 백개 날아 다니며 바다에 들어가서 손은 집게 손 모형, 눈에 센서가 달려 바다에 있는 쓰레기는 손으로 잡고 자기 머리 뚜껑을 열어 쓰레기를 넣어 자동 처리 한다 집게 손으로 집을수 있는 것은 손으로 잡아 머리 뚜껑을 열어 쓰레기를 자동 처리 하는 외형을 갖춘 로봇 '해양 쓰레기 봇 X👍'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 해양 오염 물질 센서에 푸른 스캔 라이트가 켜지며(물속에 있는 오염 물질을 센서로 감지 함) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 목표물을 집어 올리고 수거 장치를 작동시키며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상. 쓰레기 진짜 제발 뱉지마 pls","deletedCommentIds":[]},"version":7,"specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"오염된 바다를 날아다니며 오염 물질을 처리한다."},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#생태계 #쓰레기 #처리"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"해양 오염 물질 센서로 쓰레기를 감지 하고 몸에 전체적으로 태양열 패널이 있어 자동 충전 외형의 로봇이다"},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"입에 있는 구멍으로는 작은 물체를 빨아들이고 집게 손으로 집을수 있는 것은 손으로 잡아 머리 뚜껑을 열어 쓰레기를 자동 처리"},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"해양 오염 물질 센서","sensorAction":"로봇의 해양 오염 물질 센서가 빛나며 바다 속에 있는 쓰레기를 센서로 감지 함을 스캔한 뒤, 쓰레기를 처리 하고 쓰레기가 많은 곳을 센서로 감지 해 또 쓰레기를 처리 한다","sensorTarget":"물속에 있는 오염 물질을 센서로 감지 함"},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"해양 쓰레기 봇 X👍","appearance":"외형은 몸통은 동그랗고 프로펠러가 4개 정도 달려 있고 다리는 새 다리 처럼 생겼다. 손은 사람처럼 있고 집게 손 모형이다. 눈에 센서가 달려 바다에 있는 쓰레기는손으로 잡고 미세 플라스틱 같은 작은 물체는 입구멍으로 빨아들이고 자기 머리 뚜껑을 열어 쓰레기를 넣어 자동 처리 한다. 그리고 몸에 전체적으로 태양열 패널이 있어 자동 충전 외형의 로봇"}},"submittedAt":"2026-11-16T03:08:28.119Z","videoPrompt":"[AI 영상 제작] 햇빛이 투명하게 투과되는 2050년 푸른 날 하늘을 날아 다니며 바다에 있는 쓰레기를 스켄 해 바다로 들어감, 외형은 몸통은 동그랗고 프로펠러가 4개 정도 달려 있고 다리는 백개 날아 다니며 바다에 들어가서 손은 집게 손 모형, 눈에 센서가 달려 바다에 있는 쓰레기는 손으로 잡고 자기 머리 뚜껑을 열어 쓰레기를 넣어 자동 처리 한다 집게 손으로 집을수 있는 것은 손으로 잡아 머리 뚜껑을 열어 쓰레기를 자동 처리 하는 외형을 갖춘 로봇 '해양 쓰레기 봇 X👍'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 해양 오염 물질 센서에 푸른 스캔 라이트가 켜지며(물속에 있는 오염 물질을 센서로 감지 함) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 목표물을 집어 올리고 수거 장치를 작동시키며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상. 쓰레기 진짜 제발 뱉지마 pls","teacherFeedbackBefore":""},{"label":"버전 8 (7차 수정)","inputs":{"purpose":"오염된 바다를 날아다니며 오염 물질을 처리한다.","robotName":"해양 쓰레기 봇 X👍","aiFeedback":{"date":"2026-11-16","count":1,"step1":"로봇의 외형이 잘 그려져서 정말 멋져요! 다만, 바다에서 쓰레기를 담을 때 물에 젖지 않도록 로봇 표면에 '연잎 효과'를 이용한 방수 신소재를 씌운다고 설명해 보면 어떨까요? 또한, 다리가 왜 새 모양인지 공학적 이유를 한 문장 더 추가해 보세요.","step2":"바다를 깨끗하게 만드는 목적이 아주 훌륭해요! 단순히 처리하는 것을 넘어, 로봇이 수집한 정보를 바탕으로 바다의 오염 지도를 실시간으로 작성하여 사람들에게 알려주는 역할을 추가하면 사회적으로 더 큰 도움이 될 거예요.","step3":"쓰레기를 빨아들이는 원리를 조금 더 구체적으로 적어볼까요? 로봇 내부에 베르누이 원리를 이용한 진공 흡입 장치가 있다고 설명하면 훨씬 공학적인 설명이 된답니다. 집게 손에는 물건의 무게를 느끼는 압력 센서를 추가해 보세요.","step4":"센서가 빛나는 모습이 상상돼요! 단순히 빛나는 것뿐만 아니라, 오염 물질의 종류를 구별할 수 있도록 '분광 센서'를 사용한다고 적어보세요. 쓰레기를 감지한 뒤에는 GPS 통신을 통해 수거된 위치를 기록하는 행동을 추가하면 완벽해요.","step5":"태양열 패널 기술은 아주 좋아요! 여기에 바다의 파도 에너지를 이용하는 '압전 소자' 기술을 추가해 보면 어떨까요? 그러면 흐린 날에도 바다 위에서 에너지를 만들어 훨씬 오래 활동할 수 있을 거예요.","updatedAt":"2026-11-16T00:25:17.649Z"},"appearance":"외형은 몸통은 동그랗고 프로펠러가 4개 정도 달려 있고 다리는 새 다리 처럼 생겼다. 손은 사람처럼 있고 집게 손 모형이다. 눈에 센서가 달려 바다에 있는 쓰레기는손으로 잡고 미세 플라스틱 같은 작은 물체는 입구멍으로 빨아들이고 자기 머리 뚜껑을 열어 쓰레기를 넣어 자동 처리 한다. 그리고 몸에 전체적으로 태양열 패널이 있어 자동 충전 외형의 로봇","coreValues":"#생태계 #쓰레기 #처리","sensorName":"해양 오염 물질 센서","videoStyle":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)","scienceTech":"해양 오염 물질 센서로 쓰레기를 감지 하고 몸에 전체적으로 태양열 패널이 있어 자동 충전 외형의 로봇이다","mainFunction":"입에 있는 구멍으로는 작은 물체를 빨아들이고 집게 손으로 집을수 있는 것은 손으로 잡아 머리 뚜껑을 열어 쓰레기를 자동 처리","sensorAction":"로봇의 해양 오염 물질 센서가 빛나며 바다 속에 있는 쓰레기를 센서로 감지 함을 스캔한 뒤, 쓰레기를 처리 하고 쓰레기가 많은 곳을 센서로 감지 해 또 쓰레기를 처리 한다","sensorTarget":"물속에 있는 오염 물질을 센서로 감지 함","boothComments":[],"customVideoPrompt":"[AI 영상 제작] 햇빛이 투명하게 투과되는 2050년 푸른 날 하늘을 날아 다니며 바다에 있는 쓰레기를 스캔 해 바다로 들어감, 몸통은 동그랗고 프로펠러가 4개 정도 달려 있고 다리는 두개 날아 다니며 바다에 들어가서 손은 집게 모형, 눈에 센서가 달려 바다에 있는 쓰레기는 손으로 잡고 자기 머리 뚜껑을 열어 쓰레기를 넣고 머리 뚜껑을 닫는다 집게 손으로 집을수 있는 것은 손으로 잡아 머리 뚜껑을 열어 쓰레기를 자동 처리 하는 외형을 갖춘 로봇 '해양 쓰레기 봇 X👍'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 해양 오염 물질 센서에 푸른 스캔 라이트가 켜지며(물속에 있는 오염 물질을 센서로 감지 함) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 목표물을 집어 올리고 수거 장치를 작동시키며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상. 쓰레기는 생성 하지 말고 날다가 바다로 들어가 쓰레기를 머리에 넣어","deletedCommentIds":[]},"version":8,"specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"오염된 바다를 날아다니며 오염 물질을 처리한다."},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#생태계 #쓰레기 #처리"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"해양 오염 물질 센서로 쓰레기를 감지 하고 몸에 전체적으로 태양열 패널이 있어 자동 충전 외형의 로봇이다"},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"입에 있는 구멍으로는 작은 물체를 빨아들이고 집게 손으로 집을수 있는 것은 손으로 잡아 머리 뚜껑을 열어 쓰레기를 자동 처리"},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"해양 오염 물질 센서","sensorAction":"로봇의 해양 오염 물질 센서가 빛나며 바다 속에 있는 쓰레기를 센서로 감지 함을 스캔한 뒤, 쓰레기를 처리 하고 쓰레기가 많은 곳을 센서로 감지 해 또 쓰레기를 처리 한다","sensorTarget":"물속에 있는 오염 물질을 센서로 감지 함"},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"해양 쓰레기 봇 X👍","appearance":"외형은 몸통은 동그랗고 프로펠러가 4개 정도 달려 있고 다리는 새 다리 처럼 생겼다. 손은 사람처럼 있고 집게 손 모형이다. 눈에 센서가 달려 바다에 있는 쓰레기는손으로 잡고 미세 플라스틱 같은 작은 물체는 입구멍으로 빨아들이고 자기 머리 뚜껑을 열어 쓰레기를 넣어 자동 처리 한다. 그리고 몸에 전체적으로 태양열 패널이 있어 자동 충전 외형의 로봇"}},"submittedAt":"2026-11-16T03:17:03.992Z","videoPrompt":"[AI 영상 제작] 햇빛이 투명하게 투과되는 2050년 푸른 날 하늘을 날아 다니며 바다에 있는 쓰레기를 스캔 해 바다로 들어감, 몸통은 동그랗고 프로펠러가 4개 정도 달려 있고 다리는 두개 날아 다니며 바다에 들어가서 손은 집게 모형, 눈에 센서가 달려 바다에 있는 쓰레기는 손으로 잡고 자기 머리 뚜껑을 열어 쓰레기를 넣고 머리 뚜껑을 닫는다 집게 손으로 집을수 있는 것은 손으로 잡아 머리 뚜껑을 열어 쓰레기를 자동 처리 하는 외형을 갖춘 로봇 '해양 쓰레기 봇 X👍'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 해양 오염 물질 센서에 푸른 스캔 라이트가 켜지며(물속에 있는 오염 물질을 센서로 감지 함) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 목표물을 집어 올리고 수거 장치를 작동시키며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상. 쓰레기는 생성 하지 말고 날다가 바다로 들어가 쓰레기를 머리에 넣어","teacherFeedbackBefore":""}],"updatedAt":"2026-11-17T00:12:24.405Z"},{"studentId":"이석준","studentName":"이석준","status":"approved","inputs":{"robotName":"스타클린 갤럭시 스윕","appearance":"팔각기둥 모양 몸체를 가지고 있고, 양 옆에 대칭으로 달려있는 직사각형 모양의 날개에는 태양 전지가 달려 있다. 로봇의 옆에도 센서들이 달려있다. 팔각기둥의 한 밑면에는 여러 센서와 쓰레기를 빨아 들일 수 있는 흡입기가 달려있다. 흡입기 뒤에는 필요에 따라 늘어 날 수 있는 긴 관이 달려있다. 팔각기둥의 다른 밑면에는 전후좌우로 갈 수 있는 부스터가 여러 개 달려있다. 로봇은 티타늄 합금으로 만들어졌다.","purpose":"쓰레기가 많은 우주를 날아 다니며 쓰레기를 처리해 우주를 깨끗하게 만든다.","mainFunction":"앞에 달려 있는 흡입기로 부스러기가 안 나오게 쓰레기를 처리한다. 날개에 달려 있는 태양 전지로 충전할 필요가 없다.","sensorName":"카메라 센서, 거리 센서, 적외선 센서","sensorTarget":"앞 옆에 달려 있는 센서들로 로봇을 중심으로 반경 15미터 이내의 쓰레기를 감지한다. 쓰레기의 크기도 감지해 흡입 세기도 조절할 수있다. 적외선 센서롤 아주 작은 먼지까지 찾아 낼 수 있다.","sensorAction":"로봇은 쓰레기가 있는 곳으로 이용해 흡입기로 쓰레기를 빨아들인다.","scienceTech":"거리 센서로 쓰레기들의 위치를 파악하고 카메라 센서로 쓰레기들을 인식해 흡입기로 빨아들인다. 태양 전지가 달려 있어 충전할 필요 없다.","coreValues":"#우주보존 #지속가능성","videoStyle":"시네마틱 SF 실사 영화 스타일 (초고화질 금속 질감과 미래형 네온 조명 연출)","customVideoPrompt":"[AI 영상 제작] 푸른 지구와 별빛이 빛나는 2050년 우주 정거장 궤도 공간에서, 팔각기둥 모양 몸체를 가지고 있고, 양 옆에 대칭으로 달려있는 직사각형 모양의 날개에는 태양 전지가 장착된, 로봇의 옆에도 센서들이 장착된, 팔각기둥의 한 밑면에는 여러 센서와 쓰레기를 빨아 들일 수 있는 흡입기가 장착됐고, 다른 밑면에는 부스터가 달려있는 외형을 갖춘 로봇 '스타클린 갤럭시 스윕'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 멀리서 날아와 장착된 카메라 센서, 거리 센서, 적외선 센서에 푸른 스캔 라이트가 켜지며(앞 옆에 달려 있는 센서들로 로봇을 중심으로 반경 15미터 이내의 쓰레기) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 몸에 부착 되어 있는 흡입기로 쓰레기를 끌어 모으는 임무를 수행하는 모습을 생생하게 보여준다.(우주에서 로봇 흡입기로) 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 시네마틱 SF 실사 영화 스타일 동영상.","aiFeedback":{"date":"2026-11-16","count":2,"step1":"로봇의 움직임이 부드러워지도록 관절이나 바퀴의 형태를 좀 더 구체적으로 설명해 볼까요? 티타늄 합금 외에도 가벼운 탄소 섬유 같은 신소재를 섞으면 우주에서 더 빠르게 이동할 수 있어요.","step2":"우주 쓰레기가 왜 위험한지 그 이유를 함께 적어주면 더 멋진 목표가 될 것 같아요. 쓰레기를 단순히 치우는 것뿐만 아니라, 수거한 쓰레기를 재활용하여 새로운 자원으로 만드는 과정까지 고민해 보면 완벽해요!","step3":"흡입기가 쓰레기를 어떻게 보관하는지 내부 저장 장치 구조를 설명해 주면 좋을 것 같아요. 흡입할 때 진공 상태를 만드는 과학적 원리를 추가하면 더 실감 나는 로봇이 될 거예요.","step4":"센서들이 쓰레기를 감지했을 때, 로봇이 스스로 경로를 계산하는 자율주행 알고리즘을 추가해 보세요. 센서로 감지한 데이터를 바탕으로 로봇이 어떤 순서로 쓰레기를 먼저 치울지 결정하는 기능도 아주 유용하답니다.","step5":"태양 전지뿐만 아니라 우주의 차가운 온도와 뜨거운 태양열을 이용한 에너지 변환 기술을 넣어보면 어떨까요? 인공지능이 스스로 쓰레기의 종류를 분류하는 머신러닝 기술에 대해서도 조사해 보세요.","updatedAt":"2026-11-16T02:50:54.795Z"},"boothComments":[{"v":2,"id":"c_1794873236600_ub8au","text":"❤️🧡💛💚💙🩵💜🩷굿👍!!","author":"이수아","createdAt":"2026-11-16T23:53:56.601Z","viewerToken":"vt_1794799212191_bqc4jkhg","authorStudentId":"이수아"},{"v":2,"id":"c_1794873909076_cl37l","text":"오와ㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏ아이디어 굿","author":"김지안","createdAt":"2026-11-17T00:05:09.077Z","viewerToken":"vt_1794796070701_4iqa9fd3","authorStudentId":"김지안"},{"v":2,"id":"c_1794873927187_60ddf","text":"멋진 아이디어다!!😯😯😯😯😯😯","author":"장서윤","createdAt":"2026-11-17T00:05:27.187Z","viewerToken":"vt_1794796665307_ra6syqil","authorStudentId":"장서윤"},{"v":2,"id":"c_1794873986045_n73d1","text":"이야ㅑㅑㅑㅑㅑㅑㅑㅑㅑㅑㅑㅑㅑㅑㅑㅑㅑㅑ","author":"김승윤","createdAt":"2026-11-17T00:06:26.045Z","viewerToken":"vt_1794796086113_pfa1lkx5","authorStudentId":"김승윤"},{"v":2,"id":"c_1794874028508_1m5bk","text":"우와ㅏ 레이저가 나오면서 쓰레기 치워주는거 아이디어 지짜 좋다 💙","author":"김지아","createdAt":"2026-11-17T00:07:08.508Z","viewerToken":"vt_1794796098329_ixf8fbb4","authorStudentId":"김지아"},{"v":2,"id":"c_1794874181236_jpati","text":"석준아 티타늄 합금이면 무거워서 엔진을 쓸라면 에너지가 무지막지하게 필요할거야 티타늄대신 비싸고 만들기 어렵지만 가볍고 단단한 티탄합금이나 강철보다 약 70배 강하고 가벼운 탄소 섬유 복합체를 쓰는게 어때?","author":"박성민","createdAt":"2026-11-17T00:09:41.236Z","viewerToken":"vt_1794797170972_uk8wojcz","authorStudentId":"박성민"},{"v":2,"id":"c_1794874357411_mdla4","text":"와 브로. 그것은 완벽함 그 잡채야🤩 이정도면 우주에 있는 모든 쓰레기와 지구에 있는 모든 쓰레기를 하나하나 따로 힘들게 노동을 하면서 버리지 않아도 많은 쓰레기를 버려서 지구 온난화를 늦출수있겠어🤩🤩🤩 와 진짜, 브로는 천재야 어떻게 로봇을 우주에 날려서 지구를 킬 생각을 한거지? 브로는 그냥 그 상태로 조금만 연구하면 우주정복은 거뜬하겠는걸?!","author":"김규혁","createdAt":"2026-11-17T00:12:37.411Z","viewerToken":"vt_1794796116808_09f96gop","authorStudentId":"김규혁"}],"deletedCommentIds":["c_1794873468568_699wa"]},"videoPrompt":"[AI 영상 제작] 푸른 지구와 별빛이 빛나는 2050년 우주 정거장 궤도 공간에서, 팔각기둥 모양 몸체를 가지고 있고, 양 옆에 대칭으로 달려있는 직사각형 모양의 날개에는 태양 전지가 장착된, 로봇의 옆에도 센서들이 장착된, 팔각기둥의 한 밑면에는 여러 센서와 쓰레기를 빨아 들일 수 있는 흡입기가 장착됐고, 다른 밑면에는 부스터가 달려있는 외형을 갖춘 로봇 '스타클린 갤럭시 스윕'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 멀리서 날아와 장착된 카메라 센서, 거리 센서, 적외선 센서에 푸른 스캔 라이트가 켜지며(앞 옆에 달려 있는 센서들로 로봇을 중심으로 반경 15미터 이내의 쓰레기) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 몸에 부착 되어 있는 흡입기로 쓰레기를 끌어 모으는 임무를 수행하는 모습을 생생하게 보여준다.(우주에서 로봇 흡입기로) 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 시네마틱 SF 실사 영화 스타일 동영상.","specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"쓰레기가 많은 우주를 날아 다니며 쓰레기를 처리해 우주를 깨끗하게 만든다."},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#우주보존 #지속가능성"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"시네마틱 SF 실사 영화 스타일 (초고화질 금속 질감과 미래형 네온 조명 연출)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"거리 센서로 쓰레기들의 위치를 파악하고 카메라 센서로 쓰레기들을 인식해 흡입기로 빨아들인다. 태양 전지가 달려 있어 충전할 필요 없다."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"앞에 달려 있는 흡입기로 부스러기가 안 나오게 쓰레기를 처리한다. 날개에 달려 있는 태양 전지로 충전할 필요가 없다."},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"카메라 센서, 거리 센서, 적외선 센서","sensorAction":"로봇은 쓰레기가 있는 곳으로 이용해 흡입기로 쓰레기를 빨아들인다.","sensorTarget":"앞 옆에 달려 있는 센서들로 로봇을 중심으로 반경 15미터 이내의 쓰레기를 감지한다. 쓰레기의 크기도 감지해 흡입 세기도 조절할 수있다. 적외선 센서롤 아주 작은 먼지까지 찾아 낼 수 있다."},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"스타클린 갤럭시 스윕","appearance":"팔각기둥 모양 몸체를 가지고 있고, 양 옆에 대칭으로 달려있는 직사각형 모양의 날개에는 태양 전지가 달려 있다. 로봇의 옆에도 센서들이 달려있다. 팔각기둥의 한 밑면에는 여러 센서와 쓰레기를 빨아 들일 수 있는 흡입기가 달려있다. 흡입기 뒤에는 필요에 따라 늘어 날 수 있는 긴 관이 달려있다. 팔각기둥의 다른 밑면에는 전후좌우로 갈 수 있는 부스터가 여러 개 달려있다. 로봇은 티타늄 합금으로 만들어졌다."}},"teacherFeedback":"","feedbackAt":"","video":{"type":"none","url":"","title":"","thumbnail":""},"likes":7,"currentVersion":6,"history":[{"label":"버전 5 (4차 수정)","inputs":{"purpose":"쓰레기가 많은 우주를 날아 다니며 쓰레기를 처리해 우주를 깨끗하게 만든다.","robotName":"스타클린 갤럭시 스윕","aiFeedback":{"date":"2026-11-16","count":2,"step1":"로봇의 움직임이 부드러워지도록 관절이나 바퀴의 형태를 좀 더 구체적으로 설명해 볼까요? 티타늄 합금 외에도 가벼운 탄소 섬유 같은 신소재를 섞으면 우주에서 더 빠르게 이동할 수 있어요.","step2":"우주 쓰레기가 왜 위험한지 그 이유를 함께 적어주면 더 멋진 목표가 될 것 같아요. 쓰레기를 단순히 치우는 것뿐만 아니라, 수거한 쓰레기를 재활용하여 새로운 자원으로 만드는 과정까지 고민해 보면 완벽해요!","step3":"흡입기가 쓰레기를 어떻게 보관하는지 내부 저장 장치 구조를 설명해 주면 좋을 것 같아요. 흡입할 때 진공 상태를 만드는 과학적 원리를 추가하면 더 실감 나는 로봇이 될 거예요.","step4":"센서들이 쓰레기를 감지했을 때, 로봇이 스스로 경로를 계산하는 자율주행 알고리즘을 추가해 보세요. 센서로 감지한 데이터를 바탕으로 로봇이 어떤 순서로 쓰레기를 먼저 치울지 결정하는 기능도 아주 유용하답니다.","step5":"태양 전지뿐만 아니라 우주의 차가운 온도와 뜨거운 태양열을 이용한 에너지 변환 기술을 넣어보면 어떨까요? 인공지능이 스스로 쓰레기의 종류를 분류하는 머신러닝 기술에 대해서도 조사해 보세요.","updatedAt":"2026-11-16T02:50:54.795Z"},"appearance":"팔각기둥 모양 몸체를 가지고 있고, 양 옆에 대칭으로 달려있는 직사각형 모양의 날개에는 태양 전지가 달려 있다. 로봇의 옆에도 센서들이 달려있다. 팔각기둥의 한 밑면에는 여러 센서와 쓰레기를 빨아 들일 수 있는 흡입기가 달려있다. 흡입기 뒤에는 필요에 따라 늘어 날 수 있는 긴 관이 달려있다. 팔각기둥의 다른 밑면에는 전후좌우로 갈 수 있는 부스터가 여러 개 달려있다. 로봇은 티타늄 합금으로 만들어졌다.","coreValues":"#우주보존 #지속가능성","sensorName":"카메라 센서, 거리 센서, 적외선 센서","videoStyle":"시네마틱 SF 실사 영화 스타일 (초고화질 금속 질감과 미래형 네온 조명 연출)","scienceTech":"거리 센서로 쓰레기들의 위치를 파악하고 카메라 센서로 쓰레기들을 인식해 흡입기로 빨아들인다. 태양 전지가 달려 있어 충전할 필요 없다.","mainFunction":"앞에 달려 있는 흡입기로 부스러기가 안 나오게 쓰레기를 처리한다. 날개에 달려 있는 태양 전지로 충전할 필요가 없다.","sensorAction":"로봇은 쓰레기가 있는 곳으로 이용해 흡입기로 쓰레기를 빨아들인다.","sensorTarget":"앞 옆에 달려 있는 센서들로 로봇을 중심으로 반경 15미터 이내의 쓰레기를 감지한다. 쓰레기의 크기도 감지해 흡입 세기도 조절할 수있다. 적외선 센서롤 아주 작은 먼지까지 찾아 낼 수 있다.","boothComments":[],"customVideoPrompt":"[AI 영상 제작] 푸른 지구와 별빛이 빛나는 2050년 우주 정거장 궤도 공간에서, 크기는 승용차 크기, 높이가 5미터 정도인 팔각기둥 모양 몸체를 가지고 있고, 양 옆면에 대칭으로 달려있는 가로 3미터 세로 2미터 정도의 직사각형 모양의 날개에는 태양 전지가 장착된, 로봇의 옆에도 센서들이 장착된, 팔각기둥의 한 밑면에는 여러 센서와 쓰레기를 빨아 들일 수 있는 흡입기가 장착됐고, 다른 밑면에는 부스터가 달려있는 외형을 갖춘 로봇 '스타클린 갤럭시 스윕'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 멀리서 날아와 장착된 카메라 센서, 거리 센서, 적외선 센서에 푸른 스캔 라이트가 켜지며(앞 옆에 달려 있는 센서들로 로봇을 중심으로 반경 15미터 이내의 쓰레기) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 흡입기를 작동시켜 쓰레기를 흡입하며 임무를 수행하는 모습을 생생하게 보여준다. 쓰레기는 뱉지 않고 흡입한다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 시네마틱 SF 실사 영화 스타일 동영상.","deletedCommentIds":[]},"version":5,"specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"쓰레기가 많은 우주를 날아 다니며 쓰레기를 처리해 우주를 깨끗하게 만든다."},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#우주보존 #지속가능성"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"시네마틱 SF 실사 영화 스타일 (초고화질 금속 질감과 미래형 네온 조명 연출)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"거리 센서로 쓰레기들의 위치를 파악하고 카메라 센서로 쓰레기들을 인식해 흡입기로 빨아들인다. 태양 전지가 달려 있어 충전할 필요 없다."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"앞에 달려 있는 흡입기로 부스러기가 안 나오게 쓰레기를 처리한다. 날개에 달려 있는 태양 전지로 충전할 필요가 없다."},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"카메라 센서, 거리 센서, 적외선 센서","sensorAction":"로봇은 쓰레기가 있는 곳으로 이용해 흡입기로 쓰레기를 빨아들인다.","sensorTarget":"앞 옆에 달려 있는 센서들로 로봇을 중심으로 반경 15미터 이내의 쓰레기를 감지한다. 쓰레기의 크기도 감지해 흡입 세기도 조절할 수있다. 적외선 센서롤 아주 작은 먼지까지 찾아 낼 수 있다."},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"스타클린 갤럭시 스윕","appearance":"팔각기둥 모양 몸체를 가지고 있고, 양 옆에 대칭으로 달려있는 직사각형 모양의 날개에는 태양 전지가 달려 있다. 로봇의 옆에도 센서들이 달려있다. 팔각기둥의 한 밑면에는 여러 센서와 쓰레기를 빨아 들일 수 있는 흡입기가 달려있다. 흡입기 뒤에는 필요에 따라 늘어 날 수 있는 긴 관이 달려있다. 팔각기둥의 다른 밑면에는 전후좌우로 갈 수 있는 부스터가 여러 개 달려있다. 로봇은 티타늄 합금으로 만들어졌다."}},"submittedAt":"2026-11-16T03:23:19.544Z","videoPrompt":"[AI 영상 제작] 푸른 지구와 별빛이 빛나는 2050년 우주 정거장 궤도 공간에서, 크기는 승용차 크기, 높이가 5미터 정도인 팔각기둥 모양 몸체를 가지고 있고, 양 옆면에 대칭으로 달려있는 가로 3미터 세로 2미터 정도의 직사각형 모양의 날개에는 태양 전지가 장착된, 로봇의 옆에도 센서들이 장착된, 팔각기둥의 한 밑면에는 여러 센서와 쓰레기를 빨아 들일 수 있는 흡입기가 장착됐고, 다른 밑면에는 부스터가 달려있는 외형을 갖춘 로봇 '스타클린 갤럭시 스윕'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 멀리서 날아와 장착된 카메라 센서, 거리 센서, 적외선 센서에 푸른 스캔 라이트가 켜지며(앞 옆에 달려 있는 센서들로 로봇을 중심으로 반경 15미터 이내의 쓰레기) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 흡입기를 작동시켜 쓰레기를 흡입하며 임무를 수행하는 모습을 생생하게 보여준다. 쓰레기는 뱉지 않고 흡입한다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 시네마틱 SF 실사 영화 스타일 동영상.","teacherFeedbackBefore":""},{"label":"버전 6 (5차 수정)","inputs":{"purpose":"쓰레기가 많은 우주를 날아 다니며 쓰레기를 처리해 우주를 깨끗하게 만든다.","robotName":"스타클린 갤럭시 스윕","aiFeedback":{"date":"2026-11-16","count":2,"step1":"로봇의 움직임이 부드러워지도록 관절이나 바퀴의 형태를 좀 더 구체적으로 설명해 볼까요? 티타늄 합금 외에도 가벼운 탄소 섬유 같은 신소재를 섞으면 우주에서 더 빠르게 이동할 수 있어요.","step2":"우주 쓰레기가 왜 위험한지 그 이유를 함께 적어주면 더 멋진 목표가 될 것 같아요. 쓰레기를 단순히 치우는 것뿐만 아니라, 수거한 쓰레기를 재활용하여 새로운 자원으로 만드는 과정까지 고민해 보면 완벽해요!","step3":"흡입기가 쓰레기를 어떻게 보관하는지 내부 저장 장치 구조를 설명해 주면 좋을 것 같아요. 흡입할 때 진공 상태를 만드는 과학적 원리를 추가하면 더 실감 나는 로봇이 될 거예요.","step4":"센서들이 쓰레기를 감지했을 때, 로봇이 스스로 경로를 계산하는 자율주행 알고리즘을 추가해 보세요. 센서로 감지한 데이터를 바탕으로 로봇이 어떤 순서로 쓰레기를 먼저 치울지 결정하는 기능도 아주 유용하답니다.","step5":"태양 전지뿐만 아니라 우주의 차가운 온도와 뜨거운 태양열을 이용한 에너지 변환 기술을 넣어보면 어떨까요? 인공지능이 스스로 쓰레기의 종류를 분류하는 머신러닝 기술에 대해서도 조사해 보세요.","updatedAt":"2026-11-16T02:50:54.795Z"},"appearance":"팔각기둥 모양 몸체를 가지고 있고, 양 옆에 대칭으로 달려있는 직사각형 모양의 날개에는 태양 전지가 달려 있다. 로봇의 옆에도 센서들이 달려있다. 팔각기둥의 한 밑면에는 여러 센서와 쓰레기를 빨아 들일 수 있는 흡입기가 달려있다. 흡입기 뒤에는 필요에 따라 늘어 날 수 있는 긴 관이 달려있다. 팔각기둥의 다른 밑면에는 전후좌우로 갈 수 있는 부스터가 여러 개 달려있다. 로봇은 티타늄 합금으로 만들어졌다.","coreValues":"#우주보존 #지속가능성","sensorName":"카메라 센서, 거리 센서, 적외선 센서","videoStyle":"시네마틱 SF 실사 영화 스타일 (초고화질 금속 질감과 미래형 네온 조명 연출)","scienceTech":"거리 센서로 쓰레기들의 위치를 파악하고 카메라 센서로 쓰레기들을 인식해 흡입기로 빨아들인다. 태양 전지가 달려 있어 충전할 필요 없다.","mainFunction":"앞에 달려 있는 흡입기로 부스러기가 안 나오게 쓰레기를 처리한다. 날개에 달려 있는 태양 전지로 충전할 필요가 없다.","sensorAction":"로봇은 쓰레기가 있는 곳으로 이용해 흡입기로 쓰레기를 빨아들인다.","sensorTarget":"앞 옆에 달려 있는 센서들로 로봇을 중심으로 반경 15미터 이내의 쓰레기를 감지한다. 쓰레기의 크기도 감지해 흡입 세기도 조절할 수있다. 적외선 센서롤 아주 작은 먼지까지 찾아 낼 수 있다.","boothComments":[],"customVideoPrompt":"[AI 영상 제작] 푸른 지구와 별빛이 빛나는 2050년 우주 정거장 궤도 공간에서, 팔각기둥 모양 몸체를 가지고 있고, 양 옆에 대칭으로 달려있는 직사각형 모양의 날개에는 태양 전지가 장착된, 로봇의 옆에도 센서들이 장착된, 팔각기둥의 한 밑면에는 여러 센서와 쓰레기를 빨아 들일 수 있는 흡입기가 장착됐고, 다른 밑면에는 부스터가 달려있는 외형을 갖춘 로봇 '스타클린 갤럭시 스윕'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 멀리서 날아와 장착된 카메라 센서, 거리 센서, 적외선 센서에 푸른 스캔 라이트가 켜지며(앞 옆에 달려 있는 센서들로 로봇을 중심으로 반경 15미터 이내의 쓰레기) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 몸에 부착 되어 있는 흡입기로 쓰레기를 끌어 모으는 임무를 수행하는 모습을 생생하게 보여준다.(우주에서 로봇 흡입기로) 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 시네마틱 SF 실사 영화 스타일 동영상.","deletedCommentIds":[]},"version":6,"specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"쓰레기가 많은 우주를 날아 다니며 쓰레기를 처리해 우주를 깨끗하게 만든다."},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#우주보존 #지속가능성"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"시네마틱 SF 실사 영화 스타일 (초고화질 금속 질감과 미래형 네온 조명 연출)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"거리 센서로 쓰레기들의 위치를 파악하고 카메라 센서로 쓰레기들을 인식해 흡입기로 빨아들인다. 태양 전지가 달려 있어 충전할 필요 없다."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"앞에 달려 있는 흡입기로 부스러기가 안 나오게 쓰레기를 처리한다. 날개에 달려 있는 태양 전지로 충전할 필요가 없다."},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"카메라 센서, 거리 센서, 적외선 센서","sensorAction":"로봇은 쓰레기가 있는 곳으로 이용해 흡입기로 쓰레기를 빨아들인다.","sensorTarget":"앞 옆에 달려 있는 센서들로 로봇을 중심으로 반경 15미터 이내의 쓰레기를 감지한다. 쓰레기의 크기도 감지해 흡입 세기도 조절할 수있다. 적외선 센서롤 아주 작은 먼지까지 찾아 낼 수 있다."},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"스타클린 갤럭시 스윕","appearance":"팔각기둥 모양 몸체를 가지고 있고, 양 옆에 대칭으로 달려있는 직사각형 모양의 날개에는 태양 전지가 달려 있다. 로봇의 옆에도 센서들이 달려있다. 팔각기둥의 한 밑면에는 여러 센서와 쓰레기를 빨아 들일 수 있는 흡입기가 달려있다. 흡입기 뒤에는 필요에 따라 늘어 날 수 있는 긴 관이 달려있다. 팔각기둥의 다른 밑면에는 전후좌우로 갈 수 있는 부스터가 여러 개 달려있다. 로봇은 티타늄 합금으로 만들어졌다."}},"submittedAt":"2026-11-16T03:42:40.370Z","videoPrompt":"[AI 영상 제작] 푸른 지구와 별빛이 빛나는 2050년 우주 정거장 궤도 공간에서, 팔각기둥 모양 몸체를 가지고 있고, 양 옆에 대칭으로 달려있는 직사각형 모양의 날개에는 태양 전지가 장착된, 로봇의 옆에도 센서들이 장착된, 팔각기둥의 한 밑면에는 여러 센서와 쓰레기를 빨아 들일 수 있는 흡입기가 장착됐고, 다른 밑면에는 부스터가 달려있는 외형을 갖춘 로봇 '스타클린 갤럭시 스윕'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 멀리서 날아와 장착된 카메라 센서, 거리 센서, 적외선 센서에 푸른 스캔 라이트가 켜지며(앞 옆에 달려 있는 센서들로 로봇을 중심으로 반경 15미터 이내의 쓰레기) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 몸에 부착 되어 있는 흡입기로 쓰레기를 끌어 모으는 임무를 수행하는 모습을 생생하게 보여준다.(우주에서 로봇 흡입기로) 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 시네마틱 SF 실사 영화 스타일 동영상.","teacherFeedbackBefore":""}],"updatedAt":"2026-11-17T00:12:37.411Z"},{"studentId":"이수아","studentName":"이수아","status":"approved","inputs":{"robotName":"알냠2050F1","appearance":"로봇 옆면에 인체 측정기가 있어 몸 속 정보를 알 수 있다. 전체적으로 서빙 로봇처럼 생겼으며 자판기처럼 밑에 알약이 나오는 구멍이 있다. 바퀴가 달려 있다.","purpose":"토양이 오염되어 농작물을 키울 공간이 없거나 거의 볼 수 없어서 영양소가 부족해 사람들이 말라 쓰러져 간다.","mainFunction":"주변에 알약을 먹으려 자신에게 다가오는 사람 쪽으로 가서 그 사람이 알약이 필요하다고 하면 옆 쪽에 측정기를 이용하여 그 사람의 영양정보(혈압, 심박수, 체지방, 혈당 등)을 알 수 있다. 그것을 토대로 AI가 판단하여 사람에게 필요한 영양소를 알약에 넣어 밑에 구멍으로 알약과 물이 나온다.","sensorName":"인공지능 AI 비전 카메라 (사람의 얼굴과 움직임을 분석하는 센서)","sensorTarget":"자신을 바라보고 자신에게 다가오는 사람 (알약이 필요한 사람)","sensorAction":"그 사람에게 다가가 측정기를 착용하라고 말한다. 그리고 AI가 필요한 영양분을 토대로 알약을 만들어 제공한다.","scienceTech":"자동제어, 푸드 3D 프린팅, AI 기반 맞춤형, 헬스케어 기술, 헬스케어 IOT. 푸드 3D 프린팅의 경우 단백질, 비타민, 미네랄 농축액 또는 가루를 사용하여 알약 캡슐 안에 넣는다.","coreValues":"#건강 #전문성","videoStyle":"2D 애니메이션 스타일","customVideoPrompt":"[AI 영상 제작] 2050년 미래 흔한 거리에서, 로봇 옆면에 혈압측정기 처럼 생긴 인체 영양정보 측정기가 있어 몸 속 정보를 알 수 있다, 전체적으로 서빙 로봇처럼 생겼으며 자판기처럼 밑에 알약이 나오는 구멍이 있다, 바퀴가 장착된 외형을 갖춘 로봇 '알냠2050F1'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 인공지능 AI 비전 카메라가 자신을 바라보고 자신에게 다가오는 사람(음식이 필요한 사람)을 인식하여 로봇이 그 사람에게 다가가 측정기를 착용하라고 말한다, 그다음 내부에서 알약을 만들어 밑에 구멍으로 물과 함께 사람에게 제공한다. 알약은 적당히 4개 정도만 너무 많이 주지 말고 물과 알약 따로 해서 함께줘 자연스러운 동작, 물건을 절대 만들어 내면 안돼 3D 스타일 동영상이고 부드러운 화면 이동.","aiFeedback":{"date":"2026-11-16","count":1,"step1":"알약을 주는 서빙 로봇의 모습이 잘 상상되지만, 몸체 재질이나 바퀴의 구체적인 움직임이 조금 부족해요. 위생이 중요한 의료 로봇인 만큼 세균이 묻지 않는 '항균 나노 신소재'를 쓰고, 제자리에서도 360도 뱅글뱅글 부드럽게 도는 '메카넘 바퀴'를 달아주면 훨씬 멋질 거예요!","step2":"미래 식량 부족 문제를 해결하려는 따뜻한 마음이 아주 멋지지만, 왜 알약으로 영양을 채우는지 이유가 조금 더 구체적이면 좋겠어요. 기후 변화로 농작물을 키우기 어려운 미래 환경을 언급하고, 적은 양으로도 하루 에너지를 채워주는 '초고농축 미래 대체 식품'을 만든다고 적어볼까요?","step3":"알약과 물이 나오는 아이디어는 훌륭한데, 로봇 내부에서 어떻게 재료를 섞고 물을 주는지 기계 구조가 더 들어가면 좋아요. 미세한 모터로 가루의 양을 정확히 조절하는 '스마트 밸브 믹서'나 알약 컵을 안전하게 건네주는 '소프트 그리퍼(부드러운 로봇 손)' 장치를 넣어보세요!","step4":"'알약이 필요한 사람 인식 센서'라는 이름보다 실제 과학 원리가 담긴 센서 이름을 붙여주면 훨씬 완성도가 높아져요. 사람의 얼굴과 움직임을 분석하는 '인공지능 AI 비전 카메라'와 체온을 느끼는 '적외선 열화상 센서'를 합쳐서 지치고 배고픈 사람을 먼저 찾아낸다고 써볼까요?","step5":"푸드 3D 프린팅과 헬스케어 기술을 아주 알맞게 잘 찾았는데, 로봇이 멈추지 않고 계속 일할 수 있는 친환경 에너지가 빠져 있어요. 로봇 뚜껑에 햇빛을 모아 스스로 전기를 만드는 '초경량 태양광 패널'이나 움직일 때 생기는 진동으로 배터리를 채우는 '압전 발전 기술'을 추가해 보세요!","updatedAt":"2026-11-16T00:13:37.619Z"},"boothComments":[{"v":2,"id":"c_1794873309044_s9nn2","text":"우와ㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏ정말 착한 로봇인것같아👏👏👏👏👏👏👏","author":"김지안","createdAt":"2026-11-16T23:55:09.045Z","viewerToken":"vt_1794796070701_4iqa9fd3","authorStudentId":"김지안"},{"v":2,"id":"c_1794873551085_udy6p","text":"오오오오오오오오오 멋진 아이디어야!!","author":"장서윤","createdAt":"2026-11-16T23:59:11.085Z","viewerToken":"vt_1794796665307_ra6syqil","authorStudentId":"장서윤"},{"v":2,"id":"c_1794873813669_6jwzh","text":"내가 내꺼에 조아요 누르기ㅣㅣㅣㅣㅣㅣ","author":"이수아","createdAt":"2026-11-17T00:03:33.669Z","viewerToken":"vt_1794799212191_bqc4jkhg","authorStudentId":""},{"v":2,"id":"c_1794873830499_3itd8","text":"아이디어가 넘 조은거 가탕!!!!!! 나도 저거 먹어보고 싶다(????)","author":"공인경","createdAt":"2026-11-17T00:03:50.499Z","viewerToken":"vt_1794799986519_qjpt3033","authorStudentId":"공인경"},{"v":2,"id":"c_1794874041228_3coyl","text":"핵심가치가 잘 들어가있어 그중에서 건강과 관련이 되있는것 같아","author":"이혜원","createdAt":"2026-11-17T00:07:21.228Z","viewerToken":"vt_1794873061965_2edypenz","authorStudentId":"이혜원"},{"v":2,"id":"c_1794874205907_stmwz","text":"정말 진짜 울트라 레전드 럭키 임피니티 다이아몬드 전설급 혁명적인 의료 로봇이여 짝짝짝짝짝짝짝짝짝💊💊💊💊💊💊💊💊💊💊💊💊💊💊💊💊💊💊💊💊💊💊💊💊💊💊💊💊💊💊💊💊💊💊💊💊💊💊💊🩻🩻🩺🩺🩻🩺🩺🩻🩻🩺🩺🩻🩺🩺🩼🩼🩼🩼🩼🩼🩼🩼🩼🩼🩼🩼🩼🩼🩼🩼🩼🩼🩼🩼","author":"신연호","createdAt":"2026-11-17T00:10:05.907Z","viewerToken":"vt_1794788851253_3o74q6xc","authorStudentId":"신연호"},{"v":2,"id":"c_1794874209880_8yvjf","text":"으이야ㅑㅑㅑㅑㅑㅑㅑㅑㅑㅑㅑㅑㅑㅑㅑㅑㅑㅑ!","author":"김승윤","createdAt":"2026-11-17T00:10:09.880Z","viewerToken":"vt_1794796086113_pfa1lkx5","authorStudentId":"김승윤"},{"v":2,"id":"c_1794874365934_iexjf","text":"약국에 이 로봇 있어도 되겠는디???","author":"신다빈","createdAt":"2026-11-17T00:12:45.934Z","viewerToken":"vt_1794796192899_42ggb0j9","authorStudentId":"신다빈"}],"deletedCommentIds":[]},"videoPrompt":"[AI 영상 제작] 2050년 미래 흔한 거리에서, 로봇 옆면에 혈압측정기 처럼 생긴 인체 영양정보 측정기가 있어 몸 속 정보를 알 수 있다, 전체적으로 서빙 로봇처럼 생겼으며 자판기처럼 밑에 알약이 나오는 구멍이 있다, 바퀴가 장착된 외형을 갖춘 로봇 '알냠2050F1'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 인공지능 AI 비전 카메라가 자신을 바라보고 자신에게 다가오는 사람(음식이 필요한 사람)을 인식하여 로봇이 그 사람에게 다가가 측정기를 착용하라고 말한다, 그다음 내부에서 알약을 만들어 밑에 구멍으로 물과 함께 사람에게 제공한다. 알약은 적당히 4개 정도만 너무 많이 주지 말고 물과 알약 따로 해서 함께줘 자연스러운 동작, 물건을 절대 만들어 내면 안돼 3D 스타일 동영상이고 부드러운 화면 이동.","specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"토양이 오염되어 농작물을 키울 공간이 없거나 거의 볼 수 없어서 영양소가 부족해 사람들이 말라 쓰러져 간다."},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#건강 #전문성"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"2D 애니메이션 스타일"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"자동제어, 푸드 3D 프린팅, AI 기반 맞춤형, 헬스케어 기술, 헬스케어 IOT. 푸드 3D 프린팅의 경우 단백질, 비타민, 미네랄 농축액 또는 가루를 사용하여 알약 캡슐 안에 넣는다."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"주변에 알약을 먹으려 자신에게 다가오는 사람 쪽으로 가서 그 사람이 알약이 필요하다고 하면 옆 쪽에 측정기를 이용하여 그 사람의 영양정보(혈압, 심박수, 체지방, 혈당 등)을 알 수 있다. 그것을 토대로 AI가 판단하여 사람에게 필요한 영양소를 알약에 넣어 밑에 구멍으로 알약과 물이 나온다."},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"인공지능 AI 비전 카메라 (사람의 얼굴과 움직임을 분석하는 센서)","sensorAction":"그 사람에게 다가가 측정기를 착용하라고 말한다. 그리고 AI가 필요한 영양분을 토대로 알약을 만들어 제공한다.","sensorTarget":"자신을 바라보고 자신에게 다가오는 사람 (알약이 필요한 사람)"},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"알냠2050F1","appearance":"로봇 옆면에 인체 측정기가 있어 몸 속 정보를 알 수 있다. 전체적으로 서빙 로봇처럼 생겼으며 자판기처럼 밑에 알약이 나오는 구멍이 있다. 바퀴가 달려 있다."}},"teacherFeedback":"영상 프롬프트를 잘 살펴보고 내가 설계한 로봇과 관련 없는 내용은 삭제하고 구체적인 로봇의 활동 상황을 더 추가 작성해주세요.","feedbackAt":"2026-11-16T04:59:46.106Z","video":{"type":"none","url":"","title":"","thumbnail":""},"likes":8,"currentVersion":7,"history":[{"label":"버전 6 (5차 수정)","inputs":{"purpose":"토양이 오염되어 농작물을 키울 공간이 없거나 거의 볼 수 없어서 영양소가 부족해 사람들이 말라 쓰러져 간다.","robotName":"알냠2050F1","aiFeedback":{"date":"2026-11-16","count":1,"step1":"알약을 주는 서빙 로봇의 모습이 잘 상상되지만, 몸체 재질이나 바퀴의 구체적인 움직임이 조금 부족해요. 위생이 중요한 의료 로봇인 만큼 세균이 묻지 않는 '항균 나노 신소재'를 쓰고, 제자리에서도 360도 뱅글뱅글 부드럽게 도는 '메카넘 바퀴'를 달아주면 훨씬 멋질 거예요!","step2":"미래 식량 부족 문제를 해결하려는 따뜻한 마음이 아주 멋지지만, 왜 알약으로 영양을 채우는지 이유가 조금 더 구체적이면 좋겠어요. 기후 변화로 농작물을 키우기 어려운 미래 환경을 언급하고, 적은 양으로도 하루 에너지를 채워주는 '초고농축 미래 대체 식품'을 만든다고 적어볼까요?","step3":"알약과 물이 나오는 아이디어는 훌륭한데, 로봇 내부에서 어떻게 재료를 섞고 물을 주는지 기계 구조가 더 들어가면 좋아요. 미세한 모터로 가루의 양을 정확히 조절하는 '스마트 밸브 믹서'나 알약 컵을 안전하게 건네주는 '소프트 그리퍼(부드러운 로봇 손)' 장치를 넣어보세요!","step4":"'알약이 필요한 사람 인식 센서'라는 이름보다 실제 과학 원리가 담긴 센서 이름을 붙여주면 훨씬 완성도가 높아져요. 사람의 얼굴과 움직임을 분석하는 '인공지능 AI 비전 카메라'와 체온을 느끼는 '적외선 열화상 센서'를 합쳐서 지치고 배고픈 사람을 먼저 찾아낸다고 써볼까요?","step5":"푸드 3D 프린팅과 헬스케어 기술을 아주 알맞게 잘 찾았는데, 로봇이 멈추지 않고 계속 일할 수 있는 친환경 에너지가 빠져 있어요. 로봇 뚜껑에 햇빛을 모아 스스로 전기를 만드는 '초경량 태양광 패널'이나 움직일 때 생기는 진동으로 배터리를 채우는 '압전 발전 기술'을 추가해 보세요!","updatedAt":"2026-11-16T00:13:37.619Z"},"appearance":"로봇 옆면에 인체 측정기가 있어 몸 속 정보를 알 수 있다. 전체적으로 서빙 로봇처럼 생겼으며 자판기처럼 밑에 알약이 나오는 구멍이 있다. 바퀴가 달려 있다.","coreValues":"#건강 #전문성","sensorName":"인공지능 AI 비전 카메라 (사람의 얼굴과 움직임을 분석하는 센서)","videoStyle":"2D 애니메이션 스타일","scienceTech":"자동제어, 푸드 3D 프린팅, AI 기반 맞춤형, 헬스케어 기술, 헬스케어 IOT. 푸드 3D 프린팅의 경우 단백질, 비타민, 미네랄 농축액 또는 가루를 사용하여 알약 캡슐 안에 넣는다.","mainFunction":"주변에 알약을 먹으려 자신에게 다가오는 사람 쪽으로 가서 그 사람이 알약이 필요하다고 하면 옆 쪽에 측정기를 이용하여 그 사람의 영양정보(혈압, 심박수, 체지방, 혈당 등)을 알 수 있다. 그것을 토대로 AI가 판단하여 사람에게 필요한 영양소를 알약에 넣어 밑에 구멍으로 알약과 물이 나온다.","sensorAction":"그 사람에게 다가가 측정기를 착용하라고 말한다. 그리고 AI가 필요한 영양분을 토대로 알약을 만들어 제공한다.","sensorTarget":"자신을 바라보고 자신에게 다가오는 사람 (알약이 필요한 사람)","boothComments":[],"customVideoPrompt":"[AI 영상 제작] 2050년 미래 흔한 거리에서, 로봇 옆면에 혈압측정기 처럼 생긴 인체 영양정보 측정기가 있어 몸 속 정보를 알 수 있다, 전체적으로 서빙 로봇처럼 생겼으며 자판기처럼 밑에 알약이 나오는 구멍이 있다, 바퀴가 장착된 외형을 갖춘 로봇 '알냠2050F1'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 인공지능 AI 비전 카메라가 자신을 바라보고 자신에게 다가오는 사람(음식이 필요한 사람)을 인식하여 로봇이 그 사람에게 다가가 측정기를 착용하라고 말한다, 그다음 내부에서 알약을 만들어 밑에 구멍으로 물과 함께 사람에게 제공한다. 알약은 적당히 4개 정도만 너무 많이 주지 말고 물과 알약 따로 해서 함께줘 3D 스타일 동영상이고 부드러운 화면 이동.","deletedCommentIds":[]},"version":6,"specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"토양이 오염되어 농작물을 키울 공간이 없거나 거의 볼 수 없어서 영양소가 부족해 사람들이 말라 쓰러져 간다."},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#건강 #전문성"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"2D 애니메이션 스타일"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"자동제어, 푸드 3D 프린팅, AI 기반 맞춤형, 헬스케어 기술, 헬스케어 IOT. 푸드 3D 프린팅의 경우 단백질, 비타민, 미네랄 농축액 또는 가루를 사용하여 알약 캡슐 안에 넣는다."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"주변에 알약을 먹으려 자신에게 다가오는 사람 쪽으로 가서 그 사람이 알약이 필요하다고 하면 옆 쪽에 측정기를 이용하여 그 사람의 영양정보(혈압, 심박수, 체지방, 혈당 등)을 알 수 있다. 그것을 토대로 AI가 판단하여 사람에게 필요한 영양소를 알약에 넣어 밑에 구멍으로 알약과 물이 나온다."},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"인공지능 AI 비전 카메라 (사람의 얼굴과 움직임을 분석하는 센서)","sensorAction":"그 사람에게 다가가 측정기를 착용하라고 말한다. 그리고 AI가 필요한 영양분을 토대로 알약을 만들어 제공한다.","sensorTarget":"자신을 바라보고 자신에게 다가오는 사람 (알약이 필요한 사람)"},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"알냠2050F1","appearance":"로봇 옆면에 인체 측정기가 있어 몸 속 정보를 알 수 있다. 전체적으로 서빙 로봇처럼 생겼으며 자판기처럼 밑에 알약이 나오는 구멍이 있다. 바퀴가 달려 있다."}},"submittedAt":"2026-11-16T03:30:35.662Z","videoPrompt":"[AI 영상 제작] 2050년 미래 흔한 거리에서, 로봇 옆면에 혈압측정기 처럼 생긴 인체 영양정보 측정기가 있어 몸 속 정보를 알 수 있다, 전체적으로 서빙 로봇처럼 생겼으며 자판기처럼 밑에 알약이 나오는 구멍이 있다, 바퀴가 장착된 외형을 갖춘 로봇 '알냠2050F1'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 인공지능 AI 비전 카메라가 자신을 바라보고 자신에게 다가오는 사람(음식이 필요한 사람)을 인식하여 로봇이 그 사람에게 다가가 측정기를 착용하라고 말한다, 그다음 내부에서 알약을 만들어 밑에 구멍으로 물과 함께 사람에게 제공한다. 알약은 적당히 4개 정도만 너무 많이 주지 말고 물과 알약 따로 해서 함께줘 3D 스타일 동영상이고 부드러운 화면 이동.","teacherFeedbackBefore":"영상 프롬프트를 잘 살펴보고 내가 설계한 로봇과 관련 없는 내용은 삭제하고 구체적인 로봇의 활동 상황을 더 추가 작성해주세요."},{"label":"버전 7 (6차 수정)","inputs":{"purpose":"토양이 오염되어 농작물을 키울 공간이 없거나 거의 볼 수 없어서 영양소가 부족해 사람들이 말라 쓰러져 간다.","robotName":"알냠2050F1","aiFeedback":{"date":"2026-11-16","count":1,"step1":"알약을 주는 서빙 로봇의 모습이 잘 상상되지만, 몸체 재질이나 바퀴의 구체적인 움직임이 조금 부족해요. 위생이 중요한 의료 로봇인 만큼 세균이 묻지 않는 '항균 나노 신소재'를 쓰고, 제자리에서도 360도 뱅글뱅글 부드럽게 도는 '메카넘 바퀴'를 달아주면 훨씬 멋질 거예요!","step2":"미래 식량 부족 문제를 해결하려는 따뜻한 마음이 아주 멋지지만, 왜 알약으로 영양을 채우는지 이유가 조금 더 구체적이면 좋겠어요. 기후 변화로 농작물을 키우기 어려운 미래 환경을 언급하고, 적은 양으로도 하루 에너지를 채워주는 '초고농축 미래 대체 식품'을 만든다고 적어볼까요?","step3":"알약과 물이 나오는 아이디어는 훌륭한데, 로봇 내부에서 어떻게 재료를 섞고 물을 주는지 기계 구조가 더 들어가면 좋아요. 미세한 모터로 가루의 양을 정확히 조절하는 '스마트 밸브 믹서'나 알약 컵을 안전하게 건네주는 '소프트 그리퍼(부드러운 로봇 손)' 장치를 넣어보세요!","step4":"'알약이 필요한 사람 인식 센서'라는 이름보다 실제 과학 원리가 담긴 센서 이름을 붙여주면 훨씬 완성도가 높아져요. 사람의 얼굴과 움직임을 분석하는 '인공지능 AI 비전 카메라'와 체온을 느끼는 '적외선 열화상 센서'를 합쳐서 지치고 배고픈 사람을 먼저 찾아낸다고 써볼까요?","step5":"푸드 3D 프린팅과 헬스케어 기술을 아주 알맞게 잘 찾았는데, 로봇이 멈추지 않고 계속 일할 수 있는 친환경 에너지가 빠져 있어요. 로봇 뚜껑에 햇빛을 모아 스스로 전기를 만드는 '초경량 태양광 패널'이나 움직일 때 생기는 진동으로 배터리를 채우는 '압전 발전 기술'을 추가해 보세요!","updatedAt":"2026-11-16T00:13:37.619Z"},"appearance":"로봇 옆면에 인체 측정기가 있어 몸 속 정보를 알 수 있다. 전체적으로 서빙 로봇처럼 생겼으며 자판기처럼 밑에 알약이 나오는 구멍이 있다. 바퀴가 달려 있다.","coreValues":"#건강 #전문성","sensorName":"인공지능 AI 비전 카메라 (사람의 얼굴과 움직임을 분석하는 센서)","videoStyle":"2D 애니메이션 스타일","scienceTech":"자동제어, 푸드 3D 프린팅, AI 기반 맞춤형, 헬스케어 기술, 헬스케어 IOT. 푸드 3D 프린팅의 경우 단백질, 비타민, 미네랄 농축액 또는 가루를 사용하여 알약 캡슐 안에 넣는다.","mainFunction":"주변에 알약을 먹으려 자신에게 다가오는 사람 쪽으로 가서 그 사람이 알약이 필요하다고 하면 옆 쪽에 측정기를 이용하여 그 사람의 영양정보(혈압, 심박수, 체지방, 혈당 등)을 알 수 있다. 그것을 토대로 AI가 판단하여 사람에게 필요한 영양소를 알약에 넣어 밑에 구멍으로 알약과 물이 나온다.","sensorAction":"그 사람에게 다가가 측정기를 착용하라고 말한다. 그리고 AI가 필요한 영양분을 토대로 알약을 만들어 제공한다.","sensorTarget":"자신을 바라보고 자신에게 다가오는 사람 (알약이 필요한 사람)","boothComments":[],"customVideoPrompt":"[AI 영상 제작] 2050년 미래 흔한 거리에서, 로봇 옆면에 혈압측정기 처럼 생긴 인체 영양정보 측정기가 있어 몸 속 정보를 알 수 있다, 전체적으로 서빙 로봇처럼 생겼으며 자판기처럼 밑에 알약이 나오는 구멍이 있다, 바퀴가 장착된 외형을 갖춘 로봇 '알냠2050F1'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 인공지능 AI 비전 카메라가 자신을 바라보고 자신에게 다가오는 사람(음식이 필요한 사람)을 인식하여 로봇이 그 사람에게 다가가 측정기를 착용하라고 말한다, 그다음 내부에서 알약을 만들어 밑에 구멍으로 물과 함께 사람에게 제공한다. 알약은 적당히 4개 정도만 너무 많이 주지 말고 물과 알약 따로 해서 함께줘 자연스러운 동작, 물건을 절대 만들어 내면 안돼 3D 스타일 동영상이고 부드러운 화면 이동.","deletedCommentIds":[]},"version":7,"specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"토양이 오염되어 농작물을 키울 공간이 없거나 거의 볼 수 없어서 영양소가 부족해 사람들이 말라 쓰러져 간다."},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#건강 #전문성"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"2D 애니메이션 스타일"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"자동제어, 푸드 3D 프린팅, AI 기반 맞춤형, 헬스케어 기술, 헬스케어 IOT. 푸드 3D 프린팅의 경우 단백질, 비타민, 미네랄 농축액 또는 가루를 사용하여 알약 캡슐 안에 넣는다."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"주변에 알약을 먹으려 자신에게 다가오는 사람 쪽으로 가서 그 사람이 알약이 필요하다고 하면 옆 쪽에 측정기를 이용하여 그 사람의 영양정보(혈압, 심박수, 체지방, 혈당 등)을 알 수 있다. 그것을 토대로 AI가 판단하여 사람에게 필요한 영양소를 알약에 넣어 밑에 구멍으로 알약과 물이 나온다."},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"인공지능 AI 비전 카메라 (사람의 얼굴과 움직임을 분석하는 센서)","sensorAction":"그 사람에게 다가가 측정기를 착용하라고 말한다. 그리고 AI가 필요한 영양분을 토대로 알약을 만들어 제공한다.","sensorTarget":"자신을 바라보고 자신에게 다가오는 사람 (알약이 필요한 사람)"},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"알냠2050F1","appearance":"로봇 옆면에 인체 측정기가 있어 몸 속 정보를 알 수 있다. 전체적으로 서빙 로봇처럼 생겼으며 자판기처럼 밑에 알약이 나오는 구멍이 있다. 바퀴가 달려 있다."}},"submittedAt":"2026-11-16T03:43:34.768Z","videoPrompt":"[AI 영상 제작] 2050년 미래 흔한 거리에서, 로봇 옆면에 혈압측정기 처럼 생긴 인체 영양정보 측정기가 있어 몸 속 정보를 알 수 있다, 전체적으로 서빙 로봇처럼 생겼으며 자판기처럼 밑에 알약이 나오는 구멍이 있다, 바퀴가 장착된 외형을 갖춘 로봇 '알냠2050F1'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 인공지능 AI 비전 카메라가 자신을 바라보고 자신에게 다가오는 사람(음식이 필요한 사람)을 인식하여 로봇이 그 사람에게 다가가 측정기를 착용하라고 말한다, 그다음 내부에서 알약을 만들어 밑에 구멍으로 물과 함께 사람에게 제공한다. 알약은 적당히 4개 정도만 너무 많이 주지 말고 물과 알약 따로 해서 함께줘 자연스러운 동작, 물건을 절대 만들어 내면 안돼 3D 스타일 동영상이고 부드러운 화면 이동.","teacherFeedbackBefore":"영상 프롬프트를 잘 살펴보고 내가 설계한 로봇과 관련 없는 내용은 삭제하고 구체적인 로봇의 활동 상황을 더 추가 작성해주세요."}],"updatedAt":"2026-11-17T00:12:45.934Z"},{"studentId":"이민구","studentName":"이민구","status":"approved","inputs":{"robotName":"물 만난 광어","appearance":"납작한 타원형 모양이고, 뒤쪽에는 수중 프로팰러가 있고, 바닥엔 빨판이 있으며 큰 입이 있다. 광어와 생김새가 비슷하다.  큰 입주변엔 물고기와 같이 세로로 된 아가미 같은 것이다. 탄소섬유와 나노소재의 복합체로 이루어진 표면을 가지고 있다.","purpose":"오염되고 쓰레기가 쌓여있는 바다의 바닥과 죽은 산호가 있다.","mainFunction":"큰 입으로 많은 쓰레기를 흡입하고 미세플라스틱을 걸러 큰 입 옆에 있는 물고기의 아가미와 비슷하게 생긴 것으로 깨끗한 바닷물을 뱉어낸다.","sensorName":"카메라 센서, 수질 센서, 온도 센서","sensorTarget":"바닷속 쓰레기의 양과 미세플라스틱의 농도와 물고기의 위치","sensorAction":"물고기를 피해 주변의 쓰레기와 미세프라스티을 흡입한다.","scienceTech":"인공지능 카메라 센서로 물고기와 쓰레기를 구별하며 흡입한 쓰레기와 미세플라스틱으로 에너지를 얻는다.","coreValues":"#생태계보존 #생명존중 #인간과자연의공존","videoStyle":"하이테크 과학 다큐멘터리 & 홀로그램 HUD 스타일 (센서 스캔 파동과 데이터 시각화 강조)","customVideoPrompt":"[AI 영상 제작] 햇빛이 투명하게 투과되는 2050년 푸른 바닷속 수중 생태계와 해안가에서, 납작한 타원형 모양이고, 바닥엔 빨판이 있으며 큰 입이 있다, 광어와 생김새가 비슷하다, 큰 입주변엔 물고기와 같이 세로로 된 아가미 같은 것 외형을 갖춘 로봇이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 카메라 센서, 수질 센서, 온도 센서에 푸른 스캔 라이트가 켜지며(바닷속 쓰레기의 양과 미세플라스틱의 농도와 물고기의 위치) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 목표물을 집어 올리고 수거 장치를 작동시킨다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 하이테크 과학 다큐멘터리 & 홀로그램 HUD 스타일 동영상. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해.","aiFeedback":null,"boothComments":[{"v":2,"id":"c_1794873362807_n93vs","text":"물 만난 광어!👍👍👍👍👍👍👍","author":"이석준","createdAt":"2026-11-16T23:56:02.808Z","viewerToken":"vt_1794799215240_tjkhcvj5","authorStudentId":"이석준"},{"v":2,"id":"c_1794873371733_q1nrs","text":"오오오오오오오 아이디어가 좋다!!!!","author":"장서윤","createdAt":"2026-11-16T23:56:11.733Z","viewerToken":"vt_1794796665307_ra6syqil","authorStudentId":"장서윤"},{"v":2,"id":"c_1794873376291_8djyo","text":"프롬프트처럼 쓰레기를 잘 모으는 것 같아","author":"진연우","createdAt":"2026-11-16T23:56:16.291Z","viewerToken":"vt_1794788838051_mpwskv0k","authorStudentId":"진연우"},{"v":2,"id":"c_1794873578636_6byna","text":"잘만들었다 있으면 환경에 좋을것 같은데?","author":"박성민","createdAt":"2026-11-16T23:59:38.636Z","viewerToken":"vt_1794797170972_uk8wojcz","authorStudentId":"박성민"},{"v":2,"id":"c_1794873711663_j56nh","text":"너~~~~~~~~~~~~~~~~~무잘","author":"김승윤","createdAt":"2026-11-17T00:01:51.663Z","viewerToken":"vt_1794796086113_pfa1lkx5","authorStudentId":"김승윤"},{"v":2,"id":"c_1794874252539_3066e","text":"브로 이것은 엄청난 👍👍👍👍👍👍👍👍","author":"이원준","createdAt":"2026-11-17T00:10:52.540Z","viewerToken":"vt_1794873057588_6rghf8uo","authorStudentId":"이원준"},{"v":2,"id":"c_1794874391791_rd0rt","text":"우와ㅏ 물만난광어라는 이름 특이해!! 요즘 상황에서 유용할것 같아 👍","author":"김지아","createdAt":"2026-11-17T00:13:11.791Z","viewerToken":"vt_1794796098329_ixf8fbb4","authorStudentId":"김지아"}],"deletedCommentIds":[]},"videoPrompt":"[AI 영상 제작] 햇빛이 투명하게 투과되는 2050년 푸른 바닷속 수중 생태계와 해안가에서, 납작한 타원형 모양이고, 바닥엔 빨판이 있으며 큰 입이 있다, 광어와 생김새가 비슷하다, 큰 입주변엔 물고기와 같이 세로로 된 아가미 같은 것 외형을 갖춘 로봇이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 카메라 센서, 수질 센서, 온도 센서에 푸른 스캔 라이트가 켜지며(바닷속 쓰레기의 양과 미세플라스틱의 농도와 물고기의 위치) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 목표물을 집어 올리고 수거 장치를 작동시킨다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 하이테크 과학 다큐멘터리 & 홀로그램 HUD 스타일 동영상. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해.","specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"오염되고 쓰레기가 쌓여있는 바다의 바닥과 죽은 산호가 있다."},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#생태계보존 #생명존중 #인간과자연의공존"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"하이테크 과학 다큐멘터리 & 홀로그램 HUD 스타일 (센서 스캔 파동과 데이터 시각화 강조)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"인공지능 카메라 센서로 물고기와 쓰레기를 구별하며 흡입한 쓰레기와 미세플라스틱으로 에너지를 얻는다."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"큰 입으로 많은 쓰레기를 흡입하고 미세플라스틱을 걸러 큰 입 옆에 있는 물고기의 아가미와 비슷하게 생긴 것으로 깨끗한 바닷물을 뱉어낸다."},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"카메라 센서, 수질 센서, 온도 센서","sensorAction":"물고기를 피해 주변의 쓰레기와 미세프라스티을 흡입한다.","sensorTarget":"바닷속 쓰레기의 양과 미세플라스틱의 농도와 물고기의 위치"},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"물 만난 광어","appearance":"납작한 타원형 모양이고, 뒤쪽에는 수중 프로팰러가 있고, 바닥엔 빨판이 있으며 큰 입이 있다. 광어와 생김새가 비슷하다.  큰 입주변엔 물고기와 같이 세로로 된 아가미 같은 것이다. 탄소섬유와 나노소재의 복합체로 이루어진 표면을 가지고 있다."}},"teacherFeedback":"","feedbackAt":"","video":{"type":"none","url":"","title":"","thumbnail":""},"likes":7,"currentVersion":6,"history":[{"label":"버전 5 (4차 수정)","inputs":{"purpose":"오염되고 쓰레기가 쌓여있는 바다의 바닥과 죽은 산호가 있다.","robotName":"물 만난 광어","aiFeedback":null,"appearance":"납작한 타원형 모양이고, 뒤쪽에는 수중 프로팰러가 있고, 바닥엔 빨판이 있으며 큰 입이 있다. 광어와 생김새가 비슷하다.  큰 입주변엔 물고기와 같이 세로로 된 아가미 같은 것이다. 탄소섬유와 나노소재의 복합체로 이루어진 표면을 가지고 있다.","coreValues":"#생태계보존 #생명존중 #인간과자연의공존","sensorName":"카메라 센서, 수질 센서, 온도 센서","videoStyle":"하이테크 과학 다큐멘터리 & 홀로그램 HUD 스타일 (센서 스캔 파동과 데이터 시각화 강조)","scienceTech":"인공지능 카메라 센서로 물고기와 쓰레기를 구별하며 흡입한 쓰레기와 미세플라스틱으로 에너지를 얻는다.","mainFunction":"큰 입으로 많은 쓰레기를 흡입하고 미세플라스틱을 걸러 큰 입 옆에 있는 물고기의 아가미와 비슷하게 생긴 것으로 깨끗한 바닷물을 뱉어낸다.","sensorAction":"물고기를 피해 주변의 쓰레기와 미세프라스티을 흡입한다.","sensorTarget":"바닷속 쓰레기의 양과 미세플라스틱의 농도와 물고기의 위치","boothComments":[],"customVideoPrompt":"[AI 영상 제작] 햇빛이 투명하게 투과되는 2050년 푸른 바닷속 수중 생태계와 해안가에서, 납작한 타원형 모양이고, 바닥엔 빨판이 있으며 큰 입이 있다, 광어와 생김새가 비슷하다, 큰 입주변엔 물고기와 같이 세로로 된 아가미 같은 것 외형을 갖춘 로봇 '물 만난 광어'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 카메라 센서, 수질 센서, 온도 센서에 푸른 스캔 라이트가 켜지며(바닷속 쓰레기의 양과 미세플라스틱의 농도와 물고기의 위치) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 목표물을 집어 올리고 수거 장치를 작동시킨다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 하이테크 과학 다큐멘터리 & 홀로그램 HUD 스타일 동영상. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해.","deletedCommentIds":[]},"version":5,"specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"오염되고 쓰레기가 쌓여있는 바다의 바닥과 죽은 산호가 있다."},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#생태계보존 #생명존중 #인간과자연의공존"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"하이테크 과학 다큐멘터리 & 홀로그램 HUD 스타일 (센서 스캔 파동과 데이터 시각화 강조)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"인공지능 카메라 센서로 물고기와 쓰레기를 구별하며 흡입한 쓰레기와 미세플라스틱으로 에너지를 얻는다."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"큰 입으로 많은 쓰레기를 흡입하고 미세플라스틱을 걸러 큰 입 옆에 있는 물고기의 아가미와 비슷하게 생긴 것으로 깨끗한 바닷물을 뱉어낸다."},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"카메라 센서, 수질 센서, 온도 센서","sensorAction":"물고기를 피해 주변의 쓰레기와 미세프라스티을 흡입한다.","sensorTarget":"바닷속 쓰레기의 양과 미세플라스틱의 농도와 물고기의 위치"},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"물 만난 광어","appearance":"납작한 타원형 모양이고, 뒤쪽에는 수중 프로팰러가 있고, 바닥엔 빨판이 있으며 큰 입이 있다. 광어와 생김새가 비슷하다.  큰 입주변엔 물고기와 같이 세로로 된 아가미 같은 것이다. 탄소섬유와 나노소재의 복합체로 이루어진 표면을 가지고 있다."}},"submittedAt":"2026-11-16T03:39:02.519Z","videoPrompt":"[AI 영상 제작] 햇빛이 투명하게 투과되는 2050년 푸른 바닷속 수중 생태계와 해안가에서, 납작한 타원형 모양이고, 바닥엔 빨판이 있으며 큰 입이 있다, 광어와 생김새가 비슷하다, 큰 입주변엔 물고기와 같이 세로로 된 아가미 같은 것 외형을 갖춘 로봇 '물 만난 광어'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 카메라 센서, 수질 센서, 온도 센서에 푸른 스캔 라이트가 켜지며(바닷속 쓰레기의 양과 미세플라스틱의 농도와 물고기의 위치) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 목표물을 집어 올리고 수거 장치를 작동시킨다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 하이테크 과학 다큐멘터리 & 홀로그램 HUD 스타일 동영상. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해.","teacherFeedbackBefore":""},{"label":"버전 6 (5차 수정)","inputs":{"purpose":"오염되고 쓰레기가 쌓여있는 바다의 바닥과 죽은 산호가 있다.","robotName":"물 만난 광어","aiFeedback":null,"appearance":"납작한 타원형 모양이고, 뒤쪽에는 수중 프로팰러가 있고, 바닥엔 빨판이 있으며 큰 입이 있다. 광어와 생김새가 비슷하다.  큰 입주변엔 물고기와 같이 세로로 된 아가미 같은 것이다. 탄소섬유와 나노소재의 복합체로 이루어진 표면을 가지고 있다.","coreValues":"#생태계보존 #생명존중 #인간과자연의공존","sensorName":"카메라 센서, 수질 센서, 온도 센서","videoStyle":"하이테크 과학 다큐멘터리 & 홀로그램 HUD 스타일 (센서 스캔 파동과 데이터 시각화 강조)","scienceTech":"인공지능 카메라 센서로 물고기와 쓰레기를 구별하며 흡입한 쓰레기와 미세플라스틱으로 에너지를 얻는다.","mainFunction":"큰 입으로 많은 쓰레기를 흡입하고 미세플라스틱을 걸러 큰 입 옆에 있는 물고기의 아가미와 비슷하게 생긴 것으로 깨끗한 바닷물을 뱉어낸다.","sensorAction":"물고기를 피해 주변의 쓰레기와 미세프라스티을 흡입한다.","sensorTarget":"바닷속 쓰레기의 양과 미세플라스틱의 농도와 물고기의 위치","boothComments":[],"customVideoPrompt":"[AI 영상 제작] 햇빛이 투명하게 투과되는 2050년 푸른 바닷속 수중 생태계와 해안가에서, 납작한 타원형 모양이고, 바닥엔 빨판이 있으며 큰 입이 있다, 광어와 생김새가 비슷하다, 큰 입주변엔 물고기와 같이 세로로 된 아가미 같은 것 외형을 갖춘 로봇이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 카메라 센서, 수질 센서, 온도 센서에 푸른 스캔 라이트가 켜지며(바닷속 쓰레기의 양과 미세플라스틱의 농도와 물고기의 위치) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 목표물을 집어 올리고 수거 장치를 작동시킨다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 하이테크 과학 다큐멘터리 & 홀로그램 HUD 스타일 동영상. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해.","deletedCommentIds":[]},"version":6,"specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"오염되고 쓰레기가 쌓여있는 바다의 바닥과 죽은 산호가 있다."},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#생태계보존 #생명존중 #인간과자연의공존"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"하이테크 과학 다큐멘터리 & 홀로그램 HUD 스타일 (센서 스캔 파동과 데이터 시각화 강조)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"인공지능 카메라 센서로 물고기와 쓰레기를 구별하며 흡입한 쓰레기와 미세플라스틱으로 에너지를 얻는다."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"큰 입으로 많은 쓰레기를 흡입하고 미세플라스틱을 걸러 큰 입 옆에 있는 물고기의 아가미와 비슷하게 생긴 것으로 깨끗한 바닷물을 뱉어낸다."},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"카메라 센서, 수질 센서, 온도 센서","sensorAction":"물고기를 피해 주변의 쓰레기와 미세프라스티을 흡입한다.","sensorTarget":"바닷속 쓰레기의 양과 미세플라스틱의 농도와 물고기의 위치"},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"물 만난 광어","appearance":"납작한 타원형 모양이고, 뒤쪽에는 수중 프로팰러가 있고, 바닥엔 빨판이 있으며 큰 입이 있다. 광어와 생김새가 비슷하다.  큰 입주변엔 물고기와 같이 세로로 된 아가미 같은 것이다. 탄소섬유와 나노소재의 복합체로 이루어진 표면을 가지고 있다."}},"submittedAt":"2026-11-16T03:44:26.538Z","videoPrompt":"[AI 영상 제작] 햇빛이 투명하게 투과되는 2050년 푸른 바닷속 수중 생태계와 해안가에서, 납작한 타원형 모양이고, 바닥엔 빨판이 있으며 큰 입이 있다, 광어와 생김새가 비슷하다, 큰 입주변엔 물고기와 같이 세로로 된 아가미 같은 것 외형을 갖춘 로봇이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 카메라 센서, 수질 센서, 온도 센서에 푸른 스캔 라이트가 켜지며(바닷속 쓰레기의 양과 미세플라스틱의 농도와 물고기의 위치) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 목표물을 집어 올리고 수거 장치를 작동시킨다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 하이테크 과학 다큐멘터리 & 홀로그램 HUD 스타일 동영상. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해. 쓰레기 뱉지말고 흡입해.","teacherFeedbackBefore":""}],"updatedAt":"2026-11-17T00:13:11.791Z"},{"studentId":"김시윤","studentName":"김시윤","status":"approved","inputs":{"robotName":"A-40","appearance":"친근한 네모유선형에 무한궤도 바퀴가있고, 앞쪽에 접이식집게팔이 있고 뒤쪽 작은 드론이 있어 멀리 떨어져 있는 쓰레기를 주워서 로봇의 앞에 놔두고, 등판에 등판에 태양광 발전이 달려있는 로봇","purpose":"오염된 도시를 다니며 환경을 오염하는 쓰레기를 주워서 도시를 깨끗하게 만든다.","mainFunction":"전면에는 다관절 집게팔이 쓰레기를 주워서 전면흡입구로 넣어 내부필터로 쓰레기를 빨아드린다.","sensorName":"위치 센서(GPS), 카메라 센서","sensorTarget":"10m 쓰레기 위치,사람위치","sensorAction":"사람을 안전하게 피해 다른 경로로 가고, 쓰레기가 있는곳에 가서 다관절 집게팔을 이용해 쓰레기를 줍는다.","scienceTech":"인공지능(AI)사물인식 기술로 사람과 쓰레기를 구별할수있고, 등판에 태양광 발전이 달려있어서 베터리를  갈필요가 없어서 무선 충전이 된다.","coreValues":"#안전한사회 #생명존중","videoStyle":"미래 박람회 쇼케이스 디지털 컨셉 아트 스타일 (세련된 조명과 미래지향적 모션그래픽)","customVideoPrompt":"[AI 영상 제작] 2050 미래 도시에서 친근한 네모유선형에 무한궤도 바퀴가있고, 앞쪽에 접이식집게팔이 있고 뒤쪽 작은 드론이 있어 멀리 떨어져 있는 쓰레기를 주워서 로봇의 앞에 놔두고, 등판에 등판에 태양광 발전이 달려있는 로봇 외형을 갖춘 로봇 'A-40'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 위치 센서, 카메라 센서에 푸른 스캔 라이트가 켜지며(10m 쓰레기 위치,사람위치) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 목표물을 집어 올리고 수거 장치를 작동시키며, 몸체의 정화 필터로 오염 물질을 흡입해 걸러낸 뒤 맑고 깨끗한 흐름을 내보내며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 미래 박람회 쇼케이스 디지털 컨셉 아트 스타일 동영상.","aiFeedback":null,"boothComments":[{"v":2,"id":"c_1794873427085_e85a8","text":"쓰레기를 버리는 로봇이네? 아이디어가 좋다!","author":"장서윤","createdAt":"2026-11-16T23:57:07.085Z","viewerToken":"vt_1794796665307_ra6syqil","authorStudentId":"장서윤"},{"v":2,"id":"c_1794873726214_qfrjx","text":"사람들이 길 바닥에 버려서 지구에 안 좋았느데 이런 로봇이면 화경에 좋을 것 같아","author":"진연우","createdAt":"2026-11-17T00:02:06.214Z","viewerToken":"vt_1794788838051_mpwskv0k","authorStudentId":"진연우"},{"v":2,"id":"c_1794873779674_uwww7","text":"얘가 길거리를 돌아다니면 쓰레기가 줄어서 깨끗해질것 같은데?","author":"박성민","createdAt":"2026-11-17T00:02:59.674Z","viewerToken":"vt_1794797170972_uk8wojcz","authorStudentId":"박성민"},{"v":2,"id":"c_1794874411241_pjfyx","text":"으에ㅔㅔㅔㅔㅔㅔㅔㅔㅔㅔㅔㅔㅔㅔㅔㅔㅔㅔㅔ","author":"김승윤","createdAt":"2026-11-17T00:13:31.241Z","viewerToken":"vt_1794796086113_pfa1lkx5","authorStudentId":"김승윤"}],"deletedCommentIds":[]},"videoPrompt":"[AI 영상 제작] 2050 미래 도시에서 친근한 네모유선형에 무한궤도 바퀴가있고, 앞쪽에 접이식집게팔이 있고 뒤쪽 작은 드론이 있어 멀리 떨어져 있는 쓰레기를 주워서 로봇의 앞에 놔두고, 등판에 등판에 태양광 발전이 달려있는 로봇 외형을 갖춘 로봇 'A-40'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 위치 센서, 카메라 센서에 푸른 스캔 라이트가 켜지며(10m 쓰레기 위치,사람위치) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 목표물을 집어 올리고 수거 장치를 작동시키며, 몸체의 정화 필터로 오염 물질을 흡입해 걸러낸 뒤 맑고 깨끗한 흐름을 내보내며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 미래 박람회 쇼케이스 디지털 컨셉 아트 스타일 동영상.","specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"오염된 도시를 다니며 환경을 오염하는 쓰레기를 주워서 도시를 깨끗하게 만든다."},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#안전한사회 #생명존중"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"미래 박람회 쇼케이스 디지털 컨셉 아트 스타일 (세련된 조명과 미래지향적 모션그래픽)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"인공지능(AI)사물인식 기술로 사람과 쓰레기를 구별할수있고, 등판에 태양광 발전이 달려있어서 베터리를  갈필요가 없어서 무선 충전이 된다."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"전면에는 다관절 집게팔이 쓰레기를 주워서 전면흡입구로 넣어 내부필터로 쓰레기를 빨아드린다."},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"위치 센서(GPS), 카메라 센서","sensorAction":"사람을 안전하게 피해 다른 경로로 가고, 쓰레기가 있는곳에 가서 다관절 집게팔을 이용해 쓰레기를 줍는다.","sensorTarget":"10m 쓰레기 위치,사람위치"},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"A-40","appearance":"친근한 네모유선형에 무한궤도 바퀴가있고, 앞쪽에 접이식집게팔이 있고 뒤쪽 작은 드론이 있어 멀리 떨어져 있는 쓰레기를 주워서 로봇의 앞에 놔두고, 등판에 등판에 태양광 발전이 달려있는 로봇"}},"teacherFeedback":"","feedbackAt":"","video":{"type":"none","url":"","title":"","thumbnail":""},"likes":4,"currentVersion":3,"history":[{"label":"버전 2 (1차 수정)","inputs":{"purpose":"오염된 도시를 다니며 환경을 오염하는 쓰레기를 주워서 도시를 깨끗하게 만든다.","robotName":"A-40","aiFeedback":null,"appearance":"친근한 네모유선형에 무한궤도 바퀴가있고, 앞쪽에 접이식집게팔이 있고 뒤쪽 작은 드론이 있어 멀리 떨어져 있는 쓰레기를 주워서 로봇의 앞에 놔두고, 등판에 등판에 태양광 발전이 달려있는 로봇","coreValues":"#안전한사회 #생명존중","sensorName":"위치 센서(GPS), 카메라 센서","videoStyle":"미래 박람회 쇼케이스 디지털 컨셉 아트 스타일 (세련된 조명과 미래지향적 모션그래픽)","scienceTech":"인공지능(AI)사물인식 기술로 사람과 쓰레기를 구별할수있고, 등판에 태양광 발전이 달려있어서 베터리를  갈필요가 없어서 무선 충전이 된다.","mainFunction":"전면에는 다관절 집게팔이 쓰레기를 주워서 전면흡입구로 넣어 내부필터로 쓰레기를 빨아드린다.","sensorAction":"사람을 안전하게 피해 다른 경로로 가고, 쓰레기가 있는곳에 가서 다관절 집게팔을 이용해 쓰레기를 줍는다.","sensorTarget":"10m 쓰레기 위치,사람위치","boothComments":[],"customVideoPrompt":"","deletedCommentIds":[]},"version":2,"specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"오염된 도시를 다니며 환경을 오염하는 쓰레기를 주워서 도시를 깨끗하게 만든다."},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#안전한사회 #생명존중"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"미래 박람회 쇼케이스 디지털 컨셉 아트 스타일 (세련된 조명과 미래지향적 모션그래픽)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"인공지능(AI)사물인식 기술로 사람과 쓰레기를 구별할수있고, 등판에 태양광 발전이 달려있어서 베터리를  갈필요가 없어서 무선 충전이 된다."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"전면에는 다관절 집게팔이 쓰레기를 주워서 전면흡입구로 넣어 내부필터로 쓰레기를 빨아드린다."},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"위치 센서(GPS), 카메라 센서","sensorAction":"사람을 안전하게 피해 다른 경로로 가고, 쓰레기가 있는곳에 가서 다관절 집게팔을 이용해 쓰레기를 줍는다.","sensorTarget":"10m 쓰레기 위치,사람위치"},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"A-40","appearance":"친근한 네모유선형에 무한궤도 바퀴가있고, 앞쪽에 접이식집게팔이 있고 뒤쪽 작은 드론이 있어 멀리 떨어져 있는 쓰레기를 주워서 로봇의 앞에 놔두고, 등판에 등판에 태양광 발전이 달려있는 로봇"}},"submittedAt":"2026-11-16T06:32:29.377Z","videoPrompt":"[AI 영상 제작] 푸른 지구와 별빛이 빛나는 2050년 우주 정거장 궤도 공간에서, 친근한 네모유선형에 무한궤도 바퀴가있고, 앞쪽에 접이식집게팔이 있고 뒤쪽 작은 드론이 있어 멀리 떨어져 있는 쓰레기를 주워서 로봇의 앞에 놔두고, 등판에 등판에 태양광 발전이 달려있는 로봇 외형을 갖춘 로봇 'A-40'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 위치 센서, 카메라 센서에 푸른 스캔 라이트가 켜지며(10m 쓰레기 위치,사람위치) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 목표물을 집어 올리고 수거 장치를 작동시키며, 몸체의 정화 필터로 오염 물질을 흡입해 걸러낸 뒤 맑고 깨끗한 흐름을 내보내며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 미래 박람회 쇼케이스 디지털 컨셉 아트 스타일 동영상.","teacherFeedbackBefore":""},{"label":"버전 3 (2차 수정)","inputs":{"purpose":"오염된 도시를 다니며 환경을 오염하는 쓰레기를 주워서 도시를 깨끗하게 만든다.","robotName":"A-40","aiFeedback":null,"appearance":"친근한 네모유선형에 무한궤도 바퀴가있고, 앞쪽에 접이식집게팔이 있고 뒤쪽 작은 드론이 있어 멀리 떨어져 있는 쓰레기를 주워서 로봇의 앞에 놔두고, 등판에 등판에 태양광 발전이 달려있는 로봇","coreValues":"#안전한사회 #생명존중","sensorName":"위치 센서(GPS), 카메라 센서","videoStyle":"미래 박람회 쇼케이스 디지털 컨셉 아트 스타일 (세련된 조명과 미래지향적 모션그래픽)","scienceTech":"인공지능(AI)사물인식 기술로 사람과 쓰레기를 구별할수있고, 등판에 태양광 발전이 달려있어서 베터리를  갈필요가 없어서 무선 충전이 된다.","mainFunction":"전면에는 다관절 집게팔이 쓰레기를 주워서 전면흡입구로 넣어 내부필터로 쓰레기를 빨아드린다.","sensorAction":"사람을 안전하게 피해 다른 경로로 가고, 쓰레기가 있는곳에 가서 다관절 집게팔을 이용해 쓰레기를 줍는다.","sensorTarget":"10m 쓰레기 위치,사람위치","boothComments":[],"customVideoPrompt":"[AI 영상 제작] 2050 미래 도시에서 친근한 네모유선형에 무한궤도 바퀴가있고, 앞쪽에 접이식집게팔이 있고 뒤쪽 작은 드론이 있어 멀리 떨어져 있는 쓰레기를 주워서 로봇의 앞에 놔두고, 등판에 등판에 태양광 발전이 달려있는 로봇 외형을 갖춘 로봇 'A-40'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 위치 센서, 카메라 센서에 푸른 스캔 라이트가 켜지며(10m 쓰레기 위치,사람위치) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 목표물을 집어 올리고 수거 장치를 작동시키며, 몸체의 정화 필터로 오염 물질을 흡입해 걸러낸 뒤 맑고 깨끗한 흐름을 내보내며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 미래 박람회 쇼케이스 디지털 컨셉 아트 스타일 동영상.","deletedCommentIds":[]},"version":3,"specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"오염된 도시를 다니며 환경을 오염하는 쓰레기를 주워서 도시를 깨끗하게 만든다."},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#안전한사회 #생명존중"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"미래 박람회 쇼케이스 디지털 컨셉 아트 스타일 (세련된 조명과 미래지향적 모션그래픽)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"인공지능(AI)사물인식 기술로 사람과 쓰레기를 구별할수있고, 등판에 태양광 발전이 달려있어서 베터리를  갈필요가 없어서 무선 충전이 된다."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"전면에는 다관절 집게팔이 쓰레기를 주워서 전면흡입구로 넣어 내부필터로 쓰레기를 빨아드린다."},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"위치 센서(GPS), 카메라 센서","sensorAction":"사람을 안전하게 피해 다른 경로로 가고, 쓰레기가 있는곳에 가서 다관절 집게팔을 이용해 쓰레기를 줍는다.","sensorTarget":"10m 쓰레기 위치,사람위치"},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"A-40","appearance":"친근한 네모유선형에 무한궤도 바퀴가있고, 앞쪽에 접이식집게팔이 있고 뒤쪽 작은 드론이 있어 멀리 떨어져 있는 쓰레기를 주워서 로봇의 앞에 놔두고, 등판에 등판에 태양광 발전이 달려있는 로봇"}},"submittedAt":"2026-11-16T06:45:31.798Z","videoPrompt":"[AI 영상 제작] 2050 미래 도시에서 친근한 네모유선형에 무한궤도 바퀴가있고, 앞쪽에 접이식집게팔이 있고 뒤쪽 작은 드론이 있어 멀리 떨어져 있는 쓰레기를 주워서 로봇의 앞에 놔두고, 등판에 등판에 태양광 발전이 달려있는 로봇 외형을 갖춘 로봇 'A-40'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 위치 센서, 카메라 센서에 푸른 스캔 라이트가 켜지며(10m 쓰레기 위치,사람위치) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 목표물을 집어 올리고 수거 장치를 작동시키며, 몸체의 정화 필터로 오염 물질을 흡입해 걸러낸 뒤 맑고 깨끗한 흐름을 내보내며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 미래 박람회 쇼케이스 디지털 컨셉 아트 스타일 동영상.","teacherFeedbackBefore":""}],"updatedAt":"2026-11-17T00:13:31.241Z"},{"studentId":"장서윤","studentName":"장서윤","status":"approved","inputs":{"robotName":"분리배출로봇","appearance":"서비스업 로봇같이 네모난 얼굴에, 몸통에 바퀴 4개가 달렸다. 네모 몸통 안에 배터리, 컴퓨터(제어보드), 모터 제어장치 등이 있다. 머리위에는 간단한 화면이나 불빛(LED)가 있어서 상태를 표시할 수 있다.","purpose":"사람들이 함부로 버리고 분래배출하지 않아 땅, 바다에 버려진 쓰레기들이 생기는 것을 막는 분리배출을 도와주는 로봇","mainFunction":"로봇이 쓰레기의 종류를 분석하여 쓰레기를 각 쓰레기통에 버리고 나중에 버려야하면 로봇의 집게팔로 2개이상의 쓰레기통을 집어 집 근처에 있는 재활용 수거함이나 분리수거함에 넣어준다.","sensorName":"종류분석센서, 카메라 센서","sensorTarget":"분리배출할 쓰레기의 종류, 쓰레기","sensorAction":"카메라센서로 쓰레기를 본 뒤 종류분석센서로 종류를 분석한 후 집 쓰레기통에 버리고 나중에 분리수거함등의 곳을 카메라센서로 확인한 후 종류분석센서 버릴 곳을 확인한 뒤 버린다.","scienceTech":"태양광자가발전 배터리로 충전되고, 음성 인식이 가능하다. 카메라센서로 인식이 가능하다. 인공지능 학습 기술로 점점 더 정확하게 분류가 가능하다","coreValues":"#생태계보존 #재활용 #자원순환","videoStyle":"솔라펑크(Solarpunk) 친환경 미래 3D 스타일 (푸른 자연 생태계와 첨단 과학기술의 조화)","customVideoPrompt":"[AI 영상 제작] 2050년, 심플한벽자와 깔끔한 집에서, 서비스업 로봇같이 네모난 얼굴에, 몸통에 바퀴 4개가 달렸다, 네모 몸통 안에 배터리, 컴퓨터, 모터 제어장치 등이 있다, 머리위에는 간단한 화면이나 불빛가 있어서 상태를 표시할 수 있다 외형을 갖춘 로봇 '분리배출로봇'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 30대여자가 과자먹고 남은 과자봉지를 종이류, 비닐류, 일반쓰레기통, 캔류의 쓰래기통에서 어떤 쓰레기종류의 통에 버릴 지 몰라하자 장착된 종류분석센서, 카메라 센서에 푸른 스캔 라이트가 켜지며(분리배출할 쓰레기의 종류, 쓰레기) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 목표물인 과자봉지(과자는 다 먹어서 없음.)를 집어 올리고 수거 장치를 작동시키며 연속된 동작으로 쓰레기통들중에 일반쓰레기통이 있는 곳으로 가서 쓰레기를 버리는 임무를 수행하는 모습을 생생하게 보여준다.(과자봉지는 일반쓰레기통 안에 들어가진다.) 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 솔라펑크 친환경 미래 3D 스타일 동영상.","aiFeedback":null,"boothComments":[{"v":2,"id":"c_1794873480727_8i8o6","text":"저런 로봇이 있으면 분리배출을 다른 데 넣지 않고 올바른 곳에 넣을 것 같아","author":"진연우","createdAt":"2026-11-16T23:58:00.727Z","viewerToken":"vt_1794788838051_mpwskv0k","authorStudentId":"진연우"},{"v":2,"id":"c_1794873689065_70gis","text":"지금의 모습과 연관지어서 로봇만든거 아이디어 짱이다🍀","author":"김지아","createdAt":"2026-11-17T00:01:29.065Z","viewerToken":"vt_1794796098329_ixf8fbb4","authorStudentId":"김지아"},{"v":2,"id":"c_1794873736757_hox5y","text":"너무무ㅜ무무무무무ㅜ무무무무무 잘했드아아아앙","author":"김승윤","createdAt":"2026-11-17T00:02:16.757Z","viewerToken":"vt_1794796086113_pfa1lkx5","authorStudentId":"김승윤"},{"v":2,"id":"c_1794873756924_pfaul","text":"아이디어가 좋고 미래에 저런게 생기면 정말 좋을거 같아","author":"진예원","createdAt":"2026-11-17T00:02:36.924Z","updatedAt":"2026-11-17T00:02:44.525Z","viewerToken":"vt_1794796813857_o43fsiny","authorStudentId":"진예원"},{"v":2,"id":"c_1794873757924_j76bx","text":"근데 저로봇이 전기를 꽤 많이 먹을것 같은데 분리배출 교육을 하는게 더 효율적일것 같아ㅜ 그래도 나쁘지 않은 시도였써ㅓㅓ","author":"이수아","createdAt":"2026-11-17T00:02:37.924Z","viewerToken":"vt_1794799212191_bqc4jkhg","authorStudentId":""},{"v":2,"id":"c_1794874318609_apael","text":"!!!😃😄😃😄😃😀😆😆🤣와우!","author":"이석준","createdAt":"2026-11-17T00:11:58.609Z","viewerToken":"vt_1794799215240_tjkhcvj5","authorStudentId":"이석준"},{"v":2,"id":"c_1794874419616_p3fth","text":"와아아아아아앙 진탸 신기해!!!!!!","author":"신다빈","createdAt":"2026-11-17T00:13:39.616Z","viewerToken":"vt_1794796192899_42ggb0j9","authorStudentId":"신다빈"}],"deletedCommentIds":[]},"videoPrompt":"[AI 영상 제작] 2050년, 심플한벽자와 깔끔한 집에서, 서비스업 로봇같이 네모난 얼굴에, 몸통에 바퀴 4개가 달렸다, 네모 몸통 안에 배터리, 컴퓨터, 모터 제어장치 등이 있다, 머리위에는 간단한 화면이나 불빛가 있어서 상태를 표시할 수 있다 외형을 갖춘 로봇 '분리배출로봇'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 30대여자가 과자먹고 남은 과자봉지를 종이류, 비닐류, 일반쓰레기통, 캔류의 쓰래기통에서 어떤 쓰레기종류의 통에 버릴 지 몰라하자 장착된 종류분석센서, 카메라 센서에 푸른 스캔 라이트가 켜지며(분리배출할 쓰레기의 종류, 쓰레기) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 목표물인 과자봉지(과자는 다 먹어서 없음.)를 집어 올리고 수거 장치를 작동시키며 연속된 동작으로 쓰레기통들중에 일반쓰레기통이 있는 곳으로 가서 쓰레기를 버리는 임무를 수행하는 모습을 생생하게 보여준다.(과자봉지는 일반쓰레기통 안에 들어가진다.) 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 솔라펑크 친환경 미래 3D 스타일 동영상.","specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"사람들이 함부로 버리고 분래배출하지 않아 땅, 바다에 버려진 쓰레기들이 생기는 것을 막는 분리배출을 도와주는 로봇"},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#생태계보존 #재활용 #자원순환"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"솔라펑크(Solarpunk) 친환경 미래 3D 스타일 (푸른 자연 생태계와 첨단 과학기술의 조화)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"태양광자가발전 배터리로 충전되고, 음성 인식이 가능하다. 카메라센서로 인식이 가능하다. 인공지능 학습 기술로 점점 더 정확하게 분류가 가능하다"},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"로봇이 쓰레기의 종류를 분석하여 쓰레기를 각 쓰레기통에 버리고 나중에 버려야하면 로봇의 집게팔로 2개이상의 쓰레기통을 집어 집 근처에 있는 재활용 수거함이나 분리수거함에 넣어준다."},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"종류분석센서, 카메라 센서","sensorAction":"카메라센서로 쓰레기를 본 뒤 종류분석센서로 종류를 분석한 후 집 쓰레기통에 버리고 나중에 분리수거함등의 곳을 카메라센서로 확인한 후 종류분석센서 버릴 곳을 확인한 뒤 버린다.","sensorTarget":"분리배출할 쓰레기의 종류, 쓰레기"},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"분리배출로봇","appearance":"서비스업 로봇같이 네모난 얼굴에, 몸통에 바퀴 4개가 달렸다. 네모 몸통 안에 배터리, 컴퓨터(제어보드), 모터 제어장치 등이 있다. 머리위에는 간단한 화면이나 불빛(LED)가 있어서 상태를 표시할 수 있다."}},"teacherFeedback":"로봇의 외형에 대한 구체적인 설명을 추가해주세요.(얼굴 모양, 몸 구조, 재질 등)","feedbackAt":"2026-11-16T03:47:52.500Z","video":{"type":"none","url":"","title":"","thumbnail":""},"likes":7,"currentVersion":7,"history":[{"label":"버전 6 (5차 수정)","inputs":{"purpose":"사람들이 함부로 버리고 분래배출하지 않아 땅, 바다에 버려진 쓰레기들이 생기는 것을 막는 분리배출을 도와주는 로봇","robotName":"분리배출로봇","aiFeedback":null,"appearance":"서비스업 로봇같이 네모난 얼굴에, 몸통에 바퀴 4개가 달렸다. 네모 몸통 안에 배터리, 컴퓨터(제어보드), 모터 제어장치 등이 있다. 머리위에는 간단한 화면이나 불빛(LED)가 있어서 상태를 표시할 수 있다.","coreValues":"#생태계보존 #재활용 #자원순환","sensorName":"종류분석센서, 카메라 센서","videoStyle":"솔라펑크(Solarpunk) 친환경 미래 3D 스타일 (푸른 자연 생태계와 첨단 과학기술의 조화)","scienceTech":"태양광자가발전 배터리로 충전되고, 음성 인식이 가능하다. 카메라센서로 인식이 가능하다. 인공지능 학습 기술로 점점 더 정확하게 분류가 가능하다","mainFunction":"로봇이 쓰레기의 종류를 분석하여 쓰레기를 각 쓰레기통에 버리고 나중에 버려야하면 로봇의 집게팔로 2개이상의 쓰레기통을 집어 집 근처에 있는 재활용 수거함이나 분리수거함에 넣어준다.","sensorAction":"카메라센서로 쓰레기를 본 뒤 종류분석센서로 종류를 분석한 후 집 쓰레기통에 버리고 나중에 분리수거함등의 곳을 카메라센서로 확인한 후 종류분석센서 버릴 곳을 확인한 뒤 버린다.","sensorTarget":"분리배출할 쓰레기의 종류, 쓰레기","boothComments":[],"customVideoPrompt":"[AI 영상 제작] 2050년, 심플한벽자와 깔끔한 집에서, 서비스업 로봇같이 네모난 얼굴에, 몸통에 바퀴 4개가 달렸다, 네모 몸통 안에 배터리, 컴퓨터, 모터 제어장치 등이 있다, 머리위에는 간단한 화면이나 불빛가 있어서 상태를 표시할 수 있다 외형을 갖춘 로봇 '분리배출로봇'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 30대여자가 과자먹고 남은 과자봉지를 종이류, 비닐류, 일반쓰레기통, 캔류의 쓰래기통에서 어떤 쓰레기종류의 통에 버릴 지 몰라하자 장착된 종류분석센서, 카메라 센서에 푸른 스캔 라이트가 켜지며(분리배출할 쓰레기의 종류, 쓰레기) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 목표물인 과자봉지(과자는 다 먹어서 없음.)를 집어 올리고 수거 장치를 작동시키며 연속된 동작으로 쓰레기통들중에 일반쓰레기통이 있는 곳으로 가서 쓰레기를 버리는 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 솔라펑크 친환경 미래 3D 스타일 동영상.","deletedCommentIds":[]},"version":6,"specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"사람들이 함부로 버리고 분래배출하지 않아 땅, 바다에 버려진 쓰레기들이 생기는 것을 막는 분리배출을 도와주는 로봇"},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#생태계보존 #재활용 #자원순환"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"솔라펑크(Solarpunk) 친환경 미래 3D 스타일 (푸른 자연 생태계와 첨단 과학기술의 조화)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"태양광자가발전 배터리로 충전되고, 음성 인식이 가능하다. 카메라센서로 인식이 가능하다. 인공지능 학습 기술로 점점 더 정확하게 분류가 가능하다"},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"로봇이 쓰레기의 종류를 분석하여 쓰레기를 각 쓰레기통에 버리고 나중에 버려야하면 로봇의 집게팔로 2개이상의 쓰레기통을 집어 집 근처에 있는 재활용 수거함이나 분리수거함에 넣어준다."},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"종류분석센서, 카메라 센서","sensorAction":"카메라센서로 쓰레기를 본 뒤 종류분석센서로 종류를 분석한 후 집 쓰레기통에 버리고 나중에 분리수거함등의 곳을 카메라센서로 확인한 후 종류분석센서 버릴 곳을 확인한 뒤 버린다.","sensorTarget":"분리배출할 쓰레기의 종류, 쓰레기"},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"분리배출로봇","appearance":"서비스업 로봇같이 네모난 얼굴에, 몸통에 바퀴 4개가 달렸다. 네모 몸통 안에 배터리, 컴퓨터(제어보드), 모터 제어장치 등이 있다. 머리위에는 간단한 화면이나 불빛(LED)가 있어서 상태를 표시할 수 있다."}},"submittedAt":"2026-11-16T03:33:03.513Z","videoPrompt":"[AI 영상 제작] 2050년, 심플한벽자와 깔끔한 집에서, 서비스업 로봇같이 네모난 얼굴에, 몸통에 바퀴 4개가 달렸다, 네모 몸통 안에 배터리, 컴퓨터, 모터 제어장치 등이 있다, 머리위에는 간단한 화면이나 불빛가 있어서 상태를 표시할 수 있다 외형을 갖춘 로봇 '분리배출로봇'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 30대여자가 과자먹고 남은 과자봉지를 종이류, 비닐류, 일반쓰레기통, 캔류의 쓰래기통에서 어떤 쓰레기종류의 통에 버릴 지 몰라하자 장착된 종류분석센서, 카메라 센서에 푸른 스캔 라이트가 켜지며(분리배출할 쓰레기의 종류, 쓰레기) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 목표물인 과자봉지(과자는 다 먹어서 없음.)를 집어 올리고 수거 장치를 작동시키며 연속된 동작으로 쓰레기통들중에 일반쓰레기통이 있는 곳으로 가서 쓰레기를 버리는 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 솔라펑크 친환경 미래 3D 스타일 동영상.","teacherFeedbackBefore":"로봇의 외형에 대한 구체적인 설명을 추가해주세요.(얼굴 모양, 몸 구조, 재질 등)"},{"label":"버전 7 (6차 수정)","inputs":{"purpose":"사람들이 함부로 버리고 분래배출하지 않아 땅, 바다에 버려진 쓰레기들이 생기는 것을 막는 분리배출을 도와주는 로봇","robotName":"분리배출로봇","aiFeedback":null,"appearance":"서비스업 로봇같이 네모난 얼굴에, 몸통에 바퀴 4개가 달렸다. 네모 몸통 안에 배터리, 컴퓨터(제어보드), 모터 제어장치 등이 있다. 머리위에는 간단한 화면이나 불빛(LED)가 있어서 상태를 표시할 수 있다.","coreValues":"#생태계보존 #재활용 #자원순환","sensorName":"종류분석센서, 카메라 센서","videoStyle":"솔라펑크(Solarpunk) 친환경 미래 3D 스타일 (푸른 자연 생태계와 첨단 과학기술의 조화)","scienceTech":"태양광자가발전 배터리로 충전되고, 음성 인식이 가능하다. 카메라센서로 인식이 가능하다. 인공지능 학습 기술로 점점 더 정확하게 분류가 가능하다","mainFunction":"로봇이 쓰레기의 종류를 분석하여 쓰레기를 각 쓰레기통에 버리고 나중에 버려야하면 로봇의 집게팔로 2개이상의 쓰레기통을 집어 집 근처에 있는 재활용 수거함이나 분리수거함에 넣어준다.","sensorAction":"카메라센서로 쓰레기를 본 뒤 종류분석센서로 종류를 분석한 후 집 쓰레기통에 버리고 나중에 분리수거함등의 곳을 카메라센서로 확인한 후 종류분석센서 버릴 곳을 확인한 뒤 버린다.","sensorTarget":"분리배출할 쓰레기의 종류, 쓰레기","boothComments":[],"customVideoPrompt":"[AI 영상 제작] 2050년, 심플한벽자와 깔끔한 집에서, 서비스업 로봇같이 네모난 얼굴에, 몸통에 바퀴 4개가 달렸다, 네모 몸통 안에 배터리, 컴퓨터, 모터 제어장치 등이 있다, 머리위에는 간단한 화면이나 불빛가 있어서 상태를 표시할 수 있다 외형을 갖춘 로봇 '분리배출로봇'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 30대여자가 과자먹고 남은 과자봉지를 종이류, 비닐류, 일반쓰레기통, 캔류의 쓰래기통에서 어떤 쓰레기종류의 통에 버릴 지 몰라하자 장착된 종류분석센서, 카메라 센서에 푸른 스캔 라이트가 켜지며(분리배출할 쓰레기의 종류, 쓰레기) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 목표물인 과자봉지(과자는 다 먹어서 없음.)를 집어 올리고 수거 장치를 작동시키며 연속된 동작으로 쓰레기통들중에 일반쓰레기통이 있는 곳으로 가서 쓰레기를 버리는 임무를 수행하는 모습을 생생하게 보여준다.(과자봉지는 일반쓰레기통 안에 들어가진다.) 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 솔라펑크 친환경 미래 3D 스타일 동영상.","deletedCommentIds":[]},"version":7,"specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"사람들이 함부로 버리고 분래배출하지 않아 땅, 바다에 버려진 쓰레기들이 생기는 것을 막는 분리배출을 도와주는 로봇"},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#생태계보존 #재활용 #자원순환"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"솔라펑크(Solarpunk) 친환경 미래 3D 스타일 (푸른 자연 생태계와 첨단 과학기술의 조화)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"태양광자가발전 배터리로 충전되고, 음성 인식이 가능하다. 카메라센서로 인식이 가능하다. 인공지능 학습 기술로 점점 더 정확하게 분류가 가능하다"},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"로봇이 쓰레기의 종류를 분석하여 쓰레기를 각 쓰레기통에 버리고 나중에 버려야하면 로봇의 집게팔로 2개이상의 쓰레기통을 집어 집 근처에 있는 재활용 수거함이나 분리수거함에 넣어준다."},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"종류분석센서, 카메라 센서","sensorAction":"카메라센서로 쓰레기를 본 뒤 종류분석센서로 종류를 분석한 후 집 쓰레기통에 버리고 나중에 분리수거함등의 곳을 카메라센서로 확인한 후 종류분석센서 버릴 곳을 확인한 뒤 버린다.","sensorTarget":"분리배출할 쓰레기의 종류, 쓰레기"},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"분리배출로봇","appearance":"서비스업 로봇같이 네모난 얼굴에, 몸통에 바퀴 4개가 달렸다. 네모 몸통 안에 배터리, 컴퓨터(제어보드), 모터 제어장치 등이 있다. 머리위에는 간단한 화면이나 불빛(LED)가 있어서 상태를 표시할 수 있다."}},"submittedAt":"2026-11-16T03:40:58.147Z","videoPrompt":"[AI 영상 제작] 2050년, 심플한벽자와 깔끔한 집에서, 서비스업 로봇같이 네모난 얼굴에, 몸통에 바퀴 4개가 달렸다, 네모 몸통 안에 배터리, 컴퓨터, 모터 제어장치 등이 있다, 머리위에는 간단한 화면이나 불빛가 있어서 상태를 표시할 수 있다 외형을 갖춘 로봇 '분리배출로봇'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 30대여자가 과자먹고 남은 과자봉지를 종이류, 비닐류, 일반쓰레기통, 캔류의 쓰래기통에서 어떤 쓰레기종류의 통에 버릴 지 몰라하자 장착된 종류분석센서, 카메라 센서에 푸른 스캔 라이트가 켜지며(분리배출할 쓰레기의 종류, 쓰레기) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 목표물인 과자봉지(과자는 다 먹어서 없음.)를 집어 올리고 수거 장치를 작동시키며 연속된 동작으로 쓰레기통들중에 일반쓰레기통이 있는 곳으로 가서 쓰레기를 버리는 임무를 수행하는 모습을 생생하게 보여준다.(과자봉지는 일반쓰레기통 안에 들어가진다.) 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 솔라펑크 친환경 미래 3D 스타일 동영상.","teacherFeedbackBefore":"로봇의 외형에 대한 구체적인 설명을 추가해주세요.(얼굴 모양, 몸 구조, 재질 등)"}],"updatedAt":"2026-11-17T00:13:39.616Z"},{"studentId":"이혜원","studentName":"이혜원","status":"approved","inputs":{"robotName":"히.직.정.로봇","appearance":"모니터,흰색, 날개, 비행형,원형의 상담실,메탈적인 재질, 접이식,집게팔,정사각형몸속에서 큰모니터가 나오는데 거기서 직업의 특정 이모지가 나오면서 선택하거나 추천해줌 \n비행형으로 다리는 없다 비행기 모양이다 VR기계가 달려있어서 집게팔로 씌워줌\n가볍고 튼튼한 탄소 섬유같은 산소재가 있음\n로봇이 날아다닐 때 바람의 저항을 줄여주는 유선형임","purpose":"히키코모리가 된 사람이 증폭됨\n정신병자,우울증등에 걸리는 사람이 많아짐\n직업을 잃으면서 가난을 겪게 되는사람이 많아짐 \n가난으로 밥을 먹지 못해서 영양실조에 걸리고, 어딘가를 다치면 병원에서 수술을 하기도 힘듬 \n가난으로 집을 잃어서 노숙자가 늘어남\n배경장소로는 길거리임\n그리고 사람의 옷이 허름하고 표정이 심각한 표정임","mainFunction":"밑에 있는 모니터가 직업을 고를 수 있게 하고, 그전에 그 사람의 정보를 찾아서 체형과 재능을 고려해 추천해줌\n그 일을 하기위한 가이드를 제공함 그 일하기위한 직업체험을 집게팔을 이용해 VR을 써줌 그걸로 직업체험을 함\n꽃게같은 팔로 VR을 씌워줌 \n영양실조인 사람을 위해 음식도 제공해줌\n사람의 표정이 나쁘고 옷이 허름하다","sensorName":"직업 없음 카메라 센서","sensorTarget":"직업이 없는 사람을 찾아냄","sensorAction":"직업없는사람의 정보를 국가에서 정보를 구해  무직인 사람에게 날개로 날아감","scienceTech":"음성 인식으로 그 사람이 원하는걸 인지하여 추천아니면 선택을 하게 해줌 \n날아다니는 기술로 직업이 없는사람에게 찾아감","coreValues":"#생명존중 #안전한사회 #생태계보존","videoStyle":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)","customVideoPrompt":"[AI 영상 제작]   2050년 길거리에서 모니터,흰색, 날개, 비행형,원형의 상담실,메탈적인 재질, 접이식,집게팔,정사각형몸속에서 큰모니터가 나오는데 거기서 직업의 특정 이모지가 나오면서 선택하거나 추천해줌 비행형으로 다리는 없다 비행기 형태 VR기계가 달려있어서 집게팔로 씌워줌 가볍고 튼튼한 탄소 섬유같은 산소재가 있음 로봇이 날아다닐 때 바람의 저항을 줄여주는 유선형임 외형을 갖춘 로봇 '히.직.정.로봇'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 직업 없음 카메라 센서에 푸른 스캔 라이트가 켜지며(직업이 없는 사람을 찾아냄) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 사람 곁으로 부드럽게 다가가 친근한 제스처와 따뜻한 라이트로 다정하게 교감하며, 다관절 집게팔을 정교하게 뻗어 목표물을 집어 올리고 수거 장치를 작동시키며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상.","aiFeedback":{"date":"2026-11-16","count":3,"step1":"히.직.정.로봇의 날개와 메탈 재질, VR 기계를 씌워주는 집게팔 아이디어가 아주 독창적이고 멋져요! 로봇이 날아다닐 때 바람의 저항을 줄여주는 유선형 디자인이나, 가볍고 튼튼한 탄소 섬유 같은 신소재를 외형 특징에 함께 적어보면 더욱 완성도 높은 로봇이 될 거예요.","step2":"마음이 힘든 친구들이나 직업이 필요한 사람들을 돕겠다는 따뜻한 마음이 정말 잘 느껴져요. 이 로봇이 단순히 고민을 들어주는 것에서 더 나아가, 영양실조나 주거 문제까지 해결할 수 있도록 푸드뱅크나 복지 기관과 연결해주는 사회적 기능도 함께 적어보면 좋겠어요.","step3":"꽃게 같은 집게팔로 VR을 씌워주고 직업 체험 가이드를 주는 모습이 아주 생생하게 그려져요. 관절을 자유롭게 움직이게 해주는 모터의 회전 원리나, VR 기계를 안전하게 잡기 위한 압력 센서의 작동 모습을 조금 더 자세히 적어보세요.","step4":"사람의 상황을 빠르게 파악하고 찾아가는 센서 아이디어가 참 돋보여요. 카메라 센서뿐만 아니라 사람의 마음속 고민을 목소리 떨림이나 표정 변화로 알아채는 '음성·표정 감지 센서'를 함께 적어주면 로봇이 훨씬 더 똑똑하게 도와줄 수 있답니다.","step5":"음성 인식과 비행 기술을 찰떡같이 잘 찾아내어 적어주었어요! 여기에 사람의 뇌파나 목소리를 분석해서 마음의 우울함을 빠르게 알아내는 '인공지능(AI) 데이터 분석 기술'이나 친환경 태양광 에너지 비행 기술을 함께 적어보면 훨씬 더 완벽한 융합 기술이 될 거예요.","updatedAt":"2026-11-16T03:16:12.326Z"},"boothComments":[{"v":2,"id":"c_1794873457788_k8pjy","text":"히키모코리가 뭔지는 모르겠는데 아이디어는 좋다","author":"박성민","createdAt":"2026-11-16T23:57:37.788Z","viewerToken":"vt_1794797170972_uk8wojcz","authorStudentId":"박성민"},{"v":2,"id":"c_1794873603696_dvct1","text":"정말 좋은데? 아이디어가 훌륭해!!!","author":"장서윤","createdAt":"2026-11-17T00:00:03.696Z","viewerToken":"vt_1794796665307_ra6syqil","authorStudentId":"장서윤"},{"v":2,"id":"c_1794873881294_nvpeb","text":"이야호오오오오오ㅗ오오오오오옹오옹어어어","author":"김승윤","createdAt":"2026-11-17T00:04:41.294Z","viewerToken":"vt_1794796086113_pfa1lkx5","authorStudentId":"김승윤"},{"v":2,"id":"c_1794874146479_6l3mb","text":"히키코모리:집에서 안나오는 사람이야!","author":"이혜원","createdAt":"2026-11-17T00:09:06.479Z","viewerToken":"vt_1794873061965_2edypenz","authorStudentId":"이혜원"},{"v":2,"id":"c_1794874146509_wmr18","text":"미래에 실제로 히키코모리랑 정신병자,우울드증등에 걸리는 사람 많을것 가타ㅏㅜ","author":"이수아","createdAt":"2026-11-17T00:09:06.509Z","viewerToken":"vt_1794799212191_bqc4jkhg","authorStudentId":""},{"v":2,"id":"c_1794874173514_dabie","text":"하키코모리가 뭐양???. 로봇은 넘 멋지당!!!","author":"공인경","createdAt":"2026-11-17T00:09:33.514Z","viewerToken":"vt_1794799986519_qjpt3033","authorStudentId":"공인경"},{"v":2,"id":"c_1794874370682_8wg21","text":"히키코모리ㆍ정신병자 예언이 진짜일것 같아서 현실적이야","author":"김서은","createdAt":"2026-11-17T00:12:50.683Z","viewerToken":"vt_1794873117429_t91qscap","authorStudentId":"김서은"},{"v":2,"id":"c_1794874474802_qbxu5","text":"하키코모리 씨가 누구죠?🤔🙂🤔🤔🤔","author":"이석준","createdAt":"2026-11-17T00:14:34.802Z","viewerToken":"vt_1794799215240_tjkhcvj5","authorStudentId":"이석준"}],"deletedCommentIds":["c_1794874080868_o4ykx"]},"videoPrompt":"[AI 영상 제작]   2050년 길거리에서 모니터,흰색, 날개, 비행형,원형의 상담실,메탈적인 재질, 접이식,집게팔,정사각형몸속에서 큰모니터가 나오는데 거기서 직업의 특정 이모지가 나오면서 선택하거나 추천해줌 비행형으로 다리는 없다 비행기 형태 VR기계가 달려있어서 집게팔로 씌워줌 가볍고 튼튼한 탄소 섬유같은 산소재가 있음 로봇이 날아다닐 때 바람의 저항을 줄여주는 유선형임 외형을 갖춘 로봇 '히.직.정.로봇'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 직업 없음 카메라 센서에 푸른 스캔 라이트가 켜지며(직업이 없는 사람을 찾아냄) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 사람 곁으로 부드럽게 다가가 친근한 제스처와 따뜻한 라이트로 다정하게 교감하며, 다관절 집게팔을 정교하게 뻗어 목표물을 집어 올리고 수거 장치를 작동시키며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상.","specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"히키코모리가 된 사람이 증폭됨\n정신병자,우울증등에 걸리는 사람이 많아짐\n직업을 잃으면서 가난을 겪게 되는사람이 많아짐 \n가난으로 밥을 먹지 못해서 영양실조에 걸리고, 어딘가를 다치면 병원에서 수술을 하기도 힘듬 \n가난으로 집을 잃어서 노숙자가 늘어남\n배경장소로는 길거리임\n그리고 사람의 옷이 허름하고 표정이 심각한 표정임"},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#생명존중 #안전한사회 #생태계보존"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"음성 인식으로 그 사람이 원하는걸 인지하여 추천아니면 선택을 하게 해줌 \n날아다니는 기술로 직업이 없는사람에게 찾아감"},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"밑에 있는 모니터가 직업을 고를 수 있게 하고, 그전에 그 사람의 정보를 찾아서 체형과 재능을 고려해 추천해줌\n그 일을 하기위한 가이드를 제공함 그 일하기위한 직업체험을 집게팔을 이용해 VR을 써줌 그걸로 직업체험을 함\n꽃게같은 팔로 VR을 씌워줌 \n영양실조인 사람을 위해 음식도 제공해줌\n사람의 표정이 나쁘고 옷이 허름하다"},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"직업 없음 카메라 센서","sensorAction":"직업없는사람의 정보를 국가에서 정보를 구해  무직인 사람에게 날개로 날아감","sensorTarget":"직업이 없는 사람을 찾아냄"},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"히.직.정.로봇","appearance":"모니터,흰색, 날개, 비행형,원형의 상담실,메탈적인 재질, 접이식,집게팔,정사각형몸속에서 큰모니터가 나오는데 거기서 직업의 특정 이모지가 나오면서 선택하거나 추천해줌 \n비행형으로 다리는 없다 비행기 모양이다 VR기계가 달려있어서 집게팔로 씌워줌\n가볍고 튼튼한 탄소 섬유같은 산소재가 있음\n로봇이 날아다닐 때 바람의 저항을 줄여주는 유선형임"}},"teacherFeedback":"로봇의 외형에 대한 특징을 문장, 구체적으로 설명해주세요.","feedbackAt":"2026-11-16T05:09:16.041Z","video":{"type":"none","url":"","title":"","thumbnail":""},"likes":8,"currentVersion":10,"history":[{"label":"버전 9 (8차 수정)","inputs":{"purpose":"히키코모리가 된 사람이 증폭됨\n정신병자,우울증등에 걸리는 사람이 많아짐\n직업을 잃으면서 가난을 겪게 되는사람이 많아짐 \n가난으로 밥을 먹지 못해서 영양실조에 걸리고, 어딘가를 다치면 병원에서 수술을 하기도 힘듬 \n가난으로 집을 잃어서 노숙자가 늘어남\n배경장소로는 길거리임\n그리고 사람의 옷이 허름하고 표정이 심각한 표정임","robotName":"히.직.정.로봇","aiFeedback":{"date":"2026-11-16","count":3,"step1":"히.직.정.로봇의 날개와 메탈 재질, VR 기계를 씌워주는 집게팔 아이디어가 아주 독창적이고 멋져요! 로봇이 날아다닐 때 바람의 저항을 줄여주는 유선형 디자인이나, 가볍고 튼튼한 탄소 섬유 같은 신소재를 외형 특징에 함께 적어보면 더욱 완성도 높은 로봇이 될 거예요.","step2":"마음이 힘든 친구들이나 직업이 필요한 사람들을 돕겠다는 따뜻한 마음이 정말 잘 느껴져요. 이 로봇이 단순히 고민을 들어주는 것에서 더 나아가, 영양실조나 주거 문제까지 해결할 수 있도록 푸드뱅크나 복지 기관과 연결해주는 사회적 기능도 함께 적어보면 좋겠어요.","step3":"꽃게 같은 집게팔로 VR을 씌워주고 직업 체험 가이드를 주는 모습이 아주 생생하게 그려져요. 관절을 자유롭게 움직이게 해주는 모터의 회전 원리나, VR 기계를 안전하게 잡기 위한 압력 센서의 작동 모습을 조금 더 자세히 적어보세요.","step4":"사람의 상황을 빠르게 파악하고 찾아가는 센서 아이디어가 참 돋보여요. 카메라 센서뿐만 아니라 사람의 마음속 고민을 목소리 떨림이나 표정 변화로 알아채는 '음성·표정 감지 센서'를 함께 적어주면 로봇이 훨씬 더 똑똑하게 도와줄 수 있답니다.","step5":"음성 인식과 비행 기술을 찰떡같이 잘 찾아내어 적어주었어요! 여기에 사람의 뇌파나 목소리를 분석해서 마음의 우울함을 빠르게 알아내는 '인공지능(AI) 데이터 분석 기술'이나 친환경 태양광 에너지 비행 기술을 함께 적어보면 훨씬 더 완벽한 융합 기술이 될 거예요.","updatedAt":"2026-11-16T03:16:12.326Z"},"appearance":"모니터,흰색, 날개, 비행형,원형의 상담실,메탈적인 재질, 접이식,집게팔,정사각형몸속에서 큰모니터가 나오는데 거기서 직업의 특정 이모지가 나오면서 선택하거나 추천해줌 \n비행형으로 다리는 없다 비행기 모양이다 VR기계가 달려있어서 집게팔로 씌워줌\n가볍고 튼튼한 탄소 섬유같은 산소재가 있음\n로봇이 날아다닐 때 바람의 저항을 줄여주는 유선형임","coreValues":"#생명존중 #안전한사회 #생태계보존","sensorName":"직업 없음 카메라 센서","videoStyle":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)","scienceTech":"음성 인식으로 그 사람이 원하는걸 인지하여 추천아니면 선택을 하게 해줌 \n날아다니는 기술로 직업이 없는사람에게 찾아감","mainFunction":"밑에 있는 모니터가 직업을 고를 수 있게 하고, 그전에 그 사람의 정보를 찾아서 체형과 재능을 고려해 추천해줌\n그 일을 하기위한 가이드를 제공함 그 일하기위한 직업체험을 집게팔을 이용해 VR을 써줌 그걸로 직업체험을 함\n꽃게같은 팔로 VR을 씌워줌 \n영양실조인 사람을 위해 음식도 제공해줌\n사람의 표정이 나쁘고 옷이 허름하다","sensorAction":"직업없는사람의 정보를 국가에서 정보를 구해  무직인 사람에게 날개로 날아감","sensorTarget":"직업이 없는 사람을 찾아냄","boothComments":[],"customVideoPrompt":"","deletedCommentIds":[]},"version":9,"specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"히키코모리가 된 사람이 증폭됨\n정신병자,우울증등에 걸리는 사람이 많아짐\n직업을 잃으면서 가난을 겪게 되는사람이 많아짐 \n가난으로 밥을 먹지 못해서 영양실조에 걸리고, 어딘가를 다치면 병원에서 수술을 하기도 힘듬 \n가난으로 집을 잃어서 노숙자가 늘어남\n배경장소로는 길거리임\n그리고 사람의 옷이 허름하고 표정이 심각한 표정임"},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#생명존중 #안전한사회 #생태계보존"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"음성 인식으로 그 사람이 원하는걸 인지하여 추천아니면 선택을 하게 해줌 \n날아다니는 기술로 직업이 없는사람에게 찾아감"},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"밑에 있는 모니터가 직업을 고를 수 있게 하고, 그전에 그 사람의 정보를 찾아서 체형과 재능을 고려해 추천해줌\n그 일을 하기위한 가이드를 제공함 그 일하기위한 직업체험을 집게팔을 이용해 VR을 써줌 그걸로 직업체험을 함\n꽃게같은 팔로 VR을 씌워줌 \n영양실조인 사람을 위해 음식도 제공해줌\n사람의 표정이 나쁘고 옷이 허름하다"},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"직업 없음 카메라 센서","sensorAction":"직업없는사람의 정보를 국가에서 정보를 구해  무직인 사람에게 날개로 날아감","sensorTarget":"직업이 없는 사람을 찾아냄"},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"히.직.정.로봇","appearance":"모니터,흰색, 날개, 비행형,원형의 상담실,메탈적인 재질, 접이식,집게팔,정사각형몸속에서 큰모니터가 나오는데 거기서 직업의 특정 이모지가 나오면서 선택하거나 추천해줌 \n비행형으로 다리는 없다 비행기 모양이다 VR기계가 달려있어서 집게팔로 씌워줌\n가볍고 튼튼한 탄소 섬유같은 산소재가 있음\n로봇이 날아다닐 때 바람의 저항을 줄여주는 유선형임"}},"submittedAt":"2026-11-16T03:42:23.977Z","videoPrompt":"[AI 영상 제작] 투명 홀로그램 의료 모니터가 빛나는 2050년 미래형 스마트 메디컬 센터에서, 모니터,흰색, 날개, 비행형,원형의 상담실,메탈적인 재질, 접이식,집게팔,정사각형몸속에서 큰모니터가 나오는데 거기서 직업의 특정 이모지가 나오면서 선택하거나 추천해줌 비행형으로 다리는 없다 비행기 형태 VR기계가 달려있어서 집게팔로 씌워줌 가볍고 튼튼한 탄소 섬유같은 산소재가 있음 로봇이 날아다닐 때 바람의 저항을 줄여주는 유선형임 외형을 갖춘 로봇 '히.직.정.로봇'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 직업 없음 카메라 센서에 푸른 스캔 라이트가 켜지며(직업이 없는 사람을 찾아냄) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 사람 곁으로 부드럽게 다가가 친근한 제스처와 따뜻한 라이트로 다정하게 교감하며, 다관절 집게팔을 정교하게 뻗어 목표물을 집어 올리고 수거 장치를 작동시키며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상.","teacherFeedbackBefore":"로봇의 외형에 대한 특징을 문장, 구체적으로 설명해주세요."},{"label":"버전 10 (9차 수정)","inputs":{"purpose":"히키코모리가 된 사람이 증폭됨\n정신병자,우울증등에 걸리는 사람이 많아짐\n직업을 잃으면서 가난을 겪게 되는사람이 많아짐 \n가난으로 밥을 먹지 못해서 영양실조에 걸리고, 어딘가를 다치면 병원에서 수술을 하기도 힘듬 \n가난으로 집을 잃어서 노숙자가 늘어남\n배경장소로는 길거리임\n그리고 사람의 옷이 허름하고 표정이 심각한 표정임","robotName":"히.직.정.로봇","aiFeedback":{"date":"2026-11-16","count":3,"step1":"히.직.정.로봇의 날개와 메탈 재질, VR 기계를 씌워주는 집게팔 아이디어가 아주 독창적이고 멋져요! 로봇이 날아다닐 때 바람의 저항을 줄여주는 유선형 디자인이나, 가볍고 튼튼한 탄소 섬유 같은 신소재를 외형 특징에 함께 적어보면 더욱 완성도 높은 로봇이 될 거예요.","step2":"마음이 힘든 친구들이나 직업이 필요한 사람들을 돕겠다는 따뜻한 마음이 정말 잘 느껴져요. 이 로봇이 단순히 고민을 들어주는 것에서 더 나아가, 영양실조나 주거 문제까지 해결할 수 있도록 푸드뱅크나 복지 기관과 연결해주는 사회적 기능도 함께 적어보면 좋겠어요.","step3":"꽃게 같은 집게팔로 VR을 씌워주고 직업 체험 가이드를 주는 모습이 아주 생생하게 그려져요. 관절을 자유롭게 움직이게 해주는 모터의 회전 원리나, VR 기계를 안전하게 잡기 위한 압력 센서의 작동 모습을 조금 더 자세히 적어보세요.","step4":"사람의 상황을 빠르게 파악하고 찾아가는 센서 아이디어가 참 돋보여요. 카메라 센서뿐만 아니라 사람의 마음속 고민을 목소리 떨림이나 표정 변화로 알아채는 '음성·표정 감지 센서'를 함께 적어주면 로봇이 훨씬 더 똑똑하게 도와줄 수 있답니다.","step5":"음성 인식과 비행 기술을 찰떡같이 잘 찾아내어 적어주었어요! 여기에 사람의 뇌파나 목소리를 분석해서 마음의 우울함을 빠르게 알아내는 '인공지능(AI) 데이터 분석 기술'이나 친환경 태양광 에너지 비행 기술을 함께 적어보면 훨씬 더 완벽한 융합 기술이 될 거예요.","updatedAt":"2026-11-16T03:16:12.326Z"},"appearance":"모니터,흰색, 날개, 비행형,원형의 상담실,메탈적인 재질, 접이식,집게팔,정사각형몸속에서 큰모니터가 나오는데 거기서 직업의 특정 이모지가 나오면서 선택하거나 추천해줌 \n비행형으로 다리는 없다 비행기 모양이다 VR기계가 달려있어서 집게팔로 씌워줌\n가볍고 튼튼한 탄소 섬유같은 산소재가 있음\n로봇이 날아다닐 때 바람의 저항을 줄여주는 유선형임","coreValues":"#생명존중 #안전한사회 #생태계보존","sensorName":"직업 없음 카메라 센서","videoStyle":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)","scienceTech":"음성 인식으로 그 사람이 원하는걸 인지하여 추천아니면 선택을 하게 해줌 \n날아다니는 기술로 직업이 없는사람에게 찾아감","mainFunction":"밑에 있는 모니터가 직업을 고를 수 있게 하고, 그전에 그 사람의 정보를 찾아서 체형과 재능을 고려해 추천해줌\n그 일을 하기위한 가이드를 제공함 그 일하기위한 직업체험을 집게팔을 이용해 VR을 써줌 그걸로 직업체험을 함\n꽃게같은 팔로 VR을 씌워줌 \n영양실조인 사람을 위해 음식도 제공해줌\n사람의 표정이 나쁘고 옷이 허름하다","sensorAction":"직업없는사람의 정보를 국가에서 정보를 구해  무직인 사람에게 날개로 날아감","sensorTarget":"직업이 없는 사람을 찾아냄","boothComments":[],"customVideoPrompt":"[AI 영상 제작]   2050년 길거리에서 모니터,흰색, 날개, 비행형,원형의 상담실,메탈적인 재질, 접이식,집게팔,정사각형몸속에서 큰모니터가 나오는데 거기서 직업의 특정 이모지가 나오면서 선택하거나 추천해줌 비행형으로 다리는 없다 비행기 형태 VR기계가 달려있어서 집게팔로 씌워줌 가볍고 튼튼한 탄소 섬유같은 산소재가 있음 로봇이 날아다닐 때 바람의 저항을 줄여주는 유선형임 외형을 갖춘 로봇 '히.직.정.로봇'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 직업 없음 카메라 센서에 푸른 스캔 라이트가 켜지며(직업이 없는 사람을 찾아냄) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 사람 곁으로 부드럽게 다가가 친근한 제스처와 따뜻한 라이트로 다정하게 교감하며, 다관절 집게팔을 정교하게 뻗어 목표물을 집어 올리고 수거 장치를 작동시키며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상.","deletedCommentIds":[]},"version":10,"specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"히키코모리가 된 사람이 증폭됨\n정신병자,우울증등에 걸리는 사람이 많아짐\n직업을 잃으면서 가난을 겪게 되는사람이 많아짐 \n가난으로 밥을 먹지 못해서 영양실조에 걸리고, 어딘가를 다치면 병원에서 수술을 하기도 힘듬 \n가난으로 집을 잃어서 노숙자가 늘어남\n배경장소로는 길거리임\n그리고 사람의 옷이 허름하고 표정이 심각한 표정임"},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#생명존중 #안전한사회 #생태계보존"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"음성 인식으로 그 사람이 원하는걸 인지하여 추천아니면 선택을 하게 해줌 \n날아다니는 기술로 직업이 없는사람에게 찾아감"},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"밑에 있는 모니터가 직업을 고를 수 있게 하고, 그전에 그 사람의 정보를 찾아서 체형과 재능을 고려해 추천해줌\n그 일을 하기위한 가이드를 제공함 그 일하기위한 직업체험을 집게팔을 이용해 VR을 써줌 그걸로 직업체험을 함\n꽃게같은 팔로 VR을 씌워줌 \n영양실조인 사람을 위해 음식도 제공해줌\n사람의 표정이 나쁘고 옷이 허름하다"},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"직업 없음 카메라 센서","sensorAction":"직업없는사람의 정보를 국가에서 정보를 구해  무직인 사람에게 날개로 날아감","sensorTarget":"직업이 없는 사람을 찾아냄"},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"히.직.정.로봇","appearance":"모니터,흰색, 날개, 비행형,원형의 상담실,메탈적인 재질, 접이식,집게팔,정사각형몸속에서 큰모니터가 나오는데 거기서 직업의 특정 이모지가 나오면서 선택하거나 추천해줌 \n비행형으로 다리는 없다 비행기 모양이다 VR기계가 달려있어서 집게팔로 씌워줌\n가볍고 튼튼한 탄소 섬유같은 산소재가 있음\n로봇이 날아다닐 때 바람의 저항을 줄여주는 유선형임"}},"submittedAt":"2026-11-16T03:49:57.871Z","videoPrompt":"[AI 영상 제작]   2050년 길거리에서 모니터,흰색, 날개, 비행형,원형의 상담실,메탈적인 재질, 접이식,집게팔,정사각형몸속에서 큰모니터가 나오는데 거기서 직업의 특정 이모지가 나오면서 선택하거나 추천해줌 비행형으로 다리는 없다 비행기 형태 VR기계가 달려있어서 집게팔로 씌워줌 가볍고 튼튼한 탄소 섬유같은 산소재가 있음 로봇이 날아다닐 때 바람의 저항을 줄여주는 유선형임 외형을 갖춘 로봇 '히.직.정.로봇'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 직업 없음 카메라 센서에 푸른 스캔 라이트가 켜지며(직업이 없는 사람을 찾아냄) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 사람 곁으로 부드럽게 다가가 친근한 제스처와 따뜻한 라이트로 다정하게 교감하며, 다관절 집게팔을 정교하게 뻗어 목표물을 집어 올리고 수거 장치를 작동시키며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상.","teacherFeedbackBefore":"로봇의 외형에 대한 특징을 문장, 구체적으로 설명해주세요."}],"updatedAt":"2026-11-17T00:14:34.802Z"},{"studentId":"공인경","studentName":"공인경","status":"approved","inputs":{"robotName":"에코드라이브 파워봇","appearance":"모서리가 둥근 살짝 이등변삼각형에서 정삼각형 그 사이의 모양인데 그 꼭대기 정도에 얼굴이 있고 배 쪽에음식물을 건조 시키는 기계가 배의 아랫쪽에는 그건조된 음식물을 에너지화 시키는 기계도 포함되어있다.그리고 다리는 없고 발바닥 쪽에는 평소에는 아무것도 없다가 어디를 빨리가야하는 일이 생기면 바퀴가 생겨 빠르게 갈수도 있다. 얼굴있는 입에는 음식물을 넣어야 하기 때문에 입을 벌릴수도 있다.몸에는 상한음식을 아주미세한냄새로도 음식이 상했는지 아닌지를 알수있는 센서도 달려있어 아직 먹을수 있거나 상하기 직전인 음식까지 섬세하게 구분할수있어 상하기 직전인 음식은 평소에는 머리안에 들어있는 드론을 꺼내 음식이 빠르게 필요한 단체나 마을게 보낼수도있다.","purpose":"식량이 매우 부족해 아사하는 사람이 많아지고 매 끼니 굶는 사람이 많아지고 있는 상황을 해결하기 위해","mainFunction":"입으로 버리는 음식물을 삼키면 그 음식물이 배 쪽으로 가 어느정도 음식물이 쌓이면 자동으로 건조가 되면 그다음 단계인 그 배쪽보다 더 밑인 아랫배 쪽으로 내려가게 되는데 아랫배에서는 그 건조된 음식물을 태워 나온 열에너지를 전기에너지로 바꾸어  필요한곳에 사용된다.그리고 태우면서 나오는 이산화탄소는 유해물질을 줄이도록 설계되어있다.","sensorName":"상하고 있는 음식물을 알수있는 데이터 센서","sensorTarget":"버려야하는 음식을 감지한다.","sensorAction":"어떤 창고에서 어떤걸 언제 샀는지 유통기한은 언제까지인지 정확한 데이터를 전부 저장해 버릴 음식이 생길때마다 가서 음식을 급속 건조 시킨다.","scienceTech":"상한 음식과 아닌음식을 정확히 구분하고 상한음식이 일정무게가 쌓이면 자동건조시키고,에너지화 시킨다.생산된 에너지 중에 일부는 로봇 충전을 위해 사용하고 나머지 에너지는 필요하곳에 공급한다.","coreValues":"#자원순환#지속가능한 #미래#낭비하지 #않는 #마음","videoStyle":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)","customVideoPrompt":"[AI 영상 제작] 마트에서 바나나(살짝썩어가고 있는 갈색 바나나 )가 바닥에 떨어져있는 상황에서 로봇이 그 바나나를 먹으려는 상황,롭의 외형은 모서리가 둥근 살짝 이등변삼각형에서 정삼각형 그 사이의 모양인데 그 꼭대기 정도에 얼굴이 있고 (얼굴은 삼각형 안에)배 쪽에음식물을 건조 시키는 기계가 배의 아랫쪽에는 그건조된 음식물을 에너지화 시키는 기계도 포함이루어진, 그리고 다리는 없고 발바닥 쪽에는 평소에는 아무것도 없다가 어디를 빨리가야하는 일이 생기면 바퀴가 생겨 빠르게 갈수도 있다, 얼굴있는 입에는 음식물을 넣어야 하기 때문에 입을 벌릴수도 있다 외형을 갖춘 로봇 '에코드라이브 파워봇'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 상하고 있는 음식물을 알수있는 데이터 센서 의해 바퀴를 이용해 달려가 관절이 있는 손으로 음식물을 입으로 넣은 다음에 음식이 건조되어 불 태워 지고 에너지가 만들어져 로봇이 충전되며 울굴에 충전된다는 번개 표시가 뜨는걸  클로즈업 하는 장면에 이어, 로봇이 어떤 창고에서 어떤걸 언제 샀는지 유통기한은 언제까지인지 정확한 데이터를 전부 저장해 버릴 음식이 생길때마다 가서 음하며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상.","aiFeedback":{"date":"2026-11-16","count":1,"step1":"삼각형 모양의 독특한 외형과 드론이 들어있는 아이디어가 정말 멋져요! 로봇의 몸체에 가볍고 튼튼한 '신소재 탄소섬유'를 사용한다는 점이나, 바퀴가 쏙 들어가는 '자유로운 관절 구조'를 함께 적어주면 훨씬 더 완벽해져요.","step2":"식량 부족 문제를 해결하려는 따뜻한 마음이 아주 잘 느껴지는 훌륭한 목적이에요! 여기에 '지속 가능한 친환경 사회'를 만든다는 목표를 더하고, 버려지는 음식물 쓰레기를 줄여 지구 온난화를 막는 환경 과학적 의미까지 추가해 볼까요?","step3":"음식물을 건조하고 전기에너지로 바꾸는 과정이 아주 구체적이어서 흥미로워요! 이 과정에서 열에너지를 전기에너지로 바꾸는 '열전 발달 원리'나 이산화탄소를 깨끗하게 걸러내는 '필터 기계 장치'를 설명에 더 자세히 적어보세요.","step4":"상한 음식을 구별하는 센서 아이디어가 참 기발해요! 센서의 이름을 '화학 물질 냄새를 맡는 가스 센서'나 '미세한 냄새 입자를 찾는 전자 코 센서'처럼 더 과학적인 이름으로 바꾸고, 드론을 출동시키는 행동을 3단계로 딱 맞춰 적어보면 더욱 좋아요.","step5":"음식물을 에너지로 바꾸고 재사용하는 훌륭한 융합 기술을 잘 찾아주었어요! 여기에 화학 에너지를 전기 에너지로 바꾸는 '화학 반응 원리'와 에너지를 효율적으로 저장하는 '고효율 배터리 기술'을 함께 적어주면 과학 박사님처럼 멋진 글이 될 거예요!","updatedAt":"2026-11-16T00:21:13.817Z"},"boothComments":[{"v":2,"id":"c_1794798296132_cqprj","text":"로봇이 바나나를 입에 넣고 불 태워 에너지로 만드는거 좋은 아이디어야!!^^","author":"장서윤","createdAt":"2026-11-16T03:04:56.134Z","viewerToken":"vt_1794796665307_ra6syqil","authorStudentId":"장서윤"},{"v":2,"id":"c_1794798838778_lb07f","text":"오와아아아아아아아 아이디어 굿굿👍🤭","author":"김지안","createdAt":"2026-11-16T03:13:58.778Z","viewerToken":"vt_1794796070701_4iqa9fd3","authorStudentId":"김지안"},{"v":2,"id":"c_1794873142745_xtdl6","text":"😀😀😀😀😀😀😀와우우우우!","author":"이석준","createdAt":"2026-11-16T23:52:22.745Z","viewerToken":"vt_1794799215240_tjkhcvj5","authorStudentId":"이석준"},{"v":2,"id":"c_1794873419153_o8q65","text":"이야아아아아아아아아아아아아아아아 우와와와와와와와","author":"김승윤","createdAt":"2026-11-16T23:56:59.153Z","viewerToken":"vt_1794796086113_pfa1lkx5","authorStudentId":"김승윤"},{"v":2,"id":"c_1794873590343_ae1ur","text":"상한 음식을 버리려는 아이디어가 정말 조은거 가탕!","author":"신다빈","createdAt":"2026-11-16T23:59:50.344Z","viewerToken":"vt_1794796192899_42ggb0j9","authorStudentId":"신다빈"},{"v":2,"id":"c_1794873673096_hxhbi","text":"이거 마트나 음식점에 있으면 음식물 쓰레기가 줄어들겠다!","author":"박성민","createdAt":"2026-11-17T00:01:13.096Z","viewerToken":"vt_1794797170972_uk8wojcz","authorStudentId":"박성민"},{"v":2,"id":"c_1794873841779_vrkww","text":"우와ㅏ 상한 음식을 처리하기위해 이렇게 만든거 아이디어 굿굿 💡","author":"김지아","createdAt":"2026-11-17T00:04:01.779Z","viewerToken":"vt_1794796098329_ixf8fbb4","authorStudentId":"김지아"},{"v":2,"id":"c_1794874034609_t7sqc","text":"이런 아이디어 ㅈㅉ 신선하다ㅏㅏㅏㅏㅏ","author":"이수아","createdAt":"2026-11-17T00:07:14.609Z","viewerToken":"vt_1794799212191_bqc4jkhg","authorStudentId":""},{"v":2,"id":"c_1794874099787_9sl6g","text":"상하고 있는 음식물을 모아 태워 에너지를 만들다니 멋져!!","author":"김서은","createdAt":"2026-11-17T00:08:19.787Z","viewerToken":"vt_1794873117429_t91qscap","authorStudentId":"김서은"},{"v":2,"id":"c_1794874108505_beucz","text":"음식으로 에너지를 만든다니 쓰레기도 줄고 에너지 사용도 줄어들 것 같아","author":"진연우","createdAt":"2026-11-17T00:08:28.505Z","viewerToken":"vt_1794788838051_mpwskv0k","authorStudentId":"진연우"},{"v":2,"id":"c_1794874140065_wvr4f","text":"와 브로. 그것은 완벽함 그 잡체야🤩 이정도면 지구상 있는 모든 쓰레기를 하나하나 따로 힘들게 노동을 하면서 버리지 않아도 많은 쓰레기를 버려서 지구 온난화를 늦출수있겠어🤩🤩🤩 와 진짜, 브로는 천재야 어떻게 로봇을 만들어서 모든 지구상에 로봇을 전국으로 보내서 사람의 몸을 지킬생각을 한거지? 브로는 그냥 그 상태로 연구해서 돈벌면 지구정복은쉽지😎","author":"김민재","createdAt":"2026-11-17T00:09:00.065Z","viewerToken":"vt_1794796308439_8yzbw3eg","authorStudentId":"김민재"},{"v":2,"id":"c_1794874317503_1ifar","text":"와 이것은 매우매우매우매우매우매우매우 엄청난","author":"이원준","createdAt":"2026-11-17T00:11:57.503Z","viewerToken":"vt_1794873057588_6rghf8uo","authorStudentId":"이원준"},{"v":2,"id":"c_1794874470322_p0t4d","text":"우와 정말 진짜울트라래전드임피니티다이아골드럭키레어잘했다. 👍 진짜혁명이야 브로 쓰레기처리 동시에 충전까지 일석이쥬 짝짝짜파게티🍌🍌🍌🍌🍌🍌🍌🍌🍌🍌🍌🍌🍌🍌🍌🍌🍌🍌🍌🍌🍌🦾🦿🦾🦿🦾🦿🦾🦿🦾🦿🦾🦾🦿🦾🦿🦾","author":"신연호","createdAt":"2026-11-17T00:14:30.322Z","viewerToken":"vt_1794788851253_3o74q6xc","authorStudentId":"신연호"},{"v":2,"id":"c_1794874476430_yqmlx","text":"이런게 생기면 엄청 조을거같고 아이디어가 정말 좋네","author":"진예원","createdAt":"2026-11-17T00:14:36.430Z","viewerToken":"vt_1794796813857_o43fsiny","authorStudentId":"진예원"}],"deletedCommentIds":["c_1794797924656_63hjd"]},"videoPrompt":"[AI 영상 제작] 마트에서 바나나(살짝썩어가고 있는 갈색 바나나 )가 바닥에 떨어져있는 상황에서 로봇이 그 바나나를 먹으려는 상황,롭의 외형은 모서리가 둥근 살짝 이등변삼각형에서 정삼각형 그 사이의 모양인데 그 꼭대기 정도에 얼굴이 있고 (얼굴은 삼각형 안에)배 쪽에음식물을 건조 시키는 기계가 배의 아랫쪽에는 그건조된 음식물을 에너지화 시키는 기계도 포함이루어진, 그리고 다리는 없고 발바닥 쪽에는 평소에는 아무것도 없다가 어디를 빨리가야하는 일이 생기면 바퀴가 생겨 빠르게 갈수도 있다, 얼굴있는 입에는 음식물을 넣어야 하기 때문에 입을 벌릴수도 있다 외형을 갖춘 로봇 '에코드라이브 파워봇'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 상하고 있는 음식물을 알수있는 데이터 센서 의해 바퀴를 이용해 달려가 관절이 있는 손으로 음식물을 입으로 넣은 다음에 음식이 건조되어 불 태워 지고 에너지가 만들어져 로봇이 충전되며 울굴에 충전된다는 번개 표시가 뜨는걸  클로즈업 하는 장면에 이어, 로봇이 어떤 창고에서 어떤걸 언제 샀는지 유통기한은 언제까지인지 정확한 데이터를 전부 저장해 버릴 음식이 생길때마다 가서 음하며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상.","specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"식량이 매우 부족해 아사하는 사람이 많아지고 매 끼니 굶는 사람이 많아지고 있는 상황을 해결하기 위해"},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#자원순환#지속가능한 #미래#낭비하지 #않는 #마음"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"상한 음식과 아닌음식을 정확히 구분하고 상한음식이 일정무게가 쌓이면 자동건조시키고,에너지화 시킨다.생산된 에너지 중에 일부는 로봇 충전을 위해 사용하고 나머지 에너지는 필요하곳에 공급한다."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"입으로 버리는 음식물을 삼키면 그 음식물이 배 쪽으로 가 어느정도 음식물이 쌓이면 자동으로 건조가 되면 그다음 단계인 그 배쪽보다 더 밑인 아랫배 쪽으로 내려가게 되는데 아랫배에서는 그 건조된 음식물을 태워 나온 열에너지를 전기에너지로 바꾸어  필요한곳에 사용된다.그리고 태우면서 나오는 이산화탄소는 유해물질을 줄이도록 설계되어있다."},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"상하고 있는 음식물을 알수있는 데이터 센서","sensorAction":"어떤 창고에서 어떤걸 언제 샀는지 유통기한은 언제까지인지 정확한 데이터를 전부 저장해 버릴 음식이 생길때마다 가서 음식을 급속 건조 시킨다.","sensorTarget":"버려야하는 음식을 감지한다."},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"에코드라이브 파워봇","appearance":"모서리가 둥근 살짝 이등변삼각형에서 정삼각형 그 사이의 모양인데 그 꼭대기 정도에 얼굴이 있고 배 쪽에음식물을 건조 시키는 기계가 배의 아랫쪽에는 그건조된 음식물을 에너지화 시키는 기계도 포함되어있다.그리고 다리는 없고 발바닥 쪽에는 평소에는 아무것도 없다가 어디를 빨리가야하는 일이 생기면 바퀴가 생겨 빠르게 갈수도 있다. 얼굴있는 입에는 음식물을 넣어야 하기 때문에 입을 벌릴수도 있다.몸에는 상한음식을 아주미세한냄새로도 음식이 상했는지 아닌지를 알수있는 센서도 달려있어 아직 먹을수 있거나 상하기 직전인 음식까지 섬세하게 구분할수있어 상하기 직전인 음식은 평소에는 머리안에 들어있는 드론을 꺼내 음식이 빠르게 필요한 단체나 마을게 보낼수도있다."}},"teacherFeedback":"","feedbackAt":"","video":{"type":"none","url":"","title":"","thumbnail":""},"likes":14,"currentVersion":4,"history":[{"label":"버전 3 (2차 수정)","inputs":{"purpose":"식량이 매우 부족해 아사하는 사람이 많아지고 매 끼니 굶는 사람이 많아지고 있는 상황을 해결하기 위해","robotName":"에코드라이브 파워봇","aiFeedback":{"date":"2026-11-16","count":1,"step1":"삼각형 모양의 독특한 외형과 드론이 들어있는 아이디어가 정말 멋져요! 로봇의 몸체에 가볍고 튼튼한 '신소재 탄소섬유'를 사용한다는 점이나, 바퀴가 쏙 들어가는 '자유로운 관절 구조'를 함께 적어주면 훨씬 더 완벽해져요.","step2":"식량 부족 문제를 해결하려는 따뜻한 마음이 아주 잘 느껴지는 훌륭한 목적이에요! 여기에 '지속 가능한 친환경 사회'를 만든다는 목표를 더하고, 버려지는 음식물 쓰레기를 줄여 지구 온난화를 막는 환경 과학적 의미까지 추가해 볼까요?","step3":"음식물을 건조하고 전기에너지로 바꾸는 과정이 아주 구체적이어서 흥미로워요! 이 과정에서 열에너지를 전기에너지로 바꾸는 '열전 발달 원리'나 이산화탄소를 깨끗하게 걸러내는 '필터 기계 장치'를 설명에 더 자세히 적어보세요.","step4":"상한 음식을 구별하는 센서 아이디어가 참 기발해요! 센서의 이름을 '화학 물질 냄새를 맡는 가스 센서'나 '미세한 냄새 입자를 찾는 전자 코 센서'처럼 더 과학적인 이름으로 바꾸고, 드론을 출동시키는 행동을 3단계로 딱 맞춰 적어보면 더욱 좋아요.","step5":"음식물을 에너지로 바꾸고 재사용하는 훌륭한 융합 기술을 잘 찾아주었어요! 여기에 화학 에너지를 전기 에너지로 바꾸는 '화학 반응 원리'와 에너지를 효율적으로 저장하는 '고효율 배터리 기술'을 함께 적어주면 과학 박사님처럼 멋진 글이 될 거예요!","updatedAt":"2026-11-16T00:21:13.817Z"},"appearance":"모서리가 둥근 살짝 이등변삼각형에서 정삼각형 그 사이의 모양인데 그 꼭대기 정도에 얼굴이 있고 배 쪽에음식물을 건조 시키는 기계가 배의 아랫쪽에는 그건조된 음식물을 에너지화 시키는 기계도 포함되어있다.그리고 다리는 없고 발바닥 쪽에는 평소에는 아무것도 없다가 어디를 빨리가야하는 일이 생기면 바퀴가 생겨 빠르게 갈수도 있다. 얼굴있는 입에는 음식물을 넣어야 하기 때문에 입을 벌릴수도 있다.몸에는 상한음식을 아주미세한냄새로도 음식이 상했는지 아닌지를 알수있는 센서도 달려있어 아직 먹을수 있거나 상하기 직전인 음식까지 섬세하게 구분할수있어 상하기 직전인 음식은 평소에는 머리안에 들어있는 드론을 꺼내 음식이 빠르게 필요한 단체나 마을게 보낼수도있다.","coreValues":"#자원순환#지속가능한 #미래#낭비하지 #않는 #마음","sensorName":"상하고 있는 음식물을 알수있는 데이터 센서","videoStyle":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)","scienceTech":"상한 음식과 아닌음식을 정확히 구분하고 상한음식이 일정무게가 쌓이면 자동건조시키고,에너지화 시킨다.생산된 에너지 중에 일부는 로봇 충전을 위해 사용하고 나머지 에너지는 필요하곳에 공급한다.","mainFunction":"입으로 버리는 음식물을 삼키면 그 음식물이 배 쪽으로 가 어느정도 음식물이 쌓이면 자동으로 건조가 되면 그다음 단계인 그 배쪽보다 더 밑인 아랫배 쪽으로 내려가게 되는데 아랫배에서는 그 건조된 음식물을 태워 나온 열에너지를 전기에너지로 바꾸어  필요한곳에 사용된다.그리고 태우면서 나오는 이산화탄소는 유해물질을 줄이도록 설계되어있다.","sensorAction":"어떤 창고에서 어떤걸 언제 샀는지 유통기한은 언제까지인지 정확한 데이터를 전부 저장해 버릴 음식이 생길때마다 가서 음식을 급속 건조 시킨다.","sensorTarget":"버려야하는 음식을 감지한다.","boothComments":[],"customVideoPrompt":"[AI 영상 제작] 마트에서 바나나가 바닥에 떨어져있는 상황에서 로봇이 그 바나나를 먹으려는 상황,롭의 외형은 모서리가 둥근 살짝 이등변삼각형에서 정삼각형 그 사이의 모양인데 그 꼭대기 정도에 얼굴이 있고 (얼굴은 삼각형 안에)배 쪽에음식물을 건조 시키는 기계가 배의 아랫쪽에는 그건조된 음식물을 에너지화 시키는 기계도 포함이루어진, 그리고 다리는 없고 발바닥 쪽에는 평소에는 아무것도 없다가 어디를 빨리가야하는 일이 생기면 바퀴가 생겨 빠르게 갈수도 있다, 얼굴있는 입에는 음식물을 넣어야 하기 때문에 입을 벌릴수도 있다 외형을 갖춘 로봇 '에코드라이브 파워봇'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 상하고 있는 음식물을 알수있는 데이터 센서 의해 바퀴를 이용해 달려가 관절이 있는 손으로 음식물을 입으로 넣은 다음에 음식이 건조되어 불 태워 지고 에너지가 만들어져 로봇이 충전되며 울굴에 충전된다는 번개 표시가 뜨는걸  클로즈업 하는 장면에 이어, 로봇이 어떤 창고에서 어떤걸 언제 샀는지 유통기한은 언제까지인지 정확한 데이터를 전부 저장해 버릴 음식이 생길때마다 가서 음하며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상.","deletedCommentIds":[]},"version":3,"specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"식량이 매우 부족해 아사하는 사람이 많아지고 매 끼니 굶는 사람이 많아지고 있는 상황을 해결하기 위해"},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#자원순환#지속가능한 #미래#낭비하지 #않는 #마음"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"상한 음식과 아닌음식을 정확히 구분하고 상한음식이 일정무게가 쌓이면 자동건조시키고,에너지화 시킨다.생산된 에너지 중에 일부는 로봇 충전을 위해 사용하고 나머지 에너지는 필요하곳에 공급한다."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"입으로 버리는 음식물을 삼키면 그 음식물이 배 쪽으로 가 어느정도 음식물이 쌓이면 자동으로 건조가 되면 그다음 단계인 그 배쪽보다 더 밑인 아랫배 쪽으로 내려가게 되는데 아랫배에서는 그 건조된 음식물을 태워 나온 열에너지를 전기에너지로 바꾸어  필요한곳에 사용된다.그리고 태우면서 나오는 이산화탄소는 유해물질을 줄이도록 설계되어있다."},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"상하고 있는 음식물을 알수있는 데이터 센서","sensorAction":"어떤 창고에서 어떤걸 언제 샀는지 유통기한은 언제까지인지 정확한 데이터를 전부 저장해 버릴 음식이 생길때마다 가서 음식을 급속 건조 시킨다.","sensorTarget":"버려야하는 음식을 감지한다."},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"에코드라이브 파워봇","appearance":"모서리가 둥근 살짝 이등변삼각형에서 정삼각형 그 사이의 모양인데 그 꼭대기 정도에 얼굴이 있고 배 쪽에음식물을 건조 시키는 기계가 배의 아랫쪽에는 그건조된 음식물을 에너지화 시키는 기계도 포함되어있다.그리고 다리는 없고 발바닥 쪽에는 평소에는 아무것도 없다가 어디를 빨리가야하는 일이 생기면 바퀴가 생겨 빠르게 갈수도 있다. 얼굴있는 입에는 음식물을 넣어야 하기 때문에 입을 벌릴수도 있다.몸에는 상한음식을 아주미세한냄새로도 음식이 상했는지 아닌지를 알수있는 센서도 달려있어 아직 먹을수 있거나 상하기 직전인 음식까지 섬세하게 구분할수있어 상하기 직전인 음식은 평소에는 머리안에 들어있는 드론을 꺼내 음식이 빠르게 필요한 단체나 마을게 보낼수도있다."}},"submittedAt":"2026-11-16T02:30:03.286Z","videoPrompt":"[AI 영상 제작] 마트에서 바나나가 바닥에 떨어져있는 상황에서 로봇이 그 바나나를 먹으려는 상황,롭의 외형은 모서리가 둥근 살짝 이등변삼각형에서 정삼각형 그 사이의 모양인데 그 꼭대기 정도에 얼굴이 있고 (얼굴은 삼각형 안에)배 쪽에음식물을 건조 시키는 기계가 배의 아랫쪽에는 그건조된 음식물을 에너지화 시키는 기계도 포함이루어진, 그리고 다리는 없고 발바닥 쪽에는 평소에는 아무것도 없다가 어디를 빨리가야하는 일이 생기면 바퀴가 생겨 빠르게 갈수도 있다, 얼굴있는 입에는 음식물을 넣어야 하기 때문에 입을 벌릴수도 있다 외형을 갖춘 로봇 '에코드라이브 파워봇'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 상하고 있는 음식물을 알수있는 데이터 센서 의해 바퀴를 이용해 달려가 관절이 있는 손으로 음식물을 입으로 넣은 다음에 음식이 건조되어 불 태워 지고 에너지가 만들어져 로봇이 충전되며 울굴에 충전된다는 번개 표시가 뜨는걸  클로즈업 하는 장면에 이어, 로봇이 어떤 창고에서 어떤걸 언제 샀는지 유통기한은 언제까지인지 정확한 데이터를 전부 저장해 버릴 음식이 생길때마다 가서 음하며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상.","teacherFeedbackBefore":""},{"label":"버전 4 (3차 수정)","inputs":{"purpose":"식량이 매우 부족해 아사하는 사람이 많아지고 매 끼니 굶는 사람이 많아지고 있는 상황을 해결하기 위해","robotName":"에코드라이브 파워봇","aiFeedback":{"date":"2026-11-16","count":1,"step1":"삼각형 모양의 독특한 외형과 드론이 들어있는 아이디어가 정말 멋져요! 로봇의 몸체에 가볍고 튼튼한 '신소재 탄소섬유'를 사용한다는 점이나, 바퀴가 쏙 들어가는 '자유로운 관절 구조'를 함께 적어주면 훨씬 더 완벽해져요.","step2":"식량 부족 문제를 해결하려는 따뜻한 마음이 아주 잘 느껴지는 훌륭한 목적이에요! 여기에 '지속 가능한 친환경 사회'를 만든다는 목표를 더하고, 버려지는 음식물 쓰레기를 줄여 지구 온난화를 막는 환경 과학적 의미까지 추가해 볼까요?","step3":"음식물을 건조하고 전기에너지로 바꾸는 과정이 아주 구체적이어서 흥미로워요! 이 과정에서 열에너지를 전기에너지로 바꾸는 '열전 발달 원리'나 이산화탄소를 깨끗하게 걸러내는 '필터 기계 장치'를 설명에 더 자세히 적어보세요.","step4":"상한 음식을 구별하는 센서 아이디어가 참 기발해요! 센서의 이름을 '화학 물질 냄새를 맡는 가스 센서'나 '미세한 냄새 입자를 찾는 전자 코 센서'처럼 더 과학적인 이름으로 바꾸고, 드론을 출동시키는 행동을 3단계로 딱 맞춰 적어보면 더욱 좋아요.","step5":"음식물을 에너지로 바꾸고 재사용하는 훌륭한 융합 기술을 잘 찾아주었어요! 여기에 화학 에너지를 전기 에너지로 바꾸는 '화학 반응 원리'와 에너지를 효율적으로 저장하는 '고효율 배터리 기술'을 함께 적어주면 과학 박사님처럼 멋진 글이 될 거예요!","updatedAt":"2026-11-16T00:21:13.817Z"},"appearance":"모서리가 둥근 살짝 이등변삼각형에서 정삼각형 그 사이의 모양인데 그 꼭대기 정도에 얼굴이 있고 배 쪽에음식물을 건조 시키는 기계가 배의 아랫쪽에는 그건조된 음식물을 에너지화 시키는 기계도 포함되어있다.그리고 다리는 없고 발바닥 쪽에는 평소에는 아무것도 없다가 어디를 빨리가야하는 일이 생기면 바퀴가 생겨 빠르게 갈수도 있다. 얼굴있는 입에는 음식물을 넣어야 하기 때문에 입을 벌릴수도 있다.몸에는 상한음식을 아주미세한냄새로도 음식이 상했는지 아닌지를 알수있는 센서도 달려있어 아직 먹을수 있거나 상하기 직전인 음식까지 섬세하게 구분할수있어 상하기 직전인 음식은 평소에는 머리안에 들어있는 드론을 꺼내 음식이 빠르게 필요한 단체나 마을게 보낼수도있다.","coreValues":"#자원순환#지속가능한 #미래#낭비하지 #않는 #마음","sensorName":"상하고 있는 음식물을 알수있는 데이터 센서","videoStyle":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)","scienceTech":"상한 음식과 아닌음식을 정확히 구분하고 상한음식이 일정무게가 쌓이면 자동건조시키고,에너지화 시킨다.생산된 에너지 중에 일부는 로봇 충전을 위해 사용하고 나머지 에너지는 필요하곳에 공급한다.","mainFunction":"입으로 버리는 음식물을 삼키면 그 음식물이 배 쪽으로 가 어느정도 음식물이 쌓이면 자동으로 건조가 되면 그다음 단계인 그 배쪽보다 더 밑인 아랫배 쪽으로 내려가게 되는데 아랫배에서는 그 건조된 음식물을 태워 나온 열에너지를 전기에너지로 바꾸어  필요한곳에 사용된다.그리고 태우면서 나오는 이산화탄소는 유해물질을 줄이도록 설계되어있다.","sensorAction":"어떤 창고에서 어떤걸 언제 샀는지 유통기한은 언제까지인지 정확한 데이터를 전부 저장해 버릴 음식이 생길때마다 가서 음식을 급속 건조 시킨다.","sensorTarget":"버려야하는 음식을 감지한다.","boothComments":[],"customVideoPrompt":"[AI 영상 제작] 마트에서 바나나(살짝썩어가고 있는 갈색 바나나 )가 바닥에 떨어져있는 상황에서 로봇이 그 바나나를 먹으려는 상황,롭의 외형은 모서리가 둥근 살짝 이등변삼각형에서 정삼각형 그 사이의 모양인데 그 꼭대기 정도에 얼굴이 있고 (얼굴은 삼각형 안에)배 쪽에음식물을 건조 시키는 기계가 배의 아랫쪽에는 그건조된 음식물을 에너지화 시키는 기계도 포함이루어진, 그리고 다리는 없고 발바닥 쪽에는 평소에는 아무것도 없다가 어디를 빨리가야하는 일이 생기면 바퀴가 생겨 빠르게 갈수도 있다, 얼굴있는 입에는 음식물을 넣어야 하기 때문에 입을 벌릴수도 있다 외형을 갖춘 로봇 '에코드라이브 파워봇'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 상하고 있는 음식물을 알수있는 데이터 센서 의해 바퀴를 이용해 달려가 관절이 있는 손으로 음식물을 입으로 넣은 다음에 음식이 건조되어 불 태워 지고 에너지가 만들어져 로봇이 충전되며 울굴에 충전된다는 번개 표시가 뜨는걸  클로즈업 하는 장면에 이어, 로봇이 어떤 창고에서 어떤걸 언제 샀는지 유통기한은 언제까지인지 정확한 데이터를 전부 저장해 버릴 음식이 생길때마다 가서 음하며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상.","deletedCommentIds":[]},"version":4,"specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"식량이 매우 부족해 아사하는 사람이 많아지고 매 끼니 굶는 사람이 많아지고 있는 상황을 해결하기 위해"},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#자원순환#지속가능한 #미래#낭비하지 #않는 #마음"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"상한 음식과 아닌음식을 정확히 구분하고 상한음식이 일정무게가 쌓이면 자동건조시키고,에너지화 시킨다.생산된 에너지 중에 일부는 로봇 충전을 위해 사용하고 나머지 에너지는 필요하곳에 공급한다."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"입으로 버리는 음식물을 삼키면 그 음식물이 배 쪽으로 가 어느정도 음식물이 쌓이면 자동으로 건조가 되면 그다음 단계인 그 배쪽보다 더 밑인 아랫배 쪽으로 내려가게 되는데 아랫배에서는 그 건조된 음식물을 태워 나온 열에너지를 전기에너지로 바꾸어  필요한곳에 사용된다.그리고 태우면서 나오는 이산화탄소는 유해물질을 줄이도록 설계되어있다."},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"상하고 있는 음식물을 알수있는 데이터 센서","sensorAction":"어떤 창고에서 어떤걸 언제 샀는지 유통기한은 언제까지인지 정확한 데이터를 전부 저장해 버릴 음식이 생길때마다 가서 음식을 급속 건조 시킨다.","sensorTarget":"버려야하는 음식을 감지한다."},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"에코드라이브 파워봇","appearance":"모서리가 둥근 살짝 이등변삼각형에서 정삼각형 그 사이의 모양인데 그 꼭대기 정도에 얼굴이 있고 배 쪽에음식물을 건조 시키는 기계가 배의 아랫쪽에는 그건조된 음식물을 에너지화 시키는 기계도 포함되어있다.그리고 다리는 없고 발바닥 쪽에는 평소에는 아무것도 없다가 어디를 빨리가야하는 일이 생기면 바퀴가 생겨 빠르게 갈수도 있다. 얼굴있는 입에는 음식물을 넣어야 하기 때문에 입을 벌릴수도 있다.몸에는 상한음식을 아주미세한냄새로도 음식이 상했는지 아닌지를 알수있는 센서도 달려있어 아직 먹을수 있거나 상하기 직전인 음식까지 섬세하게 구분할수있어 상하기 직전인 음식은 평소에는 머리안에 들어있는 드론을 꺼내 음식이 빠르게 필요한 단체나 마을게 보낼수도있다."}},"submittedAt":"2026-11-16T02:33:07.369Z","videoPrompt":"[AI 영상 제작] 마트에서 바나나(살짝썩어가고 있는 갈색 바나나 )가 바닥에 떨어져있는 상황에서 로봇이 그 바나나를 먹으려는 상황,롭의 외형은 모서리가 둥근 살짝 이등변삼각형에서 정삼각형 그 사이의 모양인데 그 꼭대기 정도에 얼굴이 있고 (얼굴은 삼각형 안에)배 쪽에음식물을 건조 시키는 기계가 배의 아랫쪽에는 그건조된 음식물을 에너지화 시키는 기계도 포함이루어진, 그리고 다리는 없고 발바닥 쪽에는 평소에는 아무것도 없다가 어디를 빨리가야하는 일이 생기면 바퀴가 생겨 빠르게 갈수도 있다, 얼굴있는 입에는 음식물을 넣어야 하기 때문에 입을 벌릴수도 있다 외형을 갖춘 로봇 '에코드라이브 파워봇'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 상하고 있는 음식물을 알수있는 데이터 센서 의해 바퀴를 이용해 달려가 관절이 있는 손으로 음식물을 입으로 넣은 다음에 음식이 건조되어 불 태워 지고 에너지가 만들어져 로봇이 충전되며 울굴에 충전된다는 번개 표시가 뜨는걸  클로즈업 하는 장면에 이어, 로봇이 어떤 창고에서 어떤걸 언제 샀는지 유통기한은 언제까지인지 정확한 데이터를 전부 저장해 버릴 음식이 생길때마다 가서 음하며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상.","teacherFeedbackBefore":""}],"updatedAt":"2026-11-17T00:14:36.430Z"},{"studentId":"김규혁","studentName":"김규혁","status":"approved","inputs":{"robotName":"유니버스 X-50","appearance":"친근한 둥근 유선형 몸체에 집게와 우주에서 움직일수 있도록 조그만한 노즐을 결합시킨뒤 우주에서도 잘보이라고 밝은 색으로 만들어졌다.","purpose":"지구와 우주를 왔다갔다 하면서 쓰레기를 수거해 우주쓰레기 정거장에 쓰레기를 버려 지구 생태계를 복원한다","mainFunction":"우주로 쓰레기를 보낼때 오작동으로 쓰레기가 우주선 밖으로 튀어나올때 유니버스 X-50 로봇을 내보내 쓰레기를 주워오게 한다","sensorName":"쓰레기 감지 센서, 라이더 센서","sensorTarget":"쓰레기 감지 센서와 쓰레기의 거리를 정확히 재는 기술을 로봇에 부착해 100m 이상 떨어질시 우주선을 멈추고 로봇이 쓰레기를 가지러 감","sensorAction":"로봇이 청소기 처럼 주운 쓰레기를 몸안에 보관해(최대 200kg) 우주선으로 들어온뒤 몸 안에 있는 쓰레기를 전용 기계를 사용해 쓰레기 저장소로 보낸다.","scienceTech":"사물인식 기술로 쓰레기와 소행성을 구별하고 우주선 안에 로봇 전용 충전기를 설치해 로봇이 방전되지 않도록 한다. 또한  로봇에 태양광 패널을 설치한다.","coreValues":"#우주쓰레기 #정거장","videoStyle":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)","customVideoPrompt":"[AI 영상 제작] 푸른 지구와 별빛이 빛나는 2050년 우주 정거장 궤도 공간에서, 흰색으로 만들어졌다 외형을 갖춘 로봇 '유니버스 X-50'이 화면 중앙에 등장해 부드럽게 움직이는 영상. 장착된 쓰레기 감지 센서, 라이더 센서는 단정하게 동그란 코어에서 푸른 스캔 라이트가 켜지며 쓰레기 감지 센서로 쓰레기를 스캔해 우주에 떠다니는 쓰레기를 단순한 로봇의 집게팔로 정교하게 뻗어 목표물을 집어 올리고 3D 입체 홀로그램 주머니를 꺼내 수거한 쓰레기를 조금도 빠짐없이 담은 뒤 초록색 3d 홀로그램으로 Missoni complate라는 문구을 생생하게 보여준다. 또한 코어에서 나오는 푸른 스캔 라이트가 꺼지는 것을 연출한 고화질 3D 애니메이션 스타일 동영상.","aiFeedback":{"date":"2026-11-16","count":2,"step1":"우리 규혁 친구, 둥근 유선형 몸체와 노즐 설명이 아주 멋져요! 몸체가 우주 공간에서 버틸 수 있도록 가볍고 튼튼한 '탄소섬유 같은 신소재'를 썼다고 적어주면 더 완벽해질 거예요.","step2":"지구와 우주를 오가며 쓰레기를 치우는 목적이 정말 훌륭해요! 이 로봇이 우주 환경을 지키는 '친환경 우주 청소부'라는 점을 강조하면 목적이 더욱 감동적으로 다가올 거예요.","step3":"쓰레기를 주워오는 모습이 눈에 그려져요! 로봇의 팔이 물건을 꽉 잡을 수 있는 '와이어 관절 구조'나 유연하게 움직이는 '모터 장치'를 설명에 추가해 보면 어떨까요?","step4":"센서와 행동을 아주 꼼꼼하게 잘 적어주었어요! 여기에 우주 먼지나 장애물을 피할 수 있는 '초음파 센서'나 '적외선 센서'를 하나 더 추가하면 로봇이 훨씬 똑똑해질 거예요.","step5":"태양광 패널과 사물인식 기술을 잘 찾아주었네요! 우주에서 전기를 아껴 쓰기 위해 '무선 충전 기술'이나 에너지를 효율적으로 모으는 과학 원리를 더 적어주면 정말 멋진 융합 기술이 될 거예요.","updatedAt":"2026-11-16T02:14:23.908Z"},"boothComments":[{"v":2,"id":"c_1794873091164_rodha","text":"😀😀😀😀어메이징!😀😀😀👍","author":"이석준","createdAt":"2026-11-16T23:51:31.165Z","viewerToken":"vt_1794799215240_tjkhcvj5","authorStudentId":"이석준"},{"v":2,"id":"c_1794873106080_jbpo7","text":"로봇이 우주쓰레기를 버리는 아이디어가 좋아!","author":"장서윤","createdAt":"2026-11-16T23:51:46.082Z","viewerToken":"vt_1794796665307_ra6syqil","authorStudentId":"장서윤"},{"v":2,"id":"c_1794873689056_ti2sl","text":"와ㅏㅏ우주가 깨끗해지겠어 너무 멋지다","author":"이원준","createdAt":"2026-11-17T00:01:29.056Z","viewerToken":"vt_1794873057588_6rghf8uo","authorStudentId":"이원준"},{"v":2,"id":"c_1794873778046_n5l1t","text":"와 브로. 그것은 완벽함 그 잡체야🤩 이정도면 우주에 있는 모든 쓰레기와 지구상에 있는 모든 쓰레기를 하나하나 따로 힘들게 노동을 하면서 버리지 않아도 많은 쓰레기를 버려서 지구 온난화를 늦출수있겠어🤩🤩🤩 와 진짜, 브로는 천재야 어떻게 로봇을 우주에 날려보내서 우주까지 지킬 생각을 한거지? 브로는 그냥 그 상태로 조금만 연구하면 화성은 거뜬하겠는걸","author":"김민재","createdAt":"2026-11-17T00:02:58.046Z","viewerToken":"vt_1794796308439_8yzbw3eg","authorStudentId":"김민재"},{"v":2,"id":"c_1794874494197_3smar","text":"와 브로. 그것은 완벽함 그 잡체야🤩 이정도면 우주에 있는 모든 쓰레기와 지구상에 있는 모든 쓰레기를 하나하나 따로그살ㄹㄹ로 힘들게 노동을 하면서 버리지 않아도 많은 쓰레기를 버려서 지구 온난화를 늦출수있겠어🤩🤩🤩 와 진짜, 브로는 천재야 어떻게 로봇을 우주에 날려보내서 우주까지 지킬 생각을 한거지? 브로는 그냥 그 상태","author":"김승윤","createdAt":"2026-11-17T00:14:54.197Z","viewerToken":"vt_1794796086113_pfa1lkx5","authorStudentId":"김승윤"}],"deletedCommentIds":["c_1794873559073_ynueh","c_1794874290785_g2532"]},"videoPrompt":"[AI 영상 제작] 푸른 지구와 별빛이 빛나는 2050년 우주 정거장 궤도 공간에서, 흰색으로 만들어졌다 외형을 갖춘 로봇 '유니버스 X-50'이 화면 중앙에 등장해 부드럽게 움직이는 영상. 장착된 쓰레기 감지 센서, 라이더 센서는 단정하게 동그란 코어에서 푸른 스캔 라이트가 켜지며 쓰레기 감지 센서로 쓰레기를 스캔해 우주에 떠다니는 쓰레기를 단순한 로봇의 집게팔로 정교하게 뻗어 목표물을 집어 올리고 3D 입체 홀로그램 주머니를 꺼내 수거한 쓰레기를 조금도 빠짐없이 담은 뒤 초록색 3d 홀로그램으로 Missoni complate라는 문구을 생생하게 보여준다. 또한 코어에서 나오는 푸른 스캔 라이트가 꺼지는 것을 연출한 고화질 3D 애니메이션 스타일 동영상.","specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"지구와 우주를 왔다갔다 하면서 쓰레기를 수거해 우주쓰레기 정거장에 쓰레기를 버려 지구 생태계를 복원한다"},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#우주쓰레기 #정거장"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"사물인식 기술로 쓰레기와 소행성을 구별하고 우주선 안에 로봇 전용 충전기를 설치해 로봇이 방전되지 않도록 한다. 또한  로봇에 태양광 패널을 설치한다."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"우주로 쓰레기를 보낼때 오작동으로 쓰레기가 우주선 밖으로 튀어나올때 유니버스 X-50 로봇을 내보내 쓰레기를 주워오게 한다"},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"쓰레기 감지 센서, 라이더 센서","sensorAction":"로봇이 청소기 처럼 주운 쓰레기를 몸안에 보관해(최대 200kg) 우주선으로 들어온뒤 몸 안에 있는 쓰레기를 전용 기계를 사용해 쓰레기 저장소로 보낸다.","sensorTarget":"쓰레기 감지 센서와 쓰레기의 거리를 정확히 재는 기술을 로봇에 부착해 100m 이상 떨어질시 우주선을 멈추고 로봇이 쓰레기를 가지러 감"},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"유니버스 X-50","appearance":"친근한 둥근 유선형 몸체에 집게와 우주에서 움직일수 있도록 조그만한 노즐을 결합시킨뒤 우주에서도 잘보이라고 밝은 색으로 만들어졌다."}},"teacherFeedback":"","feedbackAt":"","video":{"type":"none","url":"","title":"","thumbnail":""},"likes":5,"currentVersion":2,"history":[{"label":"버전 1 (최초 제출)","inputs":{"purpose":"지구와 우주를 왔다갔다 하면서 쓰레기를 수거해 우주쓰레기 정거장에 쓰레기를 버려 지구 생태계를 복원한다","robotName":"유니버스 X-50","aiFeedback":{"date":"2026-11-16","count":2,"step1":"우리 규혁 친구, 둥근 유선형 몸체와 노즐 설명이 아주 멋져요! 몸체가 우주 공간에서 버틸 수 있도록 가볍고 튼튼한 '탄소섬유 같은 신소재'를 썼다고 적어주면 더 완벽해질 거예요.","step2":"지구와 우주를 오가며 쓰레기를 치우는 목적이 정말 훌륭해요! 이 로봇이 우주 환경을 지키는 '친환경 우주 청소부'라는 점을 강조하면 목적이 더욱 감동적으로 다가올 거예요.","step3":"쓰레기를 주워오는 모습이 눈에 그려져요! 로봇의 팔이 물건을 꽉 잡을 수 있는 '와이어 관절 구조'나 유연하게 움직이는 '모터 장치'를 설명에 추가해 보면 어떨까요?","step4":"센서와 행동을 아주 꼼꼼하게 잘 적어주었어요! 여기에 우주 먼지나 장애물을 피할 수 있는 '초음파 센서'나 '적외선 센서'를 하나 더 추가하면 로봇이 훨씬 똑똑해질 거예요.","step5":"태양광 패널과 사물인식 기술을 잘 찾아주었네요! 우주에서 전기를 아껴 쓰기 위해 '무선 충전 기술'이나 에너지를 효율적으로 모으는 과학 원리를 더 적어주면 정말 멋진 융합 기술이 될 거예요.","updatedAt":"2026-11-16T02:14:23.908Z"},"appearance":"친근한 둥근 유선형 몸체에 집게와 우주에서 움직일수 있도록 조그만한 노즐을 결합시킨뒤 우주에서도 잘보이라고 밝은 색으로 만들어졌다.","coreValues":"#우주쓰레기 #정거장","sensorName":"쓰레기 감지 센서, 라이더 센서","videoStyle":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)","scienceTech":"사물인식 기술로 쓰레기와 소행성을 구별하고 우주선 안에 로봇 전용 충전기를 설치해 로봇이 방전되지 않도록 한다. 또한  로봇에 태양광 패널을 설치한다.","mainFunction":"우주로 쓰레기를 보낼때 오작동으로 쓰레기가 우주선 밖으로 튀어나올때 유니버스 X-50 로봇을 내보내 쓰레기를 주워오게 한다","sensorAction":"로봇이 청소기 처럼 주운 쓰레기를 몸안에 보관해(최대 200kg) 우주선으로 들어온뒤 몸 안에 있는 쓰레기를 전용 기계를 사용해 쓰레기 저장소로 보낸다.","sensorTarget":"쓰레기 감지 센서와 쓰레기의 거리를 정확히 재는 기술을 로봇에 부착해 100m 이상 떨어질시 우주선을 멈추고 로봇이 쓰레기를 가지러 감","boothComments":[],"customVideoPrompt":"","deletedCommentIds":[]},"version":1,"specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"지구와 우주를 왔다갔다 하면서 쓰레기를 수거해 우주쓰레기 정거장에 쓰레기를 버려 지구 생태계를 복원한다"},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#우주쓰레기 #정거장"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"사물인식 기술로 쓰레기와 소행성을 구별하고 우주선 안에 로봇 전용 충전기를 설치해 로봇이 방전되지 않도록 한다. 또한  로봇에 태양광 패널을 설치한다."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"우주로 쓰레기를 보낼때 오작동으로 쓰레기가 우주선 밖으로 튀어나올때 유니버스 X-50 로봇을 내보내 쓰레기를 주워오게 한다"},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"쓰레기 감지 센서, 라이더 센서","sensorAction":"로봇이 청소기 처럼 주운 쓰레기를 몸안에 보관해(최대 200kg) 우주선으로 들어온뒤 몸 안에 있는 쓰레기를 전용 기계를 사용해 쓰레기 저장소로 보낸다.","sensorTarget":"쓰레기 감지 센서와 쓰레기의 거리를 정확히 재는 기술을 로봇에 부착해 100m 이상 떨어질시 우주선을 멈추고 로봇이 쓰레기를 가지러 감"},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"유니버스 X-50","appearance":"친근한 둥근 유선형 몸체에 집게와 우주에서 움직일수 있도록 조그만한 노즐을 결합시킨뒤 우주에서도 잘보이라고 밝은 색으로 만들어졌다."}},"submittedAt":"2026-11-16T02:15:55.690Z","videoPrompt":"[AI 영상 제작] 푸른 지구와 별빛이 빛나는 2050년 우주 정거장 궤도 공간에서, 밝은 색으로 만들어졌다 외형을 갖춘 로봇 '유니버스 X-50'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 쓰레기 감지 센서, 라이더 센서에 푸른 스캔 라이트가 켜지며(쓰레기 감지 센서와 쓰레기의) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 목표물을 집어 올리고 수거 장치를 작동시키며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상.","teacherFeedbackBefore":""},{"label":"버전 2 (1차 수정)","inputs":{"purpose":"지구와 우주를 왔다갔다 하면서 쓰레기를 수거해 우주쓰레기 정거장에 쓰레기를 버려 지구 생태계를 복원한다","robotName":"유니버스 X-50","aiFeedback":{"date":"2026-11-16","count":2,"step1":"우리 규혁 친구, 둥근 유선형 몸체와 노즐 설명이 아주 멋져요! 몸체가 우주 공간에서 버틸 수 있도록 가볍고 튼튼한 '탄소섬유 같은 신소재'를 썼다고 적어주면 더 완벽해질 거예요.","step2":"지구와 우주를 오가며 쓰레기를 치우는 목적이 정말 훌륭해요! 이 로봇이 우주 환경을 지키는 '친환경 우주 청소부'라는 점을 강조하면 목적이 더욱 감동적으로 다가올 거예요.","step3":"쓰레기를 주워오는 모습이 눈에 그려져요! 로봇의 팔이 물건을 꽉 잡을 수 있는 '와이어 관절 구조'나 유연하게 움직이는 '모터 장치'를 설명에 추가해 보면 어떨까요?","step4":"센서와 행동을 아주 꼼꼼하게 잘 적어주었어요! 여기에 우주 먼지나 장애물을 피할 수 있는 '초음파 센서'나 '적외선 센서'를 하나 더 추가하면 로봇이 훨씬 똑똑해질 거예요.","step5":"태양광 패널과 사물인식 기술을 잘 찾아주었네요! 우주에서 전기를 아껴 쓰기 위해 '무선 충전 기술'이나 에너지를 효율적으로 모으는 과학 원리를 더 적어주면 정말 멋진 융합 기술이 될 거예요.","updatedAt":"2026-11-16T02:14:23.908Z"},"appearance":"친근한 둥근 유선형 몸체에 집게와 우주에서 움직일수 있도록 조그만한 노즐을 결합시킨뒤 우주에서도 잘보이라고 밝은 색으로 만들어졌다.","coreValues":"#우주쓰레기 #정거장","sensorName":"쓰레기 감지 센서, 라이더 센서","videoStyle":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)","scienceTech":"사물인식 기술로 쓰레기와 소행성을 구별하고 우주선 안에 로봇 전용 충전기를 설치해 로봇이 방전되지 않도록 한다. 또한  로봇에 태양광 패널을 설치한다.","mainFunction":"우주로 쓰레기를 보낼때 오작동으로 쓰레기가 우주선 밖으로 튀어나올때 유니버스 X-50 로봇을 내보내 쓰레기를 주워오게 한다","sensorAction":"로봇이 청소기 처럼 주운 쓰레기를 몸안에 보관해(최대 200kg) 우주선으로 들어온뒤 몸 안에 있는 쓰레기를 전용 기계를 사용해 쓰레기 저장소로 보낸다.","sensorTarget":"쓰레기 감지 센서와 쓰레기의 거리를 정확히 재는 기술을 로봇에 부착해 100m 이상 떨어질시 우주선을 멈추고 로봇이 쓰레기를 가지러 감","boothComments":[],"customVideoPrompt":"[AI 영상 제작] 푸른 지구와 별빛이 빛나는 2050년 우주 정거장 궤도 공간에서, 흰색으로 만들어졌다 외형을 갖춘 로봇 '유니버스 X-50'이 화면 중앙에 등장해 부드럽게 움직이는 영상. 장착된 쓰레기 감지 센서, 라이더 센서는 단정하게 동그란 코어에서 푸른 스캔 라이트가 켜지며 쓰레기 감지 센서로 쓰레기를 스캔해 우주에 떠다니는 쓰레기를 단순한 로봇의 집게팔로 정교하게 뻗어 목표물을 집어 올리고 3D 입체 홀로그램 주머니를 꺼내 수거한 쓰레기를 조금도 빠짐없이 담은 뒤 초록색 3d 홀로그램으로 Missoni complate라는 문구을 생생하게 보여준다. 또한 코어에서 나오는 푸른 스캔 라이트가 꺼지는 것을 연출한 고화질 3D 애니메이션 스타일 동영상.","deletedCommentIds":[]},"version":2,"specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"지구와 우주를 왔다갔다 하면서 쓰레기를 수거해 우주쓰레기 정거장에 쓰레기를 버려 지구 생태계를 복원한다"},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#우주쓰레기 #정거장"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"사물인식 기술로 쓰레기와 소행성을 구별하고 우주선 안에 로봇 전용 충전기를 설치해 로봇이 방전되지 않도록 한다. 또한  로봇에 태양광 패널을 설치한다."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"우주로 쓰레기를 보낼때 오작동으로 쓰레기가 우주선 밖으로 튀어나올때 유니버스 X-50 로봇을 내보내 쓰레기를 주워오게 한다"},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"쓰레기 감지 센서, 라이더 센서","sensorAction":"로봇이 청소기 처럼 주운 쓰레기를 몸안에 보관해(최대 200kg) 우주선으로 들어온뒤 몸 안에 있는 쓰레기를 전용 기계를 사용해 쓰레기 저장소로 보낸다.","sensorTarget":"쓰레기 감지 센서와 쓰레기의 거리를 정확히 재는 기술을 로봇에 부착해 100m 이상 떨어질시 우주선을 멈추고 로봇이 쓰레기를 가지러 감"},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"유니버스 X-50","appearance":"친근한 둥근 유선형 몸체에 집게와 우주에서 움직일수 있도록 조그만한 노즐을 결합시킨뒤 우주에서도 잘보이라고 밝은 색으로 만들어졌다."}},"submittedAt":"2026-11-16T02:52:28.160Z","videoPrompt":"[AI 영상 제작] 푸른 지구와 별빛이 빛나는 2050년 우주 정거장 궤도 공간에서, 흰색으로 만들어졌다 외형을 갖춘 로봇 '유니버스 X-50'이 화면 중앙에 등장해 부드럽게 움직이는 영상. 장착된 쓰레기 감지 센서, 라이더 센서는 단정하게 동그란 코어에서 푸른 스캔 라이트가 켜지며 쓰레기 감지 센서로 쓰레기를 스캔해 우주에 떠다니는 쓰레기를 단순한 로봇의 집게팔로 정교하게 뻗어 목표물을 집어 올리고 3D 입체 홀로그램 주머니를 꺼내 수거한 쓰레기를 조금도 빠짐없이 담은 뒤 초록색 3d 홀로그램으로 Missoni complate라는 문구을 생생하게 보여준다. 또한 코어에서 나오는 푸른 스캔 라이트가 꺼지는 것을 연출한 고화질 3D 애니메이션 스타일 동영상.","teacherFeedbackBefore":""}],"updatedAt":"2026-11-17T00:14:54.197Z"},{"studentId":"진예원","studentName":"진예원","status":"approved","inputs":{"robotName":"오비트클리너","appearance":"친근한 둥근 위성처럼 생긴 로봇팔과 그물 발사 장치를 단 우주쓰레기 수거 로봇","purpose":"지구 궤도에는 점점 늘어나는 우주쓰레기 때문에 인공위성과 우주선이 충돌할 위험이 커지고 있다. 이 우주 로봇은 인공위성과 우주정거장이 많이 지나가는 우주 공간에서 쓰레기를 수거하고, 모은 쓰레기를 다시 지구로 가져와 재활용함으로써 자원을 순환시키고 우주 환경을 지키는 것을 목표로 한다.","mainFunction":"카메라 센서로 우주쓰레기의 위치를 찾은 뒤, 작은 추진기로 자세를 바꾸고 로봇팔을 뻗어 쓰레기를 잡는다. 로봇팔 끝에는 사람 손가락처럼 움직이는 그리퍼가 있어서 쓰레기를 정밀하게 집을 수 있고, 진공 흡착 기능으로 표면에 꽉 붙잡아 놓치지 않게 만든다. 잡은 쓰레기는 로봇팔이 몸속 저장 통까지 옮겨 넣는다.","sensorName":"카메라 센서와 레이더 센서","sensorTarget":"우주에 떠다니는 인공위성 조각이나 철 조각 같은 작은 쓰레기의 위치와 크기 움직임을 자세히 감지한다","sensorAction":"충돌하지 않도록 거리와 방향을 계산해서 가까이 다가가 로봇팔과 그물로 쓰레기를 잡는다","scienceTech":"오비트클리너는 센서와 인공지능, 자율 비행 기술을 사용해 우주쓰레기를 스스로 찾아가 로봇팔과 그물로 자동으로 수거하는 로봇이다. 인공지능은 비행 경로와 에너지 사용을 계산하는 최적화 알고리즘을 이용해, 연료를 아끼면서도 가장 효율적인 길로 이동하도록 로봇을 조종한다","coreValues":"#우주환경보호 #지속가능한미래","videoStyle":"시네마틱 SF 실사 영화 스타일 (초고화질 금속 질감과 미래형 네온 조명 연출)","customVideoPrompt":"","aiFeedback":{"date":"2026-11-16","count":2,"step1":"둥근 외형은 우주에서 부딪힐 위험이 적어 정말 좋은 생각이에요! 로봇 표면에 태양빛을 전기로 바꾸는 태양광 패널을 부착하거나, 외부 충격에 강한 신소재인 탄소섬유를 사용했다고 설명하면 더 완벽할 것 같아요.","step2":"우주쓰레기 문제의 심각성을 아주 잘 짚어주었어요. 쓰레기를 단순히 수거하는 것을 넘어, 수거한 쓰레기를 다시 지구로 가져와 재활용하는 '자원 순환'의 개념을 추가하면 더욱 멋진 목적이 될 거예요.","step3":"그리퍼와 진공 흡착 기능을 섞은 것은 정말 똑똑한 기계 공학적 설계예요! 쓰레기를 잡을 때 반동 때문에 로봇이 튕겨 나가지 않도록 몸체에 '자이로 센서'를 이용한 자세 제어 장치를 추가해 보세요.","step4":"카메라와 레이더 조합은 아주 정확한 방법이에요! 쓰레기의 재질을 구분할 수 있는 '근적외선 센서'를 추가하면, 금속 쓰레기인지 아닌지 더 똑똑하게 판별해서 행동할 수 있을 거예요.","step5":"자율 비행 기술은 훌륭해요! 여기에 스스로 에너지를 아끼며 비행 경로를 짜는 '최적화 알고리즘' 기술을 언급해 주면, 인공지능이 더 똑똑하게 작동하는 것처럼 보일 거예요.","updatedAt":"2026-11-16T02:28:27.138Z"},"boothComments":[{"v":2,"id":"c_1794797519687_gfb4x","text":"우주쓰레기를 수거하는 로봇이라니 아이디어가 좋아!","author":"장서윤","createdAt":"2026-11-16T02:51:59.689Z","viewerToken":"vt_1794796665307_ra6syqil","authorStudentId":"장서윤"},{"v":2,"id":"c_1794798301598_9d5ug","text":"우우우우ㅜ우우우우우웅와오아와와오아오아 정말멋져","author":"신연호","createdAt":"2026-11-16T03:05:01.598Z","viewerToken":"vt_1794788851253_3o74q6xc","authorStudentId":"신연호"},{"v":2,"id":"c_1794798933777_njars","text":"오아아아아아아아아아ㅏ아아아아아아아 정말 멋져!👍👍👍👍👍👍👍👍","author":"김지안","createdAt":"2026-11-16T03:15:33.777Z","viewerToken":"vt_1794796070701_4iqa9fd3","authorStudentId":"김지안"},{"v":2,"id":"c_1794799259251_fa12z","text":"와ㅏㅏㅏㅏ!!!!!!!!!!!!!!!!!!!!!!!!! 아이디어가 정말 좋다ㅏㅏㅏ!!","author":"이수아","createdAt":"2026-11-16T03:20:59.251Z","viewerToken":"vt_1794799212191_bqc4jkhg","authorStudentId":"이수아"},{"v":2,"id":"c_1794873202811_09dx3","text":"우우우우우우우우우우우우우우우와와와와 정말 대단한걸??","author":"김민재","createdAt":"2026-11-16T23:53:22.811Z","viewerToken":"vt_1794796308439_8yzbw3eg","authorStudentId":"김민재"},{"v":2,"id":"c_1794873207732_a4zoo","text":"와우와우우👍👍👍👍👍👍👍👍","author":"이석준","createdAt":"2026-11-16T23:53:27.733Z","viewerToken":"vt_1794799215240_tjkhcvj5","authorStudentId":"이석준"},{"v":2,"id":"c_1794873753539_iio6m","text":"이야ㅑㅑㅑㅑㅑㅑㅑㅑㅑㅑㅑㅑㅑㅑㅑㅑㅑㅑ","author":"김승윤","createdAt":"2026-11-17T00:02:33.539Z","viewerToken":"vt_1794796086113_pfa1lkx5","authorStudentId":"김승윤"},{"v":2,"id":"c_1794873756908_plp4f","text":"우와ㅏ엄청 유용할것 같아 멋있어 보여😎","author":"김지아","createdAt":"2026-11-17T00:02:36.908Z","viewerToken":"vt_1794796098329_ixf8fbb4","authorStudentId":"김지아"},{"v":2,"id":"c_1794873927750_p5hkl","text":"우주 쓰레기를 이렇게 간단하게 치울수 있다면 얼마나 조을까!!!!! 아이디어 굳굳!!!","author":"공인경","createdAt":"2026-11-17T00:05:27.750Z","viewerToken":"vt_1794799986519_qjpt3033","authorStudentId":"공인경"},{"v":2,"id":"c_1794874030397_0gexa","text":"아쉽지만 영상이 흡입하는게 나오면 좋겠어. 하지만 아이디어가 좋은 것 같아","author":"진연우","createdAt":"2026-11-17T00:07:10.397Z","viewerToken":"vt_1794788838051_mpwskv0k","authorStudentId":"진연우"},{"v":2,"id":"c_1794874446364_1wpwk","text":"와 브로. 그것은 완벽함 그 잡채야🤩 이정도면 우주에 있는 모든 쓰레기와 지구에 있는 모든 쓰레기를 하나하나 따로 힘들게 노동을 하면서 버리지 않아도 많은 쓰레기를 버려서 지구 온난화를 늦출수있겠어🤩🤩🤩 와 진짜, 브로는 천재야 어떻게 로봇을 우주에 날려서 지구를 킬 생각을 한거지? 브로는 그냥 그 상태로 조금만 연구하면 우주정복은 거뜬하겠는걸?!","author":"김규혁","createdAt":"2026-11-17T00:14:06.364Z","viewerToken":"vt_1794796116808_09f96gop","authorStudentId":"김규혁"},{"v":2,"id":"c_1794874498031_9wzuv","text":"와우우우우우우우우우우웅 ㅇ완전 엄청난","author":"신다빈","createdAt":"2026-11-17T00:14:58.031Z","viewerToken":"vt_1794796192899_42ggb0j9","authorStudentId":"신다빈"}],"deletedCommentIds":["c_1794797969909_yo3mb","c_1794798262395_s1mh3","c_1794873628027_jcog6"]},"videoPrompt":"[AI 영상 제작] 푸른 지구와 별빛이 빛나는 2050년 우주 정거장 궤도 공간에서, 친근한 둥근 위성처럼 생긴 로봇팔과 그물 발사 장치를 단 우주쓰레기 수거 로봇 외형을 갖춘 로봇 '오비트클리너'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 카메라 센서와 레이더 센서에 푸른 스캔 라이트가 켜지며(우주에 떠다니는 인공위성 조각이나 철 조각 같은 작은 쓰레기의 위치와 크기 움직임을 자세히) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 목표물을 집어 올리고 수거 장치를 작동시키며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 시네마틱 SF 실사 영화 스타일 동영상.","specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"지구 궤도에는 점점 늘어나는 우주쓰레기 때문에 인공위성과 우주선이 충돌할 위험이 커지고 있다. 이 우주 로봇은 인공위성과 우주정거장이 많이 지나가는 우주 공간에서 쓰레기를 수거하고, 모은 쓰레기를 다시 지구로 가져와 재활용함으로써 자원을 순환시키고 우주 환경을 지키는 것을 목표로 한다."},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#우주환경보호 #지속가능한미래"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"시네마틱 SF 실사 영화 스타일 (초고화질 금속 질감과 미래형 네온 조명 연출)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"오비트클리너는 센서와 인공지능, 자율 비행 기술을 사용해 우주쓰레기를 스스로 찾아가 로봇팔과 그물로 자동으로 수거하는 로봇이다. 인공지능은 비행 경로와 에너지 사용을 계산하는 최적화 알고리즘을 이용해, 연료를 아끼면서도 가장 효율적인 길로 이동하도록 로봇을 조종한다"},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"카메라 센서로 우주쓰레기의 위치를 찾은 뒤, 작은 추진기로 자세를 바꾸고 로봇팔을 뻗어 쓰레기를 잡는다. 로봇팔 끝에는 사람 손가락처럼 움직이는 그리퍼가 있어서 쓰레기를 정밀하게 집을 수 있고, 진공 흡착 기능으로 표면에 꽉 붙잡아 놓치지 않게 만든다. 잡은 쓰레기는 로봇팔이 몸속 저장 통까지 옮겨 넣는다."},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"카메라 센서와 레이더 센서","sensorAction":"충돌하지 않도록 거리와 방향을 계산해서 가까이 다가가 로봇팔과 그물로 쓰레기를 잡는다","sensorTarget":"우주에 떠다니는 인공위성 조각이나 철 조각 같은 작은 쓰레기의 위치와 크기 움직임을 자세히 감지한다"},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"오비트클리너","appearance":"친근한 둥근 위성처럼 생긴 로봇팔과 그물 발사 장치를 단 우주쓰레기 수거 로봇"}},"teacherFeedback":"","feedbackAt":"","video":{"type":"none","url":"","title":"","thumbnail":""},"likes":12,"currentVersion":2,"history":[{"label":"버전 1 (최초 제출)","inputs":{"purpose":"지구 궤도에 점점 늘어나는 우주쓰레기로 인해 위성,우주선 충돌의 위험이 증가한다. 활동 배경 장소는 인공위성과 우주정거장이 많이 지나가는 우주 공간이다.","robotName":"오비트클리너","aiFeedback":{"date":"2026-11-16","count":1,"step1":"예원 친구, 오비트클리너라는 이름이 정말 멋져요! 로봇이 우주 환경에서 견딜 수 있도록 태양열을 흡수하는 신소재 금속 껍질이나, 스스로 에너지를 만드는 태양광 날개를 외형에 추가해 보면 훨씬 더 튼튼해 보일 거예요.","step2":"우주 쓰레기 문제를 해결하려는 생각이 정말 기특해요! 단순히 수거하는 것을 넘어서, 수거한 쓰레기를 지구 대기권에서 안전하게 태워 없애거나 재활용하는 친환경적인 목적을 추가하면 더 훌륭한 로봇이 될 거예요.","step3":"쓰레기를 잡는 로봇팔의 움직임을 더 자세히 설명해 볼까요? 사람의 손가락처럼 정밀하게 움직이는 '그리퍼' 관절 구조나, 쓰레기를 놓치지 않도록 꽉 잡는 진공 흡착 기능을 넣으면 훨씬 더 과학적인 로봇이 된답니다.","step4":"아주 똑똑한 선택이에요! 쓰레기와의 거리를 정확히 재는 '라이다(LiDAR) 센서'를 추가해 보세요. 감지 후에는 쓰레기의 회전 방향까지 계산해서 로봇이 안전하게 붙을 수 있도록 회전 속도를 맞추는 행동을 추가하면 완벽해요.","step5":"훌륭한 기술들을 잘 찾아주었어요! 여기에 더해 우주 공간에서 아주 조금만 연료를 써도 빠르게 이동할 수 있는 '이온 엔진' 기술을 더해 보세요. 로봇이 우주에서 에너지를 아끼며 오래 활동하는 과학적 원리까지 포함하면 더 대단한 발명품이 될 거예요.","updatedAt":"2026-11-16T00:28:33.769Z"},"appearance":"친근한 둥근 위성처럼 생긴 로봇팔과 그물 발사 장치를 단 우주쓰레기 수거 로봇","coreValues":"#우주환경보호 #지속가능한미래","sensorName":"카메라 센서와 레이더 센서","videoStyle":"시네마틱 SF 실사 영화 스타일 (초고화질 금속 질감과 미래형 네온 조명 연출)","scienceTech":"오비트클리너는 센서와 인공지능,자율 비행 기술을 사용해 우주쓰레기를 스스로 찾아가 로봇팔과 그물로 자동으로 수거하는 로봇이다","mainFunction":"카메라 센서로 우주쓰레기의 위치를 찾은 뒤, 작은 추진기로 자세를 바꾸고 로봇팔을 뻗어 쓰레기를 잡는다. 로봇팔 끝에는 사람 손가락처럼 움직이는 그리퍼가 있어서 쓰레기를 정밀하게 집을 수 있고, 진공 흡착 기능으로 표면에 꽉 붙잡아 놓치지 않게 만든다. 잡은 쓰레기는 로봇팔이 몸속 저장 통까지 옮겨 넣는다.","sensorAction":"충돌하지 않도록 거리와 방향을 계산해서 가까이 다가가 로봇팔과 그물로 쓰레기를 잡는다","sensorTarget":"우주에 떠다니는 인공위성 조각이나 철 조각 같은 작은 쓰레기의 위치와 크기 움직임을 자세히 감지한다","boothComments":[],"customVideoPrompt":"","deletedCommentIds":[]},"version":1,"specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"지구 궤도에 점점 늘어나는 우주쓰레기로 인해 위성,우주선 충돌의 위험이 증가한다. 활동 배경 장소는 인공위성과 우주정거장이 많이 지나가는 우주 공간이다."},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#우주환경보호 #지속가능한미래"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"시네마틱 SF 실사 영화 스타일 (초고화질 금속 질감과 미래형 네온 조명 연출)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"오비트클리너는 센서와 인공지능,자율 비행 기술을 사용해 우주쓰레기를 스스로 찾아가 로봇팔과 그물로 자동으로 수거하는 로봇이다"},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"카메라 센서로 우주쓰레기의 위치를 찾은 뒤, 작은 추진기로 자세를 바꾸고 로봇팔을 뻗어 쓰레기를 잡는다. 로봇팔 끝에는 사람 손가락처럼 움직이는 그리퍼가 있어서 쓰레기를 정밀하게 집을 수 있고, 진공 흡착 기능으로 표면에 꽉 붙잡아 놓치지 않게 만든다. 잡은 쓰레기는 로봇팔이 몸속 저장 통까지 옮겨 넣는다."},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"카메라 센서와 레이더 센서","sensorAction":"충돌하지 않도록 거리와 방향을 계산해서 가까이 다가가 로봇팔과 그물로 쓰레기를 잡는다","sensorTarget":"우주에 떠다니는 인공위성 조각이나 철 조각 같은 작은 쓰레기의 위치와 크기 움직임을 자세히 감지한다"},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"오비트클리너","appearance":"친근한 둥근 위성처럼 생긴 로봇팔과 그물 발사 장치를 단 우주쓰레기 수거 로봇"}},"submittedAt":"2026-11-16T00:33:22.787Z","videoPrompt":"[AI 영상 제작] 푸른 지구와 별빛이 빛나는 2050년 우주 정거장 궤도 공간에서, 친근한 둥근 위성처럼 생긴 로봇팔과 그물 발사 장치를 단 우주쓰레기 수거 로봇 외형을 갖춘 로봇 '오비트클리너'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 카메라 센서와 레이더 센서에 푸른 스캔 라이트가 켜지며(우주에 떠다니는 인공위성 조각이나 철 조각 같은 작은 쓰레기의 위치와 크기 움직임을 자세히) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 목표물을 집어 올리고 수거 장치를 작동시키며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 시네마틱 SF 실사 영화 스타일 동영상.","teacherFeedbackBefore":""},{"label":"버전 2 (1차 수정)","inputs":{"purpose":"지구 궤도에는 점점 늘어나는 우주쓰레기 때문에 인공위성과 우주선이 충돌할 위험이 커지고 있다. 이 우주 로봇은 인공위성과 우주정거장이 많이 지나가는 우주 공간에서 쓰레기를 수거하고, 모은 쓰레기를 다시 지구로 가져와 재활용함으로써 자원을 순환시키고 우주 환경을 지키는 것을 목표로 한다.","robotName":"오비트클리너","aiFeedback":{"date":"2026-11-16","count":2,"step1":"둥근 외형은 우주에서 부딪힐 위험이 적어 정말 좋은 생각이에요! 로봇 표면에 태양빛을 전기로 바꾸는 태양광 패널을 부착하거나, 외부 충격에 강한 신소재인 탄소섬유를 사용했다고 설명하면 더 완벽할 것 같아요.","step2":"우주쓰레기 문제의 심각성을 아주 잘 짚어주었어요. 쓰레기를 단순히 수거하는 것을 넘어, 수거한 쓰레기를 다시 지구로 가져와 재활용하는 '자원 순환'의 개념을 추가하면 더욱 멋진 목적이 될 거예요.","step3":"그리퍼와 진공 흡착 기능을 섞은 것은 정말 똑똑한 기계 공학적 설계예요! 쓰레기를 잡을 때 반동 때문에 로봇이 튕겨 나가지 않도록 몸체에 '자이로 센서'를 이용한 자세 제어 장치를 추가해 보세요.","step4":"카메라와 레이더 조합은 아주 정확한 방법이에요! 쓰레기의 재질을 구분할 수 있는 '근적외선 센서'를 추가하면, 금속 쓰레기인지 아닌지 더 똑똑하게 판별해서 행동할 수 있을 거예요.","step5":"자율 비행 기술은 훌륭해요! 여기에 스스로 에너지를 아끼며 비행 경로를 짜는 '최적화 알고리즘' 기술을 언급해 주면, 인공지능이 더 똑똑하게 작동하는 것처럼 보일 거예요.","updatedAt":"2026-11-16T02:28:27.138Z"},"appearance":"친근한 둥근 위성처럼 생긴 로봇팔과 그물 발사 장치를 단 우주쓰레기 수거 로봇","coreValues":"#우주환경보호 #지속가능한미래","sensorName":"카메라 센서와 레이더 센서","videoStyle":"시네마틱 SF 실사 영화 스타일 (초고화질 금속 질감과 미래형 네온 조명 연출)","scienceTech":"오비트클리너는 센서와 인공지능, 자율 비행 기술을 사용해 우주쓰레기를 스스로 찾아가 로봇팔과 그물로 자동으로 수거하는 로봇이다. 인공지능은 비행 경로와 에너지 사용을 계산하는 최적화 알고리즘을 이용해, 연료를 아끼면서도 가장 효율적인 길로 이동하도록 로봇을 조종한다","mainFunction":"카메라 센서로 우주쓰레기의 위치를 찾은 뒤, 작은 추진기로 자세를 바꾸고 로봇팔을 뻗어 쓰레기를 잡는다. 로봇팔 끝에는 사람 손가락처럼 움직이는 그리퍼가 있어서 쓰레기를 정밀하게 집을 수 있고, 진공 흡착 기능으로 표면에 꽉 붙잡아 놓치지 않게 만든다. 잡은 쓰레기는 로봇팔이 몸속 저장 통까지 옮겨 넣는다.","sensorAction":"충돌하지 않도록 거리와 방향을 계산해서 가까이 다가가 로봇팔과 그물로 쓰레기를 잡는다","sensorTarget":"우주에 떠다니는 인공위성 조각이나 철 조각 같은 작은 쓰레기의 위치와 크기 움직임을 자세히 감지한다","boothComments":[],"customVideoPrompt":"","deletedCommentIds":[]},"version":2,"specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"지구 궤도에는 점점 늘어나는 우주쓰레기 때문에 인공위성과 우주선이 충돌할 위험이 커지고 있다. 이 우주 로봇은 인공위성과 우주정거장이 많이 지나가는 우주 공간에서 쓰레기를 수거하고, 모은 쓰레기를 다시 지구로 가져와 재활용함으로써 자원을 순환시키고 우주 환경을 지키는 것을 목표로 한다."},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#우주환경보호 #지속가능한미래"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"시네마틱 SF 실사 영화 스타일 (초고화질 금속 질감과 미래형 네온 조명 연출)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"오비트클리너는 센서와 인공지능, 자율 비행 기술을 사용해 우주쓰레기를 스스로 찾아가 로봇팔과 그물로 자동으로 수거하는 로봇이다. 인공지능은 비행 경로와 에너지 사용을 계산하는 최적화 알고리즘을 이용해, 연료를 아끼면서도 가장 효율적인 길로 이동하도록 로봇을 조종한다"},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"카메라 센서로 우주쓰레기의 위치를 찾은 뒤, 작은 추진기로 자세를 바꾸고 로봇팔을 뻗어 쓰레기를 잡는다. 로봇팔 끝에는 사람 손가락처럼 움직이는 그리퍼가 있어서 쓰레기를 정밀하게 집을 수 있고, 진공 흡착 기능으로 표면에 꽉 붙잡아 놓치지 않게 만든다. 잡은 쓰레기는 로봇팔이 몸속 저장 통까지 옮겨 넣는다."},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"카메라 센서와 레이더 센서","sensorAction":"충돌하지 않도록 거리와 방향을 계산해서 가까이 다가가 로봇팔과 그물로 쓰레기를 잡는다","sensorTarget":"우주에 떠다니는 인공위성 조각이나 철 조각 같은 작은 쓰레기의 위치와 크기 움직임을 자세히 감지한다"},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"오비트클리너","appearance":"친근한 둥근 위성처럼 생긴 로봇팔과 그물 발사 장치를 단 우주쓰레기 수거 로봇"}},"submittedAt":"2026-11-16T02:32:53.195Z","videoPrompt":"[AI 영상 제작] 푸른 지구와 별빛이 빛나는 2050년 우주 정거장 궤도 공간에서, 친근한 둥근 위성처럼 생긴 로봇팔과 그물 발사 장치를 단 우주쓰레기 수거 로봇 외형을 갖춘 로봇 '오비트클리너'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 카메라 센서와 레이더 센서에 푸른 스캔 라이트가 켜지며(우주에 떠다니는 인공위성 조각이나 철 조각 같은 작은 쓰레기의 위치와 크기 움직임을 자세히) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 다관절 집게팔을 정교하게 뻗어 목표물을 집어 올리고 수거 장치를 작동시키며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 시네마틱 SF 실사 영화 스타일 동영상.","teacherFeedbackBefore":""}],"updatedAt":"2026-11-17T00:14:58.031Z"},{"studentId":"신연호","studentName":"신연호","status":"approved","inputs":{"robotName":"씨드 가디언 플렌트-X","appearance":"정사각형 몸체에 배쪽에 내모난 유리안에 흙과 식물이있다. 머리는 둥근모양이다. 지구 온난화로 인해 추운 지역에사는 식물들이 멸종위기종이된 식물을 인공 교배를 시켜 개체수를 늘린다 현장에서 다리는 2개이며 팔이 4개이며 손바닥에서 자동으로 썩는 캡슐에 담긴 씨앗이 나온다. 손가락으로 식물의 DNA를 추출할수있다. 손목에 냉동고가 있으며,냉동고에는 태양열 발전기가 있다.또한 등에도 발전기가 달려있다.동물들이 경계하지 않도록 몸에 식물이 달려있다.몸통은 티타늄으로 되있다.팔은 강철선으로 되있다.팔4개이며 팔2개는 삽모양이다 .머리는 긴원형이며 눈은 길게 하나로 이루워져있다 .발에는 미끄러지지않게 고무로 되어있다. 최취한 식물은 몸체에 넣어다닌다. 몸체에는 식물이 달려있으며 바퀴달린 다리로 4족 보행을한다.","purpose":"지구 온난화로 인해 멸종위기종의 추운 지역에 사는 식물을 인공 교배를 시켜 개체수를 늘린다","mainFunction":"로봇의 카메라 센서가 빛나며 식물의 종류중 정확히 원하는 식물을 찾아낸다을 스캔한 뒤, 식물이 다치지않게 다니고 식물의 정보를 최취한다하며 손가락에서 나오는 면봉으로 식물 세포를 추출해서 손목에 있는 냉동고로  DNA를 추출할수있다. 삽모양의 식물의 꽃을 최취해 멸종위기종 식물을 인공 수성을 시켜 개체수를 늘린다","sensorName":"카메라 센서(새로운 식물을 인식), 온도 센서(몸체에서 식물을 키울수있게 식물이 사는 지역 온도를 찾음)","sensorTarget":"여럿종류의 식물중 원하는 식물을 찾아냄,식물이 사는 온도분석한다.","sensorAction":"삽모양 팔로 다치지 않게 식물을 뽑아 인공 수정을 시킨다,식물을 몸체에서 키움","scienceTech":"인공지능(AI)사물인식기능으로 식물의 종류를 알수있다, 배터리를 등에달린 태양열  발전기를 이용해 충전할수있다, 밤에는 압전 소자를 이용해 밤에도 움직일수있다","coreValues":"#생태계보존 #생명존중","videoStyle":"솔라펑크(Solarpunk) 친환경 미래 3D 스타일 (푸른 자연 생태계와 첨단 과학기술의 조화)","customVideoPrompt":"","aiFeedback":{"date":"2026-11-16","count":2,"step1":"연호가 만든 로봇은 아주 튼튼해 보여요! 로봇이 험한 추운 지역을 다닐 때 미끄러지지 않도록 발바닥에 '마찰력 센서'나 '미끄럼 방지 고무 패드'를 추가하면 더 안정적일 것 같아요.","step2":"멸종 위기 식물을 지키는 목적이 정말 따뜻하고 멋져요! 단순히 개체 수를 늘리는 것 외에도, 식물이 자라기 좋은 토양의 습도나 영양분을 조절하는 기능까지 더하면 지구 환경을 더 완벽하게 도울 수 있을 거예요.","step3":"손가락 면봉과 삽 팔 아이디어가 참신하네요! 식물을 다룰 때 너무 강한 힘이 들어가면 다칠 수 있으니, 아주 섬세하게 움직일 수 있는 '압력 센서'를 팔 끝에 넣어보자고 하면 더 과학적이 될 거예요.","step4":"카메라로 식물을 찾는 건 아주 좋아요! 여기서 한 걸음 더 나아가, 주변 온도를 감지하는 '온도 센서'를 추가해서 식물이 자라기 딱 좋은 최적의 온도를 스스로 찾아가도록 하면 어떨까요?","step5":"태양열 발전 아이디어가 아주 훌륭해요! 태양 빛이 부족한 추운 밤을 대비해서 식물의 흔들림에서 에너지를 얻는 '압전 소자' 기술을 추가하면 로봇이 24시간 멈추지 않고 일할 수 있을 거예요.","updatedAt":"2026-11-16T00:21:39.553Z"},"boothComments":[{"v":2,"id":"c_1794799506017_p04uw","text":"🌲🌳🌲🌳🌲🌳🌲🌳🌲🌳🌲🌳","author":"김규혁","createdAt":"2026-11-16T03:25:06.017Z","viewerToken":"vt_1794796116808_09f96gop","authorStudentId":"김규혁"},{"v":2,"id":"c_1794873149721_tylbc","text":"좋은 아이디어야!!!!!!!!!!!!!!","author":"장서윤","createdAt":"2026-11-16T23:52:29.721Z","viewerToken":"vt_1794796665307_ra6syqil","authorStudentId":"장서윤"},{"v":2,"id":"c_1794873280632_xgzsq","text":"설계가 좋았어!👍👍👍👍👍👍","author":"진연우","createdAt":"2026-11-16T23:54:40.632Z","viewerToken":"vt_1794788838051_mpwskv0k","authorStudentId":"진연우"},{"v":2,"id":"c_1794873503153_ba53m","text":"우아아아앙  ^_^   amazing","author":"이석준","createdAt":"2026-11-16T23:58:23.153Z","viewerToken":"vt_1794799215240_tjkhcvj5","authorStudentId":"이석준"},{"v":2,"id":"c_1794873576247_ldn7c","text":"우와우와 정말정말 울트라 진짜 ㄹㅈㄷ 잘했다","author":"신연호","createdAt":"2026-11-16T23:59:36.247Z","viewerToken":"vt_1794788851253_3o74q6xc","authorStudentId":"신연호"},{"v":2,"id":"c_1794874042661_sbjyx","text":"슈퍼짱짱짱 멋지다 엄청나 👍👍👍👍👍👍👍","author":"이원준","createdAt":"2026-11-17T00:07:22.661Z","viewerToken":"vt_1794873057588_6rghf8uo","authorStudentId":"이원준"},{"v":2,"id":"c_1794874409749_iyp6i","text":"와 브로. 그것은 완벽함 그 잡체야🤩 이정도면 지구상에 있는 모든 숲에 꽃과 잎과 나무와 그냥 그 생태계 자체를 지키는 아주 멋진 로봇인걸??🤩🤩🤩 와 진짜, 브로는 천재야 어떻게 로봇의 몸에서 흙이 나와서 꽃을 심고 씨앗을 심을 생각을 한거지? 브로는 그냥 그 상태로 조금만 연구하면 숲속의 모든 동물들에게 존경받고 한 가정의 목숨을 살릴수있겠는걸?","author":"김민재","createdAt":"2026-11-17T00:13:29.749Z","viewerToken":"vt_1794796308439_8yzbw3eg","authorStudentId":"김민재"},{"v":2,"id":"c_1794874514884_ortun","text":"우와ㅏ 네모난 유리안에 식물을 키우는거 아이디어가 좋다!! 요즘 상황에서 유용할것같아 지짜 굿굿이네 👍","author":"김지아","createdAt":"2026-11-17T00:15:14.884Z","viewerToken":"vt_1794796098329_ixf8fbb4","authorStudentId":"김지아"},{"v":2,"id":"c_1794874545146_ym5e5","text":"키야야ㅑ야야야야야야ㅑ야양야야야ㅑ야야야야야야야야 이야ㅑㅑㅑㅑㅑㅑㅑㅑㅑㅑㅑ 우와ㅏㅏㅏㅏㅏㅏ❤️💖❤️💖❤️💖💖💕","author":"김승윤","createdAt":"2026-11-17T00:15:45.146Z","viewerToken":"vt_1794796086113_pfa1lkx5","authorStudentId":"김승윤"}],"deletedCommentIds":["c_1794799492026_qfps0"]},"videoPrompt":"[AI 영상 제작] 푸른 나무와 빛나는 자연이 어우러진 2050년 미래 생태 숲 현장에서, 정사각형 몸체에 배쪽에 내모난 유리안에 흙과 식물이있다, 머리는 둥근형태, 지구 온난화로 인해 추운 지역에사는 식물들이 멸종위기종이된 식물을 인공 교배를 시켜 개체수를 늘린다 현장에서 다리는 2개이며 팔이 4개이며 손바닥에서 자동으로 썩는 캡슐에 담긴 씨앗이 나온다 외형을 갖춘 로봇 '씨드 가디언 플렌트-X'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 카메라 센서, 온도 센서에 푸른 스캔 라이트가 켜지며(여럿종류의 식물중 원하는 식물을 찾아냄,식물이 사는 온도분석한다) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 삽모양 팔로 다치지 않게 식물을 뽑아 인공 수정을 시킨다,식물을 몸체에서 키움, 로봇의 카메라 센서가 빛나며 식물의 하며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 솔라펑크 친환경 미래 3D 스타일 동영상.","specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"지구 온난화로 인해 멸종위기종의 추운 지역에 사는 식물을 인공 교배를 시켜 개체수를 늘린다"},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#생태계보존 #생명존중"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"솔라펑크(Solarpunk) 친환경 미래 3D 스타일 (푸른 자연 생태계와 첨단 과학기술의 조화)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"인공지능(AI)사물인식기능으로 식물의 종류를 알수있다, 배터리를 등에달린 태양열  발전기를 이용해 충전할수있다, 밤에는 압전 소자를 이용해 밤에도 움직일수있다"},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"로봇의 카메라 센서가 빛나며 식물의 종류중 정확히 원하는 식물을 찾아낸다을 스캔한 뒤, 식물이 다치지않게 다니고 식물의 정보를 최취한다하며 손가락에서 나오는 면봉으로 식물 세포를 추출해서 손목에 있는 냉동고로  DNA를 추출할수있다. 삽모양의 식물의 꽃을 최취해 멸종위기종 식물을 인공 수성을 시켜 개체수를 늘린다"},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"카메라 센서(새로운 식물을 인식), 온도 센서(몸체에서 식물을 키울수있게 식물이 사는 지역 온도를 찾음)","sensorAction":"삽모양 팔로 다치지 않게 식물을 뽑아 인공 수정을 시킨다,식물을 몸체에서 키움","sensorTarget":"여럿종류의 식물중 원하는 식물을 찾아냄,식물이 사는 온도분석한다."},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"씨드 가디언 플렌트-X","appearance":"정사각형 몸체에 배쪽에 내모난 유리안에 흙과 식물이있다. 머리는 둥근모양이다. 지구 온난화로 인해 추운 지역에사는 식물들이 멸종위기종이된 식물을 인공 교배를 시켜 개체수를 늘린다 현장에서 다리는 2개이며 팔이 4개이며 손바닥에서 자동으로 썩는 캡슐에 담긴 씨앗이 나온다. 손가락으로 식물의 DNA를 추출할수있다. 손목에 냉동고가 있으며,냉동고에는 태양열 발전기가 있다.또한 등에도 발전기가 달려있다.동물들이 경계하지 않도록 몸에 식물이 달려있다.몸통은 티타늄으로 되있다.팔은 강철선으로 되있다.팔4개이며 팔2개는 삽모양이다 .머리는 긴원형이며 눈은 길게 하나로 이루워져있다 .발에는 미끄러지지않게 고무로 되어있다. 최취한 식물은 몸체에 넣어다닌다. 몸체에는 식물이 달려있으며 바퀴달린 다리로 4족 보행을한다."}},"teacherFeedback":"","feedbackAt":"","video":{"type":"none","url":"","title":"","thumbnail":""},"likes":9,"currentVersion":11,"history":[{"label":"버전 10 (9차 수정)","inputs":{"purpose":"지구 온난화로 인해 멸종위기종의 추운 지역에 사는 식물을 인공 교배를 시켜 개체수를 늘린다","robotName":"씨드 가디언 플렌트-X","aiFeedback":{"date":"2026-11-16","count":2,"step1":"연호가 만든 로봇은 아주 튼튼해 보여요! 로봇이 험한 추운 지역을 다닐 때 미끄러지지 않도록 발바닥에 '마찰력 센서'나 '미끄럼 방지 고무 패드'를 추가하면 더 안정적일 것 같아요.","step2":"멸종 위기 식물을 지키는 목적이 정말 따뜻하고 멋져요! 단순히 개체 수를 늘리는 것 외에도, 식물이 자라기 좋은 토양의 습도나 영양분을 조절하는 기능까지 더하면 지구 환경을 더 완벽하게 도울 수 있을 거예요.","step3":"손가락 면봉과 삽 팔 아이디어가 참신하네요! 식물을 다룰 때 너무 강한 힘이 들어가면 다칠 수 있으니, 아주 섬세하게 움직일 수 있는 '압력 센서'를 팔 끝에 넣어보자고 하면 더 과학적이 될 거예요.","step4":"카메라로 식물을 찾는 건 아주 좋아요! 여기서 한 걸음 더 나아가, 주변 온도를 감지하는 '온도 센서'를 추가해서 식물이 자라기 딱 좋은 최적의 온도를 스스로 찾아가도록 하면 어떨까요?","step5":"태양열 발전 아이디어가 아주 훌륭해요! 태양 빛이 부족한 추운 밤을 대비해서 식물의 흔들림에서 에너지를 얻는 '압전 소자' 기술을 추가하면 로봇이 24시간 멈추지 않고 일할 수 있을 거예요.","updatedAt":"2026-11-16T00:21:39.553Z"},"appearance":"정사각형 몸체에 배쪽에 내모난 유리안에 흙과 식물이있다. 머리는 둥근모양이다. 지구 온난화로 인해 추운 지역에사는 식물들이 멸종위기종이된 식물을 인공 교배를 시켜 개체수를 늘린다 현장에서 다리는 2개이며 팔이 4개이며 손바닥에서 자동으로 썩는 캡슐에 담긴 씨앗이 나온다. 손가락으로 식물의 DNA를 추출할수있다. 손목에 냉동고가 있으며,냉동고에는 태양열 발전기가 있다.또한 등에도 발전기가 달려있다.동물들이 경계하지 않도록 몸에 식물이 달려있다.몸통은 티타늄으로 되있다.팔은 강철선으로 되있다.팔4개이며 팔2개는 삽모양이다 .머리는 긴원형이며 눈은 길게 하나로 이루워져있다 .발에는 미끄러지지않게 고무로 되어있다. 최취한 식물은 몸체에 넣어다닌다. 몸체에는 식물이 달려있으며 바퀴달린 다리로 4족 보행을한다.","coreValues":"#생태계보존 #생명존중","sensorName":"카메라 센서(새로운 식물을 인식), 온도 센서(몸체에서 식물을 키울수있게 식물이 사는 지역 온도를 찾음)","videoStyle":"솔라펑크(Solarpunk) 친환경 미래 3D 스타일 (푸른 자연 생태계와 첨단 과학기술의 조화)","scienceTech":"인공지능(AI)사물인식기능으로 식물의 종류를 알수있다, 배터리를 등에달린 태양열  발전기를 이용해 충전할수있다, 밤에는 압전 소자를 이용해 밤에도 움직일수있다","mainFunction":"로봇의 카메라 센서가 빛나며 식물의 종류중 정확히 원하는 식물을 찾아낸다을 스캔한 뒤, 식물이 다치지않게 다니고 식물의 정보를 최취한다하며 손가락에서 나오는 면봉으로 식물 세포를 추출해서 손목에 있는 냉동고로  DNA를 추출할수있다. 삽모양의 식물의 꽃을 최취해 멸종위기종 식물을 인공 수성을 시켜 개체수를 늘린다","sensorAction":"삽모양 팔로 다치지 않게 식물을 뽑아 인공 수정을 시킨다,식물을 몸체에서 키움","sensorTarget":"여럿종류의 식물중 원하는 식물을 찾아냄,식물이 사는 온도분석한다.","boothComments":[],"customVideoPrompt":"","deletedCommentIds":[]},"version":10,"specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"지구 온난화로 인해 멸종위기종의 추운 지역에 사는 식물을 인공 교배를 시켜 개체수를 늘린다"},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#생태계보존 #생명존중"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"솔라펑크(Solarpunk) 친환경 미래 3D 스타일 (푸른 자연 생태계와 첨단 과학기술의 조화)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"인공지능(AI)사물인식기능으로 식물의 종류를 알수있다, 배터리를 등에달린 태양열  발전기를 이용해 충전할수있다, 밤에는 압전 소자를 이용해 밤에도 움직일수있다"},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"로봇의 카메라 센서가 빛나며 식물의 종류중 정확히 원하는 식물을 찾아낸다을 스캔한 뒤, 식물이 다치지않게 다니고 식물의 정보를 최취한다하며 손가락에서 나오는 면봉으로 식물 세포를 추출해서 손목에 있는 냉동고로  DNA를 추출할수있다. 삽모양의 식물의 꽃을 최취해 멸종위기종 식물을 인공 수성을 시켜 개체수를 늘린다"},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"카메라 센서(새로운 식물을 인식), 온도 센서(몸체에서 식물을 키울수있게 식물이 사는 지역 온도를 찾음)","sensorAction":"삽모양 팔로 다치지 않게 식물을 뽑아 인공 수정을 시킨다,식물을 몸체에서 키움","sensorTarget":"여럿종류의 식물중 원하는 식물을 찾아냄,식물이 사는 온도분석한다."},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"씨드 가디언 플렌트-X","appearance":"정사각형 몸체에 배쪽에 내모난 유리안에 흙과 식물이있다. 머리는 둥근모양이다. 지구 온난화로 인해 추운 지역에사는 식물들이 멸종위기종이된 식물을 인공 교배를 시켜 개체수를 늘린다 현장에서 다리는 2개이며 팔이 4개이며 손바닥에서 자동으로 썩는 캡슐에 담긴 씨앗이 나온다. 손가락으로 식물의 DNA를 추출할수있다. 손목에 냉동고가 있으며,냉동고에는 태양열 발전기가 있다.또한 등에도 발전기가 달려있다.동물들이 경계하지 않도록 몸에 식물이 달려있다.몸통은 티타늄으로 되있다.팔은 강철선으로 되있다.팔4개이며 팔2개는 삽모양이다 .머리는 긴원형이며 눈은 길게 하나로 이루워져있다 .발에는 미끄러지지않게 고무로 되어있다. 최취한 식물은 몸체에 넣어다닌다. 몸체에는 식물이 달려있으며 바퀴달린 다리로 4족 보행을한다."}},"submittedAt":"2026-11-16T02:48:36.216Z","videoPrompt":"[AI 영상 제작] 푸른 나무와 빛나는 자연이 어우러진 2050년 미래 생태 숲 현장에서, 정사각형 몸체에 배쪽에 내모난 유리안에 흙과 식물이있다, 머리는 둥근형태, 지구 온난화로 인해 추운 지역에사는 식물들이 멸종위기종이된 식물을 인공 교배를 시켜 개체수를 늘린다 현장에서 다리는 2개이며 팔이 4개이며 손바닥에서 자동으로 썩는 캡슐에 담긴 씨앗이 나온다 외형을 갖춘 로봇 '씨드 가디언 플렌트-X'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 카메라 센서, 온도 센서에 푸른 스캔 라이트가 켜지며(여럿종류의 식물중 원하는 식물을 찾아냄,식물이 사는 온도분석한다) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 삽모양 팔로 다치지 않게 식물을 뽑아 인공 수정을 시킨다,식물을 몸체에서 키움, 로봇의 카메라 센서가 빛나며 식물의 하며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 솔라펑크 친환경 미래 3D 스타일 동영상.","teacherFeedbackBefore":""},{"label":"버전 11 (10차 수정)","inputs":{"purpose":"지구 온난화로 인해 멸종위기종의 추운 지역에 사는 식물을 인공 교배를 시켜 개체수를 늘린다","robotName":"씨드 가디언 플렌트-X","aiFeedback":{"date":"2026-11-16","count":2,"step1":"연호가 만든 로봇은 아주 튼튼해 보여요! 로봇이 험한 추운 지역을 다닐 때 미끄러지지 않도록 발바닥에 '마찰력 센서'나 '미끄럼 방지 고무 패드'를 추가하면 더 안정적일 것 같아요.","step2":"멸종 위기 식물을 지키는 목적이 정말 따뜻하고 멋져요! 단순히 개체 수를 늘리는 것 외에도, 식물이 자라기 좋은 토양의 습도나 영양분을 조절하는 기능까지 더하면 지구 환경을 더 완벽하게 도울 수 있을 거예요.","step3":"손가락 면봉과 삽 팔 아이디어가 참신하네요! 식물을 다룰 때 너무 강한 힘이 들어가면 다칠 수 있으니, 아주 섬세하게 움직일 수 있는 '압력 센서'를 팔 끝에 넣어보자고 하면 더 과학적이 될 거예요.","step4":"카메라로 식물을 찾는 건 아주 좋아요! 여기서 한 걸음 더 나아가, 주변 온도를 감지하는 '온도 센서'를 추가해서 식물이 자라기 딱 좋은 최적의 온도를 스스로 찾아가도록 하면 어떨까요?","step5":"태양열 발전 아이디어가 아주 훌륭해요! 태양 빛이 부족한 추운 밤을 대비해서 식물의 흔들림에서 에너지를 얻는 '압전 소자' 기술을 추가하면 로봇이 24시간 멈추지 않고 일할 수 있을 거예요.","updatedAt":"2026-11-16T00:21:39.553Z"},"appearance":"정사각형 몸체에 배쪽에 내모난 유리안에 흙과 식물이있다. 머리는 둥근모양이다. 지구 온난화로 인해 추운 지역에사는 식물들이 멸종위기종이된 식물을 인공 교배를 시켜 개체수를 늘린다 현장에서 다리는 2개이며 팔이 4개이며 손바닥에서 자동으로 썩는 캡슐에 담긴 씨앗이 나온다. 손가락으로 식물의 DNA를 추출할수있다. 손목에 냉동고가 있으며,냉동고에는 태양열 발전기가 있다.또한 등에도 발전기가 달려있다.동물들이 경계하지 않도록 몸에 식물이 달려있다.몸통은 티타늄으로 되있다.팔은 강철선으로 되있다.팔4개이며 팔2개는 삽모양이다 .머리는 긴원형이며 눈은 길게 하나로 이루워져있다 .발에는 미끄러지지않게 고무로 되어있다. 최취한 식물은 몸체에 넣어다닌다. 몸체에는 식물이 달려있으며 바퀴달린 다리로 4족 보행을한다.","coreValues":"#생태계보존 #생명존중","sensorName":"카메라 센서(새로운 식물을 인식), 온도 센서(몸체에서 식물을 키울수있게 식물이 사는 지역 온도를 찾음)","videoStyle":"솔라펑크(Solarpunk) 친환경 미래 3D 스타일 (푸른 자연 생태계와 첨단 과학기술의 조화)","scienceTech":"인공지능(AI)사물인식기능으로 식물의 종류를 알수있다, 배터리를 등에달린 태양열  발전기를 이용해 충전할수있다, 밤에는 압전 소자를 이용해 밤에도 움직일수있다","mainFunction":"로봇의 카메라 센서가 빛나며 식물의 종류중 정확히 원하는 식물을 찾아낸다을 스캔한 뒤, 식물이 다치지않게 다니고 식물의 정보를 최취한다하며 손가락에서 나오는 면봉으로 식물 세포를 추출해서 손목에 있는 냉동고로  DNA를 추출할수있다. 삽모양의 식물의 꽃을 최취해 멸종위기종 식물을 인공 수성을 시켜 개체수를 늘린다","sensorAction":"삽모양 팔로 다치지 않게 식물을 뽑아 인공 수정을 시킨다,식물을 몸체에서 키움","sensorTarget":"여럿종류의 식물중 원하는 식물을 찾아냄,식물이 사는 온도분석한다.","boothComments":[],"customVideoPrompt":"","deletedCommentIds":[]},"version":11,"specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"지구 온난화로 인해 멸종위기종의 추운 지역에 사는 식물을 인공 교배를 시켜 개체수를 늘린다"},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#생태계보존 #생명존중"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"솔라펑크(Solarpunk) 친환경 미래 3D 스타일 (푸른 자연 생태계와 첨단 과학기술의 조화)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"인공지능(AI)사물인식기능으로 식물의 종류를 알수있다, 배터리를 등에달린 태양열  발전기를 이용해 충전할수있다, 밤에는 압전 소자를 이용해 밤에도 움직일수있다"},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"로봇의 카메라 센서가 빛나며 식물의 종류중 정확히 원하는 식물을 찾아낸다을 스캔한 뒤, 식물이 다치지않게 다니고 식물의 정보를 최취한다하며 손가락에서 나오는 면봉으로 식물 세포를 추출해서 손목에 있는 냉동고로  DNA를 추출할수있다. 삽모양의 식물의 꽃을 최취해 멸종위기종 식물을 인공 수성을 시켜 개체수를 늘린다"},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"카메라 센서(새로운 식물을 인식), 온도 센서(몸체에서 식물을 키울수있게 식물이 사는 지역 온도를 찾음)","sensorAction":"삽모양 팔로 다치지 않게 식물을 뽑아 인공 수정을 시킨다,식물을 몸체에서 키움","sensorTarget":"여럿종류의 식물중 원하는 식물을 찾아냄,식물이 사는 온도분석한다."},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"씨드 가디언 플렌트-X","appearance":"정사각형 몸체에 배쪽에 내모난 유리안에 흙과 식물이있다. 머리는 둥근모양이다. 지구 온난화로 인해 추운 지역에사는 식물들이 멸종위기종이된 식물을 인공 교배를 시켜 개체수를 늘린다 현장에서 다리는 2개이며 팔이 4개이며 손바닥에서 자동으로 썩는 캡슐에 담긴 씨앗이 나온다. 손가락으로 식물의 DNA를 추출할수있다. 손목에 냉동고가 있으며,냉동고에는 태양열 발전기가 있다.또한 등에도 발전기가 달려있다.동물들이 경계하지 않도록 몸에 식물이 달려있다.몸통은 티타늄으로 되있다.팔은 강철선으로 되있다.팔4개이며 팔2개는 삽모양이다 .머리는 긴원형이며 눈은 길게 하나로 이루워져있다 .발에는 미끄러지지않게 고무로 되어있다. 최취한 식물은 몸체에 넣어다닌다. 몸체에는 식물이 달려있으며 바퀴달린 다리로 4족 보행을한다."}},"submittedAt":"2026-11-16T02:48:40.068Z","videoPrompt":"[AI 영상 제작] 푸른 나무와 빛나는 자연이 어우러진 2050년 미래 생태 숲 현장에서, 정사각형 몸체에 배쪽에 내모난 유리안에 흙과 식물이있다, 머리는 둥근형태, 지구 온난화로 인해 추운 지역에사는 식물들이 멸종위기종이된 식물을 인공 교배를 시켜 개체수를 늘린다 현장에서 다리는 2개이며 팔이 4개이며 손바닥에서 자동으로 썩는 캡슐에 담긴 씨앗이 나온다 외형을 갖춘 로봇 '씨드 가디언 플렌트-X'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 카메라 센서, 온도 센서에 푸른 스캔 라이트가 켜지며(여럿종류의 식물중 원하는 식물을 찾아냄,식물이 사는 온도분석한다) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 삽모양 팔로 다치지 않게 식물을 뽑아 인공 수정을 시킨다,식물을 몸체에서 키움, 로봇의 카메라 센서가 빛나며 식물의 하며 연속된 동작으로 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 솔라펑크 친환경 미래 3D 스타일 동영상.","teacherFeedbackBefore":""}],"updatedAt":"2026-11-17T00:15:45.146Z"},{"studentId":"김윤서","studentName":"김윤서","status":"approved","inputs":{"robotName":"돌봄 로봇","appearance":"깡통처럼 매끈한 재질과 사람처럼 두 발로 서 있을 수 있으며 휴면로이드 로봇처럼 생겼다. 아이들과 부딪혀도 안전한 말랑말랑한 소프트 로봇 신소재를 사용한다. 또, 미끄럼 방지 구조가 발바닥에 있다.","purpose":"집에서, 저출산 때문에 아이들이 줄어든 지금, 아이를 대신 키우는 부담이 줄어 저출산 문제가 해결 할 수 있다. 또, 어른들 대신 아이들의 교육을 돕는다거나 안정을 돕는다.","mainFunction":"로봇이 다리로 움직여 다리 관절에 부드러운 움직임을 위해 공압 액추에디터 라는 기술이 있다. 몸통 속 스마트기기가 있어, 아이들을 처음 키우는 어른들에게 도움을 줄 수 있다. 그리고 등판에 건전지가 있어서 충전할 필요가 없다.","sensorName":"#체온센서 #심박수센서","sensorTarget":"인공지능 아이들의 체온과 심박수을 측정한다. 또, 음성 인식 센서의 기능이 있다. 그리고, 인공지능 감지 센서에 적외선 카메라가 있다.","sensorAction":"감지해서 아이들의 심박수 또는 체온이 평균보다 높으면 몸 속 스마트기기를 연결해 곧바로 어른에게 연락하거나 병원에 연락한다. 또, 음성 인식 기능과 상대의 목소리 톤을 분석해 기분을 살핀다.그리고, 적외선 카메라로 어두운 곳에서도 아이를 잘 볼 수 있다.","scienceTech":"인공지능 (AI) 사물인식 기능으로 생물을 구별하고 무선 충전(건전지)로 전기를 사용을 자주 안 해서 친환경적이다. 또, 로봇이 아이와 함께 있을 때 자연스럽게 짓는 표정의 감정 표현 기술이 있다.","coreValues":"#인구증가 #아이돌봄","videoStyle":"고화질 2D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)","customVideoPrompt":"[AI 영상 제작] 2050년 미래형 평범하고 따뜻한 집에서, 깡통처럼 매끈한 재질과 사람처럼 두 발로 서 있을 수 있으며 휴면로이드 로봇처럼, 귀엽고 깜찍한 아이와 부딪혀도 안전한 말랑말랑한 소프트 로봇 신소재를 사용한다 외형을 갖춘 로봇 '돌봄 로봇'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 체온센서 심박수센서에 매우 연한 스캔 라이트가 켜지며(인공지능 노인들의 체온과 심박수) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 아이 곁으로 부드럽게 다가가 친근한 제스처와 다정하게 교감하며, 등판의 매우 작은 건전지로 에너지를 충전하며 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 2D 애니메이션 스타일 동영상.","aiFeedback":{"date":"2026-11-16","count":3,"step1":"윤서 학생, 말랑말랑한 신소재를 생각한 점이 정말 멋져요! 로봇이 아이들을 안아줄 때 얼마나 포근할까요? 로봇의 관절이 사람처럼 유연하게 움직이도록 돕는 '인공 근육' 기술을 추가하면 훨씬 더 실감 나는 로봇이 될 거예요.","step2":"저출산이라는 무거운 주제를 로봇으로 해결하려는 따뜻한 마음이 느껴져요! 아이들의 심리적 안정이나 언어 교육을 돕는다는 구체적인 목표를 더하면 로봇이 아이들에게 왜 꼭 필요한지 더 잘 드러날 거예요.","step3":"공압 액추에이터를 사용한 점이 아주 똑똑해요! 등판의 건전지 대신 햇빛을 받으면 전기를 만드는 '태양광 셀'이나 스스로 에너지를 만드는 '압전 소자' 기술을 넣으면 충전 걱정 없는 완벽한 친환경 로봇이 된답니다.","step4":"센서 이름과 행동을 잘 연결했어요! 여기에 아이의 위치를 파악하는 'GPS 센서'나 어두운 곳에서도 아이를 잘 볼 수 있는 '적외선 카메라' 기능을 추가하면 더욱 든든한 돌봄 친구가 될 거예요.","step5":"AI를 활용한 점이 아주 훌륭해요! 로봇이 아이와 대화할 때 자연스럽게 표정을 짓는 '감정 표현 기술'이나, 아이가 넘어지지 않게 균형을 잡는 '자이로 센서' 원리를 추가해 보면 과학 지식이 훨씬 풍성해질 거예요.","updatedAt":"2026-11-16T02:36:30.975Z"},"boothComments":[{"v":2,"id":"c_1794873624942_9e0fi","text":"로봇 약간 텔레토비인가 거기에 나올 것 같이 생겨써ㅓㅓ","author":"이수아","createdAt":"2026-11-17T00:00:24.942Z","viewerToken":"vt_1794799212191_bqc4jkhg","authorStudentId":""},{"v":2,"id":"c_1794873704442_pr4jj","text":"미래에 정말 필요할 것 같은 기술이야","author":"김서은","createdAt":"2026-11-17T00:01:44.442Z","viewerToken":"vt_1794873117429_t91qscap","authorStudentId":"김서은"},{"v":2,"id":"c_1794873763788_t29tu","text":"아이가 행복해 할 것 같아!! 정말 좋은 아이디어야","author":"장서윤","createdAt":"2026-11-17T00:02:43.788Z","viewerToken":"vt_1794796665307_ra6syqil","authorStudentId":"장서윤"},{"v":2,"id":"c_1794873932256_cu5g0","text":"외형에 휴면로이드라고 썻는데 휴머노이드야 몰랐으면 도움이 되기를 바래","author":"박성민","createdAt":"2026-11-17T00:05:32.257Z","viewerToken":"vt_1794797170972_uk8wojcz","authorStudentId":"박성민"},{"v":2,"id":"c_1794874045317_oztqs","text":"이야ㅑㅑㅑㅑㅑㅑㅑ아아아아ㅏ아아아아아아앙","author":"김승윤","createdAt":"2026-11-17T00:07:25.318Z","viewerToken":"vt_1794796086113_pfa1lkx5","authorStudentId":"김승윤"},{"v":2,"id":"c_1794874174718_0b1vj","text":"정말 나중에 도움이 될것같아 그리구 기여워❣️","author":"김지안","createdAt":"2026-11-17T00:09:34.719Z","viewerToken":"vt_1794796070701_4iqa9fd3","authorStudentId":"김지안"},{"v":2,"id":"c_1794874276126_4yn7z","text":"돌봄 로봇이 착해보이고 아이가 혼자있을때 외롭지 않을거 같아","author":"진예원","createdAt":"2026-11-17T00:11:16.126Z","viewerToken":"vt_1794796813857_o43fsiny","authorStudentId":"진예원"},{"v":2,"id":"c_1794874289495_29d63","text":"맞벌이 가족에게는 정말 필요한 로봇인거 같앙!","author":"이혜원","createdAt":"2026-11-17T00:11:29.495Z","viewerToken":"vt_1794873061965_2edypenz","authorStudentId":"이혜원"},{"v":2,"id":"c_1794874557173_0a3g8","text":"아기가 웃는게 넘ㅁㅁ무 기여버어어어엉","author":"신다빈","createdAt":"2026-11-17T00:15:57.173Z","viewerToken":"vt_1794796192899_42ggb0j9","authorStudentId":"신다빈"}],"deletedCommentIds":["c_1794873636250_u1dfa","c_1794873237152_225gp"]},"videoPrompt":"[AI 영상 제작] 2050년 미래형 평범하고 따뜻한 집에서, 깡통처럼 매끈한 재질과 사람처럼 두 발로 서 있을 수 있으며 휴면로이드 로봇처럼, 귀엽고 깜찍한 아이와 부딪혀도 안전한 말랑말랑한 소프트 로봇 신소재를 사용한다 외형을 갖춘 로봇 '돌봄 로봇'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 체온센서 심박수센서에 매우 연한 스캔 라이트가 켜지며(인공지능 노인들의 체온과 심박수) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 아이 곁으로 부드럽게 다가가 친근한 제스처와 다정하게 교감하며, 등판의 매우 작은 건전지로 에너지를 충전하며 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 2D 애니메이션 스타일 동영상.","specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"집에서, 저출산 때문에 아이들이 줄어든 지금, 아이를 대신 키우는 부담이 줄어 저출산 문제가 해결 할 수 있다. 또, 어른들 대신 아이들의 교육을 돕는다거나 안정을 돕는다."},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#인구증가 #아이돌봄"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"고화질 2D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"인공지능 (AI) 사물인식 기능으로 생물을 구별하고 무선 충전(건전지)로 전기를 사용을 자주 안 해서 친환경적이다. 또, 로봇이 아이와 함께 있을 때 자연스럽게 짓는 표정의 감정 표현 기술이 있다."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"로봇이 다리로 움직여 다리 관절에 부드러운 움직임을 위해 공압 액추에디터 라는 기술이 있다. 몸통 속 스마트기기가 있어, 아이들을 처음 키우는 어른들에게 도움을 줄 수 있다. 그리고 등판에 건전지가 있어서 충전할 필요가 없다."},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"#체온센서 #심박수센서","sensorAction":"감지해서 아이들의 심박수 또는 체온이 평균보다 높으면 몸 속 스마트기기를 연결해 곧바로 어른에게 연락하거나 병원에 연락한다. 또, 음성 인식 기능과 상대의 목소리 톤을 분석해 기분을 살핀다.그리고, 적외선 카메라로 어두운 곳에서도 아이를 잘 볼 수 있다.","sensorTarget":"인공지능 아이들의 체온과 심박수을 측정한다. 또, 음성 인식 센서의 기능이 있다. 그리고, 인공지능 감지 센서에 적외선 카메라가 있다."},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"돌봄 로봇","appearance":"깡통처럼 매끈한 재질과 사람처럼 두 발로 서 있을 수 있으며 휴면로이드 로봇처럼 생겼다. 아이들과 부딪혀도 안전한 말랑말랑한 소프트 로봇 신소재를 사용한다. 또, 미끄럼 방지 구조가 발바닥에 있다."}},"teacherFeedback":"","feedbackAt":"","video":{"type":"none","url":"","title":"","thumbnail":""},"likes":9,"currentVersion":6,"history":[{"label":"버전 5 (4차 수정)","inputs":{"purpose":"집에서, 저출산 때문에 아이들이 줄어든 지금, 아이를 대신 키우는 부담이 줄어 저출산 문제가 해결 할 수 있다. 또, 어른들 대신 아이들의 교육을 돕는다거나 안정을 돕는다.","robotName":"돌봄 로봇","aiFeedback":{"date":"2026-11-16","count":3,"step1":"윤서 학생, 말랑말랑한 신소재를 생각한 점이 정말 멋져요! 로봇이 아이들을 안아줄 때 얼마나 포근할까요? 로봇의 관절이 사람처럼 유연하게 움직이도록 돕는 '인공 근육' 기술을 추가하면 훨씬 더 실감 나는 로봇이 될 거예요.","step2":"저출산이라는 무거운 주제를 로봇으로 해결하려는 따뜻한 마음이 느껴져요! 아이들의 심리적 안정이나 언어 교육을 돕는다는 구체적인 목표를 더하면 로봇이 아이들에게 왜 꼭 필요한지 더 잘 드러날 거예요.","step3":"공압 액추에이터를 사용한 점이 아주 똑똑해요! 등판의 건전지 대신 햇빛을 받으면 전기를 만드는 '태양광 셀'이나 스스로 에너지를 만드는 '압전 소자' 기술을 넣으면 충전 걱정 없는 완벽한 친환경 로봇이 된답니다.","step4":"센서 이름과 행동을 잘 연결했어요! 여기에 아이의 위치를 파악하는 'GPS 센서'나 어두운 곳에서도 아이를 잘 볼 수 있는 '적외선 카메라' 기능을 추가하면 더욱 든든한 돌봄 친구가 될 거예요.","step5":"AI를 활용한 점이 아주 훌륭해요! 로봇이 아이와 대화할 때 자연스럽게 표정을 짓는 '감정 표현 기술'이나, 아이가 넘어지지 않게 균형을 잡는 '자이로 센서' 원리를 추가해 보면 과학 지식이 훨씬 풍성해질 거예요.","updatedAt":"2026-11-16T02:36:30.975Z"},"appearance":"깡통처럼 매끈한 재질과 사람처럼 두 발로 서 있을 수 있으며 휴면로이드 로봇처럼 생겼다. 아이들과 부딪혀도 안전한 말랑말랑한 소프트 로봇 신소재를 사용한다. 또, 미끄럼 방지 구조가 발바닥에 있다.","coreValues":"#인구증가 #아이돌봄","sensorName":"#체온센서 #심박수센서","videoStyle":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)","scienceTech":"인공지능 (AI) 사물인식 기능으로 생물을 구별하고 무선 충전(건전지)로 전기를 사용을 자주 안 해서 친환경적이다. 또, 로봇이 아이와 함께 있을 때 자연스럽게 짓는 표정의 감정 표현 기술이 있다.","mainFunction":"로봇이 다리로 움직여 다리 관절에 부드러운 움직임을 위해 공압 액추에디터 라는 기술이 있다. 몸통 속 스마트기기가 있어, 아이들을 처음 키우는 어른들에게 도움을 줄 수 있다. 그리고 등판에 건전지가 있어서 충전할 필요가 없다.","sensorAction":"감지해서 아이들의 심박수 또는 체온이 평균보다 높으면 몸 속 스마트기기를 연결해 곧바로 어른에게 연락하거나 병원에 연락한다. 또, 음성 인식 기능과 상대의 목소리 톤을 분석해 기분을 살핀다.\n그리고, 적외선 카메라로 어두운 곳에서도 아이를 잘 볼 수 있다.","sensorTarget":"인공지능 아이들의 체온과 심박수을 측정한다. 또, 음성 인식 센서의 기능이 있다. 그리고, 인공지능 감지 센서에 적외선 카메라가 있다.","boothComments":[],"customVideoPrompt":"[AI 영상 제작] 2050년 미래형 평범하고 따뜻한 집에서, 깡통처럼 매끈한 재질과 사람처럼 두 발로 서 있을 수 있으며 휴면로이드 로봇처럼, 귀엽고 깜찍한 아이와 부딪혀도 안전한 말랑말랑한 소프트 로봇 신소재를 사용한다 외형을 갖춘 로봇 '돌봄 로봇'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 체온센서 심박수센서에 매우 연한 스캔 라이트가 켜지며(인공지능 노인들의 체온과 심박수) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 아이 곁으로 부드럽게 다가가 친근한 제스처와 다정하게 교감하며, 등판의 매우 작은 건전지로 에너지를 충전하며 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상.","deletedCommentIds":[]},"version":5,"specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"집에서, 저출산 때문에 아이들이 줄어든 지금, 아이를 대신 키우는 부담이 줄어 저출산 문제가 해결 할 수 있다. 또, 어른들 대신 아이들의 교육을 돕는다거나 안정을 돕는다."},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#인구증가 #아이돌봄"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"고화질 3D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"인공지능 (AI) 사물인식 기능으로 생물을 구별하고 무선 충전(건전지)로 전기를 사용을 자주 안 해서 친환경적이다. 또, 로봇이 아이와 함께 있을 때 자연스럽게 짓는 표정의 감정 표현 기술이 있다."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"로봇이 다리로 움직여 다리 관절에 부드러운 움직임을 위해 공압 액추에디터 라는 기술이 있다. 몸통 속 스마트기기가 있어, 아이들을 처음 키우는 어른들에게 도움을 줄 수 있다. 그리고 등판에 건전지가 있어서 충전할 필요가 없다."},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"#체온센서 #심박수센서","sensorAction":"감지해서 아이들의 심박수 또는 체온이 평균보다 높으면 몸 속 스마트기기를 연결해 곧바로 어른에게 연락하거나 병원에 연락한다. 또, 음성 인식 기능과 상대의 목소리 톤을 분석해 기분을 살핀다.\n그리고, 적외선 카메라로 어두운 곳에서도 아이를 잘 볼 수 있다.","sensorTarget":"인공지능 아이들의 체온과 심박수을 측정한다. 또, 음성 인식 센서의 기능이 있다. 그리고, 인공지능 감지 센서에 적외선 카메라가 있다."},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"돌봄 로봇","appearance":"깡통처럼 매끈한 재질과 사람처럼 두 발로 서 있을 수 있으며 휴면로이드 로봇처럼 생겼다. 아이들과 부딪혀도 안전한 말랑말랑한 소프트 로봇 신소재를 사용한다. 또, 미끄럼 방지 구조가 발바닥에 있다."}},"submittedAt":"2026-11-16T03:18:50.007Z","videoPrompt":"[AI 영상 제작] 2050년 미래형 평범하고 따뜻한 집에서, 깡통처럼 매끈한 재질과 사람처럼 두 발로 서 있을 수 있으며 휴면로이드 로봇처럼, 귀엽고 깜찍한 아이와 부딪혀도 안전한 말랑말랑한 소프트 로봇 신소재를 사용한다 외형을 갖춘 로봇 '돌봄 로봇'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 체온센서 심박수센서에 매우 연한 스캔 라이트가 켜지며(인공지능 노인들의 체온과 심박수) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 아이 곁으로 부드럽게 다가가 친근한 제스처와 다정하게 교감하며, 등판의 매우 작은 건전지로 에너지를 충전하며 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 3D 애니메이션 스타일 동영상.","teacherFeedbackBefore":""},{"label":"버전 6 (5차 수정)","inputs":{"purpose":"집에서, 저출산 때문에 아이들이 줄어든 지금, 아이를 대신 키우는 부담이 줄어 저출산 문제가 해결 할 수 있다. 또, 어른들 대신 아이들의 교육을 돕는다거나 안정을 돕는다.","robotName":"돌봄 로봇","aiFeedback":{"date":"2026-11-16","count":3,"step1":"윤서 학생, 말랑말랑한 신소재를 생각한 점이 정말 멋져요! 로봇이 아이들을 안아줄 때 얼마나 포근할까요? 로봇의 관절이 사람처럼 유연하게 움직이도록 돕는 '인공 근육' 기술을 추가하면 훨씬 더 실감 나는 로봇이 될 거예요.","step2":"저출산이라는 무거운 주제를 로봇으로 해결하려는 따뜻한 마음이 느껴져요! 아이들의 심리적 안정이나 언어 교육을 돕는다는 구체적인 목표를 더하면 로봇이 아이들에게 왜 꼭 필요한지 더 잘 드러날 거예요.","step3":"공압 액추에이터를 사용한 점이 아주 똑똑해요! 등판의 건전지 대신 햇빛을 받으면 전기를 만드는 '태양광 셀'이나 스스로 에너지를 만드는 '압전 소자' 기술을 넣으면 충전 걱정 없는 완벽한 친환경 로봇이 된답니다.","step4":"센서 이름과 행동을 잘 연결했어요! 여기에 아이의 위치를 파악하는 'GPS 센서'나 어두운 곳에서도 아이를 잘 볼 수 있는 '적외선 카메라' 기능을 추가하면 더욱 든든한 돌봄 친구가 될 거예요.","step5":"AI를 활용한 점이 아주 훌륭해요! 로봇이 아이와 대화할 때 자연스럽게 표정을 짓는 '감정 표현 기술'이나, 아이가 넘어지지 않게 균형을 잡는 '자이로 센서' 원리를 추가해 보면 과학 지식이 훨씬 풍성해질 거예요.","updatedAt":"2026-11-16T02:36:30.975Z"},"appearance":"깡통처럼 매끈한 재질과 사람처럼 두 발로 서 있을 수 있으며 휴면로이드 로봇처럼 생겼다. 아이들과 부딪혀도 안전한 말랑말랑한 소프트 로봇 신소재를 사용한다. 또, 미끄럼 방지 구조가 발바닥에 있다.","coreValues":"#인구증가 #아이돌봄","sensorName":"#체온센서 #심박수센서","videoStyle":"고화질 2D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)","scienceTech":"인공지능 (AI) 사물인식 기능으로 생물을 구별하고 무선 충전(건전지)로 전기를 사용을 자주 안 해서 친환경적이다. 또, 로봇이 아이와 함께 있을 때 자연스럽게 짓는 표정의 감정 표현 기술이 있다.","mainFunction":"로봇이 다리로 움직여 다리 관절에 부드러운 움직임을 위해 공압 액추에디터 라는 기술이 있다. 몸통 속 스마트기기가 있어, 아이들을 처음 키우는 어른들에게 도움을 줄 수 있다. 그리고 등판에 건전지가 있어서 충전할 필요가 없다.","sensorAction":"감지해서 아이들의 심박수 또는 체온이 평균보다 높으면 몸 속 스마트기기를 연결해 곧바로 어른에게 연락하거나 병원에 연락한다. 또, 음성 인식 기능과 상대의 목소리 톤을 분석해 기분을 살핀다.그리고, 적외선 카메라로 어두운 곳에서도 아이를 잘 볼 수 있다.","sensorTarget":"인공지능 아이들의 체온과 심박수을 측정한다. 또, 음성 인식 센서의 기능이 있다. 그리고, 인공지능 감지 센서에 적외선 카메라가 있다.","boothComments":[],"customVideoPrompt":"[AI 영상 제작] 2050년 미래형 평범하고 따뜻한 집에서, 깡통처럼 매끈한 재질과 사람처럼 두 발로 서 있을 수 있으며 휴면로이드 로봇처럼, 귀엽고 깜찍한 아이와 부딪혀도 안전한 말랑말랑한 소프트 로봇 신소재를 사용한다 외형을 갖춘 로봇 '돌봄 로봇'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 체온센서 심박수센서에 매우 연한 스캔 라이트가 켜지며(인공지능 노인들의 체온과 심박수) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 아이 곁으로 부드럽게 다가가 친근한 제스처와 다정하게 교감하며, 등판의 매우 작은 건전지로 에너지를 충전하며 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 2D 애니메이션 스타일 동영상.","deletedCommentIds":[]},"version":6,"specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"집에서, 저출산 때문에 아이들이 줄어든 지금, 아이를 대신 키우는 부담이 줄어 저출산 문제가 해결 할 수 있다. 또, 어른들 대신 아이들의 교육을 돕는다거나 안정을 돕는다."},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#인구증가 #아이돌봄"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"고화질 2D 애니메이션 스타일 (밝고 입체적인 미래 도시와 정교한 로봇 연출)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"인공지능 (AI) 사물인식 기능으로 생물을 구별하고 무선 충전(건전지)로 전기를 사용을 자주 안 해서 친환경적이다. 또, 로봇이 아이와 함께 있을 때 자연스럽게 짓는 표정의 감정 표현 기술이 있다."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"로봇이 다리로 움직여 다리 관절에 부드러운 움직임을 위해 공압 액추에디터 라는 기술이 있다. 몸통 속 스마트기기가 있어, 아이들을 처음 키우는 어른들에게 도움을 줄 수 있다. 그리고 등판에 건전지가 있어서 충전할 필요가 없다."},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"#체온센서 #심박수센서","sensorAction":"감지해서 아이들의 심박수 또는 체온이 평균보다 높으면 몸 속 스마트기기를 연결해 곧바로 어른에게 연락하거나 병원에 연락한다. 또, 음성 인식 기능과 상대의 목소리 톤을 분석해 기분을 살핀다.그리고, 적외선 카메라로 어두운 곳에서도 아이를 잘 볼 수 있다.","sensorTarget":"인공지능 아이들의 체온과 심박수을 측정한다. 또, 음성 인식 센서의 기능이 있다. 그리고, 인공지능 감지 센서에 적외선 카메라가 있다."},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"돌봄 로봇","appearance":"깡통처럼 매끈한 재질과 사람처럼 두 발로 서 있을 수 있으며 휴면로이드 로봇처럼 생겼다. 아이들과 부딪혀도 안전한 말랑말랑한 소프트 로봇 신소재를 사용한다. 또, 미끄럼 방지 구조가 발바닥에 있다."}},"submittedAt":"2026-11-16T03:30:00.745Z","videoPrompt":"[AI 영상 제작] 2050년 미래형 평범하고 따뜻한 집에서, 깡통처럼 매끈한 재질과 사람처럼 두 발로 서 있을 수 있으며 휴면로이드 로봇처럼, 귀엽고 깜찍한 아이와 부딪혀도 안전한 말랑말랑한 소프트 로봇 신소재를 사용한다 외형을 갖춘 로봇 '돌봄 로봇'이 화면 중앙에 등장해 생동감 있게 움직이는 영상. 장착된 체온센서 심박수센서에 매우 연한 스캔 라이트가 켜지며(인공지능 노인들의 체온과 심박수) 주변을 입체 홀로그램 파장으로 정밀 스캔하는 클로즈업 장면에 이어, 로봇이 아이 곁으로 부드럽게 다가가 친근한 제스처와 다정하게 교감하며, 등판의 매우 작은 건전지로 에너지를 충전하며 임무를 수행하는 모습을 생생하게 보여준다. 와이드 샷에서 기계 관절 클로즈업으로 자연스럽게 이어지는 카메라 트래킹과 입체적인 조명으로 연출한 고화질 2D 애니메이션 스타일 동영상.","teacherFeedbackBefore":""}],"updatedAt":"2026-11-17T00:15:57.174Z"},{"studentId":"진연우","studentName":"진연우","status":"approved","inputs":{"robotName":"Mars-3D","appearance":"바퀴 빼고 가로는 220cm정도 세로, 높이는 190cm정도 크기이다. 바퀴는 무한궤도(캐터필더)호 양옆에 있고 방향을 바꿀때 바퀴가 방향을 이동하게한다. 본체안에 3d프린터가 있고 양역에는 기계팔이 있어서 주인이 cad를 주면 본체안에서 직접뽑고 화성 바닥으로 잉크를 만든다.다 만들면 작업물이 나오면서 기계팔이 어디에 둘지 카메라센서로 보고 그 위치에 둔다. 만약 주인이 위치를 지정하면 그곳에 둔다.겉면은 화성 바람으로 고장나지 않기 위해 단단하고 어느정도 무거워야 한다. 대부분 하얀색이다.","purpose":"만약 지구온난화로 지구말고  화성에 가게되면 재료는 없고 기지를 만들때 필요한 로봇이다.","mainFunction":"이동기능으로 이동한다.\n 3D프린팅 기술로 화성 땅으로 잉크 만들고 원하는 것을 만들수 있다\n조작운반 기술과 관절 구동 모터기술로 기계팔이 움직이며 자동배치 기술로 원하는 위치에 둔다.","sensorName":"카메라 센서, 통신용 센서, 초음파 센서,라이다 센서","sensorTarget":"지형, 작업물, 환경,사람들과의 거리","sensorAction":"화성에서 돌아다니는 사람들을 피하편서 만들어진 것을 지정된 위치에 가져간다.","scienceTech":"자율주행으로 사람들을 피하면서 다닌다. 실시간 통신기술로 주인이 위치를 지정하고 원성률을 확인할수 있다. 물질 추출 기술로 잉크를 만들고 알고리즘기술로 스스로 경로를 계산한다.","coreValues":"#효율성 #안전성","videoStyle":"정밀 메카닉 공학 시뮬레이션 스타일 (로봇 관절 구조와 내부 기계 작동 클로즈업),하이테크 과학 다큐멘터리 & 홀로그램 HUD 스타일 (센서 스캔 파동과 데이터 시각화 강조)","customVideoPrompt":"[AI Video Production] At a Mars exploration site in 2050, set against a red sand desert and a state-of-the-art dome base, the main body is square like a cube, and the 3D printer is inside the cube, so it is printing from within the main body and can move; except for the wheels, the main structure is always white. Simply put, a large 3D printer is moving, with mechanical arms on both sides to take things out and place them. Measuring about 220 cm wide and 190 cm high, with wheels on both sides of the tracked vehicle that change direction by being pulled out directly from inside the robot and ink applied to the Martian surface, the stylized robot 'Mars-3D' appears in the center of the screen, creating a vivid sense of movement.Blue scan lights illuminate the mounted camera sensors, smart detection sensors, ultrasonic sensors, and LiDAR sensors (detecting terrain, work objects, environment, and distance to people), followed by a close-up scan of the surroundings using three-dimensional holographic wavelengths. The robot then moves its robotic arms and nozzles to 3D print structures layer by layer, precisely place them at designated locations, and agilely steer to safely avoid nearby living organisms and obstacles, demonstrating its mission through continuous operation. Create precise mecha engineering simulation-style, high-tech science documentary and hologram HUD videos with camera tracking that flows naturally from wide shots to close-ups of mechanical joints.","aiFeedback":{"date":"2026-11-16","count":1,"step1":"Mars-3D라는 이름이 아주 멋져요! 로봇의 외형에 가볍고 튼튼한 '탄소 섬유' 신소재를 적용했다고 적어보면 어떨까요? 외부 충격에 강하게 보호하는 로봇의 모습을 더 자세히 상상해 보세요.","step2":"화성 기지 건설이라는 목적이 매우 훌륭해요! 여기에 화성의 강한 모래바람을 막아주는 '방진 설계'나 태양광을 사용하는 '친환경 에너지 기술'을 추가하면 훨씬 과학적인 이야기가 될 거예요.","step3":"3D 프린팅과 기계팔의 조합이 창의적이에요! 기계팔에 사람의 손처럼 정교하게 움직이는 '관절 구동 모터' 원리를 추가하면, 로봇이 어떻게 더 섬세하게 물건을 옮길지 설명할 수 있어요.","step4":"카메라와 초음파 센서로 사람을 피하는 모습이 잘 그려져요! 여기서 장애물의 거리를 계산하는 '라이다 센서'를 추가해 보세요. 로봇이 주변 지형을 더 똑똑하게 입체적으로 인식하게 될 거예요.","step5":"자율주행과 통신 기술은 필수적이에요! 여기에 화성에서 생성된 잉크를 만드는 '물질 추출 기술'이나 인공지능이 스스로 경로를 계산하는 '알고리즘 기술'을 더하면 정말 완벽한 설계도가 될 것 같아요.","updatedAt":"2026-11-16T00:12:10.027Z"},"boothComments":[{"v":2,"id":"c_1794873238480_h6p4n","text":"오오오오오오오 아이디어가 좋아!!!!","author":"장서윤","createdAt":"2026-11-16T23:53:58.480Z","viewerToken":"vt_1794796665307_ra6syqil","authorStudentId":"장서윤"},{"v":2,"id":"c_1794873334126_ch2u9","text":"아이디어 굿굿 그리고 영어로 쓴거 대단해!!","author":"김지아","createdAt":"2026-11-16T23:55:34.126Z","viewerToken":"vt_1794796098329_ixf8fbb4","authorStudentId":"김지아"},{"v":2,"id":"c_1794873489983_kqeqw","text":"영어라서 ㅈㅉ 있어보여 로봇이름부터 화성에 ㅈㅉ 갈수 있을것 가타","author":"이수아","createdAt":"2026-11-16T23:58:09.983Z","viewerToken":"vt_1794799212191_bqc4jkhg","authorStudentId":""},{"v":2,"id":"c_1794873642413_5cqu3","text":"로봇 완전 짱이다!! 진짜미래 사회에 필요할듯!!!","author":"공인경","createdAt":"2026-11-17T00:00:42.413Z","viewerToken":"vt_1794799986519_qjpt3033","authorStudentId":"공인경"},{"v":2,"id":"c_1794873766030_movmi","text":"WOW 정말 쩐다 AMAZING!!!","author":"이석준","createdAt":"2026-11-17T00:02:46.030Z","viewerToken":"vt_1794799215240_tjkhcvj5","authorStudentId":"이석준"},{"v":2,"id":"c_1794874092991_d4z5g","text":"우아ㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏㅏ","author":"김승윤","createdAt":"2026-11-17T00:08:12.991Z","viewerToken":"vt_1794796086113_pfa1lkx5","authorStudentId":"김승윤"},{"v":2,"id":"c_1794874489736_eqsyz","text":"와 엄청난 👍😍 이것은 엄청난이것이 있으면 재료가 필요 없을것 같은👍👍👍👍👍","author":"이원준","createdAt":"2026-11-17T00:14:49.736Z","viewerToken":"vt_1794873057588_6rghf8uo","authorStudentId":"이원준"},{"v":2,"id":"c_1794874544594_dteg6","text":"ㅇ게 나야😁😁😁😁😁😁😁😁","author":"진연우","createdAt":"2026-11-17T00:15:44.594Z","viewerToken":"vt_1794788838051_mpwskv0k","authorStudentId":"진연우"},{"v":2,"id":"c_1794874598471_ibswc","text":"와 브로. 그것은 완벽함 그 잡채야🤩 이정도면 화성에 기지를 만들 생각을 한거지?! 지구 온난화를 늦출수있겠어🤩🤩🤩 와 진짜, 브로는 천재야 어떻게 로봇을 화성에 날릴 생각을 한거지?! 브로는 그냥 그 상태로 조금만 연구하면 화성정복은 거뜬하겠는걸?!너무 멋져👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍👍","author":"김규혁","createdAt":"2026-11-17T00:16:38.471Z","viewerToken":"vt_1794796116808_09f96gop","authorStudentId":"김규혁"}],"deletedCommentIds":[]},"videoPrompt":"[AI Video Production] At a Mars exploration site in 2050, set against a red sand desert and a state-of-the-art dome base, the main body is square like a cube, and the 3D printer is inside the cube, so it is printing from within the main body and can move; except for the wheels, the main structure is always white. Simply put, a large 3D printer is moving, with mechanical arms on both sides to take things out and place them. Measuring about 220 cm wide and 190 cm high, with wheels on both sides of the tracked vehicle that change direction by being pulled out directly from inside the robot and ink applied to the Martian surface, the stylized robot 'Mars-3D' appears in the center of the screen, creating a vivid sense of movement.Blue scan lights illuminate the mounted camera sensors, smart detection sensors, ultrasonic sensors, and LiDAR sensors (detecting terrain, work objects, environment, and distance to people), followed by a close-up scan of the surroundings using three-dimensional holographic wavelengths. The robot then moves its robotic arms and nozzles to 3D print structures layer by layer, precisely place them at designated locations, and agilely steer to safely avoid nearby living organisms and obstacles, demonstrating its mission through continuous operation. Create precise mecha engineering simulation-style, high-tech science documentary and hologram HUD videos with camera tracking that flows naturally from wide shots to close-ups of mechanical joints.","specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"만약 지구온난화로 지구말고  화성에 가게되면 재료는 없고 기지를 만들때 필요한 로봇이다."},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#효율성 #안전성"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"정밀 메카닉 공학 시뮬레이션 스타일 (로봇 관절 구조와 내부 기계 작동 클로즈업),하이테크 과학 다큐멘터리 & 홀로그램 HUD 스타일 (센서 스캔 파동과 데이터 시각화 강조)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"자율주행으로 사람들을 피하면서 다닌다. 실시간 통신기술로 주인이 위치를 지정하고 원성률을 확인할수 있다. 물질 추출 기술로 잉크를 만들고 알고리즘기술로 스스로 경로를 계산한다."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"이동기능으로 이동한다.\n 3D프린팅 기술로 화성 땅으로 잉크 만들고 원하는 것을 만들수 있다\n조작운반 기술과 관절 구동 모터기술로 기계팔이 움직이며 자동배치 기술로 원하는 위치에 둔다."},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"카메라 센서, 통신용 센서, 초음파 센서,라이다 센서","sensorAction":"화성에서 돌아다니는 사람들을 피하편서 만들어진 것을 지정된 위치에 가져간다.","sensorTarget":"지형, 작업물, 환경,사람들과의 거리"},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"Mars-3D","appearance":"바퀴 빼고 가로는 220cm정도 세로, 높이는 190cm정도 크기이다. 바퀴는 무한궤도(캐터필더)호 양옆에 있고 방향을 바꿀때 바퀴가 방향을 이동하게한다. 본체안에 3d프린터가 있고 양역에는 기계팔이 있어서 주인이 cad를 주면 본체안에서 직접뽑고 화성 바닥으로 잉크를 만든다.다 만들면 작업물이 나오면서 기계팔이 어디에 둘지 카메라센서로 보고 그 위치에 둔다. 만약 주인이 위치를 지정하면 그곳에 둔다.겉면은 화성 바람으로 고장나지 않기 위해 단단하고 어느정도 무거워야 한다. 대부분 하얀색이다."}},"teacherFeedback":"","feedbackAt":"","video":{"type":"none","url":"","title":"","thumbnail":""},"likes":9,"currentVersion":8,"history":[{"label":"버전 7 (6차 수정)","inputs":{"purpose":"만약 지구온난화로 지구말고  화성에 가게되면 재료는 없고 기지를 만들때 필요한 로봇이다.","robotName":"Mars-3D","aiFeedback":{"date":"2026-11-16","count":1,"step1":"Mars-3D라는 이름이 아주 멋져요! 로봇의 외형에 가볍고 튼튼한 '탄소 섬유' 신소재를 적용했다고 적어보면 어떨까요? 외부 충격에 강하게 보호하는 로봇의 모습을 더 자세히 상상해 보세요.","step2":"화성 기지 건설이라는 목적이 매우 훌륭해요! 여기에 화성의 강한 모래바람을 막아주는 '방진 설계'나 태양광을 사용하는 '친환경 에너지 기술'을 추가하면 훨씬 과학적인 이야기가 될 거예요.","step3":"3D 프린팅과 기계팔의 조합이 창의적이에요! 기계팔에 사람의 손처럼 정교하게 움직이는 '관절 구동 모터' 원리를 추가하면, 로봇이 어떻게 더 섬세하게 물건을 옮길지 설명할 수 있어요.","step4":"카메라와 초음파 센서로 사람을 피하는 모습이 잘 그려져요! 여기서 장애물의 거리를 계산하는 '라이다 센서'를 추가해 보세요. 로봇이 주변 지형을 더 똑똑하게 입체적으로 인식하게 될 거예요.","step5":"자율주행과 통신 기술은 필수적이에요! 여기에 화성에서 생성된 잉크를 만드는 '물질 추출 기술'이나 인공지능이 스스로 경로를 계산하는 '알고리즘 기술'을 더하면 정말 완벽한 설계도가 될 것 같아요.","updatedAt":"2026-11-16T00:12:10.027Z"},"appearance":"바퀴 빼고 가로는 220cm정도 세로, 높이는 190cm정도 크기이다. 바퀴는 무한궤도(캐터필더)호 양옆에 있고 방향을 바꿀때 바퀴가 방향을 이동하게한다. 본체안에 3d프린터가 있고 양역에는 기계팔이 있어서 주인이 cad를 주면 본체안에서 직접뽑고 화성 바닥으로 잉크를 만든다.다 만들면 작업물이 나오면서 기계팔이 어디에 둘지 카메라센서로 보고 그 위치에 둔다. 만약 주인이 위치를 지정하면 그곳에 둔다.겉면은 화성 바람으로 고장나지 않기 위해 단단하고 어느정도 무거워야 한다. 대부분 하얀색이다.","coreValues":"#효율성 #안전성","sensorName":"카메라 센서, 통신용 센서, 초음파 센서,라이다 센서","videoStyle":"정밀 메카닉 공학 시뮬레이션 스타일 (로봇 관절 구조와 내부 기계 작동 클로즈업),하이테크 과학 다큐멘터리 & 홀로그램 HUD 스타일 (센서 스캔 파동과 데이터 시각화 강조)","scienceTech":"자율주행으로 사람들을 피하면서 다닌다. 실시간 통신기술로 주인이 위치를 지정하고 원성률을 확인할수 있다. 물질 추출 기술로 잉크를 만들고 알고리즘기술로 스스로 경로를 계산한다.","mainFunction":"이동기능으로 이동한다.\n 3D프린팅 기술로 화성 땅으로 잉크 만들고 원하는 것을 만들수 있다\n조작운반 기술과 관절 구동 모터기술로 기계팔이 움직이며 자동배치 기술로 원하는 위치에 둔다.","sensorAction":"화성에서 돌아다니는 사람들을 피하편서 만들어진 것을 지정된 위치에 가져간다.","sensorTarget":"지형, 작업물, 환경,사람들과의 거리","boothComments":[],"customVideoPrompt":"[AI Video Production] At a Mars exploration site in 2050, set against a red sand desert and a state-of-the-art dome base, the main body is square like a cube, and the 3D printer is inside the cube, so it is printing from within the main body and can move; except for the wheels, the main structure is always white. Simply put, a large 3D printer is moving, with mechanical arms on both sides to take things out and place them. Measuring about 220 cm wide and 190 cm high, with wheels on both sides of the tracked vehicle that change direction by being pulled out directly from inside the robot and ink applied to the Martian surface, the stylized robot 'Mars-3D' appears in the center of the screen, creating a vivid sense of movement.Blue scan lights illuminate the mounted camera sensors, smart detection sensors, ultrasonic sensors, and LiDAR sensors (detecting terrain, work objects, environment, and distance to people), followed by a close-up scan of the surroundings using three-dimensional holographic wavelengths. The robot then moves its robotic arms and nozzles to 3D print structures layer by layer, precisely place them at designated locations, and agilely steer to safely avoid nearby living organisms and obstacles, demonstrating its mission through continuous operation. Create precise mecha engineering simulation-style, high-tech science documentary and hologram HUD videos with camera tracking that flows naturally from wide shots to close-ups of mechanical joints.","deletedCommentIds":[]},"version":7,"specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"만약 지구온난화로 지구말고  화성에 가게되면 재료는 없고 기지를 만들때 필요한 로봇이다."},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#효율성 #안전성"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"정밀 메카닉 공학 시뮬레이션 스타일 (로봇 관절 구조와 내부 기계 작동 클로즈업),하이테크 과학 다큐멘터리 & 홀로그램 HUD 스타일 (센서 스캔 파동과 데이터 시각화 강조)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"자율주행으로 사람들을 피하면서 다닌다. 실시간 통신기술로 주인이 위치를 지정하고 원성률을 확인할수 있다. 물질 추출 기술로 잉크를 만들고 알고리즘기술로 스스로 경로를 계산한다."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"이동기능으로 이동한다.\n 3D프린팅 기술로 화성 땅으로 잉크 만들고 원하는 것을 만들수 있다\n조작운반 기술과 관절 구동 모터기술로 기계팔이 움직이며 자동배치 기술로 원하는 위치에 둔다."},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"카메라 센서, 통신용 센서, 초음파 센서,라이다 센서","sensorAction":"화성에서 돌아다니는 사람들을 피하편서 만들어진 것을 지정된 위치에 가져간다.","sensorTarget":"지형, 작업물, 환경,사람들과의 거리"},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"Mars-3D","appearance":"바퀴 빼고 가로는 220cm정도 세로, 높이는 190cm정도 크기이다. 바퀴는 무한궤도(캐터필더)호 양옆에 있고 방향을 바꿀때 바퀴가 방향을 이동하게한다. 본체안에 3d프린터가 있고 양역에는 기계팔이 있어서 주인이 cad를 주면 본체안에서 직접뽑고 화성 바닥으로 잉크를 만든다.다 만들면 작업물이 나오면서 기계팔이 어디에 둘지 카메라센서로 보고 그 위치에 둔다. 만약 주인이 위치를 지정하면 그곳에 둔다.겉면은 화성 바람으로 고장나지 않기 위해 단단하고 어느정도 무거워야 한다. 대부분 하얀색이다."}},"submittedAt":"2026-11-16T03:18:25.313Z","videoPrompt":"[AI Video Production] At a Mars exploration site in 2050, set against a red sand desert and a state-of-the-art dome base, the main body is square like a cube, and the 3D printer is inside the cube, so it is printing from within the main body and can move; except for the wheels, the main structure is always white. Simply put, a large 3D printer is moving, with mechanical arms on both sides to take things out and place them. Measuring about 220 cm wide and 190 cm high, with wheels on both sides of the tracked vehicle that change direction by being pulled out directly from inside the robot and ink applied to the Martian surface, the stylized robot 'Mars-3D' appears in the center of the screen, creating a vivid sense of movement.Blue scan lights illuminate the mounted camera sensors, smart detection sensors, ultrasonic sensors, and LiDAR sensors (detecting terrain, work objects, environment, and distance to people), followed by a close-up scan of the surroundings using three-dimensional holographic wavelengths. The robot then moves its robotic arms and nozzles to 3D print structures layer by layer, precisely place them at designated locations, and agilely steer to safely avoid nearby living organisms and obstacles, demonstrating its mission through continuous operation. Create precise mecha engineering simulation-style, high-tech science documentary and hologram HUD videos with camera tracking that flows naturally from wide shots to close-ups of mechanical joints.","teacherFeedbackBefore":""},{"label":"버전 8 (7차 수정)","inputs":{"purpose":"만약 지구온난화로 지구말고  화성에 가게되면 재료는 없고 기지를 만들때 필요한 로봇이다.","robotName":"Mars-3D","aiFeedback":{"date":"2026-11-16","count":1,"step1":"Mars-3D라는 이름이 아주 멋져요! 로봇의 외형에 가볍고 튼튼한 '탄소 섬유' 신소재를 적용했다고 적어보면 어떨까요? 외부 충격에 강하게 보호하는 로봇의 모습을 더 자세히 상상해 보세요.","step2":"화성 기지 건설이라는 목적이 매우 훌륭해요! 여기에 화성의 강한 모래바람을 막아주는 '방진 설계'나 태양광을 사용하는 '친환경 에너지 기술'을 추가하면 훨씬 과학적인 이야기가 될 거예요.","step3":"3D 프린팅과 기계팔의 조합이 창의적이에요! 기계팔에 사람의 손처럼 정교하게 움직이는 '관절 구동 모터' 원리를 추가하면, 로봇이 어떻게 더 섬세하게 물건을 옮길지 설명할 수 있어요.","step4":"카메라와 초음파 센서로 사람을 피하는 모습이 잘 그려져요! 여기서 장애물의 거리를 계산하는 '라이다 센서'를 추가해 보세요. 로봇이 주변 지형을 더 똑똑하게 입체적으로 인식하게 될 거예요.","step5":"자율주행과 통신 기술은 필수적이에요! 여기에 화성에서 생성된 잉크를 만드는 '물질 추출 기술'이나 인공지능이 스스로 경로를 계산하는 '알고리즘 기술'을 더하면 정말 완벽한 설계도가 될 것 같아요.","updatedAt":"2026-11-16T00:12:10.027Z"},"appearance":"바퀴 빼고 가로는 220cm정도 세로, 높이는 190cm정도 크기이다. 바퀴는 무한궤도(캐터필더)호 양옆에 있고 방향을 바꿀때 바퀴가 방향을 이동하게한다. 본체안에 3d프린터가 있고 양역에는 기계팔이 있어서 주인이 cad를 주면 본체안에서 직접뽑고 화성 바닥으로 잉크를 만든다.다 만들면 작업물이 나오면서 기계팔이 어디에 둘지 카메라센서로 보고 그 위치에 둔다. 만약 주인이 위치를 지정하면 그곳에 둔다.겉면은 화성 바람으로 고장나지 않기 위해 단단하고 어느정도 무거워야 한다. 대부분 하얀색이다.","coreValues":"#효율성 #안전성","sensorName":"카메라 센서, 통신용 센서, 초음파 센서,라이다 센서","videoStyle":"정밀 메카닉 공학 시뮬레이션 스타일 (로봇 관절 구조와 내부 기계 작동 클로즈업),하이테크 과학 다큐멘터리 & 홀로그램 HUD 스타일 (센서 스캔 파동과 데이터 시각화 강조)","scienceTech":"자율주행으로 사람들을 피하면서 다닌다. 실시간 통신기술로 주인이 위치를 지정하고 원성률을 확인할수 있다. 물질 추출 기술로 잉크를 만들고 알고리즘기술로 스스로 경로를 계산한다.","mainFunction":"이동기능으로 이동한다.\n 3D프린팅 기술로 화성 땅으로 잉크 만들고 원하는 것을 만들수 있다\n조작운반 기술과 관절 구동 모터기술로 기계팔이 움직이며 자동배치 기술로 원하는 위치에 둔다.","sensorAction":"화성에서 돌아다니는 사람들을 피하편서 만들어진 것을 지정된 위치에 가져간다.","sensorTarget":"지형, 작업물, 환경,사람들과의 거리","boothComments":[],"customVideoPrompt":"[AI Video Production] At a Mars exploration site in 2050, set against a red sand desert and a state-of-the-art dome base, the main body is square like a cube, and the 3D printer is inside the cube, so it is printing from within the main body and can move; except for the wheels, the main structure is always white. Simply put, a large 3D printer is moving, with mechanical arms on both sides to take things out and place them. Measuring about 220 cm wide and 190 cm high, with wheels on both sides of the tracked vehicle that change direction by being pulled out directly from inside the robot and ink applied to the Martian surface, the stylized robot 'Mars-3D' appears in the center of the screen, creating a vivid sense of movement.Blue scan lights illuminate the mounted camera sensors, smart detection sensors, ultrasonic sensors, and LiDAR sensors (detecting terrain, work objects, environment, and distance to people), followed by a close-up scan of the surroundings using three-dimensional holographic wavelengths. The robot then moves its robotic arms and nozzles to 3D print structures layer by layer, precisely place them at designated locations, and agilely steer to safely avoid nearby living organisms and obstacles, demonstrating its mission through continuous operation. Create precise mecha engineering simulation-style, high-tech science documentary and hologram HUD videos with camera tracking that flows naturally from wide shots to close-ups of mechanical joints.","deletedCommentIds":[]},"version":8,"specSheet":{"purpose":{"title":"🎯 개발 배경 및 목적","content":"만약 지구온난화로 지구말고  화성에 가게되면 재료는 없고 기지를 만들때 필요한 로봇이다."},"coreValues":{"title":"💎 추구하는 핵심 가치","content":"#효율성 #안전성"},"videoStyle":{"title":"🎨 영상 연출 스타일","content":"정밀 메카닉 공학 시뮬레이션 스타일 (로봇 관절 구조와 내부 기계 작동 클로즈업),하이테크 과학 다큐멘터리 & 홀로그램 HUD 스타일 (센서 스캔 파동과 데이터 시각화 강조)"},"scienceTech":{"title":"🔬 적용 융합 과학기술","content":"자율주행으로 사람들을 피하면서 다닌다. 실시간 통신기술로 주인이 위치를 지정하고 원성률을 확인할수 있다. 물질 추출 기술로 잉크를 만들고 알고리즘기술로 스스로 경로를 계산한다."},"mainFunction":{"title":"⚙️ 핵심 작동 기능 및 구조","content":"이동기능으로 이동한다.\n 3D프린팅 기술로 화성 땅으로 잉크 만들고 원하는 것을 만들수 있다\n조작운반 기술과 관절 구동 모터기술로 기계팔이 움직이며 자동배치 기술로 원하는 위치에 둔다."},"sensorMechanism":{"title":"📡 스마트 감지 메커니즘 (센서명 / 감지 대상 / 작동 연동)","sensorName":"카메라 센서, 통신용 센서, 초음파 센서,라이다 센서","sensorAction":"화성에서 돌아다니는 사람들을 피하편서 만들어진 것을 지정된 위치에 가져간다.","sensorTarget":"지형, 작업물, 환경,사람들과의 거리"},"robotAndAppearance":{"title":"🤖 출품 로봇명 & 외형","robotName":"Mars-3D","appearance":"바퀴 빼고 가로는 220cm정도 세로, 높이는 190cm정도 크기이다. 바퀴는 무한궤도(캐터필더)호 양옆에 있고 방향을 바꿀때 바퀴가 방향을 이동하게한다. 본체안에 3d프린터가 있고 양역에는 기계팔이 있어서 주인이 cad를 주면 본체안에서 직접뽑고 화성 바닥으로 잉크를 만든다.다 만들면 작업물이 나오면서 기계팔이 어디에 둘지 카메라센서로 보고 그 위치에 둔다. 만약 주인이 위치를 지정하면 그곳에 둔다.겉면은 화성 바람으로 고장나지 않기 위해 단단하고 어느정도 무거워야 한다. 대부분 하얀색이다."}},"submittedAt":"2026-11-16T03:19:29.155Z","videoPrompt":"[AI Video Production] At a Mars exploration site in 2050, set against a red sand desert and a state-of-the-art dome base, the main body is square like a cube, and the 3D printer is inside the cube, so it is printing from within the main body and can move; except for the wheels, the main structure is always white. Simply put, a large 3D printer is moving, with mechanical arms on both sides to take things out and place them. Measuring about 220 cm wide and 190 cm high, with wheels on both sides of the tracked vehicle that change direction by being pulled out directly from inside the robot and ink applied to the Martian surface, the stylized robot 'Mars-3D' appears in the center of the screen, creating a vivid sense of movement.Blue scan lights illuminate the mounted camera sensors, smart detection sensors, ultrasonic sensors, and LiDAR sensors (detecting terrain, work objects, environment, and distance to people), followed by a close-up scan of the surroundings using three-dimensional holographic wavelengths. The robot then moves its robotic arms and nozzles to 3D print structures layer by layer, precisely place them at designated locations, and agilely steer to safely avoid nearby living organisms and obstacles, demonstrating its mission through continuous operation. Create precise mecha engineering simulation-style, high-tech science documentary and hologram HUD videos with camera tracking that flows naturally from wide shots to close-ups of mechanical joints.","teacherFeedbackBefore":""}],"updatedAt":"2026-11-17T00:16:38.471Z"}];
  return preserved.filter((s) => !isStudentMarkedDeleted(s));
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
      'robot_expo_2050_supabase_url_v2',
      'robot_expo_2050_supabase_key_v2',
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
  const isOldProjectUrl =
    savedSbUrl.includes('ybdxajahpvqbsglolnqi') || savedSbUrl.includes('cyjnrwtnbcxcobfzuhwc');
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
      // 새 Supabase 프로젝트 테이블이 비어있는 경우 보존된 학급 데이터를 자동으로 초기 시드 업로드
      if (fetchedStudents.length === 0 && state.students.length === 0) {
        const seedStudents = getInitialDummyStudents();
        if (seedStudents.length > 0) {
          state.students = seedStudents;
          saveStudentsToLocalStorage(false);
          refreshAllViews(false);
          pushAllLocalToCloud(true);
          return true;
        }
      } else if (fetchedStudents.length === 0 && state.students.length > 0) {
        pushAllLocalToCloud(true);
        return true;
      }
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

grant usage on schema public to anon, authenticated;
grant all on table public.robot_expo_students to anon, authenticated;

alter table public.robot_expo_students enable row level security;

drop policy if exists "Allow public classroom access on robot_expo_students" on public.robot_expo_students;
create policy "Allow public classroom access on robot_expo_students"
  on public.robot_expo_students
  for all
  to anon, authenticated
  using (true)
  with check (true);

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
