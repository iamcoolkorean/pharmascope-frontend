const API_BASE = window.PHARMASCOPE_API || "http://localhost:8000";

let lastCandidates = [];
let lastAnalysis = [];
let lastReportMd = "";

const $ = (id) => document.getElementById(id);
const scanBtn = $("scanBtn");
const statusEl = $("status");

function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }

function renderTable(tableEl, columns, rows) {
  const thead = tableEl.querySelector("thead");
  const tbody = tableEl.querySelector("tbody");
  thead.innerHTML = "<tr>" + columns.map(c => `<th>${c.label}</th>`).join("") + "</tr>";
  tbody.innerHTML = rows.map(r =>
    "<tr>" + columns.map(c => `<td>${r[c.key] ?? ""}</td>`).join("") + "</tr>"
  ).join("");
}

async function apiFetch(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`API 오류 ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res.json();
}

scanBtn.addEventListener("click", async () => {
  const disease = $("disease").value.trim();
  const modality = $("modality").value.trim();
  const phase = $("phase").value;

  if (!disease) { statusEl.textContent = "질환명을 입력하세요."; return; }

  scanBtn.disabled = true;
  statusEl.textContent = "임상시험 DB 검색 중...";
  hide($("candidatesSection"));
  hide($("analysisSection"));
  hide($("chartSection"));
  hide($("reportSection"));

  try {
    const data = await apiFetch("/api/scan", { disease, modality, phase });
    lastCandidates = data.candidates || [];
    if (lastCandidates.length === 0) {
      statusEl.textContent = data.message || "결과가 없습니다.";
      return;
    }
    statusEl.textContent = data.message;

    renderTable($("candidatesTable"),
      [
        { key: "NCT_ID", label: "NCT ID" },
        { key: "제목", label: "제목" },
        { key: "임상단계", label: "단계" },
        { key: "중재법", label: "중재법" },
        { key: "스폰서", label: "스폰서" },
      ],
      lastCandidates
    );
    show($("candidatesSection"));
    await evaluateAll(disease, modality, phase);
  } catch (e) {
    statusEl.textContent = "오류: " + e.message;
  } finally {
    scanBtn.disabled = false;
  }
});

async function evaluateAll(disease, modality, phase) {
  show($("analysisSection"));
  const progress = $("analysisProgress");
  const rows = [];
  lastAnalysis = [];

  for (let i = 0; i < lastCandidates.length; i++) {
    const c = lastCandidates[i];
    progress.textContent = `⏳ 처리 중 (${i + 1}/${lastCandidates.length}): ${c.NCT_ID}`;
    try {
      const res = await apiFetch("/api/evaluate", {
        nct_id: c.NCT_ID,
        sponsor: c.스폰서 || "",
        disease: c.질환 || disease,
        modality: modality,
        phase: c.임상단계 || phase,
        intervention: c.중재법 || ""
      });
      const pred = res.prediction || {};
      rows.push({
        nct_id: res.nct_id,
        similarity: res.similarity + "%",
        upfront: pred.upfront_million ?? "?",
        milestone: pred.milestone_total_million ?? "?",
        royalty: pred.royalty_rate_percent ?? "?",
        financial: res.financial_health
      });
      lastAnalysis.push({ candidate: c, result: res });
    } catch (e) {
      rows.push({
        nct_id: c.NCT_ID, similarity: "-", upfront: "-", milestone: "-",
        royalty: "-", financial: "오류: " + e.message
      });
    }

    renderTable($("analysisTable"),
      [
        { key: "nct_id", label: "NCT ID" },
        { key: "similarity", label: "유사도" },
        { key: "upfront", label: "예상 계약금 ($M)" },
        { key: "milestone", label: "예상 마일스톤 ($M)" },
        { key: "royalty", label: "예상 로열티 (%)" },
        { key: "financial", label: "재무 안전성" },
      ],
      rows
    );
  }
  progress.textContent = `✅ ${rows.length}건 분석 완료`;

  drawBarChart(rows);
  await generateReport();
}

function drawBarChart(rows) {
  const valid = rows.filter(r => typeof r.upfront === "number");
  if (valid.length === 0) return;
  show($("chartSection"));
  const trace = {
    x: valid.map(r => r.nct_id),
    y: valid.map(r => r.upfront),
    type: "bar",
    marker: { color: valid.map(r => r.upfront), colorscale: "Blues" }
  };
  const layout = {
    title: "타겟별 예상 계약금 (Upfront)",
    xaxis: { title: "임상시험 ID" },
    yaxis: { title: "계약금 (백만 달러)" },
    margin: { t: 50, r: 20, b: 80, l: 60 },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)"
  };
  Plotly.newPlot("barChart", [trace], layout, { responsive: true });
}

async function generateReport() {
  if (lastAnalysis.length === 0) return;
  const top3 = lastAnalysis.slice(0, 3).map(a => ({
    name: `${a.candidate.NCT_ID} / ${a.candidate.스폰서}`,
    nct_id: a.candidate.NCT_ID,
    phase: a.candidate.임상단계,
    sponsor: a.candidate.스폰서,
    moa: a.candidate.중재법,
    deal_prediction: a.result.prediction,
    financial_health: a.result.financial_health
  }));

  $("reportContent").textContent = "리포트 생성 중...";
  show($("reportSection"));

  try {
    const data = await apiFetch("/api/report", { targets: top3 });
    lastReportMd = data.report_markdown;
    $("reportContent").innerHTML = marked.parse(lastReportMd);
  } catch (e) {
    $("reportContent").textContent = "리포트 생성 오류: " + e.message;
  }
}

$("downloadBtn").addEventListener("click", () => {
  if (!lastReportMd) return;
  const blob = new Blob([lastReportMd], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "pharmascope_report.md";
  a.click();
  URL.revokeObjectURL(a.href);
});