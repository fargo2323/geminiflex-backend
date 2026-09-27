// Cloudflare Pages Serverless Proxy for GeminiFlex with Tavily AI Real-time Web Search

async function fetchTavilySearch(query, tavilyApiKey) {
  try {
    const resp = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: tavilyApiKey,
        query: query,
        max_results: 3,
        search_depth: "basic",
      }),
    });

    if (!resp.ok) return [];
    const data = await resp.json();
    return data.results || [];
  } catch (e) {
    return [];
  }
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
        service: "GeminiFlex Cloudflare Pages (Tavily Search-Enabled)",
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

  // پردازش هوشمند پیام با سرچ زنده Tavily
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

      const parts = [];
      for (const img of images) {
        if (img.data) {
          parts.push({
            inlineData: {
              mimeType: img.mimeType || "image/jpeg",
              data: img.data.trim(),
            },
          });
        }
      }

      if (prompt.trim().length > 0) {
        parts.push({ text: prompt.trim() });
      }

      if (parts.length === 0) {
        return new Response(
          JSON.stringify({ error: "Prompt or image is required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // دستورالعمل سیستمی پایه
      let systemPromptText = "You are Gemini, an intelligent, helpful, and state-of-the-art AI assistant built by Google.";

      // کلیدواژه‌های جستجوی زنده در وب
      const searchKeywords = [
        "بازی", "فوتبال", "مسابقه", "نتیجه", "نتایج", "امشب", "امروز", "الان", "ساعت", "تاریخ",
        "اخبار", "جدید", "قیمت", "هوا", "چند", "کی", "سرچ", "بیتکوین", "طلا", "دلار", "ارز",
        "schedule", "score", "match", "result", "today", "tonight", "news", "price", "btc"
      ];

      const needsSearch = prompt.length > 2 && (searchKeywords.some(kw => prompt.toLowerCase().includes(kw)) || prompt.includes("؟") || prompt.includes("?"));

      if (needsSearch && tavilyApiKey) {
        const searchResults = await fetchTavilySearch(prompt, tavilyApiKey);
        if (searchResults.length > 0) {
          const formattedResults = searchResults
            .map((r, idx) => `[منبع ${idx + 1}: ${r.title}]\n${r.content}`)
            .join("\n\n");
          systemPromptText += `\n\n[نتایج زنده جستجوی اینترنت برای این سوال]:\n${formattedResults}\n\nپاسخ کاربر را بر اساس نتایج زنده و به‌روز بالا، به صورت دقیق و به زبان فارسی ارائه کن.`;
        }
      }

      const startTime = Date.now();
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

      const requestPayload = {
        contents: [{ role: "user", parts: parts }],
        systemInstruction: {
          parts: [{ text: systemPromptText }],
        },
        generationConfig: {
          temperature: body.temperature ?? 0.4,
          maxOutputTokens: body.maxOutputTokens ?? 2048,
        },
      };

      const geminiResponse = await fetch(geminiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestPayload),
      });

      const geminiData = await geminiResponse.json();
      const latencyMs = Date.now() - startTime;

      if (!geminiResponse.ok) {
        return new Response(
          JSON.stringify({ success: false, status_code: geminiResponse.status, error: geminiData }),
          { status: geminiResponse.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const candidate = geminiData.candidates?.[0];
      let replyText = "";
      if (candidate?.content?.parts) {
        replyText = candidate.content.parts.map((p) => p.text || "").join("");
      }

      const usage = geminiData.usageMetadata || {};
      const promptTokens = usage.promptTokenCount || 0;
      const candidatesTokens = usage.candidatesTokenCount || 0;
      const totalTokens = usage.totalTokenCount || promptTokens + candidatesTokens;

      return new Response(
        JSON.stringify({
          success: true,
          model_used: model,
          reply: replyText,
          latency_ms: latencyMs,
          stats: {
            daily_limit: 500,
            rpm_limit: 15,
            tpm_limit: 250000,
            last_tokens_used: totalTokens,
            prompt_tokens: promptTokens,
            reply_tokens: candidatesTokens,
          },
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    } catch (err) {
      return new Response(
        JSON.stringify({ error: "Server Error", message: err.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  }

  return new Response(JSON.stringify({ error: "Not found" }), {
    status: 404,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
