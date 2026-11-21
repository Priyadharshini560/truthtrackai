
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();

app.use(cors());
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "../public")));

const PORT = process.env.PORT || 3000;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY?.trim();
const BIFROST_URL = (process.env.BIFROST_URL || "http://localhost:8080").replace(/\/+$/, "");
const BIFROST_API_KEY = process.env.BIFROST_API_KEY || "";
const BIFROST_MODEL = process.env.BIFROST_MODEL || "openai/gpt-4o-mini";

async function request(url, options = {}) {
    try {
        return await fetch(url, options);
    } catch (error) {
        console.error("Network request failed:", url);
        console.error("Error:", error.message);
        console.error("Cause:", error.cause || "No additional cause");

        throw new Error(
            `Network error: ${error.cause?.code || error.message}`
        );
    }
}

async function callBifrost(messages) {
    if (process.env.BIFROST_ENABLED !== "true") {
        throw new Error("Bifrost is not enabled.");
    }

    const headers = {
        "Content-Type": "application/json"
    };

    if (BIFROST_API_KEY) {
        headers.Authorization = `Bearer ${BIFROST_API_KEY}`;
    }

    const response = await request(
        `${BIFROST_URL}/v1/chat/completions`,
        {
            method: "POST",
            headers,
            body: JSON.stringify({
                model: BIFROST_MODEL,
                temperature: 0,
                messages
            }),
            signal: AbortSignal.timeout(60000)
        }
    );

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Bifrost error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
        throw new Error("Bifrost returned an empty response.");
    }

    return content;
}

function parseJSON(text) {
    const cleaned = text
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();

    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");

    if (start === -1 || end === -1) {
        throw new Error("AI did not return valid JSON.");
    }

    return JSON.parse(cleaned.slice(start, end + 1));
}

async function extractClaims(answer) {
    try {
        const result = await callBifrost([
            {
                role: "system",
                content: `Extract factual claims from the answer.
Return ONLY JSON:
{"claims":["claim one","claim two"]}
Maximum 5 claims. Do not invent claims.`
            },
            {
                role: "user",
                content: answer
            }
        ]);

        const parsed = parseJSON(result);

        return parsed.claims
            .filter(c => typeof c === "string" && c.trim())
            .slice(0, 5);

    } catch (error) {
        console.log("Basic claim extraction:", error.message);

        return answer
            .split(/(?<=[.!?])\s+/)
            .map(s => s.trim())
            .filter(s => s.length > 20)
            .slice(0, 5);
    }
}

async function searchTavily(query) {
    if (!TAVILY_API_KEY) {
        throw new Error("Tavily API key is missing. Check your .env file.");
    }

    const response = await request(
        "https://api.tavily.com/search",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${TAVILY_API_KEY}`
            },
            body: JSON.stringify({
                query,
                search_depth: "basic",
                topic: "general",
                max_results: 5,
                include_answer: false
            }),
            signal: AbortSignal.timeout(30000)
        }
    );

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Tavily error ${response.status}: ${errorText}`);
    }

    const data = await response.json();

    return (data.results || []).map(item => ({
        title: item.title || "Untitled source",
        url: item.url,
        content: (item.content || "").slice(0, 1500),
        score: item.score || 0,
        publishedDate: item.published_date || null
    }));
}

async function evaluateClaim(claim, sources) {
    if (!sources.length) {
        return {
            text: claim,
            status: "Unverified",
            freshnessScore: 0,
            explanation: "No relevant live web evidence was found.",
            sources: []
        };
    }

    try {
        const result = await callBifrost([
            {
                role: "system",
                content: `Verify the claim using only the supplied evidence.
Return ONLY JSON:
{
"status":"Supported",
"freshnessScore":75,
"explanation":"Brief explanation"
}
Allowed statuses: Supported, Potentially Stale, Contradicted, Unverified.
Do not invent facts. Score must be 0 to 100.`
            },
            {
                role: "user",
                content: JSON.stringify({
                    claim,
                    currentDate: new Date().toISOString().slice(0, 10),
                    evidence: sources
                })
            }
        ]);

        const parsed = parseJSON(result);

        const allowed = [
            "Supported",
            "Potentially Stale",
            "Contradicted",
            "Unverified"
        ];

        return {
            text: claim,
            status: allowed.includes(parsed.status)
                ? parsed.status
                : "Unverified",
            freshnessScore: Math.max(
                0,
                Math.min(100, Number(parsed.freshnessScore) || 0)
            ),
            explanation: String(parsed.explanation || "Insufficient evidence."),
            sources
        };

    } catch (error) {
        console.error("AI evaluation error:", error.message);

        return {
            text: claim,
            status: "Unverified",
            freshnessScore: 0,
            explanation: "Evidence found, but AI evaluation failed: " + error.message,
            sources
        };
    }
}

app.get("/api/health", (req, res) => {
    res.json({
        status: "running",
        project: "TruthTrack AI",
        tavilyConfigured: Boolean(TAVILY_API_KEY),
        bifrostEnabled: process.env.BIFROST_ENABLED === "true"
    });
});

app.post("/api/verify", async (req, res) => {
    try {
        const { answer } = req.body;

        if (!answer || typeof answer !== "string" || !answer.trim()) {
            return res.status(400).json({
                error: "Please provide an answer to verify."
            });
        }

        if (answer.length > 10000) {
            return res.status(400).json({
                error: "Answer must be under 10000 characters."
            });
        }

        console.log("Starting TruthTrack verification...");

        const claims = await extractClaims(answer);

        if (!claims.length) {
            return res.status(400).json({
                error: "No verifiable claims found."
            });
        }

        const claimResults = [];

        for (const claim of claims) {
            try {
                console.log("Searching:", claim);

                const sources = await searchTavily(claim);
                const evaluation = await evaluateClaim(claim, sources);

                claimResults.push(evaluation);

            } catch (error) {
                console.error("Tavily verification error:", error.message);

                claimResults.push({
                    text: claim,
                    status: "Unverified",
                    freshnessScore: 0,
                    explanation: error.message,
                    sources: []
                });
            }
        }

        const totalScore = Math.round(
            claimResults.reduce(
                (sum, item) => sum + item.freshnessScore, 0
            ) / claimResults.length
        );

        const counts = {
            Supported: claimResults.filter(c => c.status === "Supported").length,
            PotentiallyStale: claimResults.filter(c => c.status === "Potentially Stale").length,
            Contradicted: claimResults.filter(c => c.status === "Contradicted").length,
            Unverified: claimResults.filter(c => c.status === "Unverified").length
        };

        let overallStatus = "Needs Review";

        if (counts.Contradicted > 0 || counts.PotentiallyStale > 0) {
            overallStatus = "Potentially Outdated";
        } else if (counts.Unverified === claimResults.length) {
            overallStatus = "Unable to Verify";
        } else if (counts.Supported === claimResults.length) {
            overallStatus = "Evidence Supports Claims";
        }

        const summary =
            `Checked ${claimResults.length} claims. ` +
            `${counts.Supported} supported, ` +
            `${counts.PotentiallyStale} potentially stale, ` +
            `${counts.Contradicted} contradicted and ` +
            `${counts.Unverified} unverified. ` +
            `Overall freshness score: ${totalScore}/100.`;

        res.json({
            success: true,
            freshnessScore: totalScore,
            overallStatus,
            summary,
            claims: claimResults
        });

    } catch (error) {
        console.error("Verification error:", error);

        res.status(500).json({
            error: error.message || "Something went wrong."
        });
    }
});

app.listen(PORT, () => {
    console.log(`TruthTrack AI running at http://localhost:${PORT}`);
});
