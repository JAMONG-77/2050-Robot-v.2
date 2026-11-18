/**
 * Netlify Serverless Function: /.netlify/functions/ai-feedback
 * - Gemini API 키(process.env.GEMINI_API_KEY)를 서버 백엔드에서만 안전하게 사용하여
 *   브라우저(웹앱), GitHub 공개 저장소, Supabase 어디에도 절대 노출되지 않도록 보호합니다.
 * - 무료 사용량 한도(일일 안전 상한선 또는 HTTP 429 RESOURCE_EXHAUSTED) 도달 시
 *   즉시 모든 AI 피드백 기능을 차단하고 '더 이상 AI 피드백을 받을 수 없습니다.'를 반환합니다.
 */

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://cyjnrwtnbcxcobfzuhwc.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN5am5yd3RuYmN4Y29iZnp1aHdjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ5NDQwMDcsImV4cCI6MjExMDUyMDAwN30._CZ5ID1XvcUnHECs7YGkYkLSLTeBAOMrrXptkKQnxAA';

const QUOTA_GUARD_ID = '__AI_QUOTA_GUARD__';
// 무료 티어 한도를 절대 넘지 않도록 안전한 일일 하드 리밋 설정 (초과 시 즉시 전체 종료)
const MAX_DAILY_FREE_CALLS = 200;
const MAX_STUDENT_DAILY_CALLS = 3;

let memoryQuotaState = {
  date: '',
  totalCalls: 0,
  exhausted: false,
  studentCounts: {},
  deletedMap: {},
};

function getKstDateString() {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

function resolveGeminiApiKey() {
  const candidates = [
    process.env.GEMINI_API_KEY,
    process.env.GOOGLE_API_KEY,
    process.env.GEMINI_KEY,
    process.env.API_KEY,
    process.env.VITE_GEMINI_API_KEY,
    process.env.REACT_APP_GEMINI_API_KEY,
  ];
  for (const val of candidates) {
    if (typeof val === 'string' && val.trim().length > 5) {
      return val.trim();
    }
  }
  return '';
}

function sanitizeErrorMessage(errMsg, apiKey) {
  if (!errMsg || typeof errMsg !== 'string') return '잠시 후 다시 시도해 주세요.';
  let safe = errMsg;
  if (apiKey && typeof apiKey === 'string' && apiKey.length > 5) {
    safe = safe.split(apiKey).join('[REDACTED]');
  }
  safe = safe.replace(/AIza[0-9A-Za-z_-]{35}/g, '[REDACTED]');
  safe = safe.replace(/key=[^&\s]+/gi, 'key=[REDACTED]');
  safe = safe.replace(/bearer\s+[a-zA-Z0-9_\-\.]+/gi, 'Bearer [REDACTED]');
  if (safe.length > 180) {
    safe = safe.slice(0, 180) + '...';
  }
  return safe;
}

function parseJsonResponseText(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  const cleaned = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
    }
    throw new Error('JSON 파싱 실패');
  }
}

function extractTextFromGeminiPayload(data) {
  if (!data || typeof data !== 'object') return '';

  // 1) 최신 Gemini Interactions API (2026-05-20 steps 스키마)
  if (Array.isArray(data.steps)) {
    let textFromSteps = '';
    for (const step of data.steps) {
      if (!step || typeof step !== 'object') continue;
      if (step.type === 'thought') continue;
      if (Array.isArray(step.content)) {
        for (const item of step.content) {
          if (item && (item.type === 'text' || !item.type) && typeof item.text === 'string') {
            textFromSteps += item.text;
          }
        }
      } else if (typeof step.text === 'string') {
        textFromSteps += step.text;
      }
    }
    if (textFromSteps.trim()) return textFromSteps.trim();
  }

  // 2) SDK 편의 필드 (output_text)
  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }

  // 3) 구형 Interactions API (outputs 배열)
  if (Array.isArray(data.outputs)) {
    let textFromOutputs = '';
    for (const out of data.outputs) {
      if (out && typeof out.text === 'string') {
        textFromOutputs += out.text;
      } else if (out && Array.isArray(out.content)) {
        for (const c of out.content) {
          if (c && typeof c.text === 'string') textFromOutputs += c.text;
        }
      }
    }
    if (textFromOutputs.trim()) return textFromOutputs.trim();
  }

  // 4) generateContent API (candidates 배열)
  if (Array.isArray(data.candidates)) {
    const parts = data.candidates[0]?.content?.parts || [];
    let textFromCandidates = '';
    for (const part of parts) {
      if (part && !part.thought && typeof part.text === 'string') {
        textFromCandidates += part.text;
      }
    }
    if (textFromCandidates.trim()) return textFromCandidates.trim();
  }

  return '';
}

async function fetchQuotaGuardFromSupabase(todayStr) {
  try {
    const url = `${SUPABASE_URL}/rest/v1/robot_expo_students?student_id=eq.${encodeURIComponent(QUOTA_GUARD_ID)}&select=inputs`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
    });
    if (!res.ok) return null;
    const rows = await res.json();
    if (Array.isArray(rows) && rows.length > 0 && rows[0].inputs) {
      const inp = rows[0].inputs;
      const deletedMap = inp.deletedMap && typeof inp.deletedMap === 'object' ? inp.deletedMap : {};
      if (inp.date === todayStr) {
        return {
          date: todayStr,
          totalCalls: Number(inp.totalCalls) || 0,
          exhausted: Boolean(inp.exhausted),
          studentCounts: inp.studentCounts && typeof inp.studentCounts === 'object' ? inp.studentCounts : {},
          deletedMap,
        };
      }
      return {
        date: todayStr,
        totalCalls: 0,
        exhausted: false,
        studentCounts: {},
        deletedMap,
      };
    }
    return {
      date: todayStr,
      totalCalls: 0,
      exhausted: false,
      studentCounts: {},
      deletedMap: {},
    };
  } catch {
    return null;
  }
}

async function saveQuotaGuardToSupabase(quotaObj) {
  try {
    const row = {
      student_id: QUOTA_GUARD_ID,
      student_name: QUOTA_GUARD_ID,
      status: 'system_guard',
      inputs: quotaObj,
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
    await fetch(`${SUPABASE_URL}/rest/v1/robot_expo_students?on_conflict=student_id`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify(row),
    });
  } catch {
    // ignore storage sync warning
  }
}

function isHardBillingOrDailyExhausted(status, errData) {
  if (status === 402) return true;
  const errMsg = JSON.stringify(errData || {}).toLowerCase();
  if (errMsg.includes('billing') || errMsg.includes('perday') || errMsg.includes('per_day')) {
    return true;
  }
  return false;
}

function isQuotaErrorResponse(status, errData) {
  if (status === 402) return true;
  const errMsg = JSON.stringify(errData || {}).toLowerCase();
  if (status === 429) {
    // 일시적 서버 수요 폭주(high demand / overloaded)는 무료 한도 소진이 아니므로 다음 경량 모델로 폴백 허용
    if (errMsg.includes('high demand') || errMsg.includes('overloaded')) {
      return false;
    }
    return true;
  }
  return (
    errMsg.includes('resource_exhausted') ||
    errMsg.includes('quota exceeded') ||
    errMsg.includes('ratelimitexceeded') ||
    errMsg.includes('billing')
  );
}

async function callGeminiApi(apiKey, systemInstruction, userPrompt, jsonSchema) {
  let lastError = null;
  let quotaErrorCount = 0;
  let totalAttempts = 0;

  // 현재 활성 Gemini 3.x 모델 풀 (25명 동시 요청 시 부하 분산을 위해 시작 모델을 해시 회전)
  const baseModels = [
    'gemini-3.5-flash-lite',
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.1-flash-lite',
  ];
  let hash = 0;
  const seedStr = String(userPrompt || '');
  for (let i = 0; i < seedStr.length; i++) {
    hash = (hash * 31 + seedStr.charCodeAt(i)) >>> 0;
  }
  const offset = hash % baseModels.length;
  const modelsToTry = [
    ...baseModels.slice(offset),
    ...baseModels.slice(0, offset),
  ];

  // 1) 최신 Gemini Interactions API (/v1beta/interactions)
  for (const modelName of modelsToTry) {
    totalAttempts += 1;
    try {
      const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          model: modelName,
          system_instruction: systemInstruction,
          input: userPrompt,
          store: false,
          response_format: {
            type: 'text',
            mime_type: 'application/json',
            schema: jsonSchema,
          },
        }),
      });

      const data = await response.json().catch(() => ({}));

      if (isHardBillingOrDailyExhausted(response.status, data)) {
        const err = new Error('QUOTA_EXHAUSTED');
        err.isQuotaExhausted = true;
        throw err;
      }

      if (isQuotaErrorResponse(response.status, data)) {
        // 특정 모델의 분당 호출(RPM) 제한일 수 있으므로 다른 3.x 모델을 먼저 시도
        quotaErrorCount += 1;
        lastError = new Error(data?.error?.message || `Quota limit on ${modelName}`);
        continue;
      }

      if (!response.ok) {
        lastError = new Error(data?.error?.message || `Gemini Interactions status ${response.status}`);
        continue;
      }

      const rawText = extractTextFromGeminiPayload(data);
      if (rawText) {
        const parsed = parseJsonResponseText(rawText);
        if (parsed) return parsed;
      }
    } catch (err) {
      if (err && err.isQuotaExhausted) throw err;
      lastError = err;
    }
  }

  // 2) generateContent 엔드포인트 폴백 (동일 3.x 모델 대상)
  for (const modelName of modelsToTry) {
    totalAttempts += 1;
    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: systemInstruction }],
          },
          contents: [
            {
              role: 'user',
              parts: [{ text: userPrompt }],
            },
          ],
          generationConfig: {
            responseMimeType: 'application/json',
            responseJsonSchema: jsonSchema,
            temperature: 0.5,
          },
        }),
      });

      const data = await response.json().catch(() => ({}));

      if (isHardBillingOrDailyExhausted(response.status, data)) {
        const err = new Error('QUOTA_EXHAUSTED');
        err.isQuotaExhausted = true;
        throw err;
      }

      if (isQuotaErrorResponse(response.status, data)) {
        quotaErrorCount += 1;
        lastError = new Error(data?.error?.message || `Quota limit on ${modelName}`);
        continue;
      }

      if (!response.ok) {
        lastError = new Error(data?.error?.message || `Gemini API status ${response.status}`);
        continue;
      }

      const rawText = extractTextFromGeminiPayload(data);
      if (rawText) {
        const parsed = parseJsonResponseText(rawText);
        if (parsed) return parsed;
      }
    } catch (err) {
      if (err && err.isQuotaExhausted) throw err;
      lastError = err;
    }
  }

  if (quotaErrorCount > 0 && quotaErrorCount >= baseModels.length) {
    const err = new Error('QUOTA_EXHAUSTED');
    err.isQuotaExhausted = true;
    throw err;
  }

  throw lastError || new Error('AI 응답을 생성하지 못했습니다.');
}

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method Not Allowed' }),
    };
  }

  const apiKey = resolveGeminiApiKey();
  if (!apiKey) {
    return {
      statusCode: 503,
      headers,
      body: JSON.stringify({
        error:
          'Netlify 서버에 GEMINI_API_KEY가 아직 반영되지 않았습니다. 환경변수 등록 후 GitHub에 새 커밋을 푸시하거나 Netlify Deploys에서 [Trigger deploy]로 재배포해 주세요.',
      }),
    };
  }

  const todayStr = getKstDateString();
  if (memoryQuotaState.date !== todayStr) {
    memoryQuotaState = {
      date: todayStr,
      totalCalls: 0,
      exhausted: false,
      studentCounts: {},
      deletedMap: memoryQuotaState.deletedMap || {},
    };
  }

  // Supabase와 서버 메모리 양쪽에서 무료 한도 상태 동기화 확인
  const remoteQuota = await fetchQuotaGuardFromSupabase(todayStr);
  if (remoteQuota) {
    memoryQuotaState.totalCalls = Math.max(memoryQuotaState.totalCalls, remoteQuota.totalCalls);
    memoryQuotaState.exhausted = memoryQuotaState.exhausted || remoteQuota.exhausted;
    memoryQuotaState.studentCounts = {
      ...remoteQuota.studentCounts,
      ...memoryQuotaState.studentCounts,
    };
    memoryQuotaState.deletedMap = {
      ...(remoteQuota.deletedMap || {}),
      ...(memoryQuotaState.deletedMap || {}),
    };
  }

  // 1) 무료 한도 도달 여부 확인 (학생·교사 모두 즉시 차단)
  if (memoryQuotaState.exhausted || memoryQuotaState.totalCalls >= MAX_DAILY_FREE_CALLS) {
    memoryQuotaState.exhausted = true;
    await saveQuotaGuardToSupabase(memoryQuotaState);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        quotaExhausted: true,
        message: '더 이상 AI 피드백을 받을 수 없습니다.',
      }),
    };
  }

  let body = {};
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: '잘못된 요청 형식입니다.' }),
    };
  }

  const mode = body.mode === 'teacher' ? 'teacher' : 'student';
  const studentName = String(body.studentName || body.studentId || '학생').trim().slice(0, 50);
  const rawInputs = body.inputs && typeof body.inputs === 'object' ? body.inputs : {};
  const inputs = {
    robotName: String(rawInputs.robotName || '').slice(0, 100),
    appearance: String(rawInputs.appearance || '').slice(0, 500),
    purpose: String(rawInputs.purpose || '').slice(0, 500),
    mainFunction: String(rawInputs.mainFunction || '').slice(0, 500),
    sensorName: String(rawInputs.sensorName || '').slice(0, 100),
    sensorTarget: String(rawInputs.sensorTarget || '').slice(0, 300),
    sensorAction: String(rawInputs.sensorAction || '').slice(0, 300),
    scienceTech: String(rawInputs.scienceTech || '').slice(0, 500),
    coreValues: String(rawInputs.coreValues || '').slice(0, 100),
    videoStyle: String(rawInputs.videoStyle || '').slice(0, 100),
  };

  // 2) 학생 모드인 경우 하루 최대 3회 제한 확인
  if (mode === 'student') {
    const usedCount = Number(memoryQuotaState.studentCounts[studentName] || 0);
    if (usedCount >= MAX_STUDENT_DAILY_CALLS) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          studentLimitReached: true,
          usedCount,
          maxCount: MAX_STUDENT_DAILY_CALLS,
          message: '오늘의 AI 피드백 받기 횟수(하루 최대 3번)를 모두 사용했어요!',
        }),
      };
    }
  }

  try {
    if (mode === 'student') {
      const systemInstruction =
        '당신은 초등학생들에게 친절하고 다정하게 로봇 공학과 과학 원리를 알려주는 2050 로봇 박람회 AI 멘토 선생님입니다. ' +
        '초등학생(4~6학년)이 충분히 쉽게 이해할 수 있는 쉬운 단어와 친근한 해요체(~해요, ~해 볼까요?)를 사용하세요. ' +
        '학생이 작성한 1번~5번 항목을 각각 살펴보고, (1) 지금 내용에서 조금 부족하거나 아쉬운 부분과 (2) 과학 및 로봇 공학 쪽으로 추가하면 좋을 구체적인 아이디어(센서, 관절/모터 구조, 친환경 에너지, 신소재, 과학 원리 등)를 각 항목별로 2~3문장 이내로 명확하고 쉽게 피드백해 주세요.';

      const userPrompt = `학생 이름: ${studentName}
[1번: 로봇 이름과 외형 특징]
- 로봇 이름: ${inputs.robotName || '(미입력)'}
- 외형 특징: ${inputs.appearance || '(미입력)'}

[2번: 제작 목적 (해결하고 싶은 미래 문제)]
- 제작 목적: ${inputs.purpose || '(미입력)'}

[3번: 주요 기능 (로봇의 작동 모습과 기계 구조)]
- 주요 기능: ${inputs.mainFunction || '(미입력)'}

[4번: 탑재 감지 장치 (센서 3단계)]
- 4-1 탑재 센서 이름: ${inputs.sensorName || '(미입력)'}
- 4-2 세부 감지 대상: ${inputs.sensorTarget || '(미입력)'}
- 4-3 감지 후 로봇의 행동: ${inputs.sensorAction || '(미입력)'}

[5번: 적용된 과학 기술 (융합 기술)]
- 적용된 과학 기술: ${inputs.scienceTech || '(미입력)'}

위 1~5번 작성 내용을 보고, 초등학생이 바로 읽고 자기 글을 고칠 수 있도록 step1, step2, step3, step4, step5 각각의 피드백을 작성해 주세요.`;

      const schema = {
        type: 'object',
        properties: {
          step1: {
            type: 'string',
            description: '1번(로봇 이름과 외형 특징)에 대해 부족한 점과 로봇 공학적으로 추가할 부분 피드백 (초등학생 수준, 2~3문장)',
          },
          step2: {
            type: 'string',
            description: '2번(제작 목적)에 대해 부족한 점과 과학·환경·사회적으로 구체화할 부분 피드백 (초등학생 수준, 2~3문장)',
          },
          step3: {
            type: 'string',
            description: '3번(주요 기능)에 대해 부족한 점과 로봇의 기계 장치·움직임 원리로 추가할 부분 피드백 (초등학생 수준, 2~3문장)',
          },
          step4: {
            type: 'string',
            description: '4번(센서 이름·감지 대상·감지 후 행동)에 대해 부족한 점과 센서-행동 연결로 추가할 부분 피드백 (초등학생 수준, 2~3문장)',
          },
          step5: {
            type: 'string',
            description: '5번(적용된 과학 기술)에 대해 부족한 점과 추가하면 좋을 과학·공학 기술 피드백 (초등학생 수준, 2~3문장)',
          },
        },
        required: ['step1', 'step2', 'step3', 'step4', 'step5'],
      };

      const feedback = await callGeminiApi(apiKey, systemInstruction, userPrompt, schema);

      // 성공 시 사용 횟수 증가 및 저장
      memoryQuotaState.totalCalls += 1;
      memoryQuotaState.studentCounts[studentName] = (Number(memoryQuotaState.studentCounts[studentName]) || 0) + 1;
      if (memoryQuotaState.totalCalls >= MAX_DAILY_FREE_CALLS) {
        memoryQuotaState.exhausted = true;
      }
      await saveQuotaGuardToSupabase(memoryQuotaState);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ok: true,
          mode: 'student',
          date: todayStr,
          usedCount: memoryQuotaState.studentCounts[studentName],
          maxCount: MAX_STUDENT_DAILY_CALLS,
          quotaExhausted: memoryQuotaState.exhausted,
          feedback: {
            step1: String(feedback.step1 || '').trim(),
            step2: String(feedback.step2 || '').trim(),
            step3: String(feedback.step3 || '').trim(),
            step4: String(feedback.step4 || '').trim(),
            step5: String(feedback.step5 || '').trim(),
          },
        }),
      };
    } else {
      // 교사 관리자 모드: 학생 제출 내용을 전체적으로 살펴보고 초등학생이 이해할 수 있도록 5줄 이하로 피드백 생성
      const systemInstruction =
        '당신은 초등학교 과학·로봇 융합 수업을 돕는 AI 보조 교사입니다. ' +
        '학생이 제출한 로봇 기획서 내용을 전체적으로 살펴보고, 초등학생이 쉽게 이해하고 바로 수정할 수 있도록 친절하고 구체적인 수정 요청 및 칭찬 피드백을 작성하세요. ' +
        '반드시 전체 길이를 5줄 이하(최대 5문장 이내, 줄바꿈 포함 5줄 이하)로 간결하게 작성하세요.';

      const userPrompt = `학생 이름: ${studentName}
1-1. 로봇 이름: ${inputs.robotName || '(미입력)'}
1-2. 외형 특징: ${inputs.appearance || '(미입력)'}
2. 제작 목적: ${inputs.purpose || '(미입력)'}
3. 주요 기능: ${inputs.mainFunction || '(미입력)'}
4-1. 탑재 센서: ${inputs.sensorName || '(미입력)'}
4-2. 세부 감지 대상: ${inputs.sensorTarget || '(미입력)'}
4-3. 감지 후 행동: ${inputs.sensorAction || '(미입력)'}
5. 적용된 과학 기술: ${inputs.scienceTech || '(미입력)'}
6. 추구하는 가치: ${inputs.coreValues || '(미입력)'}
7. 영상 스타일: ${inputs.videoStyle || '(미입력)'}

위 학생의 제출 내용을 전체적으로 살펴보고, 잘한 점 1가지와 과학·로봇 공학적으로 보완하면 좋을 점들을 초등학생 눈높이에 맞춰 반드시 5줄 이하로 작성해 주세요.`;

      const schema = {
        type: 'object',
        properties: {
          teacherFeedback: {
            type: 'string',
            description: '초등학생이 이해하기 쉬운 전체 종합 피드백 (반드시 5줄 이하)',
          },
        },
        required: ['teacherFeedback'],
      };

      const result = await callGeminiApi(apiKey, systemInstruction, userPrompt, schema);

      // 5줄 이하 강제 보장
      const lines = String(result.teacherFeedback || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 5);
      const formattedFeedback = lines.join('\n');

      memoryQuotaState.totalCalls += 1;
      if (memoryQuotaState.totalCalls >= MAX_DAILY_FREE_CALLS) {
        memoryQuotaState.exhausted = true;
      }
      await saveQuotaGuardToSupabase(memoryQuotaState);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ok: true,
          mode: 'teacher',
          quotaExhausted: memoryQuotaState.exhausted,
          teacherFeedback: formattedFeedback,
        }),
      };
    }
  } catch (err) {
    if (err && err.isQuotaExhausted) {
      memoryQuotaState.exhausted = true;
      await saveQuotaGuardToSupabase(memoryQuotaState);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          quotaExhausted: true,
          message: '더 이상 AI 피드백을 받을 수 없습니다.',
        }),
      };
    }

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: `AI 피드백 생성 오류: ${sanitizeErrorMessage(err?.message, apiKey)}`,
      }),
    };
  }
};
