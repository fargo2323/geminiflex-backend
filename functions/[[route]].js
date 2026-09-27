// Cloudflare Pages Serverless Proxy for GeminiFlex with Context-Aware Multi-Turn History & Smart Web Search

async function fetchTavilySearch(query, tavilyApiKey) {
  try {
    const resp = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: tavilyApiKey,
        query: query,
        search_depth: "advanced",
        include_answer: true,
        max_results: 4,
      }),
    });

    if (!resp.ok) return null;
    const data = await resp.json();
    return {
      answer: data.answer || "",
      results: data.results || [],
    };
  } catch (e) {
    return null;
  }
}

function evaluateWebSearch(prompt, conversationTurns) {
  const p = prompt.trim();

  // ۱. خوش‌وبش‌های کوتاه و احوال‌پرسی (بدون نیاز به سرچ)
  if (/^(سلام|درود|صبح بخیر|عصر بخیر|شب بخیر|خوبی|چطوری|سلام علیکم)(\s+(عزیز|دوست من|وقت بخیر|خوبی|خسته نباشید))?[\.!\؟\?]?$/i.test(p)) {
    return { shouldSearch: false, query: "" };
  }

  // ۲. سوالات توضیحی و پیگیری درباره پاسخ‌های قبلی ربات (Meta-questions)
  if (/(چرا|چطور|علت|دلیل|کجا).*(خطا|اشتباه|غلط|اینطوری گفتی|این جواب|اشتباه شد)/i.test(p) ||
      /^(چرا|منظورت چی بود|منظورم این نبود|رنج قیمت چیو|قیمت چیو|چی گفتی|چی شد)/i.test(p)) {
    return { shouldSearch: false, query: "" };
  }

  // ۳. درخواست‌های کدنویسی، ترجمه، بازنویسی و ادبی
  if (/(کد|برنامه|اسکریپت|تابع|کلاس|پایتون|جاوا|کاتلین).*(بنویس|بزن|بده|توسعه)/i.test(p) ||
      /^(ترجمه کن|خلاصه کن|بازنویسی کن|شعر بگو|داستان بگو)/i.test(p)) {
    return { shouldSearch: false, query: "" };
  }

  // ۴. کلیدواژه‌های نیازمند اطلاعات زنده وب
  const livePatterns = [
    /(قیمت|نرخ|ارزش|چنده|چند بود|رنج|کف|سقف|بالاترین|پایین‌ترین|نوسان)/i,
    /(امروز|الان|لحظه‌ای|دیروز|هفته پیش|امشب|فردا|ساعت چند|تاریخ امروز)/i,
    /(بیتکوین|ارز|دلار|تومان|تتر|طلا|سکه|بورس|سهام|کریپتو|رمزارز|BTC|ETH)/i,
    /(بازی|فوتبال|مسابقه|نتیجه|جدول|ورزش|لیگ)/i,
    /(اخبار|خبر|جدیدترین|رویداد|وضعیت هوا)/i,
    /(price|today|now|live|news|score|match|weather|crypto|bitcoin|rate)/i
  ];

  const needsSearch = livePatterns.some(pat => pat.test(p));
  if (!needsSearch) {
    return { shouldSearch: false, query: "" };
  }

  // ۵. ساخت کوئری متصل به کانتکست مکالمه
  let query = p.replace(/^(سلام|درود|وقت بخیر|خسته نباشید)[\s،,]+/i, "").trim();

  // اگر سوال دنباله‌دار است، موضوع صحبت را از پیام‌های قبلی استخراج می‌کنیم
  let subject = "";
  for (let i = conversationTurns.length - 1; i >= 0; i--) {
    const turnText = conversationTurns[i].parts?.[0]?.text || "";
    const match = turnText.match(/(بیتکوین|اتریوم|دلار|طلا|سکه|تتر|رمزارز|بورس|پرسپولیس|استقلال|رئال مادرید|بارسلونا|[A-Z]{3,5})/i);
    if (match) {
      subject = match[1];
      break;
    }
    if (conversationTurns[i].role === "user" && !subject) {
      const words = turnText.split(/\s+/).slice(0, 6);
      const clean = words.filter(w => !["سلام", "امروز", "لطفا", "چنده", "قیمت", "نرخ", "چند", "بود"].includes(w));
      if (clean.length > 0) {
        subject = clean.join(" ");
        break;
      }
    }
  }

  if (subject && !query.toLowerCase().includes(subject.toLowerCase())) {
    query = `${subject} ${query}`;
  }

  return { shouldSearch: true, query: query };
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // وضعیت و آمار سهمیه
  if (url.pathname === "/stats" || (url.pathname === "/" && request.method === "GET")) {
    return new Response(
      JSON.stringify({
        status: "online",
        service: "GeminiFlex Cloudflare Pages (Smart Contextual Search & Multi-turn History)",
        default_model: "gemini-3.5-flash-lite",
        stats: {
          daily_limit: 500,
          rpm_limit: 15,
          tpm_limit: 250000,
        },
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // پردازش هوشمند پیام با تاریخچه کامل ترد و سرچ زنده هدفمند
  if (url.pathname === "/generate" && request.method === "POST") {
    try {
      const body = await request.json();
      const apiKey = body.apiKey && body.apiKey.trim() ? body.apiKey.trim() : env.GEMINI_API_KEY;
      const tavilyApiKey = env.TAVILY_API_KEY || "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";

      if (!apiKey) {
        return new Response(
          JSON.stringify({ error: "GEMINI_API_KEY is not configured" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const prompt = body.prompt || "";
      const images = body.images || [];
      const model = body.model || "gemini-3.5-flash-lite";
      const rawHistory = Array.isArray(body.history) ? body.history : [];

      const currentParts = [];
      for (const img of images) {
        if (img.data) {
          currentParts.push({
            inlineData: {
              mimeType: img.mimeType || "image/jpeg",
              data: img.data.trim(),
            },
          });
        }
      }

      if (prompt.trim().length > 0) {
        currentParts.push({ text: prompt.trim() });
      }

      if (currentParts.length === 0) {
        return new Response(
          JSON.stringify({ error: "Prompt or image is required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // ساخت آرایه تاریخچه استاندارد چندمرحله‌ای Google Gemini API
      const conversationTurns = [];

      for (const item of rawHistory) {
        if (!item || !item.content || typeof item.content !== "string") continue;
        const textContent = item.content.trim();
        if (textContent.length === 0) continue;

        const role = (item.role === "assistant" || item.role === "model") ? "model" : "user";
        
        // ادغام پیام‌های متوالی با نقش یکسان
        if (conversationTurns.length > 0 && conversationTurns[conversationTurns.length - 1].role === role) {
          conversationTurns[conversationTurns.length - 1].parts[0].text += "\n" + textContent;
        } else {
          if (conversationTurns.length === 0 && role === "model") {
            continue;
          }
          conversationTurns.push({
            role: role,
            parts: [{ text: textContent }],
          });
        }
      }

      // اضافه کردن پیام جاری کاربر به انتهای تاریخچه
      if (conversationTurns.length > 0 && conversationTurns[conversationTurns.length - 1].role === "user") {
        conversationTurns[conversationTurns.length - 1].parts.push(...currentParts);
      } else {
        conversationTurns.push({
          role: "user",
          parts: currentParts,
        });
      }

      // دستورالعمل سیستمی برای هوش مصنوعی
      let systemPromptText = "You are Gemini, an intelligent, helpful, and state-of-the-art AI built by Google. You have full memory of this ongoing conversation thread. Always stay consistent with previous conversation turns and user topics.\n\n[CRITICAL - NATIVE CHART ENGINE]: Your client application interface has a built-in Native Interactive Animated Chart Engine. NEVER say 'I cannot draw charts' or 'من به عنوان هوش مصنوعی متنی امکان ترسیم مستقیم نمودار ندارم'! Whenever the user asks for a chart, graph, price trend, technical levels, comparison, or asks 'can you draw/plot a chart?', you MUST ALWAYS include a ```chart code block in JSON format alongside your explanation so the app UI renders it immediately as an interactive visual chart:\n```chart\n{\"type\":\"line\",\"title\":\"روند قیمت\",\"data\":[{\"label\":\"نقطه ۱\",\"value\":80000},{\"label\":\"نقطه ۲\",\"value\":85000}]}\n```\n(Supported types: 'line' for trends/prices, 'bar' for categories, 'pie' for shares).";

      // ارزیابی هوشمند نیاز به جستجوی وب
      const searchDecision = evaluateWebSearch(prompt, conversationTurns);

      if (searchDecision.shouldSearch && tavilyApiKey) {
        const searchData = await fetchTavilySearch(searchDecision.query, tavilyApiKey);
        if (searchData && (searchData.answer || searchData.results.length > 0)) {
          let searchContext = "";
          if (searchData.answer) {
            searchContext += `[پاسخ خلاصه موتور جستجو]:\n${searchData.answer}\n\n`;
          }
          if (searchData.results.length > 0) {
            searchContext += `[منابع زنده وب]:\n` + searchData.results
              .map((r, idx) => `(منبع ${idx + 1}: ${r.title})\n${r.content}`)
              .join("\n\n");
          }
          systemPromptText += `\n\n[اطلاعات زنده وب استخراج‌شده برای موضوع کاربر]:\n${searchContext}\n\nنکته مهم: از اطلاعات زنده بالا استفاده کن مشروط بر اینکه مستقیماً با موضوع اصلی مکالمه (مثلاً بیت‌کوین) مرتبط باشد. اگر اطلاعات مربوط
