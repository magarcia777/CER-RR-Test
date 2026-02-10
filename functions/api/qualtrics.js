let cachedMap = null;
let cachedTeacherCourses = null;

const ENROLLMENT_PARTS = [
  'data/enrollment-data.part001.json',
  'data/enrollment-data.part002.json',
  'data/enrollment-data.part003.json',
  'data/enrollment-data.part004.json',
  'data/enrollment-data.part005.json'
];

async function loadMap(env) {
  if (cachedMap) return cachedMap;
  const req = new Request('https://example.com/data/lecturer-map.json');
  const res = await env.ASSETS.fetch(req);
  if (!res.ok) {
    throw new Error('Unable to load lecturer map');
  }
  cachedMap = await res.json();
  return cachedMap;
}

async function loadTeacherCourses(env) {
  if (cachedTeacherCourses) return cachedTeacherCourses;
  cachedTeacherCourses = new Map();

  for (const part of ENROLLMENT_PARTS) {
    const res = await env.ASSETS.fetch(new Request(`https://example.com/${part}`));
    if (!res.ok) {
      throw new Error(`Unable to load ${part}`);
    }
    const data = await res.json();
    const rows = Array.isArray(data.enrollmentData) ? data.enrollmentData : [];
    for (const row of rows) {
      const teacherId = String(row.teacherId || row.TeacherId || '').trim();
      const courseCode = (row.CourseCode || row.courseCode || '').trim();
      if (!teacherId || !courseCode) continue;
      if (!cachedTeacherCourses.has(teacherId)) {
        cachedTeacherCourses.set(teacherId, new Set());
      }
      cachedTeacherCourses.get(teacherId).add(courseCode);
    }
  }

  return cachedTeacherCourses;
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}

async function getQualtricsResponses(env, surveyId) {
  const baseUrl = env.QUALTRICS_BASE_URL;
  const apiToken = env.QUALTRICS_API_TOKEN;
  if (!baseUrl || !apiToken) {
    throw new Error('Qualtrics configuration missing');
  }

  // Step 1: Create export
  const createRes = await fetch(`${baseUrl}/surveys/${surveyId}/export-responses`, {
    method: 'POST',
    headers: {
      'X-API-TOKEN': apiToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ format: 'json', compress: false })
  });
  if (!createRes.ok) {
    throw new Error(`Failed to create export: ${createRes.statusText}`);
  }
  const createData = await createRes.json();
  const progressId = createData.result.progressId;

  // Step 2: Check export progress
  let fileId = null;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const progressRes = await fetch(`${baseUrl}/surveys/${surveyId}/export-responses/${progressId}`, {
      method: 'GET',
      headers: {
        'X-API-TOKEN': apiToken,
        'Content-Type': 'application/json'
      }
    });
    if (!progressRes.ok) {
      throw new Error(`Failed to check progress: ${progressRes.statusText}`);
    }
    const progressData = await progressRes.json();
    if (progressData.result.status === 'complete') {
      fileId = progressData.result.fileId;
      break;
    }
    if (progressData.result.status === 'failed') {
      throw new Error('Export failed');
    }
  }
  if (!fileId) {
    throw new Error('Export timed out');
  }

  // Step 3: Download file
  const downloadRes = await fetch(`${baseUrl}/surveys/${surveyId}/export-responses/${fileId}/file`, {
    method: 'GET',
    headers: { 'X-API-TOKEN': apiToken }
  });
  if (!downloadRes.ok) {
    throw new Error(`Failed to download: ${downloadRes.statusText}`);
  }
  const responseData = await downloadRes.json();
  return responseData.responses || [];
}

export async function onRequest({ request, env }) {
  const emailHeader = request.headers.get('cf-access-authenticated-user-email') ||
    request.headers.get('CF-Access-Authenticated-User-Email');
  if (!emailHeader) {
    return jsonResponse(401, { error: 'Missing Cloudflare Access identity.' });
  }
  const email = emailHeader.trim().toLowerCase();
  const map = await loadMap(env);
  const teacherId = map.emailToTeacherId?.[email] || null;

  const adminEmails = (env.ADMIN_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
  const isAdmin = adminEmails.includes(email);

  if (!teacherId && !isAdmin) {
    return jsonResponse(403, { error: 'No lecturer record found for your account.' });
  }

  const url = new URL(request.url);
  const surveyKey = url.searchParams.get('survey');
  const surveyId = surveyKey === 'courseDesign'
    ? env.QUALTRICS_COURSE_DESIGN_SURVEY_ID
    : surveyKey === 'learningExp'
      ? env.QUALTRICS_LEARNING_EXP_SURVEY_ID
      : null;

  if (!surveyId) {
    return jsonResponse(400, { error: 'Invalid survey key.' });
  }

  let responses = await getQualtricsResponses(env, surveyId);

  // Normalize fields
  const courseCodeField = env.QUALTRICS_COURSE_CODE_FIELD || 'CourseCode';
  const teacherIdField = env.QUALTRICS_TEACHER_ID_FIELD || 'teacherId';

  const transformed = responses.map(r => {
    const values = r.values || {};
    return {
      ...values,
      CourseCode: values[courseCodeField] || values.CourseCode || values.courseCode,
      teacherId: values[teacherIdField] || values.teacherId || values.TeacherId
    };
  });

  if (!isAdmin) {
    const teacherCourses = await loadTeacherCourses(env);
    const courseSet = teacherCourses.get(String(teacherId)) || new Set();
    responses = transformed.filter(r => r.CourseCode && courseSet.has(r.CourseCode));
  } else {
    const requestedTeacherId = url.searchParams.get('teacherId');
    if (requestedTeacherId) {
      const teacherCourses = await loadTeacherCourses(env);
      const courseSet = teacherCourses.get(String(requestedTeacherId)) || new Set();
      responses = transformed.filter(r => r.CourseCode && courseSet.has(r.CourseCode));
    } else {
      responses = transformed;
    }
  }

  return jsonResponse(200, { responses });
}
