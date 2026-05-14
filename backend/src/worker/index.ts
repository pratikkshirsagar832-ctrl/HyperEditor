import { Hono } from "hono";
import { cors } from "hono/cors";
import { generateWithDeepSeek } from "./ai-helper";

interface Env {
  DEEPSEEK_API_KEY: string;
  R2_BUCKET: R2Bucket;
  DB: D1Database;
  MOCHA_USERS_SERVICE_API_URL: string;
  MOCHA_USERS_SERVICE_API_KEY: string;
}

interface AIEditResult {
  command: string;
  explanation: string;
}

interface PendingRequest {
  status: string;
  result?: AIEditResult;
  error?: string;
}

// In-memory store for pending requests (dev only)
const pendingRequests = new Map<string, PendingRequest>();

const app = new Hono<{ Bindings: Env }>();

app.use("/*", cors());

// Start an AI edit job - returns immediately with a job ID
app.post("/api/ai-edit/start", async (c) => {
  try {
    const body = await c.req.json();
    const prompt = body.prompt;

    if (!prompt) {
      return c.json({ error: "Prompt is required" }, 400);
    }

    const jobId = crypto.randomUUID();
    pendingRequests.set(jobId, { status: "processing" });

    // Process in background using waitUntil
    c.executionCtx.waitUntil(
      (async () => {
        try {
          const response = await generateWithDeepSeek(c.env.DEEPSEEK_API_KEY, prompt, {
            systemInstruction: `You are a video editing AI assistant that helps users edit their videos using FFmpeg commands.

When the user describes what they want to do with their video, you should:
1. Understand the editing request
2. Generate the appropriate FFmpeg command to accomplish it
3. Explain what the command will do in simple terms

IMPORTANT: Always use "input.mp4" as the input filename and "output.mp4" as the output filename in your commands.

Return your response as valid JSON with exactly this structure:
{"command": "the FFmpeg command", "explanation": "simple explanation"}

Common video editing tasks:
- Remove dead air/silence: ffmpeg -y -i input.mp4 -af "silenceremove=start_periods=1:start_duration=0.5:start_threshold=-40dB:stop_periods=-1:stop_duration=0.5:stop_threshold=-40dB,asetpts=N/SR/TB" -vf "setpts=N/FRAME_RATE/TB" -shortest output.mp4
- Trim/cut video: ffmpeg -y -i input.mp4 -ss 00:00:10 -to 00:00:30 -c copy output.mp4
- Speed up 2x: ffmpeg -y -i input.mp4 -filter:v "setpts=0.5*PTS" -filter:a "atempo=2.0" output.mp4
- Slow down 0.5x: ffmpeg -y -i input.mp4 -filter:v "setpts=2.0*PTS" -filter:a "atempo=0.5" output.mp4
- Remove audio: ffmpeg -y -i input.mp4 -an -c:v copy output.mp4
- Remove background noise: ffmpeg -y -i input.mp4 -af "highpass=f=200,lowpass=f=3000,afftdn=nf=-25" -c:v copy output.mp4
- Resize to 1920x1080: ffmpeg -y -i input.mp4 -vf "scale=1920:1080" output.mp4
- Rotate 90° clockwise: ffmpeg -y -i input.mp4 -vf "transpose=1" output.mp4
- Increase volume 50%: ffmpeg -y -i input.mp4 -af "volume=1.5" -c:v copy output.mp4
- Add fade in/out (1 second): ffmpeg -y -i input.mp4 -vf "fade=t=in:st=0:d=1,fade=t=out:st=END-1:d=1" -af "afade=t=in:st=0:d=1,afade=t=out:st=END-1:d=1" output.mp4

Always use -y flag to overwrite output. Provide safe, valid FFmpeg commands.`,
            responseMimeType: "application/json",
          });

          const responseText = response.text || "{}";
          let result: AIEditResult;
          try {
            result = JSON.parse(responseText);
          } catch {
            const jsonMatch = responseText.match(/\{[\s\S]*\}/);
            result = jsonMatch
              ? JSON.parse(jsonMatch[0])
              : { command: "", explanation: "Failed to parse response" };
          }

          pendingRequests.set(jobId, { status: "complete", result });
        } catch (error) {
          console.error("AI edit error:", error);
          pendingRequests.set(jobId, {
            status: "error",
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      })()
    );

    return c.json({ jobId, status: "processing" });
  } catch (error) {
    console.error("Start job error:", error);
    return c.json({ error: "Failed to start job" }, 500);
  }
});

// Check job status
app.get("/api/ai-edit/status/:jobId", async (c) => {
  const jobId = c.req.param("jobId");
  const job = pendingRequests.get(jobId);

  if (!job) {
    return c.json({ error: "Job not found" }, 404);
  }

  if (job.status === "complete") {
    pendingRequests.delete(jobId); // Clean up
    return c.json({ status: "complete", success: true, ...job.result });
  }

  if (job.status === "error") {
    pendingRequests.delete(jobId); // Clean up
    return c.json({ status: "error", error: job.error });
  }

  return c.json({ status: "processing" });
});

// Legacy endpoint - simple synchronous call (fallback)
app.post("/api/ai-edit", async (c) => {
  try {
    const body = await c.req.json();
    const prompt = body.prompt;

    if (!prompt) {
      return c.json({ error: "Prompt is required" }, 400);
    }

    const response = await generateWithDeepSeek(c.env.DEEPSEEK_API_KEY, prompt, {
      systemInstruction: `You are a video editing AI assistant that helps users edit their videos using FFmpeg commands.

When the user describes what they want to do with their video, you should:
1. Understand the editing request
2. Generate the appropriate FFmpeg command to accomplish it
3. Explain what the command will do in simple terms

IMPORTANT: Always use "input.mp4" as the input filename and "output.mp4" as the output filename in your commands.

Return your response as valid JSON with exactly this structure:
{"command": "the FFmpeg command", "explanation": "simple explanation"}

Common video editing tasks:
- Remove dead air/silence: ffmpeg -y -i input.mp4 -af "silenceremove=start_periods=1:start_duration=0.5:start_threshold=-40dB:stop_periods=-1:stop_duration=0.5:stop_threshold=-40dB,asetpts=N/SR/TB" -vf "setpts=N/FRAME_RATE/TB" -shortest output.mp4
- Trim/cut: ffmpeg -y -i input.mp4 -ss 00:00:10 -to 00:00:30 -c copy output.mp4
- Speed up 2x: ffmpeg -y -i input.mp4 -filter:v "setpts=0.5*PTS" -filter:a "atempo=2.0" output.mp4
- Remove background noise: ffmpeg -y -i input.mp4 -af "highpass=f=200,lowpass=f=3000,afftdn=nf=-25" -c:v copy output.mp4
- Resize: ffmpeg -y -i input.mp4 -vf "scale=1280:720" output.mp4

Always use -y flag to overwrite output. Provide safe, valid FFmpeg commands.`,
      responseMimeType: "application/json",
    });

    const responseText = response.text || "{}";
    let result;
    try {
      result = JSON.parse(responseText);
    } catch {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      result = jsonMatch
        ? JSON.parse(jsonMatch[0])
        : { command: "", explanation: "Failed to parse response" };
    }

    return c.json({ success: true, ...result });
  } catch (error) {
    console.error("AI edit error:", error);
    return c.json(
      {
        error: "Failed to process AI request",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

export default app;
