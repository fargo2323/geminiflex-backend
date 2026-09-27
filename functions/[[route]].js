// Cloudflare Pages Serverless Proxy for GeminiFlex with Context-Aware Multi-Turn History & Advanced Tavily Search

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
        service: "GeminiFlex Cloudflare Pages (Multi-turn History & Advanced Search)",
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

  // پردازش هوشمند پیام با تاریخچه کامل ترد و سرچ زنده پیشرفته
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

      // ساخت آرایه تاریخچه چندمرحله‌ای (Multi-Turn Contents) استاندارد Google Gemini API
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

      // دستورالعمل سیستمی برای مدل
      let systemPromptText = "You are Gemini, a helpful, intelligent, precise, and state-of-the-art AI built by Google. You have full memory and context of the entire conversation thread above. Always consider the previous conversation turns when answering the user.";

      // جستجوی وب هوشمند و متصل به کانتکست مکالمه
      if (prompt.trim().length > 2 && tavilyApiKey) {
        let searchQuery = prompt.trim();
        if (searchQuery.length < 25 && conversationTurns.length >= 2) {
          const previousUserTurn = conversationTurns.slice(0, -1).reverse().find(t => t.role === "user");
          if (previousUserTurn && previousUserTurn.parts?.[0]?.text) {
            searchQuery = `${previousUserTurn.parts[0].text} ${searchQuery}`;
          }
        }

        const searchData = await fetchTavilySearch(searchQuery, tavilyApiKey);
        if (searchData && (searchData.answer || searchData.results.length > 0)) {
          let searchContext = "";
          if (searchData.answer) {
            searchContext += `[خلاصه موثق و قطعی موتور جستجو]:\n${searchData.answer}\n\n`;
          }
          if (searchData.results.length > 0) {
            searchContext += `[جزئیات منابع زنده وب]:\n` + searchData.results
              .map((r, idx) => `(منبع ${idx + 1}: ${r.title})\n${r.content}`)
              .join("\n\n");
          }
          systemPromptText += `\n\n[اطلاعات زنده و اینترنتی موثق برای این سوال]:\n${searchContext}\n\nنکته مهم: برای پاسخ به سوال کاربر حتماً و موکداً از اطلاعات زنده بالا استفاده کن. اگر قیمت لحظه‌ای، تاریخ، ساعت یا نتیجه مسابقه خواسته شده، دقیقاً همان عدد و داده‌های جدید و قطعی استخراج‌شده بالا را ملاک قرار بده و به کاربر اعلام کن.`;
        }
      }

      const startTime = Date.now();
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

      const requestPayload = {
        contents: conversationTurns,
        systemInstruction: {
          parts: [{ text: systemPromptText }],
        },
        generationConfig: {
          temperature: body.temperature ?? 0.3,
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
