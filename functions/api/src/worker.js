// Cloudflare Worker: serves /api/analyze, everything else comes from the public/ folder.
// Needs secret GEMINI_API_KEY (and optional GEMINI_MODEL) in the Worker's settings.

const SYSTEM = `You help short-term rental hosts respond to a bad guest review.
Rules:
- Never invent facts. Use only what the host provides. If a detail is missing, write a neutral line instead.
- Never promise the review will be removed. Removal is only plausible when a review breaks the platform's content policy (typical categories: irrelevant to the stay, retaliation or extortion, discriminatory or abusive language, private information, a stay that never happened). A review that is simply negative or unfair-but-honest usually stays up.
- Tell the host to confirm against the platform's current review policy, because rules change.
- The public reply must be calm, short (60-110 words), non-defensive, written for future guests who will read it.
- The removal request must be factual, polite, and name the specific policy category it relies on. If removal chances are low, say so and keep the request short.
Return ONLY JSON with keys:
"category" (short string), "removal_chance" ("low" | "medium" | "high"), "why" (2-3 sentences),
"removal_request" (string, ready to paste), "public_reply" (string, ready to paste), "check_before_sending" (array of 1-3 short strings).`;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });

async function analyze(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Send valid JSON." }, 400);
  }

  const review = String(body.review || "").trim();
  const facts = String(body.facts || "").trim();
  const stars = String(body.stars || "").trim();

  if (review.length < 20) return json({ error: "Paste the full review (at least 20 characters)." }, 400);
  if (review.length > 2500 || facts.length > 1500)
    return json({ error: "Text is too long. Keep the review under 2500 characters and your notes under 1500." }, 400);
  if (!env.GEMINI_API_KEY) return json({ error: "Server is missing GEMINI_API_KEY." }, 500);

  const model = env.GEMINI_MODEL || "gemini-2.5-flash";
  const prompt =
    `Star rating: ${stars || "not given"}\n\nGuest review:\n"""${review}"""\n\n` +
    `Host's notes on what actually happened:\n"""${facts || "none provided"}"""`;

  let res;
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.4 },
        }),
      }
    );
  } catch {
    return json({ error: "Could not reach the AI service. Try again." }, 502);
  }

  if (res.status === 429)
    return json({ error: "Free AI limit reached for now. Wait a minute and try again." }, 429);
  if (!res.ok) return json({ error: `AI service error (${res.status}).` }, 502);

  try {
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    const clean = text.replace(/```json|```/g, "").trim();
    return json(JSON.parse(clean));
  } catch {
    return json({ error: "The AI returned an unreadable answer. Try again." }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/analyze") {
      if (request.method !== "POST") return json({ error: "Use POST." }, 405);
      return analyze(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
