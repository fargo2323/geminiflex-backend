// Cloudflare Pages Serverless Proxy for GeminiFlex

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

  // وضعیت و لیمیت‌ها
  if (url.pathname === "/stats" || (url.pathname === "/" && request.method === "GET")) {
    const todayStr = new Date().toISOString().split("T")[0];
    return new Response(
      JSON.stringify({
        status: "online",
        service: "GeminiFlex Cloudflare Pages",
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

  // ارسال پرامپت و تصویر به گوگل جمنای
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

      const startTime = Date.now();
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

      const geminiResponse = await fetch(geminiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: parts }],
          generationConfig: {
            temperature: body.temperature ?? 0.4,
            maxOutputTokens: body.maxOutputTokens ?? 2048,
          },
        }),
      });

      const geminiData = await geminiResponse.json();
      const latencyMs = Date.now() - startTime;

      if (!geminiResponse.ok) {
        return new Response(
          JSON.stringify({ success: false, status_code: geminiResponse.status, error: geminiData }),
          { status: geminiResponse.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const replyText =
        geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "";

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
