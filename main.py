import os
import httpx
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional

app = FastAPI(title="GeminiFlex Backend Proxy")

# تنظیم CORS برای ارتباط بدون محدودیت
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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
        "default_model": "gemini-3.5-flash-lite"
    }

@app.post("/generate")
async def generate(req: ChatRequest):
    # دریافت کلید از متغیرهای امنیتی سرور
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=500, 
            detail="GEMINI_API_KEY is not configured in Render Environment Variables"
        )

    # چینش بخش‌های ارسالی (تصاویر و متن)
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

    async with httpx.AsyncClient(timeout=90.0) as client:
        try:
            resp = await client.post(url, json=payload)
            data = resp.json()
            
            if resp.status_code != 200:
                return {
                    "success": False, 
                    "status_code": resp.status_code, 
                    "error": data
                }
            
            # استخراج پاسخ متنی مدل
            candidates = data.get("candidates", [])
            reply_text = ""
            if candidates:
                parts_out = candidates[0].get("content", {}).get("parts", [])
                if parts_out:
                    reply_text = parts_out[0].get("text", "")

            return {
                "success": True,
                "model_used": model_name,
                "reply": reply_text
            }
        except httpx.TimeoutException:
            raise HTTPException(status_code=504, detail="Gemini API timeout (90s exceeded)")
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))
