// Cloudflare Pages Serverless Proxy for GeminiFlex with Built-in Live Web Search

async function fetchWebSearch(query) {
  try {
    const resp = await fetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      body: new URLSearchParams({ q: query }).toString(),
    });

    if (!resp.ok) return [];
    const html = await resp.text();

    const snippets = [];
    const regex = /<a[^>]*class=["']result__snippet["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = regex.exec(html)) !== null && snippets.length < 5) {
      const clean = match[1].replace(/<[^>]+>/g, "").trim();
      if (clean.length > 10) snippets.push(clean);
    }
    return snippets;
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
        service: "GeminiFlex Cloudflare Pages (Search-Enabled)",
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

  // پردازش هوشمند پیام با سرچ زنده وب
  if (url.pathname === "/generate" && request.method === "POST") {
    try {
      const body = await request.json();
      const apiKey = body.apiKey && body.apiKey.trim() ? body.apiKey.trim() : env.GEMINI_API_KEY;

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

      // بررسی هوشمند نیاز به جستجوی وب برای نتایج زنده، مسابقات، اخبار و رویدادها
      let systemPromptText = "You are Gemini, a helpful, precise, and state-of-the-art AI built by Google.";
      
      const searchKeywords = ["بازی", "فوتبال", "مسابقه", "نتیجه", "نتایج", "امشب", "امروز", "الان", "ساعت", "تاریخ", "اخبار", "جدید", "قیمت", "هوا", "schedule", "score", "match", "result", "today", "tonight", "news"];
      const needsSearch = prompt.length > 2 && searchKeywords.some(kw => prompt.toLowerCase().includes(kw));

      if (needsSearch) {
        const searchResults = await fetchWebSearch(prompt);
        if (searchResults.length > 0) {
          systemPromptText += `\n[Live Web Search Results from the Internet]:\n${searchResults.map((s, idx) => `(${idx + 1}) ${s}`).join("\n")}\nUse these live web search results to provide accurate, real-time facts, match scores, and current event details to the user.`;
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
