import os
import httpx
from datetime import datetime, timezone
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional

app = FastAPI(title="GeminiFlex Backend Proxy with Quota Tracker")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DAILY_LIMIT = int(os.getenv("GEMINI_DAILY_LIMIT", "1500"))

# حافظه شمارشگر روزانه سرور
quota_tracker = {
    "current_date": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
    "requests_today": 0,
    "total_tokens_today": 0,
    "daily_limit": DAILY_LIMIT
}

def check_and_reset_daily():
    today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if quota_tracker["current_date"] != today_str:
        quota_tracker["current_date"] = today_str
        quota_tracker["requests_today"] = 0
        quota_tracker["total_tokens_today"] = 0

def get_stats_dict(last_tokens: int = 0):
    check_and_reset_daily()
    req_today = quota_tracker["requests_today"]
    rem = max(0, quota_tracker["daily_limit"] - req_today)
    pct = round((req_today / quota_tracker["daily_limit"]) * 100, 1)
    
    return {
        "date_utc": quota_tracker["current_date"],
        "requests_today": req_today,
        "daily_limit": quota_tracker["daily_limit"],
        "requests_remaining": rem,
        "usage_percentage": pct,
        "last_tokens_used": last_tokens,
        "total_tokens_today": quota_tracker["total_tokens_today"]
    }

class ImageData(BaseModel):
    data: str
    mimeType: Optional[str] = "image/jpeg"

class ChatRequest(BaseModel):
    prompt: Optional[str] = ""
    images: Optional[List[ImageData]] = []
    model: Optional[str] = "gemini-3.5-flash-lite"
    temperature: Optional[float] = 0.4
    maxOutputTokens: Optional[int] = 2048

@app.get("/")
def health_check():
    return {
        "status": "online",
        "service": "GeminiFlex Backend",
        "default_model": "gemini-3.5-flash-lite",
        "stats": get_stats_dict()
    }

@app.get("/stats")
def get_stats():
    return get_stats_dict()

@app.post("/generate")
async def generate(req: ChatRequest):
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="GEMINI_API_KEY is not configured")

    check_and_reset_daily()

    parts = []
    for img in (req.images or []):
        if img.data and img.data.strip():
            parts.append({
                "inlineData": {
                    "mimeType": img.mimeType or "image/jpeg",
                    "data": img.data.strip()
                }
            })

    if req.prompt and req.prompt.strip():
        parts.append({"text": req.prompt.strip()})

    if not parts:
        raise HTTPException(status_code=400, detail="Prompt or image is required")

    model_name = req.model if req.model else "gemini-3.5-flash-lite"
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent?key={api_key}"

    payload = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {
            "temperature": req.temperature,
            "maxOutputTokens": req.maxOutputTokens
        }
    }

    start_time = datetime.now()

    async with httpx.AsyncClient(timeout=90.0) as client:
        try:
            resp = await client.post(url, json=payload)
            data = resp.json()
            latency_ms = int((datetime.now() - start_time).total_seconds() * 1000)

            if resp.status_code != 200:
                return {
                    "success": False,
                    "status_code": resp.status_code,
                    "error": data,
                    "stats": get_stats_dict()
                }

            # ۱. استخراج پاسخ
            candidates = data.get("candidates", [])
            reply_text = ""
            if candidates:
                parts_out = candidates[0].get("content", {}).get("parts", [])
                if parts_out:
                    reply_text = parts_out[0].get("text", "")

            # ۲. استخراج توکن‌های مصرفی از گوگل
            usage = data.get("usageMetadata", {})
            prompt_tokens = usage.get("promptTokenCount", 0)
            candidates_tokens = usage.get("candidatesTokenCount", 0)
            total_tokens = usage.get("totalTokenCount", prompt_tokens + candidates_tokens)

            # ۳. به‌روزرسانی شمارنده روزانه
            quota_tracker["requests_today"] += 1
            quota_tracker["total_tokens_today"] += total_tokens

            return {
                "success": True,
                "model_used": model_name,
                "reply": reply_text,
                "latency_ms": latency_ms,
                "stats": get_stats_dict(last_tokens=total_tokens)
            }
        except httpx.TimeoutException:
            raise HTTPException(status_code=504, detail="Gemini API timeout")
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))
