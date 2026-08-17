import { escapeHtml } from "./ui.js";

/**
 * The Rating History line chart: hand-drawn SVG, no chart library and no framework.
 *
 * A CDN chart bundle would be the only third-party runtime on this static page, and
 * the browser end-to-end run deliberately blocks every host but loopback and the
 * Firebase CDN, so it could not load there either. What is actually needed here --
 * a few polylines, two axes, a legend and a tooltip -- is a couple of hundred lines
 * of SVG generation, redrawn only when the data or the container width changes.
 *
 * The chart never fits anything itself. It renders whatever `computeRatingHistory`
 * produced, and resolves player IDs to names through the caller's `nameFor`, so a
 * rename is reflected on the next render without touching the history.
 */
const PADDING = { top: 18, right: 16, bottom: 38, left: 50 };
const GOLDEN_ANGLE = 137.508;

/**
 * Colour comes from the player's position in an ID-sorted list, never from their
 * name: renaming a player must not recolour their line, and no name is special.
 */
function seriesColor(index) {
  const hue = Math.round((index * GOLDEN_ANGLE) % 360);
  // Two alternating lightness steps keep neighbouring hues apart once the wheel
  // wraps, and both stay dark enough to read against the light card.
  return `hsl(${hue}, 58%, ${index % 2 ? 32 : 44}%)`;
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** Axis bounds on a round step, always wide enough to show movement around 1000. */
function niceScale(min, max, targetTicks) {
  let low = Math.min(min, max);
  let high = Math.max(min, max);
  if (high - low < 40) { const middle = (low + high) / 2; low = middle - 20; high = middle + 20; }
  const rough = (high - low) / Math.max(1, targetTicks);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((value) => value >= rough) ?? 10 * magnitude;
  const start = Math.floor(low / step) * step;
  const end = Math.ceil(high / step) * step;
  const ticks = [];
  for (let value = start; value <= end + step / 1000; value += step) ticks.push(Math.round(value));
  return { min: start, max: end, ticks };
}

const shortDate = new Intl.DateTimeFormat("en", { month: "short", day: "numeric" });
const shortTime = new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" });
const fullDate = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

export function createRatingChart(container) {
  const hidden = new Set();
  const plot = document.createElement("div");
  plot.className = "chart-plot";
  const tooltip = document.createElement("div");
  tooltip.className = "chart-tooltip";
  tooltip.hidden = true;
  const legend = document.createElement("div");
  legend.className = "chart-legend";
  plot.append(tooltip);
  container.append(plot, legend);

  let data = null;
  let nameFor = (id) => id;
  let colors = new Map();
  let geometry = null;
  let signature = "";

  const visibleSeries = () => (data?.series ?? []).filter((series) => !hidden.has(series.playerId));
  const ratingAt = (series, index) => series.values.find((value) => value.index === index) ?? null;

  function renderLegend() {
    if (!data?.series.length) { legend.innerHTML = ""; return; }
    legend.innerHTML = data.series.map((series) => {
      const off = hidden.has(series.playerId);
      return `<button class="legend-item${off ? " is-off" : ""}" type="button" data-player-id="${escapeHtml(series.playerId)}" aria-pressed="${!off}" data-rating="${series.rating}">
        <span class="legend-swatch" style="background:${colors.get(series.playerId)}"></span>
        <span class="legend-name">${escapeHtml(nameFor(series.playerId))}</span>
        <span class="legend-rating">${series.rating}</span>
      </button>`;
    }).join("");
  }

  function renderSvg() {
    const width = Math.round(plot.clientWidth);
    // A hidden panel has no width. The ResizeObserver draws again the moment it
    // gains one, so there is nothing to do -- and nothing to measure -- until then.
    if (!width) { geometry = null; return; }
    const compact = width < 560;
    const height = compact ? 250 : 320;
    const left = compact ? 42 : PADDING.left;
    const innerWidth = Math.max(40, width - left - PADDING.right);
    const innerHeight = height - PADDING.top - PADDING.bottom;
    const lastIndex = data.points.length - 1;
    const visible = visibleSeries();

    const ratings = visible.flatMap((series) => series.values.map((value) => value.rating));
    const scale = niceScale(Math.min(1000, ...ratings), Math.max(1000, ...ratings), compact ? 4 : 5);
    const x = (index) => left + (lastIndex ? (index / lastIndex) * innerWidth : innerWidth / 2);
    const y = (rating) => PADDING.top + innerHeight - ((rating - scale.min) / (scale.max - scale.min)) * innerHeight;

    const gridlines = scale.ticks.map((tick) => `
      <line class="chart-grid" x1="${left}" x2="${left + innerWidth}" y1="${y(tick).toFixed(1)}" y2="${y(tick).toFixed(1)}"${tick === 1000 ? ' stroke-dasharray="3 3"' : ""}></line>
      <text class="chart-axis-label" x="${left - 8}" y="${(y(tick) + 4).toFixed(1)}" text-anchor="end">${tick}</text>`).join("");

    // At most a handful of date labels, always including the first and last point.
    const maxLabels = compact ? 3 : 6;
    const stride = Math.max(1, Math.ceil(lastIndex / maxLabels));
    // A history recorded inside one day would otherwise print the same date at every
    // tick, which says nothing about the progression; those axes show the time.
    const dates = data.points.slice(1).map((point) => point.date).filter(Boolean);
    const oneDay = dates.length > 1 && dates[0].toDateString() === dates.at(-1).toDateString();
    const axisFormat = oneDay ? shortTime : shortDate;
    const ticks = data.points.filter((point) =>
      point.index === 0 || point.index === lastIndex
      // Intermediate ticks keep a full stride clear of the last label so nothing
      // collides at the right edge on a narrow screen.
      || (point.index % stride === 0 && lastIndex - point.index >= stride));
    let labels = ticks.map((point) => (point.index === 0 ? "Start" : point.date ? axisFormat.format(point.date) : `#${point.index}`));
    // Several matches inside one minute would repeat one timestamp across the axis,
    // which says nothing about the progression. The match number always does.
    if (new Set(labels).size !== labels.length) labels = ticks.map((point) => (point.index === 0 ? "Start" : `#${point.index}`));
    const xLabels = ticks.map((point, position) => {
      const anchor = point.index === 0 ? "start" : point.index === lastIndex ? "end" : "middle";
      return `<text class="chart-axis-label" x="${x(point.index).toFixed(1)}" y="${height - 14}" text-anchor="${anchor}">${escapeHtml(labels[position])}</text>`;
    }).join("");

    const paths = visible.map((series) => {
      const color = colors.get(series.playerId);
      const d = series.values.map((value, position) => `${position ? "L" : "M"}${x(value.index).toFixed(1)},${y(value.rating).toFixed(1)}`).join(" ");
      const dots = series.values.length <= 40
        ? series.values.map((value) => `<circle class="chart-dot" cx="${x(value.index).toFixed(1)}" cy="${y(value.rating).toFixed(1)}" r="${compact ? 2 : 2.6}" fill="${color}"></circle>`).join("")
        : "";
      return `<g data-player-id="${escapeHtml(series.playerId)}" data-ratings="${series.values.map((value) => value.rating).join(",")}" data-first-index="${series.firstIndex}">
        <path class="chart-line" d="${d}" fill="none" stroke="${color}" stroke-width="${compact ? 1.8 : 2.2}" stroke-linecap="round" stroke-linejoin="round"></path>${dots}
      </g>`;
    }).join("");

    const markers = visible.map((series) => `<circle class="chart-marker" data-player-id="${escapeHtml(series.playerId)}" r="4.5" fill="${colors.get(series.playerId)}" stroke="white" stroke-width="1.6" opacity="0"></circle>`).join("");

    plot.querySelector("svg")?.remove();
    plot.insertAdjacentHTML("afterbegin", `<svg class="chart-svg" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img"
      aria-label="Rating history for ${visible.length} player${visible.length === 1 ? "" : "s"} over ${lastIndex} match${lastIndex === 1 ? "" : "es"}, from 1000 at the start.">
      ${gridlines}
      <line class="chart-guide" y1="${PADDING.top}" y2="${PADDING.top + innerHeight}" x1="0" x2="0" opacity="0"></line>
      ${paths}
      ${markers}
      <rect class="chart-hit" x="0" y="0" width="${width}" height="${height}" fill="transparent"></rect>
      ${xLabels}
    </svg>`);

    geometry = { width, height, left, innerWidth, lastIndex, x, y, visible };
  }

  function hideTooltip() {
    tooltip.hidden = true;
    const svg = plot.querySelector("svg");
    if (!svg) return;
    svg.querySelector(".chart-guide")?.setAttribute("opacity", "0");
    svg.querySelectorAll(".chart-marker").forEach((marker) => marker.setAttribute("opacity", "0"));
  }

  function showTooltip(clientX) {
    if (!geometry || !data) return;
    const svg = plot.querySelector("svg");
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const factor = geometry.width / rect.width;
    const local = (clientX - rect.left) * factor;
    const index = geometry.lastIndex
      ? clamp(Math.round(((local - geometry.left) / geometry.innerWidth) * geometry.lastIndex), 0, geometry.lastIndex)
      : 0;
    const point = data.points[index];

    const rows = geometry.visible
      .map((series) => ({ series, value: ratingAt(series, index) }))
      .filter((entry) => entry.value)
      .sort((a, b) => b.value.rating - a.value.rating);

    const guide = svg.querySelector(".chart-guide");
    guide.setAttribute("x1", geometry.x(index).toFixed(1));
    guide.setAttribute("x2", geometry.x(index).toFixed(1));
    guide.setAttribute("opacity", "1");
    for (const marker of svg.querySelectorAll(".chart-marker")) {
      const entry = rows.find((row) => row.series.playerId === marker.dataset.playerId);
      marker.setAttribute("opacity", entry ? "1" : "0");
      if (entry) {
        marker.setAttribute("cx", geometry.x(index).toFixed(1));
        marker.setAttribute("cy", geometry.y(entry.value.rating).toFixed(1));
      }
    }

    const names = (ids) => ids.map((id) => escapeHtml(nameFor(id))).join(", ");
    const header = index === 0
      ? "<strong>Before any matches</strong><span>Everybody starts at 1000</span>"
      : `<strong>Match ${index} of ${geometry.lastIndex}</strong><span>${point.date ? escapeHtml(fullDate.format(point.date)) : "Recording…"}</span>
         <span class="chart-tooltip-match">${names(point.teamA)} <b>${point.scoreA}–${point.scoreB}</b> ${names(point.teamB)}</span>`;
    const shown = rows.slice(0, 8);
    tooltip.innerHTML = `<div class="chart-tooltip-head">${header}</div>
      <ul>${shown.map((row) => `<li><span class="legend-swatch" style="background:${colors.get(row.series.playerId)}"></span><span>${escapeHtml(nameFor(row.series.playerId))}</span><b>${row.value.rating}</b></li>`).join("")}</ul>
      ${rows.length > shown.length ? `<p class="chart-tooltip-more">+${rows.length - shown.length} more</p>` : ""}`;
    tooltip.hidden = false;
    const position = geometry.x(index) / factor;
    tooltip.style.left = `${clamp(position, tooltip.offsetWidth / 2 + 4, rect.width - tooltip.offsetWidth / 2 - 4)}px`;
  }

  plot.addEventListener("pointermove", (event) => showTooltip(event.clientX));
  plot.addEventListener("pointerdown", (event) => showTooltip(event.clientX));
  plot.addEventListener("pointerleave", hideTooltip);
  plot.addEventListener("pointercancel", hideTooltip);

  legend.addEventListener("click", (event) => {
    const button = event.target.closest("[data-player-id]");
    if (!button) return;
    const id = button.dataset.playerId;
    // Hiding the last visible line would leave an empty grid, so the last one stays.
    if (hidden.has(id)) hidden.delete(id);
    else if (visibleSeries().length > 1) hidden.add(id);
    else return;
    signature = "";
    render();
  });

  function render() {
    // A hidden container -- the Leaderboard's other view, or the other main tab --
    // has no width, so nothing can be drawn into it. Leave the signature alone as
    // well as the SVG: re-showing it at an unchanged width with an unchanged
    // snapshot is then a genuine no-op instead of a rebuild of a correct picture.
    // The ResizeObserver fires again on the way back, and redraws if either moved.
    if (!plot.clientWidth && plot.querySelector("svg")) return;
    if (!data || !data.matchCount || !data.series.length) {
      plot.querySelector("svg")?.remove();
      hideTooltip();
      legend.innerHTML = "";
      geometry = null;
      if (!plot.querySelector(".empty-state")) plot.insertAdjacentHTML("afterbegin", '<div class="empty-state">Rating history appears once matches are recorded.</div>');
      return;
    }
    plot.querySelector(".empty-state")?.remove();
    // Redrawing is skipped unless the data snapshot, the visible set or the width
    // actually changed, so scrolling and pointer moves never rebuild the SVG.
    const next = `${data.revision ?? ""}|${data.matchCount}|${data.series.map((series) => `${series.playerId}:${series.rating}:${nameFor(series.playerId)}`).join(",")}|${[...hidden].sort().join(",")}|${Math.round(plot.clientWidth)}`;
    if (next === signature) return;
    signature = next;
    hideTooltip();
    renderSvg();
    renderLegend();
  }

  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => render()) : null;
  observer?.observe(plot);
  if (!observer) window.addEventListener("resize", () => render());

  return {
    update(next, resolveName) {
      data = next;
      nameFor = resolveName ?? nameFor;
      const ordered = (data?.series ?? []).map((series) => series.playerId).sort((a, b) => String(a).localeCompare(String(b)));
      colors = new Map(ordered.map((id, index) => [id, seriesColor(index)]));
      render();
    },
    /** Test and debug hook: what the chart currently believes it is drawing. */
    snapshot() {
      return { hidden: [...hidden], series: (data?.series ?? []).map((series) => ({ playerId: series.playerId, rating: series.rating })) };
    },
  };
}
