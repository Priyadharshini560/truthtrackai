
const answerInput = document.getElementById("answer");
const verifyBtn = document.getElementById("verifyBtn");

answerInput.addEventListener("input", () => {
    document.getElementById("charCount").textContent =
        `${answerInput.value.length} / 10000 characters`;
});

async function verifyAnswer() {
    const answer = answerInput.value.trim();

    if (!answer) {
        alert("Please paste an AI-generated answer first.");
        return;
    }

    const loading = document.getElementById("loading");
    const results = document.getElementById("results");
    const error = document.getElementById("error");

    results.classList.add("hidden");
    error.classList.add("hidden");
    loading.classList.remove("hidden");
    verifyBtn.disabled = true;
    verifyBtn.textContent = "Verifying...";

    try {
        const response = await fetch("/api/verify", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ answer })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || "Verification failed.");
        }

        displayResults(data);

    } catch (err) {
        error.textContent = err.message;
        error.classList.remove("hidden");
    } finally {
        loading.classList.add("hidden");
        verifyBtn.disabled = false;
        verifyBtn.textContent = "Verify Answer →";
    }
}

function displayResults(data) {
    const results = document.getElementById("results");
    const counts = {
        supported: 0,
        stale: 0,
        contradicted: 0,
        unverified: 0
    };

    document.getElementById("score").textContent =
        data.freshnessScore + " / 100";

    document.getElementById("scoreStatus").textContent =
        data.overallStatus;

    data.claims.forEach(claim => {
        if (claim.status === "Supported") counts.supported++;
        else if (claim.status === "Potentially Stale") counts.stale++;
        else if (claim.status === "Contradicted") counts.contradicted++;
        else counts.unverified++;
    });

    document.getElementById("supported").textContent = counts.supported;
    document.getElementById("stale").textContent = counts.stale;
    document.getElementById("contradicted").textContent = counts.contradicted;
    document.getElementById("unverified").textContent = counts.unverified;

    const claimList = document.getElementById("claimList");
    claimList.replaceChildren();

    data.claims.forEach(claim => {
        const card = document.createElement("article");
        card.className = "claim";

        const heading = document.createElement("h4");
        heading.textContent = claim.text;

        const status = document.createElement("span");
        status.className = "status " + claim.status.replaceAll(" ", "-");
        status.textContent = claim.status;

        const score = document.createElement("p");
        score.textContent = `Freshness: ${claim.freshnessScore}/100`;

        const explanation = document.createElement("p");
        explanation.textContent = claim.explanation;

        card.append(status, heading, score, explanation);

        (claim.sources || []).forEach(source => {
            try {
                const url = new URL(source.url);

                if (url.protocol !== "https:" && url.protocol !== "http:") return;

                const link = document.createElement("a");
                link.href = url.href;
                link.target = "_blank";
                link.rel = "noopener noreferrer";
                link.textContent = source.title || url.hostname;

                card.appendChild(link);
            } catch {
                // Ignore invalid source URLs.
            }
        });

        claimList.appendChild(card);
    });

    document.getElementById("summary").textContent = data.summary;

    results.classList.remove("hidden");
    results.scrollIntoView({ behavior: "smooth" });
}
