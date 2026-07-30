// ============================================================================
// أوفق AI Agent v2.0 — باذن الله
//
// أداة واحدة بس: run_terminal. الـ AI هو اللي بيعمل كل حاجة بنفسه بالكامل —
// جلب نصوص، تحميل صوت، كتابة ملفات، **وحتى كتابة وتشغيل كود الرندر بالـ Playwright
// بنفسه** (الوصفة موجودة كمرجع في AGENTS.md، مش دالة جاهزة هنا). agent.js
// مفيهوش أي منطق محتوى أو رندر خالص — بس المحرك اللي بيشغّل الأداة الوحيدة.
//
// معمارية التفكير: Plan-and-Solve (خطة نصية كاملة قبل أول أمر) + Reflexion
// (مراجعة نصية إلزامية بعد كل فيديو — دي بقت قاعدة سلوكية مكتوبة في AGENTS.md
// والـ Agent نفسه مسؤول عن الالتزام بيها؛ agent.js بقى بس بيتأكد من وجود
// TASK_COMPLETE.json عشان يعرف يوقف، من غير أي مراقبة أو فرض تاني من الكود).
// ============================================================================

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WORK_DIR = process.cwd();

function log(msg) {
  console.error(`[agent ${new Date().toISOString()}] ${msg}`);
}

// ============================================================================
// وضع الـ Agent الرئيسي
// ============================================================================
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// سلسلة نماذج احتياطية — التبديل تلقائي للي بعده لما نستنفد محاولات إعادة الاتصال
// على النموذج الحالي. مرتبة من الأعلى قدرة للأكرم في حدود الخطة المجانية (RPM).
const MODEL_CHAIN = (process.env.GEMINI_MODEL_CHAIN || 'gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-2.5-flash-lite')
  .split(',').map((s) => s.trim()).filter(Boolean);
let currentModelIndex = 0;

const TASK_JSON = process.env.TASK_JSON || 'اعمل فيديو سورة الإخلاص كاملة، بدون تفسير، أفقي.';
const CALLBACK_URL = process.env.CALLBACK_URL || ''; // هيتحدد لاحقًا، اختياري دلوقتي
const GH_REPO = process.env.GITHUB_REPOSITORY || '';
const RELEASE_TAG = `render-${process.env.GITHUB_RUN_NUMBER || Date.now()}`;
// لازم نسجّلهم فعليًا في process.env — مش بس متغيرات JS محلية — عشان يبقوا
// متاحين كـ $RELEASE_TAG و$GH_REPO جوه أي أمر run_terminal (bash child process)
process.env.RELEASE_TAG = RELEASE_TAG;
process.env.GH_REPO = GH_REPO;
const MAX_TURNS = 80;

const TASK_COMPLETE_MARKER = 'TASK_COMPLETE.json';

// ---------------------------------------------------------------------------
// الأداة الوحيدة: تنفيذ أمر شل حقيقي
// ---------------------------------------------------------------------------
async function runTerminal({ command }) {
  try {
    const output = execSync(command, {
      cwd: WORK_DIR,
      env: process.env,
      timeout: 10 * 60 * 1000, // أكبر من مهلة الرندر الداخلية (8 دقايق) عشان الرندر يقدر يرجّع JSON منظم لو فشل، بدل قتل عنيف من هنا
      maxBuffer: 30 * 1024 * 1024,
      shell: '/bin/bash',
    }).toString();
    return { success: true, exit_code: 0, output: output.slice(0, 6000) };
  } catch (e) {
    return {
      success: false,
      exit_code: e.status ?? null,
      error: e.message,
      stdout: (e.stdout || '').toString().slice(0, 3000),
      stderr: (e.stderr || '').toString().slice(0, 3000),
    };
  }
}

const functionDeclarations = [
  {
    name: 'run_terminal',
    description:
      'الأداة الوحيدة المتاحة لك. تنفّذ أي أمر bash حقيقي داخل بيئة GitHub Actions ' +
      '(curl لجلب أي API، cat/heredoc لكتابة أي ملف، node لتشغيل الرندر، gh لرفع الملفات). ' +
      'أنت المسؤول الكامل عن تنفيذ كل خطوة بنفسك عن طريق الأداة دي — مفيش أي أداة تانية.',
    parameters: {
      type: 'OBJECT',
      properties: { command: { type: 'STRING', description: 'أمر bash كامل، ممكن يكون متعدد الأسطر (heredoc مثلاً)' } },
      required: ['command'],
    },
  },
];

// ---------------------------------------------------------------------------
// فحص بسيط جدًا: هل ملف إنهاء المهمة موجود؟ كل حاجة تانية (التحقق من صحة
// scene.html، تتبّع كل فيديو خلص، الالتزام بالـ Reflexion) بقت مسؤولية
// الـ Agent نفسه بالكامل، حسب التعليمات المكتوبة في AGENTS.md — مفيش أي
// كود هنا بيراقبها أو بيفرضها.
// ---------------------------------------------------------------------------
function isTaskComplete() {
  return fs.existsSync(path.join(WORK_DIR, TASK_COMPLETE_MARKER));
}

// ---------------------------------------------------------------------------
// Gemini API — REST مباشر مع retry + تبديل نماذج تلقائي
// ---------------------------------------------------------------------------
function parseRetryDelaySeconds(errorBody) {
  try {
    const details = errorBody && errorBody.error && errorBody.error.details;
    const retryInfo = details && details.find((d) => (d['@type'] || '').includes('RetryInfo'));
    if (!retryInfo || !retryInfo.retryDelay) return null;
    const seconds = parseFloat(String(retryInfo.retryDelay).replace('s', ''));
    return Number.isFinite(seconds) ? seconds : null;
  } catch (e) {
    return null;
  }
}

async function callGemini(contents, systemInstruction, attempt = 1) {
  const MAX_ATTEMPTS_PER_MODEL = 3;
  const model = MODEL_CHAIN[currentModelIndex];
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const body = {
    contents,
    system_instruction: { parts: [{ text: systemInstruction }] },
    tools: [{ functionDeclarations }],
  };

  let res, data;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify(body),
    });
    data = await res.json();
  } catch (networkErr) {
    if (attempt < MAX_ATTEMPTS_PER_MODEL) {
      const waitSeconds = Math.min(60, 5 * Math.pow(2, attempt));
      log(`خطأ شبكة عند الاتصال بـ Gemini (${networkErr.message}). هستنى ${waitSeconds}s وأعيد المحاولة (${attempt}/${MAX_ATTEMPTS_PER_MODEL})...`);
      await new Promise((r) => setTimeout(r, waitSeconds * 1000));
      return callGemini(contents, systemInstruction, attempt + 1);
    }
    throw new Error(`فشل الاتصال بـ Gemini بعد عدة محاولات: ${networkErr.message}`);
  }

  if (!res.ok) {
    const isTransient = res.status === 429 || (res.status >= 500 && res.status < 600);
    if (isTransient) {
      if (attempt < MAX_ATTEMPTS_PER_MODEL) {
        const serverDelay = parseRetryDelaySeconds(data);
        const waitSeconds = serverDelay != null ? serverDelay + 1 : Math.min(60, 5 * Math.pow(2, attempt));
        log(`خطأ مؤقت (${res.status}) على ${model}. هستنى ${waitSeconds.toFixed(1)}s وأعيد المحاولة (${attempt}/${MAX_ATTEMPTS_PER_MODEL})...`);
        await new Promise((r) => setTimeout(r, waitSeconds * 1000));
        return callGemini(contents, systemInstruction, attempt + 1);
      }
      if (currentModelIndex < MODEL_CHAIN.length - 1) {
        currentModelIndex++;
        log(`استنفدنا محاولات ${model} (${res.status}). التبديل للنموذج الاحتياطي: ${MODEL_CHAIN[currentModelIndex]}`);
        return callGemini(contents, systemInstruction, 1);
      }
      throw new Error(`استنفدنا كل النماذج في السلسلة (${MODEL_CHAIN.join(', ')}) بسبب أخطاء متكررة (${res.status}).`);
    }
    throw new Error(`Gemini API error (${res.status}): ${JSON.stringify(data).slice(0, 500)}`);
  }
  return data;
}

function buildSystemPrompt(agentsMd) {
  return `
انت أوفق AI Agent — عقل مستقل بيبني فيديوهات قرآنية كاملة من الصفر.

# هويتك الثابتة والعقد التقني الإلزامي (التزم بيه حرفيًا)
${agentsMd}

# الأداة الوحيدة المتاحة لك
run_terminal(command) — ده كل اللي عندك. مفيش أي أداة تانية، ومفيش أي دالة رندر جاهزة.
من خلاله لازم:
- تجيب أي نص (آية/تفسير) عن طريق: curl -s "<url>"
- تحمّل الصوت والصور عن طريق: curl -s -o assets/xxx "<url>"
- تكتب أي ملف (scene.html، سكريبت الرندر، ملف .md) عن طريق: cat > path/to/file << 'EOF' ... EOF
- **الرندر نفسه لازم تكتبه إنت بالكامل**: اكتب سكريبت Node.js بيستخدم Playwright
  (الوصفة الكاملة والمُختبَرة موجودة في قسم "دليل كتابة سكريبت الرندر" في AGENTS.md فوق —
  انسخها واستخدمها زي ما هي)، احفظه بأمر terminal، وشغّله بعد كده عن طريق terminal تاني.
- ترفع أي ملف على الـ Release عن طريق: gh release upload $RELEASE_TAG <file> --repo $GH_REPO

**مهم جدًا**: لو أي أمر terminal فشل (زي مشكلة quoting في heredoc)، **صحّح نفس المشكلة
بدقة وأعد المحاولة** — ممنوع منعًا باتًا تستبدل المحتوى بنسخة مبسّطة أو منقوصة عشان
"تتجنب" الخطأ. **مفيش أي فحص سلامة تلقائي بالكود هيرفض المشهد بدالك** — إنت المسؤول
الوحيد عن التأكد بنفسك إن scene.html فيه نص الآية الحقيقي والهوية البصرية والخلفية
قبل ما تعتبره جاهز، حسب القواعد المكتوبة في AGENTS.md.

# معمارية تفكيرك — إلزامية
1. **Plan-and-Solve**: أول رد منك في المهمة لازم يكون **نص عادي** (من غير أي استدعاء run_terminal)
   فيه خطتك الكاملة خطوة بخطوة. لو حاولت تستخدم run_terminal قبل كده هيترفض تلقائيًا.
2. **التنفيذ**: نفّذ خطوة خطوة عن طريق run_terminal. ممنوع تمامًا تكتب أي نص قرآني أو تفسير
   من ذاكرتك الداخلية — لازم يكون مصدره نتيجة curl فعلية في نفس الجلسة.
3. **علامة انتهاء كل فيديو**: بعد ما ترفع فيديو وملف الوصف بتاعه بنجاح، اكتب ملف علامة بالأمر:
   cat > video_<رقم السورة>_done.json << 'EOF'
   {"surah": <رقم>, "release_video_url": "...", "release_md_url": "..."}
   EOF
   **بعد ما تكتب ملف العلامة ده، إنت المسؤول بنفسك (من غير ما حد يطلب منك) عن كتابة
   رد نصي عادي (Reflexion) يقيّم اللي حصل قبل ما تكمل لأي فيديو تاني** — مفيش كود
   بيراقب ده أو بيجبرك عليه، الالتزام بالقاعدة دي بالكامل مسؤوليتك.
4. **علامة انتهاء المهمة كاملة**: لما كل الفيديوهات المطلوبة تخلص، اكتب:
   cat > TASK_COMPLETE.json << 'EOF'
   {"summary": "...", "videos": [...]}
   EOF
   وده آخر حاجة تعملها في الجلسة.

# بيئة التشغيل (متاحة كمتغيرات بيئة لأي أمر run_terminal)
- الريبو: $GH_REPO (${GH_REPO})
- Release Tag: $RELEASE_TAG (${RELEASE_TAG}) — الـ Release ده اتعمل فاضي بالفعل قبل ما تبدأ
- curl، gh، node، npm كلهم متاحين مباشرة

# المهمة المطلوبة منك دلوقتي
${TASK_JSON}
`.trim();
}

async function runAgentLoop() {
  const agentsMd = fs.readFileSync(path.join(WORK_DIR, 'AGENTS.md'), 'utf-8');
  const systemInstruction = buildSystemPrompt(agentsMd);

  let contents = [{ role: 'user', parts: [{ text: 'ابدأ المهمة. اكتب خطتك الكاملة كنص عادي أولًا.' }] }];
  let hasPlanned = false;
  let taskComplete = false;
  let finalPayload = null;

  for (let turn = 0; turn < MAX_TURNS && !taskComplete; turn++) {
    log(`--- Turn ${turn + 1}/${MAX_TURNS} ---`);
    const response = await callGemini(contents, systemInstruction);
    const candidate = response.candidates && response.candidates[0];
    if (!candidate) throw new Error('مفيش رد من Gemini: ' + JSON.stringify(response).slice(0, 500));

    contents.push(candidate.content);
    const parts = candidate.content.parts || [];
    const functionCalls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);

    if (functionCalls.length === 0) {
      const textReply = parts.map((p) => p.text || '').join(' ');
      log('رد نصي (خطة/تفكير/مراجعة): ' + textReply.slice(0, 500));
      hasPlanned = true;
      contents.push({ role: 'user', parts: [{ text: 'تمام. كمّل بأوامر run_terminal الفعلية دلوقتي.' }] });
      continue;
    }

    const functionResponses = [];
    for (const fc of functionCalls) {
      log(`run_terminal: ${JSON.stringify(fc.args).slice(0, 300)}`);

      let result;
      if (!hasPlanned) {
        result = { success: false, error: 'لازم تكتب خطتك الكاملة كنص عادي الأول قبل أي أمر terminal.' };
      } else {
        result = await runTerminal(fc.args || {});
      }

      log(`نتيجة: ${JSON.stringify(result).slice(0, 400)}`);
      functionResponses.push({ functionResponse: { name: fc.name, response: result, id: fc.id } });
    }
    contents.push({ role: 'user', parts: functionResponses });

    // فحص بسيط بعد كل دورة: هل ملف إنهاء المهمة ظهر؟ (تتبّع كل فيديو ومراجعته
    // الذاتية بقت مسؤولية الـ Agent نفسه حسب AGENTS.md، مش كود هنا)
    if (isTaskComplete()) {
      const raw = fs.readFileSync(path.join(WORK_DIR, TASK_COMPLETE_MARKER), 'utf-8');
      finalPayload = JSON.parse(raw);
      taskComplete = true;
      log('المهمة اكتملت بالكامل.');
    }
  }

  if (!taskComplete) {
    throw new Error(`وصلنا للحد الأقصى من الأدوار (${MAX_TURNS}) من غير ما نلاقي ${TASK_COMPLETE_MARKER}.`);
  }
  return finalPayload;
}

async function main() {
  if (!GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY غير موجود في متغيرات البيئة. أوقف التنفيذ.');
    process.exit(1);
  }

  log('بسم الله — بدء تشغيل أوفق AI Agent v2.0');

  try {
    execSync(
      `gh release create ${RELEASE_TAG} --repo ${GH_REPO} --title "Ofoq AI Agent Render" --notes "تم الإنشاء تلقائيًا بواسطة agent.js"`,
      { env: process.env, stdio: 'pipe' }
    );
    log(`تم إنشاء Release: ${RELEASE_TAG}`);
  } catch (e) {
    log('ملحوظة: فشل إنشاء الـ Release (يمكن يكون موجود بالفعل) — ' + e.message.slice(0, 200));
  }

  const finalPayload = await runAgentLoop();
  log('النتيجة النهائية: ' + JSON.stringify(finalPayload, null, 2));

  if (CALLBACK_URL) {
    try {
      await fetch(CALLBACK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(finalPayload),
      });
      log('تم إبلاغ الـ callback endpoint بنجاح.');
    } catch (e) {
      log('تحذير: فشل الاتصال بالـ callback endpoint — ' + e.message);
    }
  }
}

// ============================================================================
// نقطة الدخول
// ============================================================================
main().catch((err) => {
  console.error('خطأ فادح في الـ Agent:', err);
  process.exit(1);
});
